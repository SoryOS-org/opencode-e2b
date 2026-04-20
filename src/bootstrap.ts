import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { sandboxBaseUrl, sandboxTargetHeaders } from "./e2b.js"
import { BOOTSTRAP_READY_MARKER } from "./template.js"

/**
 * Absolute path inside the sandbox where the baked template's start command
 * redirects the running OpenCode server's combined stdout+stderr. We read
 * from here on readiness-check failure so the user can see the actual server
 * error instead of just a generic timeout. Must stay in sync with the
 * template.ts constant of the same name.
 */
const START_COMMAND_LOG_PATH = "/tmp/opencode-serve.log"

/**
 * Prepare the uploaded project in the sandbox and release the baked
 * `opencode serve` process by touching the bootstrap-ready marker. The
 * managed template is responsible for launching opencode itself — this
 * function only arranges the preconditions and waits for the server to
 * become reachable.
 */
export async function bootstrapWorkspace(params: {
  sandbox: Sandbox
  info: WorkspaceInfo
  config: NormalizedE2BWorkspaceConfig
  runtimeVersion: string
  logger?: PluginLogger
}): Promise<void> {
  void params.runtimeVersion
  await runPrepareCommands(params.sandbox, params.config)
  await ensureGitRepository(params.sandbox, params.info, params.config)
  await writeProjectMarker(params.sandbox, params.info, params.config)
  await signalBootstrapReady(params.sandbox, params.logger)
  await waitForServerReady(params.sandbox, params.config)
}

/**
 * Run the user-configured prepare commands before signaling the baked
 * runtime to start. These remain the supported extension point for
 * workspace-specific setup (env setup, dependency installs, filesystem
 * seeding) that has to happen after upload but before opencode boots.
 *
 * Note that `bootstrap.installCommand` and `bootstrap.startCommand` are no
 * longer part of the runtime flow: the pinned controller is installed at
 * template build time and launched by the template's baked start command.
 * Any values users set for those fields are validated by config.ts but
 * otherwise ignored — config.ts logs a deprecation warning at normalization.
 */
async function runPrepareCommands(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  for (const command of config.bootstrap.prepareCommands) {
    if (!command.trim()) continue
    await runCheckedCommand(sandbox, command, config.projectPath)
  }
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
 * Release the baked start command by creating the bootstrap-ready marker.
 * The template's init script polls this file path every 250ms and `exec`s
 * opencode as soon as it exists, so creating the marker is the single
 * handoff between per-workspace provisioning and server start.
 */
async function signalBootstrapReady(sandbox: Sandbox, logger?: PluginLogger): Promise<void> {
  // Write an empty file rather than touching via shell to avoid depending on
  // a specific shell being on PATH in exotic base images.
  await sandbox.files.write(BOOTSTRAP_READY_MARKER, "")
  await logger?.info("bootstrap marker written", {
    markerPath: BOOTSTRAP_READY_MARKER,
  })
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
  // the baked start command's combined stdout/stderr log so the user sees the
  // actual startup error (port conflict, crashed subprocess, template misconfig,
  // etc.) instead of a generic timeout.
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
 * Quote a shell path for remote command execution.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
