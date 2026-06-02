import type { WorkspaceInfo } from "@opencode-ai/plugin"

import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceCompatibility,
  PersistedWorkspaceExtra,
  PluginLogger,
} from "./types.js"
import { DEFAULT_TEMPLATE_GC_COOLDOWN_MS, DEFAULT_TEMPLATE_GC_TTL_MS, MIN_TEMPLATE_GC_TTL_MS } from "./gc.js"

export { validatePluginOptions } from "./config-validate.js"

export const CURRENT_WORKSPACE_API_VERSION = "1"
const DEFAULT_NODE_VARIANT = "22-slim"

const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".DS_Store",
] as const

export function normalizeOptions(options?: E2BWorkspacePluginOptions): NormalizedE2BWorkspaceConfig {
  const sandboxTimeoutMs =
    requirePositiveInteger(options?.sandboxTimeoutMs, "sandboxTimeoutMs") ?? 60 * 60 * 1000
  const serverPort = requirePositiveInteger(options?.serverPort, "serverPort") ?? 4096
  const waitForTimeoutMs =
    requirePositiveInteger(options?.bootstrap?.waitForTimeoutMs, "bootstrap.waitForTimeoutMs") ?? 30_000
  const batchSize = requirePositiveInteger(options?.upload?.batchSize, "upload.batchSize") ?? 100
  const templateGcTtlMs = Math.max(
    requirePositiveInteger(options?.templateGc?.ttlMs, "templateGc.ttlMs") ?? DEFAULT_TEMPLATE_GC_TTL_MS,
    MIN_TEMPLATE_GC_TTL_MS,
  )
  const templateGcCooldownMs =
    requirePositiveInteger(options?.templateGc?.cooldownMs, "templateGc.cooldownMs") ??
    DEFAULT_TEMPLATE_GC_COOLDOWN_MS

  const config = {
    workspaceApiVersion: CURRENT_WORKSPACE_API_VERSION,
    nodeVariant: options?.nodeVariant ?? DEFAULT_NODE_VARIANT,
    sandboxTimeoutMs,
    projectPath: options?.projectPath ?? "/home/user/project",
    serverPort,
    secure: options?.secure ?? true,
    network: {
      allowPublicTraffic: options?.network?.allowPublicTraffic ?? true,
      allowOut: options?.network?.allowOut ?? [],
      denyOut: options?.network?.denyOut ?? [],
      maskRequestHost: options?.network?.maskRequestHost ?? "",
    },
    bootstrap: {
      prepareCommands: options?.bootstrap?.prepareCommands ?? [],
      installCommand: options?.bootstrap?.installCommand ?? "",
      startCommand: options?.bootstrap?.startCommand ?? "",
      waitForPath: options?.bootstrap?.waitForPath ?? "/global/health",
      waitForTimeoutMs,
    },
    upload: {
      ignore: options?.upload?.ignore ?? [...DEFAULT_IGNORE],
      includeDotGit: options?.upload?.includeDotGit ?? false,
      batchSize,
      followSymlinks: options?.upload?.followSymlinks ?? false,
    },
    templateGc: {
      enabled: options?.templateGc?.enabled !== false,
      ttlMs: templateGcTtlMs,
      cooldownMs: templateGcCooldownMs,
    },
    metadata: options?.metadata ?? {},
    flags: [] as string[],
  } satisfies NormalizedE2BWorkspaceConfig

  return {
    ...config,
    flags: buildWorkspaceFlags(config),
  }
}

export async function warnDeprecatedBootstrapOptions(
  options: E2BWorkspacePluginOptions | undefined,
  logger: PluginLogger | undefined,
): Promise<void> {
  const installCommand = options?.bootstrap?.installCommand?.trim()
  const startCommand = options?.bootstrap?.startCommand?.trim()

  if (installCommand) {
    await logger?.warn(
      "bootstrap.installCommand is deprecated and ignored; opencode is installed during managed-template build.",
      {
        installCommand,
      },
    )
  }

  if (startCommand) {
    await logger?.warn(
      "bootstrap.startCommand is deprecated and ignored; the managed template runs a marker-gated systemd service.",
      {
        startCommand,
      },
    )
  }
}

export function buildPersistedExtra(
  config: NormalizedE2BWorkspaceConfig,
  runtimeVersion: string,
): PersistedWorkspaceExtra {
  return {
    e2b: {
      workspaceApiVersion: config.workspaceApiVersion,
      runtimeVersion,
      flags: config.flags,
      nodeVariant: config.nodeVariant,
      projectPath: config.projectPath,
      serverPort: config.serverPort,
      secure: config.secure,
      metadata: config.metadata,
    },
  }
}

export function resolveWorkspaceConfig(
  info: WorkspaceInfo,
  options?: E2BWorkspacePluginOptions,
): NormalizedE2BWorkspaceConfig {
  const normalized = normalizeOptions(options)
  const extra = readPersistedExtra(info)
  if (!extra) return normalized

  return {
    ...normalized,
    workspaceApiVersion: extra.e2b.workspaceApiVersion,
    nodeVariant: extra.e2b.nodeVariant,
    projectPath: extra.e2b.projectPath,
    serverPort: extra.e2b.serverPort,
    secure: extra.e2b.secure,
    flags: extra.e2b.flags,
    metadata: {
      ...normalized.metadata,
      ...extra.e2b.metadata,
    },
  }
}

export function resolveWorkspaceCompatibility(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  runtimeVersion: string,
): PersistedWorkspaceCompatibility {
  const extra = readPersistedExtra(info)
  if (!extra) {
    return buildFreshCompatibility(config, runtimeVersion)
  }

  return {
    workspaceApiVersion: extra.e2b.workspaceApiVersion,
    runtimeVersion: extra.e2b.runtimeVersion,
    flags: extra.e2b.flags,
  }
}

export function buildFreshCompatibility(
  config: NormalizedE2BWorkspaceConfig,
  runtimeVersion: string,
): PersistedWorkspaceCompatibility {
  return {
    workspaceApiVersion: config.workspaceApiVersion,
    runtimeVersion,
    flags: config.flags,
  }
}

export function defaultWorkspaceName(info: WorkspaceInfo): string {
  const branchPart = info.branch?.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const suffix = info.id.slice(-6)
  return branchPart ? `e2b-${branchPart}` : `e2b-${suffix}`
}

function readPersistedExtra(info: WorkspaceInfo): PersistedWorkspaceExtra | undefined {
  if (!info.extra || typeof info.extra !== "object") return undefined

  const candidate = info.extra as Partial<PersistedWorkspaceExtra>
  if (!candidate.e2b) return undefined
  if (typeof candidate.e2b.workspaceApiVersion !== "string") return undefined
  if (typeof candidate.e2b.runtimeVersion !== "string") return undefined
  if (!Array.isArray(candidate.e2b.flags) || !candidate.e2b.flags.every((flag) => typeof flag === "string")) {
    return undefined
  }
  if (typeof candidate.e2b.nodeVariant !== "string") return undefined
  if (typeof candidate.e2b.projectPath !== "string") return undefined
  if (typeof candidate.e2b.serverPort !== "number") return undefined
  if (typeof candidate.e2b.secure !== "boolean") return undefined
  if (!candidate.e2b.metadata || typeof candidate.e2b.metadata !== "object") return undefined

  return candidate as PersistedWorkspaceExtra
}

function buildWorkspaceFlags(config: Omit<NormalizedE2BWorkspaceConfig, "flags">): string[] {
  const flags = new Set<string>(["sync:local-snapshot-upload", "repo:git-init", "install:node-base"])

  return [...flags]
}

function requirePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) return undefined
  if (Number.isInteger(value) && value > 0) {
    return value
  }

  throw new Error(`Expected ${fieldName} to be a positive integer`)
}
