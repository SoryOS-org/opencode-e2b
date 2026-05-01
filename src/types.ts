import type { PluginOptions, WorkspaceInfo } from "@opencode-ai/plugin"

export type E2BNetworkOptions = {
  allowPublicTraffic?: boolean
  allowOut?: string[]
  denyOut?: string[]
  maskRequestHost?: string
}

export type E2BBootstrapOptions = {
  prepareCommands?: string[]
  installCommand?: string
  startCommand?: string
  waitForPath?: string
  waitForTimeoutMs?: number
}

export type E2BUploadOptions = {
  ignore?: string[]
  includeDotGit?: boolean
  batchSize?: number
  followSymlinks?: boolean
}

export type E2BTemplateGCOptions = {
  /** When false, GC is disabled entirely. Default true. */
  enabled?: boolean
  /**
   * A managed template is eligible for deletion only if its freshness (max of
   * lastSpawnedAt / updatedAt / createdAt) is older than this. Default 72h
   * (3 * 24 * 60 * 60 * 1000). Values below 1h are clamped up.
   */
  ttlMs?: number
  /**
   * Minimum wall-clock gap between GC passes initiated by this process.
   * Default 10 minutes. Prevents a remove-heavy session from hammering the
   * templates endpoint.
   */
  cooldownMs?: number
}

export type E2BWorkspacePluginOptions = PluginOptions & {
  nodeVariant?: string
  sandboxTimeoutMs?: number
  projectPath?: string
  serverPort?: number
  secure?: boolean
  network?: E2BNetworkOptions
  bootstrap?: E2BBootstrapOptions
  upload?: E2BUploadOptions
  templateGc?: E2BTemplateGCOptions
  metadata?: Record<string, string>
}

export type NormalizedE2BWorkspaceConfig = {
  workspaceApiVersion: string
  nodeVariant: string
  sandboxTimeoutMs: number
  projectPath: string
  serverPort: number
  secure: boolean
  network: Required<E2BNetworkOptions>
  bootstrap: Required<E2BBootstrapOptions>
  upload: Required<E2BUploadOptions>
  templateGc: Required<E2BTemplateGCOptions>
  metadata: Record<string, string>
  flags: string[]
}

export type PersistedWorkspaceCompatibility = {
  workspaceApiVersion: string
  runtimeVersion: string
  flags: string[]
}

export type PersistedWorkspaceExtra = {
  e2b: PersistedWorkspaceCompatibility & {
    nodeVariant: string
    projectPath: string
    serverPort: number
    secure: boolean
    metadata: Record<string, string>
  }
}

export type RuntimeWorkspaceAdaptor = {
  name: string
  description: string
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(info: WorkspaceInfo, env: Record<string, string | undefined>): Promise<void>
  remove(info: WorkspaceInfo): Promise<void>
  target(info: WorkspaceInfo): Promise<{ type: "remote"; url: string | URL; headers?: HeadersInit }>
}

export type PluginLogger = {
  info(message: string, extra?: Record<string, unknown>): Promise<void>
  warn(message: string, extra?: Record<string, unknown>): Promise<void>
  error(message: string, extra?: Record<string, unknown>): Promise<void>
}

export type SandboxMetadataCompatibility = {
  workspaceApiVersion?: string
  runtimeVersion?: string
  flags: string[]
}
