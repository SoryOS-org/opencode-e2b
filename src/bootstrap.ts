import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig } from "./types.js"
import { sandboxBaseUrl, sandboxTargetHeaders } from "./e2b.js"

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
  await sandbox.commands.run(startCommand, {
    cwd: config.projectPath,
    background: true,
  })
}

/**
 * Wait until the OpenCode server becomes reachable through the sandbox host.
 * The default readiness path is `/global/event`, which should respond as soon
 * as the server accepts the SSE connection.
 */
async function waitForServerReady(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): Promise<void> {
  const baseUrl = sandboxBaseUrl(sandbox, config)
  const readyUrl = new URL(config.bootstrap.waitForPath, baseUrl)
  const headers = sandboxTargetHeaders(sandbox, config)
  const startedAt = Date.now()

  while (Date.now() - startedAt < config.bootstrap.waitForTimeoutMs) {
    try {
      const response = await fetch(readyUrl, {
        headers,
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) {
        return
      }
    } catch {
      // Ignore transient startup errors until the timeout expires.
    }

    await sleep(750)
  }

  throw new Error(`Timed out waiting for OpenCode server at ${readyUrl.toString()}`)
}

/**
 * Run a remote command and fail with stderr included when the command exits
 * unsuccessfully.
 */
async function runCheckedCommand(sandbox: Sandbox, command: string, cwd?: string): Promise<void> {
  const result = await sandbox.commands.run(command, { cwd })
  if (result.exitCode === 0) return

  const stderr = result.stderr.trim()
  throw new Error(stderr ? `Remote command failed: ${stderr}` : `Remote command failed: ${command}`)
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
