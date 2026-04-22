import { Sandbox } from "e2b"

import { CURRENT_WORKSPACE_API_VERSION } from "./config.js"
import { errorMessage } from "./shared.js"
import type {
  PersistedWorkspaceCompatibility,
  PluginLogger,
  SandboxMetadataCompatibility,
} from "./types.js"

const HEALTH_TIMEOUT_MS = 1_500
let installedRuntimeVersionPromise: Promise<string> | undefined

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
 * Resolve the local controller's OpenCode runtime version by probing the same
 * health endpoint the plugin already uses for remote sandboxes. Reading a
 * declared dependency from this package can drift from the running controller
 * under bundling or dev-linked installs, while `serverUrl` reflects the actual
 * local binary backing the current OpenCode process.
 *
 * Paired with `probeRemoteRuntimeVersion` which reaches out to the sandbox's
 * health endpoint — together they produce the (local, remote) pair that
 * drives the compatibility check.
 *
 * The resolved version is memoized for the process lifetime. A failure
 * clears the cache so the next call re-probes the controller.
 */
export async function resolveLocalRuntimeVersion(
  serverUrl: URL,
  logger?: PluginLogger,
): Promise<string> {
  installedRuntimeVersionPromise ??= fetchRemoteRuntimeHealth(serverUrl, {
    target: "local-controller",
    logger,
  }).then((health) => health.version).catch((error) => {
    installedRuntimeVersionPromise = undefined
    throw error
  })

  return installedRuntimeVersionPromise
}

/**
 * Probe the actual OpenCode version running inside the sandbox via the same
 * `/global/health` endpoint used for local controller detection. `create`
 * already gates on that endpoint before a workspace reaches `target()`, so any
 * sandbox that survives to this check is expected to be health-responsive.
 * When the sandbox gateway requires an access token (`secure: true`) the
 * caller passes it via `headers` so the HTTPS round-trip isn't rejected at the
 * edge.
 */
export async function probeRemoteRuntimeVersion(params: {
  baseUrl: URL
  sandbox: Sandbox
  projectPath: string
  logger?: PluginLogger
  headers?: Record<string, string>
}): Promise<string> {
  const health = await fetchRemoteRuntimeHealth(params.baseUrl, {
    logger: params.logger,
    target: "remote-workspace",
    headers: params.headers,
  })
  return health.version
}

/**
 * Fail fast when the current plugin cannot safely interpret or reuse a sandbox
 * created under a different workspace compatibility model or OpenCode runtime
 * version.
 */
export async function assertWorkspaceCompatibility(params: {
  workspaceID: string
  localRuntimeVersion: string
  persistedCompatibility: PersistedWorkspaceCompatibility
  sandboxCompatibility: SandboxMetadataCompatibility
  sandbox: Sandbox
  baseUrl: URL
  projectPath: string
  headers?: Record<string, string>
}): Promise<void> {
  const declaredApiVersion =
    params.sandboxCompatibility.workspaceApiVersion ?? params.persistedCompatibility.workspaceApiVersion
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

  const declaredRuntimeVersion =
    params.sandboxCompatibility.runtimeVersion ?? params.persistedCompatibility.runtimeVersion
  const declaredFlags =
    params.sandboxCompatibility.flags.length ? params.sandboxCompatibility.flags : params.persistedCompatibility.flags
  const declaredRuntimeClause = declaredRuntimeVersion
    ? ` Sandbox metadata recorded ${declaredRuntimeVersion}.`
    : ""
  const flagsClause = declaredFlags.length ? ` Flags: ${declaredFlags.join(", ")}.` : ""

  throw new Error(
    `Workspace ${params.workspaceID} is running OpenCode ${remoteRuntimeVersion}, but the local controller is ${params.localRuntimeVersion}.${declaredRuntimeClause}${flagsClause}`,
  )
}

/**
 * Fetch the OpenCode health payload from a remote workspace URL.
 */
async function fetchRemoteRuntimeHealth(
  baseUrl: URL,
  options?: {
    logger?: PluginLogger
    target: string
    headers?: Record<string, string>
  },
): Promise<{ healthy: true; version: string }> {
  const healthUrl = remoteHealthUrl(baseUrl)
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
 * Build the remote workspace health endpoint URL from its base server URL.
 */
function remoteHealthUrl(baseUrl: URL): URL {
  return new URL("/global/health", baseUrl)
}

