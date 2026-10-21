/**
 * Compatibility between the local OpenCode 1 runtime and a workspace sandbox: what the
 * workspace row persists in `extra`, and what a reconnect checks against it.
 */

import type { WorkspaceInfo } from "@opencode-ai/plugin"

import { readPersistedExtra } from "../core/config.js"
import type {
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceCompatibility,
  PersistedWorkspaceExtra,
} from "../core/types.js"

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
