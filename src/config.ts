import type { WorkspaceInfo } from "@opencode-ai/plugin"

import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceExtra,
} from "./types.js"

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
  return {
    template: options?.template ?? "base",
    sandboxTimeoutMs: options?.sandboxTimeoutMs ?? 60 * 60 * 1000,
    projectPath: options?.projectPath ?? "/home/user/project",
    serverPort: options?.serverPort ?? 4096,
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
      waitForTimeoutMs: options?.bootstrap?.waitForTimeoutMs ?? 30_000,
    },
    upload: {
      ignore: options?.upload?.ignore ?? [...DEFAULT_IGNORE],
      includeDotGit: options?.upload?.includeDotGit ?? false,
      batchSize: options?.upload?.batchSize ?? 100,
      followSymlinks: options?.upload?.followSymlinks ?? false,
    },
    metadata: options?.metadata ?? {},
  }
}

/**
 * Create the persisted `extra` blob stored with the workspace row.
 */
export function buildPersistedExtra(config: NormalizedE2BWorkspaceConfig): PersistedWorkspaceExtra {
  return {
    e2b: {
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
    template: extra.e2b.template,
    projectPath: extra.e2b.projectPath,
    serverPort: extra.e2b.serverPort,
    secure: extra.e2b.secure,
    metadata: {
      ...normalized.metadata,
      ...extra.e2b.metadata,
    },
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
  if (typeof candidate.e2b.template !== "string") return undefined
  if (typeof candidate.e2b.projectPath !== "string") return undefined
  if (typeof candidate.e2b.serverPort !== "number") return undefined
  if (typeof candidate.e2b.secure !== "boolean") return undefined
  if (!candidate.e2b.metadata || typeof candidate.e2b.metadata !== "object") return undefined

  return candidate as PersistedWorkspaceExtra
}
