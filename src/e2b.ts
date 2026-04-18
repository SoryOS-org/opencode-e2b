import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import type { NormalizedE2BWorkspaceConfig } from "./types.js"

const WORKSPACE_ID_METADATA_KEY = "opencodeWorkspaceId"
const PROJECT_ID_METADATA_KEY = "opencodeProjectId"
const WORKSPACE_TYPE_METADATA_KEY = "opencodeWorkspaceType"

/**
 * Build the metadata attached to each E2B sandbox so later adaptor calls can
 * rediscover the sandbox without storing the generated sandbox ID locally.
 */
export function buildSandboxMetadata(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Record<string, string> {
  return {
    ...config.metadata,
    [WORKSPACE_ID_METADATA_KEY]: info.id,
    [PROJECT_ID_METADATA_KEY]: info.projectID,
    [WORKSPACE_TYPE_METADATA_KEY]: info.type,
  }
}

/**
 * Create an E2B sandbox for the requested workspace.
 */
export async function createWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  env: Record<string, string | undefined>,
): Promise<Sandbox> {
  return Sandbox.create(config.template, {
    timeoutMs: config.sandboxTimeoutMs,
    metadata: buildSandboxMetadata(info, config),
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
 * Find and connect to the sandbox associated with a workspace.
 */
export async function findWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<Sandbox | undefined> {
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
    return Sandbox.connect(sandboxInfo.sandboxId, {
      timeoutMs: config.sandboxTimeoutMs,
    })
  }

  return undefined
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
 * Drop undefined environment variables before sending them to E2B.
 */
function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
