import type { WorkspaceInfo } from "@opencode-ai/plugin"

import {
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceCompatibility,
  resolveWorkspaceConfig,
} from "./config.js"
import {
  readSandboxCompatibility,
  removeWorkspaceSandbox,
  requireWorkspaceSandboxRecord,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "./e2b.js"
import { runTemplateGC } from "./gc.js"
import { assertWorkspaceCompatibility, resolveLocalRuntimeVersion } from "./runtime.js"
import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PluginLogger,
  RuntimeWorkspaceAdaptor,
} from "./types.js"
import { createWorkspace } from "./workspace-create.js"

type WorkspaceAdaptorDeps = {
  directory: string
  serverUrl: URL
  options: E2BWorkspacePluginOptions | undefined
  logger: PluginLogger
  gcConfig: NormalizedE2BWorkspaceConfig["templateGc"]
}

export function createE2BWorkspaceAdaptor(deps: WorkspaceAdaptorDeps): RuntimeWorkspaceAdaptor {
  return {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, deps.options, deps.serverUrl, deps.logger)
    },
    async create(info, env) {
      assertE2BApiKeyAvailable()
      await createWorkspace({
        info,
        env,
        localDirectory: deps.directory,
        options: deps.options,
        serverUrl: deps.serverUrl,
        logger: deps.logger,
      })
    },
    async remove(info) {
      assertE2BApiKeyAvailable()
      const config = resolveWorkspaceConfig(info, deps.options)
      await removeWorkspaceSandbox(info, config)
      if (deps.gcConfig.enabled) {
        void runTemplateGC(deps.gcConfig, deps.logger).catch(() => {})
      }
    },
    async target(info) {
      assertE2BApiKeyAvailable()
      return resolveWorkspaceTarget({
        info,
        options: deps.options,
        serverUrl: deps.serverUrl,
        logger: deps.logger,
      })
    },
  }
}

async function configureWorkspace(
  info: WorkspaceInfo,
  options: E2BWorkspacePluginOptions | undefined,
  serverUrl: URL,
  logger: PluginLogger,
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options)
  await logger.info("configure workspace start", {
    workspaceID: info.id,
    branch: info.branch ?? undefined,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })
  const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger)

  await logger.info("configure workspace resolved local runtime", {
    workspaceID: info.id,
    runtimeVersion,
  })

  return {
    ...info,
    name: defaultWorkspaceName(info),
    directory: config.projectPath,
    extra: buildPersistedExtra(config, runtimeVersion),
  }
}

async function resolveWorkspaceTarget(params: {
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

function assertE2BApiKeyAvailable(env: NodeJS.ProcessEnv = process.env): void {
  const key = env.E2B_API_KEY
  if (key && key.trim() !== "") return

  throw new Error(
    "E2B_API_KEY is not set. Export it in your shell (or OpenCode launch env) " +
      "before enabling the e2b workspace plugin. Get a key at https://e2b.dev/dashboard.",
  )
}
