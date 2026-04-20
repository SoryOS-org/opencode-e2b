import { Sandbox } from "e2b"

import { CURRENT_WORKSPACE_API_VERSION } from "./config.js"
import type {
  PersistedWorkspaceContract,
  PluginLogger,
  SandboxMetadataContract,
} from "./types.js"

const GLOBAL_HEALTH_PATH = "/global/health"
const HEALTH_TIMEOUT_MS = 1_500

/**
 * Process-local cache of sandbox IDs that have already been confirmed
 * compatible with the current local OpenCode controller. Entries are keyed by
 * sandbox ID and track the local runtime version they were proven against, so
 * a controller upgrade during the same process naturally re-probes instead of
 * trusting a stale positive result.
 *
 * Compatibility is a deterministic function of (sandbox metadata, sandbox's
 * running OpenCode version, local controller version). None of those can
 * change without going through create or restart, so caching positive results
 * for the process lifetime is safe. Negative results are never cached because
 * they throw before we'd reach the cache insertion.
 */
const compatibilityCache = new Map<string, { localRuntimeVersion: string }>()

/**
 * Invalidate the compatibility cache entry for a sandbox ID. Call this
 * whenever the sandbox is killed or replaced so that a fresh sandbox
 * created with the same ID (rare but possible across provider churn) is
 * re-validated from scratch.
 */
export function forgetSandboxCompatibility(sandboxId: string): void {
  compatibilityCache.delete(sandboxId)
}

/**
 * Resolve the version of the currently running local OpenCode server.
 */
export async function resolveLocalRuntimeVersion(serverUrl: URL, logger?: PluginLogger): Promise<string> {
  const health = await fetchRuntimeHealth(serverUrl, { logger, target: "local-controller" })
  return health.version
}

/**
 * Probe the actual OpenCode version running inside the sandbox. The server
 * health endpoint is preferred, with a CLI fallback in case the server is up
 * but not yet exposing the health shape we expect. When the sandbox gateway
 * requires an access token (`secure: true`) the caller passes it via
 * `headers` so the HTTPS round-trip isn't rejected at the edge.
 */
export async function probeRemoteRuntimeVersion(params: {
  baseUrl: URL
  sandbox: Sandbox
  projectPath: string
  logger?: PluginLogger
  headers?: Record<string, string>
}): Promise<string> {
  try {
    const health = await fetchRuntimeHealth(params.baseUrl, {
      logger: params.logger,
      target: "remote-workspace",
      headers: params.headers,
    })
    return health.version
  } catch (healthError) {
    try {
      return await probeRemoteCliVersion(params.sandbox, params.projectPath)
    } catch (cliError) {
      const healthMessage = errorMessage(healthError)
      const cliMessage = errorMessage(cliError)
      throw new Error(
        `Failed to determine remote OpenCode version from ${new URL(GLOBAL_HEALTH_PATH, params.baseUrl)} or \`opencode --version\`: ${healthMessage}; ${cliMessage}`,
      )
    }
  }
}

/**
 * Fail fast when the current plugin cannot safely interpret or reuse a sandbox
 * created under a different workspace contract or OpenCode runtime version.
 */
export async function assertWorkspaceCompatibility(params: {
  workspaceID: string
  localRuntimeVersion: string
  persistedContract: PersistedWorkspaceContract
  sandboxContract: SandboxMetadataContract
  sandbox: Sandbox
  baseUrl: URL
  projectPath: string
  headers?: Record<string, string>
}): Promise<void> {
  const declaredApiVersion = params.sandboxContract.workspaceApiVersion ?? params.persistedContract.workspaceApiVersion
  if (declaredApiVersion !== CURRENT_WORKSPACE_API_VERSION) {
    throw new Error(
      `Workspace ${params.workspaceID} uses workspace API ${declaredApiVersion}, but this plugin expects ${CURRENT_WORKSPACE_API_VERSION}`,
    )
  }

  // Short-circuit repeated probes for a sandbox that this process already
  // validated against the current local controller. `target()` is called
  // frequently (sync loop, session restore, proxy paths), so skipping the
  // remote round-trip here is the biggest win of the cache.
  const cached = compatibilityCache.get(params.sandbox.sandboxId)
  if (cached && cached.localRuntimeVersion === params.localRuntimeVersion) {
    return
  }

  const remoteRuntimeVersion = await probeRemoteRuntimeVersion({
    baseUrl: params.baseUrl,
    sandbox: params.sandbox,
    projectPath: params.projectPath,
    logger: undefined,
    headers: params.headers,
  })
  if (remoteRuntimeVersion === params.localRuntimeVersion) {
    compatibilityCache.set(params.sandbox.sandboxId, {
      localRuntimeVersion: params.localRuntimeVersion,
    })
    return
  }

  const declaredRuntimeVersion = params.sandboxContract.runtimeVersion ?? params.persistedContract.runtimeVersion
  const declaredFlags = params.sandboxContract.flags.length ? params.sandboxContract.flags : params.persistedContract.flags
  const declaredRuntimeClause = declaredRuntimeVersion
    ? ` Sandbox metadata recorded ${declaredRuntimeVersion}.`
    : ""
  const flagsClause = declaredFlags.length ? ` Flags: ${declaredFlags.join(", ")}.` : ""

  throw new Error(
    `Workspace ${params.workspaceID} is running OpenCode ${remoteRuntimeVersion}, but the local controller is ${params.localRuntimeVersion}.${declaredRuntimeClause}${flagsClause}`,
  )
}

/**
 * Fetch the OpenCode health payload from a local or remote server URL.
 */
async function fetchRuntimeHealth(
  baseUrl: URL,
  options?: {
    logger?: PluginLogger
    target: string
    headers?: Record<string, string>
  },
): Promise<{ healthy: true; version: string }> {
  const healthUrl = new URL(GLOBAL_HEALTH_PATH, baseUrl)
  const startedAt = Date.now()

  await options?.logger?.info("runtime health probe start", {
    target: options.target,
    healthUrl: healthUrl.toString(),
    timeoutMs: HEALTH_TIMEOUT_MS,
  })

  try {
    const response = await fetch(healthUrl, {
      headers: options?.headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Health check failed with status ${response.status}`)
    }

    const payload = (await response.json()) as Partial<{ healthy: boolean; version: unknown }>
    if (payload.healthy !== true || typeof payload.version !== "string") {
      throw new Error(`Unexpected health payload from ${healthUrl}`)
    }

    await options?.logger?.info("runtime health probe success", {
      target: options.target,
      healthUrl: healthUrl.toString(),
      durationMs: Date.now() - startedAt,
      version: payload.version,
    })

    return {
      healthy: true,
      version: payload.version,
    }
  } catch (error) {
    await options?.logger?.error("runtime health probe failed", {
      target: options.target,
      healthUrl: healthUrl.toString(),
      timeoutMs: HEALTH_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    })
    throw error
  }
}

/**
 * Fallback runtime probe that shells into the sandbox when the remote server is
 * reachable but does not expose the expected health payload.
 */
async function probeRemoteCliVersion(sandbox: Sandbox, projectPath: string): Promise<string> {
  const result = await sandbox.commands.run("opencode --version", {
    cwd: projectPath,
  })
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    throw new Error(stderr || "Remote version command failed")
  }

  const version = extractVersion(result.stdout)
  if (!version) {
    throw new Error(`Could not parse remote OpenCode version from ${JSON.stringify(result.stdout.trim())}`)
  }

  return version
}

/**
 * Extract a semver-like version from the command output.
 */
function extractVersion(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][^\s]+)?\b/)
  return match?.[0]
}

/**
 * Normalize unknown thrown values into a readable message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
