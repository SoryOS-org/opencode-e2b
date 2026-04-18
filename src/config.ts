import type { WorkspaceInfo } from "@opencode-ai/plugin"

import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceContract,
  PersistedWorkspaceExtra,
} from "./types.js"

export const CURRENT_WORKSPACE_API_VERSION = "1"

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

  const config = {
    workspaceApiVersion: CURRENT_WORKSPACE_API_VERSION,
    template: options?.template ?? "base",
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
      installCommand: options?.bootstrap?.installCommand ?? "",
      startCommand:
        options?.bootstrap?.startCommand ?? "opencode serve --hostname 0.0.0.0 --port 4096",
      waitForPath: options?.bootstrap?.waitForPath ?? "/global/event",
      waitForTimeoutMs,
    },
    upload: {
      ignore: options?.upload?.ignore ?? [...DEFAULT_IGNORE],
      includeDotGit: options?.upload?.includeDotGit ?? false,
      batchSize,
      followSymlinks: options?.upload?.followSymlinks ?? false,
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
      template: config.template,
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
    template: extra.e2b.template,
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
 * Resolve the persisted workspace contract used for sandbox metadata and
 * compatibility checks. When older workspace rows are missing the contract, the
 * current runtime values are used as a best-effort fallback.
 */
export function resolveWorkspaceContract(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  runtimeVersion: string,
): PersistedWorkspaceContract {
  const extra = readPersistedExtra(info)
  if (!extra) {
    return {
      workspaceApiVersion: config.workspaceApiVersion,
      runtimeVersion,
      flags: config.flags,
    }
  }

  return {
    workspaceApiVersion: extra.e2b.workspaceApiVersion,
    runtimeVersion: extra.e2b.runtimeVersion,
    flags: extra.e2b.flags,
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
export function readPersistedExtra(info: WorkspaceInfo): PersistedWorkspaceExtra | undefined {
  if (!info.extra || typeof info.extra !== "object") return undefined

  const candidate = info.extra as Partial<PersistedWorkspaceExtra>
  if (!candidate.e2b) return undefined
  if (typeof candidate.e2b.workspaceApiVersion !== "string") return undefined
  if (typeof candidate.e2b.runtimeVersion !== "string") return undefined
  if (!Array.isArray(candidate.e2b.flags) || !candidate.e2b.flags.every((flag) => typeof flag === "string")) {
    return undefined
  }
  if (typeof candidate.e2b.template !== "string") return undefined
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
  ])

  if (config.bootstrap.prepareCommands.some((command) => command.trim())) {
    flags.add("bootstrap:prepare-commands")
  }

  if (config.bootstrap.installCommand.trim()) {
    flags.add("install:runtime-bootstrap")
  }

  if (/\bopencode\b/.test(config.bootstrap.startCommand)) {
    flags.add("serve:opencode-cli")
  }

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
