import type { WorkspaceInfo } from "@opencode-ai/plugin"

import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceCompatibility,
  PersistedWorkspaceExtra,
  PluginLogger,
} from "./types.js"
import {
  DEFAULT_TEMPLATE_GC_COOLDOWN_MS,
  DEFAULT_TEMPLATE_GC_TTL_MS,
  MIN_TEMPLATE_GC_TTL_MS,
} from "./gc.js"

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

/**
 * Normalize raw plugin options into the concrete runtime config used by the
 * rest of the package.
 */
export function normalizeOptions(options?: E2BWorkspacePluginOptions): NormalizedE2BWorkspaceConfig {
  const sandboxTimeoutMs = requirePositiveInteger(options?.sandboxTimeoutMs, "sandboxTimeoutMs") ?? 60 * 60 * 1000
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
    secure: options?.secure ?? false,
    network: {
      allowPublicTraffic: options?.network?.allowPublicTraffic ?? true,
      allowOut: options?.network?.allowOut ?? [],
      denyOut: options?.network?.denyOut ?? [],
      maskRequestHost: options?.network?.maskRequestHost ?? "",
    },
    bootstrap: {
      prepareCommands: options?.bootstrap?.prepareCommands ?? [],
      // Deprecated: the pinned controller is now installed at managed
      // template build time. This field is still validated so older
      // configs continue to load, but its value is ignored at runtime.
      installCommand: options?.bootstrap?.installCommand ?? "",
      // Deprecated: the managed template bakes its own start command that
      // waits for the bootstrap-ready marker and then exec's the installed
      // opencode by absolute path. This field is still validated so older
      // configs continue to load, but its value is ignored at runtime.
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

/**
 * Warn once per process when deprecated `bootstrap` options are set in the
 * user config. Their values are schema-validated so loading succeeds, but
 * they no longer affect runtime behavior — carrying them silently would be
 * misleading to users who expect them to run.
 */
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
      "bootstrap.startCommand is deprecated and ignored; the managed template runs a marker-gated start command.",
      {
        startCommand,
      },
    )
  }
}

/**
 * Create the persisted `extra` blob stored with the workspace row.
 */
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

/**
 * Merge persisted workspace config back into the current runtime options.
 * The stored values win for per-workspace identity, while broader plugin-level
 * defaults continue to control the more open ended behaviors.
 */
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

/**
 * Resolve the persisted workspace compatibility data used for sandbox metadata
 * and compatibility checks. When older workspace rows are missing these
 * values, the current runtime values are used as a best-effort fallback.
 */
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

/**
 * Build compatibility data that reflects the current plugin + controller
 * state, ignoring whatever was previously persisted. Use this whenever a
 * sandbox is provisioned fresh (first create, or replacement after an
 * incompatible one was killed) so its metadata matches the code that wrote
 * it.
 */
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

/**
 * Generate a stable, readable default workspace name.
 */
export function defaultWorkspaceName(info: WorkspaceInfo): string {
  const branchPart = info.branch?.replace(/[^a-zA-Z0-9._-]+/g, "-")
  const suffix = info.id.slice(-6)
  return branchPart ? `e2b-${branchPart}` : `e2b-${suffix}`
}

/**
 * Parse the persisted `extra` payload when it matches the plugin's expected
 * shape. Invalid or unrelated `extra` values are ignored instead of failing.
 */
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

/**
 * Derive stable provenance flags from the current scaffold behavior. Missing
 * future flags should be interpreted as unknown rather than false.
 */
function buildWorkspaceFlags(config: Omit<NormalizedE2BWorkspaceConfig, "flags">): string[] {
  const flags = new Set<string>([
    "sync:local-snapshot-upload",
    "repo:git-init",
    // Managed templates now start from a Node image and install the pinned
    // controller before baking the marker-gated start command.
    "install:node-base",
  ])

  if (config.bootstrap.prepareCommands.some((command) => command.trim())) {
    flags.add("bootstrap:prepare-commands")
  }

  // `bootstrap.installCommand` and `bootstrap.startCommand` are accepted for
  // schema compatibility but no longer affect runtime behavior, so no
  // provenance flag is emitted.

  return [...flags]
}

/**
 * Validate optional numeric configuration before runtime behavior depends on it.
 */
function requirePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) return undefined
  if (Number.isInteger(value) && value > 0) {
    return value
  }

  throw new Error(`Expected ${fieldName} to be a positive integer`)
}
