import type { WorkspaceInfo } from "@opencode-ai/plugin"

import {
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceConfig,
} from "./config.js"
import { assertE2BApiKeyAvailable } from "./credentials.js"
import { removeWorkspaceSandbox } from "./e2b.js"
import { runTemplateGC } from "./gc.js"
import { resolveLocalRuntimeVersion } from "./runtime.js"
import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PluginLogger,
  RuntimeWorkspaceAdaptor,
} from "./types.js"
import { createWorkspace } from "./workspace-create.js"
import { resolveWorkspaceTarget } from "./workspace-target.js"

type WorkspaceAdaptorDeps = {
  directory: string
  serverUrl: URL
  options: E2BWorkspacePluginOptions | undefined
  logger: PluginLogger
  gcConfig: NormalizedE2BWorkspaceConfig["templateGc"]
}

/**
 * Build the OpenCode workspace adaptor around the E2B lifecycle operations.
 * Keeping this outside the plugin entrypoint makes `index.ts` responsible for
 * wiring only, while this module owns workspace behavior.
 */
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

/**
 * Build the persisted workspace record before sandbox creation begins.
 */
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
