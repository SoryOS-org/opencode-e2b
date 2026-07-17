import { posix } from "node:path"

import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { sandboxBaseUrl, sandboxTargetHeaders } from "./e2b.js"
import { normalizePosixPath, shellSingleQuote } from "./shared.js"
import { BOOTSTRAP_READY_MARKER, RUNTIME_ENV_FILE } from "./template.js"

const SYSTEMD_SERVICE_NAME = "opencode-e2b.service"
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  localDirectory?: string
  logger?: PluginLogger
}): Promise<void> {
  await runBootstrapCommands(params.sandbox, params.info, params.config, params.localDirectory)
  await writeProjectMarker(params.sandbox, params.info, params.config)
  await writeRuntimeEnvFile(params.sandbox, params.env, params.logger)
  await signalBootstrapReady(params.sandbox, params.logger)
  await waitForServerReady(params.sandbox, params.config, params.logger)
  await waitForSyncReady(params.sandbox, params.config, params.logger)
}

async function runBootstrapCommands(
  sandbox: Sandbox,
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  localDirectory?: string,
): Promise<void> {
  await runCheckedCommand(sandbox, buildBootstrapCommand(info, config, localDirectory))
}

export function buildBootstrapCommand(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  localDirectory?: string,
): string {
  const branch = info.branch ?? "main"
  const commands = [
    `mkdir -p ${shellSingleQuote(config.projectPath)}`,
    // A warped session keeps its local directory; opencode resolves that path
    // on the remote, so mirror it onto the project (else prompts ENOENT).
    ...buildMirrorPathCommands(localDirectory, config.projectPath),
    `cd ${shellSingleQuote(config.projectPath)}`,
    ...config.bootstrap.prepareCommands
      .map((command) => command.trim())
      .filter(Boolean)
      .map((command) => `(${command})`),
    `if [ ! -d .git ]; then git init -b ${shellSingleQuote(branch)}; fi`,
  ]

  return commands.join(" && ")
}

/**
 * Make the local project path resolvable inside a sandbox by (re)creating the
 * mirror symlink. The commands are idempotent (`mkdir -p` + `ln -sfn`), so
 * this is safe to run on every reuse — it is how sandboxes provisioned before
 * the mirror existed (or before the local project moved) pick it up without a
 * destructive replace.
 */
export async function ensureMirroredLocalPath(
  sandbox: Sandbox,
  localDirectory: string | undefined,
  projectPath: string,
  logger?: PluginLogger,
): Promise<void> {
  const commands = buildMirrorPathCommands(localDirectory, projectPath)
  if (commands.length === 0) {
    if (localDirectory && localDirectory !== projectPath) {
      // Nested or root paths are deliberately not mirrored; say so instead of
      // leaving a warped session's ENOENT unexplained.
      await logger?.warn("local path mirror skipped", { localDirectory, projectPath })
    }
    return
  }
  await runCheckedCommand(sandbox, commands.join(" && "))
}

// sudo because the local path may live outside $HOME (e.g. macOS `/Users/...`).
function buildMirrorPathCommands(localDirectory: string | undefined, projectPath: string): string[] {
  if (!localDirectory) return []
  // Normalize before comparing: a trailing-slash variant of projectPath would
  // otherwise plant a self-referential symlink inside the repo, and mirroring
  // an ancestor/descendant of projectPath makes `ln` replace a real directory
  // (failing the whole provision) or shadow part of the project tree.
  const local = normalizePosixPath(localDirectory)
  const project = normalizePosixPath(projectPath)
  if (local === project || local === "/") return []
  if (project.startsWith(`${local}/`) || local.startsWith(`${project}/`)) return []
  const parent = posix.dirname(local)
  const commands = [`sudo ln -sfn ${shellSingleQuote(project)} ${shellSingleQuote(local)}`]
  if (parent && parent !== "." && parent !== "/") {
    commands.unshift(`sudo mkdir -p ${shellSingleQuote(parent)}`)
  }
  return commands
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
    "# Written by opencode-e2b bootstrap; sourced by the managed template systemd service.",
    "# Do not edit: regenerated on every workspace create.",
    ...entries.map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
    "",
  ]

  return lines.join("\n")
}

function filterRuntimeEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => SHELL_IDENTIFIER.test(entry[0]) && typeof entry[1] === "string",
    ),
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
async function waitForServerReady(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
): Promise<void> {
  const baseUrl = sandboxBaseUrl(sandbox, config)
  const readyUrl = new URL(config.bootstrap.waitForPath, baseUrl)
  const headers = sandboxTargetHeaders(sandbox, config)
  const startedAt = Date.now()
  let attempts = 0

  while (Date.now() - startedAt < config.bootstrap.waitForTimeoutMs) {
    attempts += 1
    let response: Response | undefined
    let ready = false
    try {
      response = await fetch(readyUrl, {
        headers,
        signal: AbortSignal.timeout(1_500),
      })
      ready = response.ok
    } catch {
      // Retry transient startup failures until the readiness timeout expires.
    } finally {
      await cancelUnusedBody(response)
    }

    if (ready) {
      await logger?.info("remote opencode health ready", {
        url: readyUrl.toString(),
        attempts,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    await sleep(750)
  }

  const tail = await readServiceJournalTail(sandbox).catch(() => undefined)
  const suffix = tail
    ? `\nLast ${tail.split("\n").length} journal lines from ${SYSTEMD_SERVICE_NAME}:\n${tail}`
    : ""
  throw new Error(`Timed out waiting for OpenCode server at ${readyUrl.toString()}${suffix}`)
}

/**
 * The local control plane gates proxied mutation responses on sync fences from
 * the remote runtime. Treat the sandbox as ready only after both the persistent
 * event stream and history sync endpoint are reachable.
 */
export async function waitForSyncReady(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
): Promise<void> {
  const baseUrl = sandboxBaseUrl(sandbox, config)
  const headers = sandboxTargetHeaders(sandbox, config)
  const eventUrl = new URL("/global/event", baseUrl)
  const historyUrl = new URL("/sync/history", baseUrl)
  const startedAt = Date.now()
  let attempts = 0

  while (Date.now() - startedAt < config.bootstrap.waitForTimeoutMs) {
    attempts += 1
    try {
      await probeEventStream(eventUrl, headers)
      await probeSyncHistory(historyUrl, headers)
      await logger?.info("remote opencode sync ready", {
        eventUrl: eventUrl.toString(),
        historyUrl: historyUrl.toString(),
        attempts,
        durationMs: Date.now() - startedAt,
      })
      return
    } catch {
      await sleep(750)
    }
  }

  const tail = await readServiceJournalTail(sandbox).catch(() => undefined)
  const suffix = tail
    ? `\nLast ${tail.split("\n").length} journal lines from ${SYSTEMD_SERVICE_NAME}:\n${tail}`
    : ""
  throw new Error(`Timed out waiting for OpenCode sync endpoints at ${baseUrl.toString()}${suffix}`)
}

async function probeEventStream(url: URL, headers: HeadersInit | undefined): Promise<void> {
  let response: Response | undefined
  try {
    response = await fetch(url, {
      headers: {
        ...headersToObject(headers),
        accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) throw new Error(`event stream returned HTTP ${response.status}`)

    const contentType = response.headers.get("content-type")
    if (contentType && !contentType.toLowerCase().includes("text/event-stream")) {
      throw new Error(`event stream returned ${contentType}`)
    }
  } finally {
    await cancelUnusedBody(response)
  }
}

async function probeSyncHistory(url: URL, headers: HeadersInit | undefined): Promise<void> {
  let response: Response | undefined
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...headersToObject(headers),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) throw new Error(`sync history returned HTTP ${response.status}`)
  } finally {
    await cancelUnusedBody(response)
  }
}

/**
 * Cancel a fetch response body that was never read, so a probe cannot leave a
 * streaming response open. Safe to call with an undefined or already-used body.
 */
async function cancelUnusedBody(response: Response | undefined): Promise<void> {
  if (response && !response.bodyUsed) {
    await response.body?.cancel().catch(() => {})
  }
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}

  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    result[key] = value
  })
  return result
}

async function readServiceJournalTail(sandbox: Sandbox): Promise<string | undefined> {
  const command = `sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -n 80 --no-pager -o cat`
  const result = await sandbox.commands.run(command)
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (result.exitCode === 0 && stdout) return stdout
  if (stdout || stderr) return [stdout, stderr].filter(Boolean).join("\n")
  return undefined
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
