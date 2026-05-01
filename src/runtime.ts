import { readFile } from "node:fs/promises"

import { Sandbox } from "e2b"

import { CURRENT_WORKSPACE_API_VERSION } from "./config.js"
import { errorMessage } from "./shared.js"
import type { PersistedWorkspaceCompatibility, PluginLogger, SandboxMetadataCompatibility } from "./types.js"

const HEALTH_TIMEOUT_MS = 1_500

/**
 * Inclusive OpenCode runtime floor below which this plugin refuses to load or
 * reuse sandboxes. Bumping this forces every running controller and every
 * cached sandbox to be re-validated after upgrade.
 *
 * `workspaceApiVersion` remains the true breaking-change gate; this floor is a
 * safety rail for too-old runtimes, not a compatibility contract.
 */
const MINIMUM_SUPPORTED_RUNTIME_VERSION = "1.14.20"

let installedRuntimeVersionPromise: Promise<string> | undefined
let installedPluginVersionPromise: Promise<string> | undefined

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
 * The resolved version is memoized for the process lifetime. A failure,
 * including a controller version below the supported floor, clears the cache so
 * the next call re-probes the controller.
 */
export async function resolveLocalRuntimeVersion(serverUrl: URL, logger?: PluginLogger): Promise<string> {
  installedRuntimeVersionPromise ??= fetchRemoteRuntimeHealth(serverUrl, {
    target: "local-controller",
    logger,
  })
    .then((health) => {
      assertRuntimeMeetsFloor(health.version, MINIMUM_SUPPORTED_RUNTIME_VERSION, "local controller")
      return health.version
    })
    .catch((error) => {
      installedRuntimeVersionPromise = undefined
      throw error
    })

  return installedRuntimeVersionPromise
}

/**
 * Read this plugin's own package version from the local package.json. The
 * value is memoized for the process lifetime and fed into the managed-template
 * alias hash so a plugin release can intentionally force a rebuild even when
 * the pinned OpenCode runtime version is unchanged.
 */
export async function resolveLocalPluginVersion(): Promise<string> {
  installedPluginVersionPromise ??= readInstalledPluginVersion().catch((error) => {
    installedPluginVersionPromise = undefined
    throw error
  })

  return installedPluginVersionPromise
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
async function probeRemoteRuntimeVersion(params: {
  baseUrl: URL
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
 * Fail fast when the current plugin cannot safely interpret or reuse a sandbox.
 * `workspaceApiVersion` remains the breaking-change gate; the runtime floor is
 * a backstop that rejects too-old controllers or sandboxes.
 */
export async function assertWorkspaceCompatibility(params: {
  workspaceID: string
  localRuntimeVersion: string
  persistedCompatibility: PersistedWorkspaceCompatibility
  sandboxCompatibility: SandboxMetadataCompatibility
  sandbox: Sandbox
  baseUrl: URL
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
    logger: undefined,
    headers: params.headers,
  })
  assertRuntimeMeetsFloor(remoteRuntimeVersion, MINIMUM_SUPPORTED_RUNTIME_VERSION, "remote sandbox")

  compatibilityCache.set(params.sandbox.sandboxId, {
    localRuntimeVersion: params.localRuntimeVersion,
  })
}

/**
 * Parse a runtime version into its numeric semver triple, ignoring prerelease
 * and build metadata while rejecting non-semver strings.
 */
function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (!match) {
    throw new Error("version must begin with numeric MAJOR.MINOR.PATCH")
  }

  const [, major, minor, patch, suffix] = match
  if (suffix.length > 0 && !suffix.startsWith("-") && !suffix.startsWith("+")) {
    throw new Error("version must begin with numeric MAJOR.MINOR.PATCH")
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  }
}

/**
 * Return whether a runtime version's numeric semver triple is at or above the
 * configured floor.
 */
export function meetsRuntimeFloor(version: string, floor: string): boolean {
  const parsedVersion = parseSemver(version)
  const parsedFloor = parseSemver(floor)

  if (parsedVersion.major !== parsedFloor.major) {
    return parsedVersion.major > parsedFloor.major
  }
  if (parsedVersion.minor !== parsedFloor.minor) {
    return parsedVersion.minor > parsedFloor.minor
  }
  return parsedVersion.patch >= parsedFloor.patch
}

/**
 * Assert that either the local controller or a remote sandbox is running an
 * OpenCode version at or above the supported floor.
 */
function assertRuntimeMeetsFloor(
  version: string,
  floor: string,
  side: "local controller" | "remote sandbox",
): void {
  try {
    if (meetsRuntimeFloor(version, floor)) {
      return
    }
  } catch (error) {
    throw new Error(`Failed to parse ${side} OpenCode version "${version}": ${errorMessage(error)}`)
  }

  throw new Error(
    `${side} is running OpenCode ${version}, which is below the minimum supported ${floor}. Upgrade the ${side} to continue using the e2b workspace plugin.`,
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

/**
 * Read and validate this package's declared version from package.json.
 */
async function readInstalledPluginVersion(): Promise<string> {
  const packageJsonUrl = new URL("../package.json", import.meta.url)
  const raw = await readFile(packageJsonUrl, "utf8")
  const payload = JSON.parse(raw) as Partial<{ version: unknown }>
  if (typeof payload.version !== "string" || payload.version.trim() === "") {
    throw new Error(`Invalid plugin package version in ${packageJsonUrl.pathname}`)
  }

  return payload.version
}
