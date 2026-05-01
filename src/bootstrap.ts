import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { sandboxBaseUrl, sandboxTargetHeaders } from "./e2b.js"
import { shellSingleQuote } from "./shared.js"
import { BOOTSTRAP_READY_MARKER, RUNTIME_ENV_FILE } from "./template.js"

/**
 * Absolute path inside the sandbox where the baked template's start command
 * redirects OpenCode output. Must stay in sync with template.ts.
 */
const START_COMMAND_LOG_PATH = "/tmp/opencode-serve.log"

/**
 * Prepare the uploaded project in the sandbox and release the baked
 * `opencode serve` process by touching the bootstrap-ready marker. The
 * managed template is responsible for launching opencode itself — this
 * function only arranges the preconditions and waits for the server to
 * become reachable.
 *
 * The env file must exist before the marker is written because the baked
 * command sources it once, immediately after the marker appears.
 */
export async function bootstrapWorkspace(params: {
  sandbox: Sandbox
  info: WorkspaceInfo
  config: NormalizedE2BWorkspaceConfig
  env: Record<string, string | undefined>
  logger?: PluginLogger
}): Promise<void> {
  await runPrepareCommands(params.sandbox, params.config)
  await ensureGitRepository(params.sandbox, params.info, params.config)
  await writeProjectMarker(params.sandbox, params.info, params.config)
  await writeRuntimeEnvFile(params.sandbox, params.env, params.logger)
  await signalBootstrapReady(params.sandbox, params.logger)
  await waitForServerReady(params.sandbox, params.config)
}

async function runPrepareCommands(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): Promise<void> {
  for (const command of config.bootstrap.prepareCommands) {
    if (!command.trim()) continue
    await runCheckedCommand(sandbox, command, config.projectPath)
  }
}

async function ensureGitRepository(
  sandbox: Sandbox,
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  const branch = info.branch ?? "main"
  const command = [
    `mkdir -p ${shellSingleQuote(config.projectPath)}`,
    `cd ${shellSingleQuote(config.projectPath)}`,
    `if [ ! -d .git ]; then git init -b ${shellSingleQuote(branch)}; fi`,
  ].join(" && ")

  await runCheckedCommand(sandbox, command)
}

async function writeProjectMarker(
  sandbox: Sandbox,
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  await sandbox.files.write(posix.join(config.projectPath, ".git", "opencode"), info.projectID)
}

async function writeRuntimeEnvFile(
  sandbox: Sandbox,
  env: Record<string, string | undefined>,
  logger?: PluginLogger,
): Promise<void> {
  await sandbox.files.write(RUNTIME_ENV_FILE, renderRuntimeEnvFile(env))

  await logger?.info("runtime env file written", {
    envPath: RUNTIME_ENV_FILE,
    keys: Object.keys(filterRuntimeEnv(env)),
  })
}

export function renderRuntimeEnvFile(env: Record<string, string | undefined>): string {
  const entries = Object.entries(filterRuntimeEnv(env))
  const lines = [
    "# Written by opencode-e2b bootstrap; sourced by the managed template start command.",
    "# Do not edit: regenerated on every workspace create.",
    ...entries.map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
    "",
  ]

  return lines.join("\n")
}

function filterRuntimeEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

async function signalBootstrapReady(sandbox: Sandbox, logger?: PluginLogger): Promise<void> {
  await sandbox.files.write(BOOTSTRAP_READY_MARKER, "")
  await logger?.info("bootstrap marker written", {
    markerPath: BOOTSTRAP_READY_MARKER,
  })
}

/**
 * Wait until the OpenCode server becomes reachable through the sandbox host.
 * The response body is cancelled each time so a custom readiness path cannot
 * leave a streaming response open across poll iterations.
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
    } finally {
      if (response && !response.bodyUsed) {
        await response.body?.cancel().catch(() => {})
      }
    }

    if (ready) return

    await sleep(750)
  }

  const tail = await readStartCommandLogTail(sandbox).catch(() => undefined)
  const suffix = tail
    ? `\nLast ${tail.split("\n").length} lines from ${START_COMMAND_LOG_PATH}:\n${tail}`
    : ""
  throw new Error(`Timed out waiting for OpenCode server at ${readyUrl.toString()}${suffix}`)
}

async function readStartCommandLogTail(sandbox: Sandbox): Promise<string | undefined> {
  const exists = await sandbox.files.exists(START_COMMAND_LOG_PATH)
  if (!exists) return undefined

  const content = await sandbox.files.read(START_COMMAND_LOG_PATH)
  const lines = content.split("\n")
  const maxLines = 40
  const slice = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  return slice.join("\n").trim()
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
