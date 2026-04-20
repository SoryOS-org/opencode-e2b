import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig } from "./types.js"
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
}): Promise<void> {
  await ensureGitRepository(params.sandbox, params.info, params.config)
  await writeProjectMarker(params.sandbox, params.info, params.config)
  await runBootstrapCommands(params.sandbox, params.config)
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
async function runBootstrapCommands(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): Promise<void> {
  for (const command of config.bootstrap.prepareCommands) {
    if (!command.trim()) continue
    await runCheckedCommand(sandbox, command, config.projectPath)
  }

  if (config.bootstrap.installCommand.trim()) {
    await runCheckedCommand(sandbox, config.bootstrap.installCommand, config.projectPath)
  }

  if (!config.bootstrap.startCommand.trim()) {
    throw new Error("Missing bootstrap.startCommand for E2B workspace")
  }

  const startCommand = config.bootstrap.startCommand.replaceAll("${PORT}", String(config.serverPort))
  // Redirect both stdout and stderr to a well-known log path inside the
  // sandbox so that if readiness times out we can fetch a tail and embed it
  // in the error message. Using `sh -c` keeps the redirection intact while
  // still running the command in the background. START_COMMAND_LOG_PATH is a
  // hardcoded constant without shell metacharacters, so no further escaping
  // is needed for the redirection target itself.
  const supervisedCommand = `sh -c ${shellQuote(`${startCommand} >${START_COMMAND_LOG_PATH} 2>&1`)}`
  await sandbox.commands.run(supervisedCommand, {
    cwd: config.projectPath,
    background: true,
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
 * Quote a shell path for remote command execution.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
