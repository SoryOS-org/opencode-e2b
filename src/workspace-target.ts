import type { WorkspaceInfo } from "@opencode-ai/plugin"

import { resolveWorkspaceCompatibility, resolveWorkspaceConfig } from "./config.js"
import {
  readSandboxCompatibility,
  requireWorkspaceSandboxRecord,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "./e2b.js"
import { assertWorkspaceCompatibility, resolveLocalRuntimeVersion } from "./runtime.js"
import type { E2BWorkspacePluginOptions, PluginLogger } from "./types.js"

export async function resolveWorkspaceTarget(params: {
  info: WorkspaceInfo
  options: E2BWorkspacePluginOptions | undefined
  serverUrl: URL
  logger: PluginLogger
}): Promise<{ type: "remote"; url: URL; headers?: HeadersInit }> {
  const localRuntimeVersion = await resolveLocalRuntimeVersion(params.serverUrl, params.logger)
  const config = resolveWorkspaceConfig(params.info, params.options)
  const compatibility = resolveWorkspaceCompatibility(params.info, config, localRuntimeVersion)
  const record = await requireWorkspaceSandboxRecord(params.info, config)
  const baseUrl = sandboxBaseUrl(record.sandbox, config)
  const headers = sandboxTargetHeaders(record.sandbox, config)

  await assertWorkspaceCompatibility({
    workspaceID: params.info.id,
    localRuntimeVersion,
    persistedCompatibility: compatibility,
    sandboxCompatibility: readSandboxCompatibility(record.metadata),
    sandbox: record.sandbox,
    baseUrl,
    headers,
  })

  return {
    type: "remote",
    url: baseUrl,
    ...(headers ? { headers } : {}),
  }
}
