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
 */
const MINIMUM_SUPPORTED_RUNTIME_VERSION = "1.14.20"

let installedRuntimeVersionPromise: Promise<string> | undefined
let installedPluginVersionPromise: Promise<string> | undefined

const compatibilityCache = new Map<string, { localRuntimeVersion: string }>()

export function forgetSandboxCompatibility(sandboxId: string): void {
  compatibilityCache.delete(sandboxId)
}

/**
 * Resolve the local controller's OpenCode runtime version by probing the same
 * health endpoint used for remote sandboxes. The result is memoized, but a
 * failed probe clears the cache so the next lifecycle call can retry.
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

export async function resolveLocalPluginVersion(): Promise<string> {
  installedPluginVersionPromise ??= readInstalledPluginVersion().catch((error) => {
    installedPluginVersionPromise = undefined
    throw error
  })

  return installedPluginVersionPromise
}

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

function remoteHealthUrl(baseUrl: URL): URL {
  return new URL("/global/health", baseUrl)
}

async function readInstalledPluginVersion(): Promise<string> {
  const packageJsonUrl = new URL("../package.json", import.meta.url)
  const raw = await readFile(packageJsonUrl, "utf8")
  const payload = JSON.parse(raw) as Partial<{ version: unknown }>
  if (typeof payload.version !== "string" || payload.version.trim() === "") {
    throw new Error(`Invalid plugin package version in ${packageJsonUrl.pathname}`)
  }

  return payload.version
}
