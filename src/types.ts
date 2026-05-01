import type { PluginOptions, WorkspaceInfo } from "@opencode-ai/plugin"

/**
 * Network options that feed directly into E2B sandbox creation.
 * The shape stays broad on purpose so later iterations can add more
 * provider-specific controls without reworking the plugin surface.
 */
export type E2BNetworkOptions = {
  allowPublicTraffic?: boolean
  allowOut?: string[]
  denyOut?: string[]
  maskRequestHost?: string
}

/**
 * Bootstrap commands run inside the sandbox during `adaptor.create`.
 * `prepareCommands` is the supported extension point; `installCommand` and
 * `startCommand` are accepted for schema compatibility but ignored.
 */
export type E2BBootstrapOptions = {
  prepareCommands?: string[]
  installCommand?: string
  startCommand?: string
  waitForPath?: string
  waitForTimeoutMs?: number
}

/**
 * Upload behavior for the initial local snapshot copied into the sandbox.
 * The uploader starts with recursive snapshot behavior and leaves room for
 * richer sync engines later.
 */
export type E2BUploadOptions = {
  ignore?: string[]
  includeDotGit?: boolean
  batchSize?: number
  followSymlinks?: boolean
}

/**
 * Garbage collection of managed templates this plugin published. Runs
 * best-effort at plugin load and after workspace teardown; never blocks the
 * caller.
 */
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

/**
 * Public plugin options accepted from the OpenCode config file.
 * These are provider-facing options that can evolve without changing the high
 * level package structure.
 */
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

/**
 * Normalized runtime config used internally by the plugin. Every field here is
 * concrete so the rest of the code can stay small and avoid repeating default
 * handling in every module.
 */
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

/**
 * Stable workspace compatibility details persisted both in OpenCode's
 * workspace row and in E2B sandbox metadata. These fields describe the local
 * and remote runtime compatibility expectations for a workspace instance.
 */
export type PersistedWorkspaceCompatibility = {
  workspaceApiVersion: string
  runtimeVersion: string
  flags: string[]
}

/**
 * Data persisted into `WorkspaceInfo.extra`. This is intentionally limited to
 * stable, serializable configuration that later adaptor calls need to resolve
 * the same remote workspace behavior. The compatibility subset is spliced in
 * via intersection so the "extra is a superset of compatibility" relationship
 * is expressed in the type rather than duplicated field-by-field.
 */
export type PersistedWorkspaceExtra = {
  e2b: PersistedWorkspaceCompatibility & {
    nodeVariant: string
    projectPath: string
    serverPort: number
    secure: boolean
    metadata: Record<string, string>
  }
}

/**
 * The runtime workspace adaptor API accepts an `env` object during `create()`,
 * but the published plugin type package lags that runtime surface. This local
 * type models the behavior the plugin receives from OpenCode.
 */
export type RuntimeWorkspaceAdaptor = {
  name: string
  description: string
  configure(info: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(info: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(info: WorkspaceInfo): Promise<void>
  target(info: WorkspaceInfo): Promise<{ type: "remote"; url: string | URL; headers?: HeadersInit }>
}

/**
 * Minimal logger shape used across plugin modules. The concrete
 * implementation lives in index.ts and forwards through the OpenCode app log
 * endpoint; everything else that needs to emit diagnostics accepts this
 * interface so we don't scatter duplicate definitions.
 */
export type PluginLogger = {
  info(message: string, extra?: Record<string, unknown>): Promise<void>
  warn(message: string, extra?: Record<string, unknown>): Promise<void>
  error(message: string, extra?: Record<string, unknown>): Promise<void>
}

/**
 * Parsed view of the workspace-compatibility fields stored in E2B sandbox
 * metadata. Fields are optional because metadata may be absent on sandboxes
 * that didn't set every key; an unknown flag set should never be confused
 * with an empty set.
 */
export type SandboxMetadataCompatibility = {
  workspaceApiVersion?: string
  runtimeVersion?: string
  flags: string[]
}
