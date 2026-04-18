import type { Plugin, WorkspaceInfo } from "@opencode-ai/plugin"

import { bootstrapWorkspace } from "./bootstrap.js"
import {
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceContract,
  resolveWorkspaceConfig,
} from "./config.js"
import {
  createWorkspaceSandbox,
  findWorkspaceSandboxRecord,
  removeWorkspaceSandbox,
  readSandboxContract,
  requireWorkspaceSandboxRecord,
  sandboxBaseUrl,
} from "./e2b.js"
import {
  assertWorkspaceCompatibility,
  resolveLocalRuntimeVersion,
} from "./runtime.js"
import type { E2BWorkspacePluginOptions, RuntimeWorkspaceAdaptor } from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"

/**
 * OpenCode plugin entrypoint for the E2B workspace adaptor.
 */
export const E2BWorkspacePlugin: Plugin = async (
  { directory, experimental_workspace, serverUrl },
  rawOptions,
) => {
  const options = rawOptions as E2BWorkspacePluginOptions | undefined
  const getLocalRuntimeVersion = createLazyRuntimeVersionResolver(serverUrl)

  const adaptor: RuntimeWorkspaceAdaptor = {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, options, getLocalRuntimeVersion())
    },
    async create(info, env) {
      await createWorkspace(info, env, directory, getLocalRuntimeVersion(), options)
    },
    async remove(info) {
      const config = resolveWorkspaceConfig(info, options)
      await removeWorkspaceSandbox(info, config)
    },
    async target(info) {
      const localRuntimeVersion = await getLocalRuntimeVersion()
      const config = resolveWorkspaceConfig(info, options)
      const contract = resolveWorkspaceContract(info, config, localRuntimeVersion)
      const record = await requireWorkspaceSandboxRecord(info, config)
      const baseUrl = sandboxBaseUrl(record.sandbox, config)

      await assertWorkspaceCompatibility({
        workspaceID: info.id,
        localRuntimeVersion,
        persistedContract: contract,
        sandboxContract: readSandboxContract(record.metadata),
        sandbox: record.sandbox,
        baseUrl,
        projectPath: config.projectPath,
      })

      return {
        type: "remote",
        url: baseUrl,
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
async function configureWorkspace(
  info: WorkspaceInfo,
  options: E2BWorkspacePluginOptions | undefined,
  runtimeVersionPromise: Promise<string>,
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options)
  const runtimeVersion = await runtimeVersionPromise

  return {
    ...info,
    name: defaultWorkspaceName(info),
    directory: config.projectPath,
    extra: buildPersistedExtra(config, runtimeVersion),
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
  runtimeVersionPromise: Promise<string>,
  options?: E2BWorkspacePluginOptions,
): Promise<void> {
  const config = resolveWorkspaceConfig(info, options)
  const runtimeVersion = await runtimeVersionPromise
  const contract = resolveWorkspaceContract(info, config, runtimeVersion)
  const existingRecord = await findWorkspaceSandboxRecord(info, config)
  if (existingRecord) {
    try {
      await assertWorkspaceCompatibility({
        workspaceID: info.id,
        localRuntimeVersion: runtimeVersion,
        persistedContract: contract,
        sandboxContract: readSandboxContract(existingRecord.metadata),
        sandbox: existingRecord.sandbox,
        baseUrl: sandboxBaseUrl(existingRecord.sandbox, config),
        projectPath: config.projectPath,
      })

      return
    } catch {
      await existingRecord.sandbox.kill()
    }
  }

  const sandbox = await createWorkspaceSandbox(info, config, env, contract)

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

/**
 * Cache the local runtime version lookup so repeated adaptor calls compare
 * against a single consistent controller version.
 */
function createLazyRuntimeVersionResolver(serverUrl: URL): () => Promise<string> {
  let runtimeVersionPromise: Promise<string> | undefined

  return () => {
    runtimeVersionPromise ??= resolveLocalRuntimeVersion(serverUrl).catch((error) => {
      runtimeVersionPromise = undefined
      throw error
    })
    return runtimeVersionPromise
  }
}
