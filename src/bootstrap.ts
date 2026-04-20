import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { sandboxBaseUrl, sandboxTargetHeaders } from "./e2b.js"

/**
 * Absolute path inside the sandbox where the OpenCode server's combined
 * stdout+stderr are redirected. We read from here on readiness-check
 * failure so the user can see the actual server error instead of just a
 * generic timeout.
 */
const START_COMMAND_LOG_PATH = "/tmp/opencode-serve.log"

/**
 * Prepare the uploaded project in the sandbox and start the OpenCode server.
 */
export async function bootstrapWorkspace(params: {
  sandbox: Sandbox
  info: WorkspaceInfo
  config: NormalizedE2BWorkspaceConfig
  runtimeVersion: string
  logger?: PluginLogger
}): Promise<void> {
  await ensureGitRepository(params.sandbox, params.info, params.config)
  await writeProjectMarker(params.sandbox, params.info, params.config)
  await runBootstrapCommands(params.sandbox, params.config, params.runtimeVersion, params.logger)
  await waitForServerReady(params.sandbox, params.config)
}

/**
 * Ensure the uploaded project directory is a git repository because current
 * OpenCode workspace support expects `.git/opencode` to exist in the sandbox.
 */
async function ensureGitRepository(
  sandbox: Sandbox,
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  const branch = info.branch ?? "main"
  const command = [
    `mkdir -p ${shellQuote(config.projectPath)}`,
    `cd ${shellQuote(config.projectPath)}`,
    `if [ ! -d .git ]; then git init -b ${shellQuote(branch)}; fi`,
  ].join(" && ")

  await runCheckedCommand(sandbox, command)
}

/**
 * Write OpenCode's temporary project marker into the sandbox repository.
 */
async function writeProjectMarker(
  sandbox: Sandbox,
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  await sandbox.files.write(posix.join(config.projectPath, ".git", "opencode"), info.projectID)
}

/**
 * Run the configured bootstrap sequence used to prepare OpenCode inside the
 * sandbox. These remain command-driven to keep the scaffold flexible.
 */
async function runBootstrapCommands(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
  runtimeVersion: string,
  logger?: PluginLogger,
): Promise<void> {
  for (const command of config.bootstrap.prepareCommands) {
    if (!command.trim()) continue
    await runCheckedCommand(sandbox, command, config.projectPath)
  }

  const installCommand = resolveInstallCommand(config, runtimeVersion)
  if (installCommand) {
    await runCheckedCommand(sandbox, installCommand, config.projectPath)
  }

  // Resolve the absolute path of the just-installed `opencode` binary. The
  // E2B `opencode` base image ships an older `opencode` that typically
  // resolves first on PATH (e.g. via `~/.bun/bin`), so a default install of
  // `opencode-ai` through npm can silently end up on a different prefix.
  // Running the freshly installed binary by absolute path ensures the server
  // we start matches the version we actually asked for.
  const resolvedOpencodeBin = await resolveOpencodeBinaryPath(sandbox, config, logger)

  await clearStaleOpencodeProcesses(sandbox, config)

  if (!config.bootstrap.startCommand.trim()) {
    throw new Error("Missing bootstrap.startCommand for E2B workspace")
  }

  const startCommand = config.bootstrap.startCommand
    .replaceAll("${PORT}", String(config.serverPort))
    .replaceAll("${OPENCODE_BIN}", resolvedOpencodeBin)
  // Redirect both stdout and stderr to a well-known log path inside the
  // sandbox so that if readiness times out we can fetch a tail and embed it
  // in the error message. Using `sh -c` keeps the redirection intact while
  // still running the command in the background. START_COMMAND_LOG_PATH is a
  // hardcoded constant without shell metacharacters, so no further escaping
  // is needed for the redirection target itself.
  const supervisedCommand = `sh -c ${shellQuote(`${startCommand} >${START_COMMAND_LOG_PATH} 2>&1`)}`
  await logger?.info("bootstrap launching opencode server", {
    opencodeBin: resolvedOpencodeBin,
    startCommand,
  })
  await sandbox.commands.run(supervisedCommand, {
    cwd: config.projectPath,
    background: true,
  })
}

/**
 * Resolve the absolute filesystem path of the `opencode` binary that should be
 * launched to run the pinned server. Preference order:
 *   1. The binary produced by the npm global install (`npm prefix -g` + bin).
 *   2. Whatever `command -v opencode` resolves to with the current PATH.
 *   3. The bare string "opencode" so callers relying on PATH still function.
 *
 * This is a best-effort lookup; failures are logged at info level and the
 * fallback is returned so bootstrap can still proceed (the user will get a
 * readable error from readiness if the path is wrong).
 */
async function resolveOpencodeBinaryPath(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
): Promise<string> {
  // npm prefix -g works on every supported npm version and prints the prefix
  // that would be used by `npm install -g`, which is exactly the directory we
  // just wrote the binary into if the default install command ran.
  const prefixProbe = await sandbox.commands
    .run("sh -c 'command -v npm >/dev/null 2>&1 && npm prefix -g'", { cwd: config.projectPath })
    .catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: errorMessage(error) }))

  if (prefixProbe.exitCode === 0) {
    const prefix = prefixProbe.stdout.trim()
    if (prefix) {
      const candidate = posix.join(prefix, "bin", "opencode")
      const exists = await sandbox.files.exists(candidate).catch(() => false)
      if (exists) {
        await logger?.info("bootstrap resolved opencode binary", {
          source: "npm-prefix",
          path: candidate,
        })
        return candidate
      }

      await logger?.info("bootstrap npm prefix lookup missed opencode binary", {
        prefix,
        candidate,
      })
    }
  } else {
    await logger?.info("bootstrap npm prefix lookup failed", {
      exitCode: prefixProbe.exitCode,
      stderr: prefixProbe.stderr.trim(),
    })
  }

  // Fall back to whatever PATH currently resolves `opencode` to. This handles
  // user-provided custom install commands that don't use npm, at the cost of
  // still depending on PATH ordering.
  const whichProbe = await sandbox.commands
    .run("sh -c 'command -v opencode'", { cwd: config.projectPath })
    .catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: errorMessage(error) }))

  if (whichProbe.exitCode === 0) {
    const path = whichProbe.stdout.trim()
    if (path) {
      await logger?.info("bootstrap resolved opencode binary", {
        source: "command-v",
        path,
      })
      return path
    }
  }

  await logger?.warn("bootstrap could not resolve opencode binary, falling back to PATH", {})
  return "opencode"
}

/**
 * Best-effort cleanup for stale OpenCode processes left behind by older base
 * templates or prior manual debugging inside the sandbox. The managed idle
 * template should keep this path mostly quiet, but clearing leftovers before we
 * launch the pinned runtime avoids port conflicts and accidental readiness from
 * an outdated server.
 */
async function clearStaleOpencodeProcesses(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  await sandbox.commands.run("sh -c \"pkill -f '(^|/)opencode( |$)' || true\"", {
    cwd: config.projectPath,
  })
}

/**
 * Keep the sandbox runtime pinned to the same published OpenCode version as the
 * local controller. The prebuilt E2B `opencode` template may lag behind the
 * currently installed desktop/CLI release, and older servers are missing the
 * sync routes required by workspace mode. Users can still override this with an
 * explicit `bootstrap.installCommand` if they have a custom image strategy.
 */
function resolveInstallCommand(config: NormalizedE2BWorkspaceConfig, runtimeVersion: string): string | undefined {
  if (config.bootstrap.installCommand.trim()) {
    return config.bootstrap.installCommand
  }

  return `npm install -g opencode-ai@${runtimeVersion}`
}

/**
 * Wait until the OpenCode server becomes reachable through the sandbox host.
 * The default readiness path is `/global/health`, which returns a small JSON
 * payload as soon as the server is accepting requests. We also defensively
 * cancel the response body on every iteration — a user-overridden path might
 * point at an SSE endpoint, and leaving the body open would leak one
 * persistent connection per poll cycle against the sandbox gateway.
 */
async function waitForServerReady(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): Promise<void> {
  const baseUrl = sandboxBaseUrl(sandbox, config)
  const readyUrl = new URL(config.bootstrap.waitForPath, baseUrl)
  const headers = sandboxTargetHeaders(sandbox, config)
  const startedAt = Date.now()

  while (Date.now() - startedAt < config.bootstrap.waitForTimeoutMs) {
    let response: Response | undefined
    let ready = false
    try {
      response = await fetch(readyUrl, {
        headers,
        signal: AbortSignal.timeout(1_500),
      })
      ready = response.ok
    } catch {
      // Ignore transient startup errors until the timeout expires.
    } finally {
      // Always release the underlying socket for this probe iteration. We
      // never read the body because `response.ok` is populated from headers
      // alone, and a streaming endpoint would otherwise stay open.
      if (response && !response.bodyUsed) {
        await response.body?.cancel().catch(() => {})
      }
    }

    if (ready) return

    await sleep(750)
  }

  // The server never came up within the window. Best-effort fetch the tail of
  // the combined stdout/stderr log so the user sees the actual startup error
  // (install failure, port conflict, crashed subprocess, etc.) instead of a
  // generic timeout.
  const tail = await readStartCommandLogTail(sandbox).catch(() => undefined)
  const suffix = tail ? `\nLast ${tail.split("\n").length} lines from ${START_COMMAND_LOG_PATH}:\n${tail}` : ""
  throw new Error(`Timed out waiting for OpenCode server at ${readyUrl.toString()}${suffix}`)
}

/**
 * Read the last few lines of the captured start-command log. Runs as a
 * best-effort diagnostic and must never mask the original readiness error:
 * callers always catch and ignore failures from this helper.
 */
async function readStartCommandLogTail(sandbox: Sandbox): Promise<string | undefined> {
  const exists = await sandbox.files.exists(START_COMMAND_LOG_PATH)
  if (!exists) return undefined

  const content = await sandbox.files.read(START_COMMAND_LOG_PATH)
  const lines = content.split("\n")
  // Keep the output bounded so the error message stays readable.
  const maxLines = 40
  const slice = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  return slice.join("\n").trim()
}

/**
 * Run a remote command and fail with its captured output included when the
 * command exits unsuccessfully. Many install/bootstrap commands write their
 * most useful diagnostics to stdout rather than stderr (npm, pip, apt all
 * do this in common failure modes), so we surface both streams.
 */
async function runCheckedCommand(sandbox: Sandbox, command: string, cwd?: string): Promise<void> {
  const result = await sandbox.commands.run(command, { cwd })
  if (result.exitCode === 0) return

  const stderr = result.stderr.trim()
  const stdout = result.stdout.trim()
  const details = [
    `exit ${result.exitCode}`,
    stderr ? `stderr: ${stderr}` : undefined,
    stdout ? `stdout: ${stdout}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n")

  throw new Error(`Remote command failed: ${command}\n${details}`)
}

/**
 * Sleep helper used by the readiness poll.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalize unknown thrown values into a readable message string suitable for
 * embedding in structured logs or synthetic command results.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Quote a shell path for remote command execution.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
