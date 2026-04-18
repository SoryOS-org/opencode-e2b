import type { Plugin, WorkspaceInfo } from "@opencode-ai/plugin"

import { bootstrapWorkspace } from "./bootstrap.js"
import {
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceConfig,
} from "./config.js"
import {
  createWorkspaceSandbox,
  removeWorkspaceSandbox,
  requireWorkspaceSandbox,
  sandboxBaseUrl,
} from "./e2b.js"
import type { E2BWorkspacePluginOptions, RuntimeWorkspaceAdaptor } from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"

/**
 * OpenCode plugin entrypoint for the E2B workspace adaptor.
 */
export const E2BWorkspacePlugin: Plugin = async ({ directory, experimental_workspace }, rawOptions) => {
  const options = rawOptions as E2BWorkspacePluginOptions | undefined

  const adaptor: RuntimeWorkspaceAdaptor = {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, options)
    },
    async create(info, env) {
      await createWorkspace(info, env, directory, options)
    },
    async remove(info) {
      const config = resolveWorkspaceConfig(info, options)
      await removeWorkspaceSandbox(info, config)
    },
    async target(info) {
      const config = resolveWorkspaceConfig(info, options)
      const sandbox = await requireWorkspaceSandbox(info, config)
      return {
        type: "remote",
        url: sandboxBaseUrl(sandbox, config),
      }
    },
  }

  experimental_workspace.register("e2b", adaptor as never)

  return {}
}

export default E2BWorkspacePlugin

/**
 * Build the persisted workspace record before sandbox creation begins.
 */
function configureWorkspace(info: WorkspaceInfo, options?: E2BWorkspacePluginOptions): WorkspaceInfo {
  const config = normalizeOptions(options)
  return {
    ...info,
    name: defaultWorkspaceName(info),
    directory: config.projectPath,
    extra: buildPersistedExtra(config),
  }
}

/**
 * Create the E2B-backed workspace, upload the local project snapshot, and
 * bootstrap the remote OpenCode server.
 */
async function createWorkspace(
  info: WorkspaceInfo,
  env: Record<string, string | undefined>,
  localDirectory: string,
  options?: E2BWorkspacePluginOptions,
): Promise<void> {
  const config = resolveWorkspaceConfig(info, options)
  const sandbox = await createWorkspaceSandbox(info, config, env)

  try {
    await uploadLocalSnapshot({
      sandbox,
      localRoot: localDirectory,
      remoteRoot: config.projectPath,
      upload: config.upload,
    })

    await bootstrapWorkspace({
      sandbox,
      info,
      config,
    })
  } catch (error) {
    await sandbox.kill().catch(() => {
      // Ignore sandbox cleanup failures and preserve the original bootstrap error.
    })
    throw error
  }
}
