import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox, SandboxNotFoundError, type SandboxOpts, type SandboxState } from "e2b"

import { createE2BConnectionOptions } from "./e2b-sdk.js"
import { forgetSandboxCompatibility } from "./runtime.js"
import type { CachedSandboxInput, SandboxStore } from "./sandbox-store.js"
import { errorMessage } from "./shared.js"
import {
  buildPrebuiltOpenCodeTemplateName,
  ensureManagedBaseTemplate,
  ensureManagedWorkspaceTemplate,
} from "./template.js"
import type {
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceCompatibility,
  PluginLogger,
  SandboxMetadataCompatibility,
} from "./types.js"

const WORKSPACE_ID_METADATA_KEY = "opencodeWorkspaceId"
const PROJECT_ID_METADATA_KEY = "opencodeProjectId"
const WORKSPACE_API_VERSION_METADATA_KEY = "opencodeWorkspaceApiVersion"
const RUNTIME_VERSION_METADATA_KEY = "opencodeRuntimeVersion"
const FLAGS_METADATA_KEY = "opencodeFlags"

type WorkspaceSandboxRecord = {
  sandbox: Sandbox
  metadata: Record<string, string>
}

type WorkspaceSandboxMatch = {
  sandboxId: string
  metadata: Record<string, string>
}

type SandboxListOptionsWithLogger = NonNullable<Parameters<typeof Sandbox.list>[0]> &
  ReturnType<typeof createE2BConnectionOptions>

type WorkspaceSandboxCreateOptions = SandboxOpts

const workspaceSandboxRecordPromises = new Map<string, Promise<WorkspaceSandboxRecord | undefined>>()

export function buildWorkspaceSandboxMetadata(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  compatibility: PersistedWorkspaceCompatibility,
): Record<string, string> {
  return {
    ...config.metadata,
    [WORKSPACE_ID_METADATA_KEY]: info.id,
    [PROJECT_ID_METADATA_KEY]: info.projectID,
    [WORKSPACE_API_VERSION_METADATA_KEY]: compatibility.workspaceApiVersion,
    [RUNTIME_VERSION_METADATA_KEY]: compatibility.runtimeVersion,
    [FLAGS_METADATA_KEY]: JSON.stringify(compatibility.flags),
  }
}

export async function createWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  compatibility: PersistedWorkspaceCompatibility,
  runtimeVersion: string,
  pluginPackageVersion: string,
  logger?: PluginLogger,
): Promise<Sandbox> {
  const sandboxOptions = buildSandboxCreateOptions(info, config, compatibility, logger)
  const templateInputs = {
    nodeVariant: config.nodeVariant,
    runtimeVersion,
    pluginPackageVersion,
  }
  const workspaceTemplateInputs = {
    ...templateInputs,
    projectPath: config.projectPath,
    serverPort: config.serverPort,
  }
  const publishedBaseTemplate = buildPrebuiltOpenCodeTemplateName(runtimeVersion)
  let managedTemplate: string

  // Do not preflight this with Template.getTags: E2B cannot call get_tags
  // across teams, so published templates must be tried directly and handled
  // through the build failure path.
  try {
    managedTemplate = await ensureManagedWorkspaceTemplate(
      {
        ...workspaceTemplateInputs,
        baseTemplate: publishedBaseTemplate,
      },
      logger,
    )
  } catch (error) {
    await logger?.warn("published opencode base template failed; building managed base template", {
      template: publishedBaseTemplate,
      runtimeVersion,
      error: errorMessage(error),
    })
    const managedBaseTemplate = await ensureManagedBaseTemplate(templateInputs, logger)
    managedTemplate = await ensureManagedWorkspaceTemplate(
      {
        ...workspaceTemplateInputs,
        baseTemplate: managedBaseTemplate,
      },
      logger,
    )
  }

  return Sandbox.create(managedTemplate, sandboxOptions)
}

function buildSandboxCreateOptions(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  compatibility: PersistedWorkspaceCompatibility,
  logger?: PluginLogger,
): WorkspaceSandboxCreateOptions {
  return {
    ...createE2BConnectionOptions(logger),
    timeoutMs: config.sandboxTimeoutMs,
    metadata: buildWorkspaceSandboxMetadata(info, config, compatibility),
    secure: config.secure,
    network: {
      allowPublicTraffic: config.network.allowPublicTraffic,
      allowOut: config.network.allowOut.length ? config.network.allowOut : undefined,
      denyOut: config.network.denyOut.length ? config.network.denyOut : undefined,
      maskRequestHost: config.network.maskRequestHost || undefined,
    },
  }
}

export async function findWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
  store?: SandboxStore,
): Promise<WorkspaceSandboxRecord | undefined> {
  const existing = workspaceSandboxRecordPromises.get(info.id)
  if (existing) return existing

  const promise = findWorkspaceSandboxRecordUncached(info, config, logger, store)
  workspaceSandboxRecordPromises.set(info.id, promise)
  try {
    return await promise
  } finally {
    workspaceSandboxRecordPromises.delete(info.id)
  }
}

async function findWorkspaceSandboxRecordUncached(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger: PluginLogger | undefined,
  store: SandboxStore | undefined,
): Promise<WorkspaceSandboxRecord | undefined> {
  const cached = await readCachedReadySandbox(info, config, logger, store)
  if (cached) return cached

  const matches = await listWorkspaceSandboxMatches(info, logger, 2)
  if (matches.length === 0) {
    return undefined
  }
  if (matches.length > 1) {
    throw new Error(buildDuplicateSandboxError(info, matches))
  }

  const [match] = matches
  if (!match) {
    return undefined
  }

  const record = await connectWorkspaceSandbox(match, config, logger)
  await markSandboxReady(
    store,
    {
      workspaceID: info.id,
      sandboxID: match.sandboxId,
      metadata: match.metadata,
    },
    logger,
  )
  return record
}

async function readCachedReadySandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger: PluginLogger | undefined,
  store: SandboxStore | undefined,
): Promise<WorkspaceSandboxRecord | undefined> {
  if (!store) return undefined

  let cached
  try {
    cached = await store.get(info.id)
  } catch (error) {
    await logger?.warn("sandbox cache read failed; falling back to e2b list", {
      workspaceID: info.id,
      error: errorMessage(error),
    })
    return undefined
  }

  if (!cached || cached.status !== "ready") return undefined

  try {
    const record = await connectWorkspaceSandbox(
      { sandboxId: cached.sandboxID, metadata: cached.metadata },
      config,
      logger,
    )
    await logger?.info("sandbox cache hit", {
      workspaceID: info.id,
      sandboxID: cached.sandboxID,
    })
    return record
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) {
      throw error
    }

    await logger?.warn("sandbox cache entry is stale; falling back to e2b list", {
      workspaceID: info.id,
      sandboxID: cached.sandboxID,
    })
    await deleteCachedSandbox(store, info.id, cached.sandboxID, logger)
    return undefined
  }
}

async function listWorkspaceSandboxMatches(
  info: WorkspaceInfo,
  logger?: PluginLogger,
  maxMatches?: number,
): Promise<WorkspaceSandboxMatch[]> {
  const query = {
    metadata: {
      [WORKSPACE_ID_METADATA_KEY]: info.id,
    },
    state: ["running", "paused"] as SandboxState[],
  }
  const listOptions: SandboxListOptionsWithLogger = {
    ...createE2BConnectionOptions(logger),
    query,
    limit: maxMatches ?? 100,
  }
  const paginator = Sandbox.list(listOptions)

  const matches: WorkspaceSandboxMatch[] = []
  while (paginator.hasNext) {
    const sandboxes = await paginator.nextItems()
    for (const sandboxInfo of sandboxes) {
      matches.push({
        sandboxId: sandboxInfo.sandboxId,
        metadata: sandboxInfo.metadata ?? {},
      })
      if (maxMatches && matches.length >= maxMatches) {
        return matches
      }
    }
  }

  return matches
}

export async function requireWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
  store?: SandboxStore,
): Promise<WorkspaceSandboxRecord> {
  const record = await findWorkspaceSandboxRecord(info, config, logger, store)
  if (!record) {
    throw new Error(`No E2B sandbox found for workspace ${info.id}`)
  }
  return record
}

export function sandboxBaseUrl(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): URL {
  return new URL(`https://${sandbox.getHost(config.serverPort)}`)
}

export function sandboxTargetHeaders(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
): Record<string, string> | undefined {
  if (!config.secure) return undefined
  if (!sandbox.trafficAccessToken) return undefined
  return { "X-Access-Token": sandbox.trafficAccessToken }
}

export async function removeWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
  store?: SandboxStore,
): Promise<void> {
  const removedCached = await removeCachedWorkspaceSandbox(info, config, logger, store)
  if (removedCached === "removed") return

  const matches = await listWorkspaceSandboxMatches(info, logger)
  if (matches.length === 0) return

  await Promise.all(
    matches.map(async (match) => {
      let sandbox
      try {
        sandbox = await Sandbox.connect(match.sandboxId, {
          ...createE2BConnectionOptions(logger),
          timeoutMs: config.sandboxTimeoutMs,
        })
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error
        }
        forgetSandboxCompatibility(match.sandboxId)
        await deleteCachedSandbox(store, info.id, match.sandboxId, logger)
        return
      }

      await sandbox.kill()
      forgetSandboxCompatibility(match.sandboxId)
      await deleteCachedSandbox(store, info.id, match.sandboxId, logger)
    }),
  )
}

type CachedRemoveResult = "removed" | "not-found" | "no-cache"

async function removeCachedWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  logger: PluginLogger | undefined,
  store: SandboxStore | undefined,
): Promise<CachedRemoveResult> {
  if (!store) return "no-cache"

  let cached
  try {
    cached = await store.get(info.id)
  } catch (error) {
    await logger?.warn("sandbox cache read failed during remove; falling back to e2b list", {
      workspaceID: info.id,
      error: errorMessage(error),
    })
    return "no-cache"
  }
  if (!cached) return "no-cache"

  let sandbox
  try {
    sandbox = await Sandbox.connect(cached.sandboxID, {
      ...createE2BConnectionOptions(logger),
      timeoutMs: config.sandboxTimeoutMs,
    })
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) {
      throw error
    }

    forgetSandboxCompatibility(cached.sandboxID)
    await deleteCachedSandbox(store, info.id, cached.sandboxID, logger)
    return "not-found"
  }

  await sandbox.kill()
  forgetSandboxCompatibility(cached.sandboxID)
  await deleteCachedSandbox(store, info.id, cached.sandboxID, logger)
  return "removed"
}

function connectWorkspaceSandbox(
  match: WorkspaceSandboxMatch,
  config: NormalizedE2BWorkspaceConfig,
  logger?: PluginLogger,
): Promise<WorkspaceSandboxRecord> {
  return Sandbox.connect(match.sandboxId, {
    ...createE2BConnectionOptions(logger),
    timeoutMs: config.sandboxTimeoutMs,
  }).then((sandbox) => ({ sandbox, metadata: match.metadata }))
}

export async function upsertProvisioningSandbox(
  store: SandboxStore | undefined,
  input: CachedSandboxInput,
  logger?: PluginLogger,
): Promise<void> {
  if (!store) return
  try {
    await store.upsertProvisioning(input)
  } catch (error) {
    await logger?.warn("sandbox cache write failed", {
      workspaceID: input.workspaceID,
      sandboxID: input.sandboxID,
      error: errorMessage(error),
    })
  }
}

export async function markSandboxReady(
  store: SandboxStore | undefined,
  input: CachedSandboxInput,
  logger?: PluginLogger,
): Promise<void> {
  if (!store) return
  try {
    await store.markReady(input)
  } catch (error) {
    await logger?.warn("sandbox cache ready update failed", {
      workspaceID: input.workspaceID,
      sandboxID: input.sandboxID,
      error: errorMessage(error),
    })
  }
}

export async function markSandboxFailed(
  store: SandboxStore | undefined,
  workspaceID: string,
  sandboxID: string,
  logger?: PluginLogger,
): Promise<void> {
  if (!store) return
  try {
    await store.markFailed(workspaceID, sandboxID)
  } catch (error) {
    await logger?.warn("sandbox cache failed update failed", {
      workspaceID,
      sandboxID,
      error: errorMessage(error),
    })
  }
}

export async function deleteCachedSandbox(
  store: SandboxStore | undefined,
  workspaceID: string,
  sandboxID: string,
  logger?: PluginLogger,
): Promise<void> {
  if (!store) return
  try {
    await store.delete(workspaceID, sandboxID)
  } catch (error) {
    await logger?.warn("sandbox cache delete failed", {
      workspaceID,
      sandboxID,
      error: errorMessage(error),
    })
  }
}

export function readSandboxCompatibility(metadata: Record<string, string>): SandboxMetadataCompatibility {
  return {
    workspaceApiVersion: metadata[WORKSPACE_API_VERSION_METADATA_KEY],
    runtimeVersion: metadata[RUNTIME_VERSION_METADATA_KEY],
    flags: parseFlags(metadata[FLAGS_METADATA_KEY]),
  }
}

function parseFlags(rawFlags: string | undefined): string[] {
  if (!rawFlags) return []

  try {
    const parsed = JSON.parse(rawFlags)
    if (Array.isArray(parsed) && parsed.every((flag) => typeof flag === "string")) {
      return parsed
    }
  } catch {
    // Invalid metadata is treated the same as missing metadata.
  }

  return []
}

function buildDuplicateSandboxError(info: WorkspaceInfo, matches: WorkspaceSandboxMatch[]): string {
  const sandboxIds = matches.map((match) => match.sandboxId).join(", ")
  return `Found multiple E2B sandboxes for workspace ${info.id}: ${sandboxIds}`
}
