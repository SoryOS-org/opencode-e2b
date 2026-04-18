import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type {
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceContract,
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

type SandboxMetadataContract = {
  workspaceApiVersion?: string
  runtimeVersion?: string
  flags: string[]
}

/**
 * Build the metadata attached to each E2B sandbox so later adaptor calls can
 * rediscover the sandbox without storing the generated sandbox ID locally.
 */
export function buildSandboxMetadata(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  contract: PersistedWorkspaceContract,
): Record<string, string> {
  return {
    ...config.metadata,
    [WORKSPACE_ID_METADATA_KEY]: info.id,
    [PROJECT_ID_METADATA_KEY]: info.projectID,
    [WORKSPACE_API_VERSION_METADATA_KEY]: contract.workspaceApiVersion,
    [RUNTIME_VERSION_METADATA_KEY]: contract.runtimeVersion,
    [FLAGS_METADATA_KEY]: JSON.stringify(contract.flags),
  }
}

/**
 * Create an E2B sandbox for the requested workspace.
 */
export async function createWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  env: Record<string, string | undefined>,
  contract: PersistedWorkspaceContract,
): Promise<Sandbox> {
  return Sandbox.create(config.template, {
    timeoutMs: config.sandboxTimeoutMs,
    metadata: buildSandboxMetadata(info, config, contract),
    envs: compactEnv(env),
    secure: config.secure,
    network: {
      allowPublicTraffic: config.network.allowPublicTraffic,
      allowOut: config.network.allowOut.length ? config.network.allowOut : undefined,
      denyOut: config.network.denyOut.length ? config.network.denyOut : undefined,
      maskRequestHost: config.network.maskRequestHost || undefined,
    },
  })
}

/**
 * Find and connect to the sandbox associated with a workspace while preserving
 * its stored E2B metadata for later compatibility checks.
 */
export async function findWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<WorkspaceSandboxRecord | undefined> {
  const paginator = Sandbox.list({
    query: {
      metadata: {
        [WORKSPACE_ID_METADATA_KEY]: info.id,
      },
      state: ["running", "paused"],
    },
    limit: 100,
  })

  while (paginator.hasNext) {
    const sandboxes = await paginator.nextItems()
    const sandboxInfo = sandboxes[0]
    if (!sandboxInfo) continue

    return {
      sandbox: await Sandbox.connect(sandboxInfo.sandboxId, {
        timeoutMs: config.sandboxTimeoutMs,
      }),
      metadata: sandboxInfo.metadata ?? {},
    }
  }

  return undefined
}

/**
 * Find and connect to the sandbox associated with a workspace.
 */
export async function findWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<Sandbox | undefined> {
  const record = await findWorkspaceSandboxRecord(info, config)
  return record?.sandbox
}

/**
 * Require an existing sandbox and fail with a clear workspace-scoped error
 * message when it is missing.
 */
export async function requireWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<Sandbox> {
  const sandbox = await findWorkspaceSandbox(info, config)
  if (!sandbox) {
    throw new Error(`No E2B sandbox found for workspace ${info.id}`)
  }
  return sandbox
}

/**
 * Require an existing sandbox record and fail with a clear workspace-scoped
 * error message when it is missing.
 */
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

/**
 * Convert the sandbox host and configured port into the remote base URL used
 * by OpenCode's remote workspace target.
 */
export function sandboxBaseUrl(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): URL {
  return new URL(`https://${sandbox.getHost(config.serverPort)}`)
}

/**
 * Remove the sandbox if it exists. Missing sandboxes are treated as already
 * deleted so workspace cleanup stays idempotent.
 */
export async function removeWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  const sandbox = await findWorkspaceSandbox(info, config)
  if (!sandbox) return
  await sandbox.kill()
}

/**
 * Parse workspace contract fields back out of raw E2B metadata. Invalid or
 * missing values are treated as absent so older sandboxes remain inspectable.
 */
export function readSandboxContract(metadata: Record<string, string>): SandboxMetadataContract {
  return {
    workspaceApiVersion: metadata[WORKSPACE_API_VERSION_METADATA_KEY],
    runtimeVersion: metadata[RUNTIME_VERSION_METADATA_KEY],
    flags: parseFlags(metadata[FLAGS_METADATA_KEY]),
  }
}

/**
 * Drop undefined environment variables before sending them to E2B.
 */
function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/**
 * Parse the serialized sandbox flags. Invalid payloads degrade gracefully to an
 * empty list so metadata bugs do not break workspace teardown.
 */
function parseFlags(rawFlags: string | undefined): string[] {
  if (!rawFlags) return []

  try {
    const parsed = JSON.parse(rawFlags)
    if (Array.isArray(parsed) && parsed.every((flag) => typeof flag === "string")) {
      return parsed
    }
  } catch {
    // Ignore invalid metadata and fall back to an empty flag list.
  }

  return []
}
