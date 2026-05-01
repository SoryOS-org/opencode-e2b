import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import { forgetSandboxCompatibility } from "./runtime.js"
import { ensureManagedWorkspaceTemplate } from "./template.js"
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

function buildSandboxMetadata(
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
  const template = await ensureManagedWorkspaceTemplate(
    {
      nodeVariant: config.nodeVariant,
      runtimeVersion,
      projectPath: config.projectPath,
      serverPort: config.serverPort,
      pluginPackageVersion,
    },
    logger,
  )

  return Sandbox.create(template, {
    timeoutMs: config.sandboxTimeoutMs,
    metadata: buildSandboxMetadata(info, config, compatibility),
    secure: config.secure,
    network: {
      allowPublicTraffic: config.network.allowPublicTraffic,
      allowOut: config.network.allowOut.length ? config.network.allowOut : undefined,
      denyOut: config.network.denyOut.length ? config.network.denyOut : undefined,
      maskRequestHost: config.network.maskRequestHost || undefined,
    },
  })
}

export async function findWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<WorkspaceSandboxRecord | undefined> {
  const matches = await listWorkspaceSandboxMatches(info)
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

  return {
    sandbox: await Sandbox.connect(match.sandboxId, {
      timeoutMs: config.sandboxTimeoutMs,
    }),
    metadata: match.metadata,
  }
}

async function listWorkspaceSandboxMatches(info: WorkspaceInfo): Promise<WorkspaceSandboxMatch[]> {
  const paginator = Sandbox.list({
    query: {
      metadata: {
        [WORKSPACE_ID_METADATA_KEY]: info.id,
      },
      state: ["running", "paused"],
    },
    limit: 100,
  })

  const matches: WorkspaceSandboxMatch[] = []

  while (paginator.hasNext) {
    const sandboxes = await paginator.nextItems()
    for (const sandboxInfo of sandboxes) {
      matches.push({
        sandboxId: sandboxInfo.sandboxId,
        metadata: sandboxInfo.metadata ?? {},
      })
    }
  }

  return matches
}

export async function requireWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<WorkspaceSandboxRecord> {
  const record = await findWorkspaceSandboxRecord(info, config)
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
): Promise<void> {
  const matches = await listWorkspaceSandboxMatches(info)
  if (matches.length === 0) return

  await Promise.all(
    matches.map(async (match) => {
      const sandbox = await Sandbox.connect(match.sandboxId, {
        timeoutMs: config.sandboxTimeoutMs,
      })
      try {
        await sandbox.kill()
      } finally {
        forgetSandboxCompatibility(match.sandboxId)
      }
    }),
  )
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
  } catch {}

  return []
}

function buildDuplicateSandboxError(info: WorkspaceInfo, matches: WorkspaceSandboxMatch[]): string {
  const sandboxIds = matches.map((match) => match.sandboxId).join(", ")
  return `Found multiple E2B sandboxes for workspace ${info.id}: ${sandboxIds}`
}
