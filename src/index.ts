import type { Plugin, PluginInput, WorkspaceInfo } from "@opencode-ai/plugin"

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
  sandboxTargetHeaders,
} from "./e2b.js"
import {
  assertWorkspaceCompatibility,
  forgetSandboxCompatibility,
  resolveLocalRuntimeVersion,
} from "./runtime.js"
import type { E2BWorkspacePluginOptions, RuntimeWorkspaceAdaptor } from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"

/**
 * OpenCode plugin entrypoint for the E2B workspace adaptor.
 */
export const E2BWorkspacePlugin: Plugin = async (
  { client, directory, experimental_workspace, serverUrl },
  rawOptions,
) => {
  const options = rawOptions as E2BWorkspacePluginOptions | undefined
  const logger = createPluginLogger(client)
  const getLocalRuntimeVersion = createLazyRuntimeVersionResolver(serverUrl, logger)

  await logger.info("registering workspace adaptor", {
    directory,
    serverUrl: serverUrl.toString(),
  })

  const adaptor: RuntimeWorkspaceAdaptor = {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, options, getLocalRuntimeVersion(), logger)
    },
    async create(info, env) {
      await createWorkspace(info, env, directory, getLocalRuntimeVersion(), options, logger)
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
      const headers = sandboxTargetHeaders(record.sandbox, config)

      await assertWorkspaceCompatibility({
        workspaceID: info.id,
        localRuntimeVersion,
        persistedContract: contract,
        sandboxContract: readSandboxContract(record.metadata),
        sandbox: record.sandbox,
        baseUrl,
        projectPath: config.projectPath,
        headers,
      })

      return {
        type: "remote",
        url: baseUrl,
        ...(headers ? { headers } : {}),
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
  logger: PluginLogger,
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options)
  await logger.info("configure workspace start", {
    workspaceID: info.id,
    branch: info.branch ?? undefined,
    projectPath: config.projectPath,
    template: config.template,
  })
  const runtimeVersion = await runtimeVersionPromise

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
  logger?: PluginLogger,
): Promise<void> {
  const config = resolveWorkspaceConfig(info, options)
  let stage = "resolve-runtime-version"

  await logger?.info("create workspace start", {
    workspaceID: info.id,
    localDirectory,
    projectPath: config.projectPath,
    template: config.template,
  })

  try {
    const runtimeVersion = await runtimeVersionPromise
    await logger?.info("create workspace resolved local runtime", {
      workspaceID: info.id,
      runtimeVersion,
    })

    stage = "resolve-contract"
    const contract = resolveWorkspaceContract(info, config, runtimeVersion)

    stage = "find-existing-sandbox"
    const existingRecord = await findWorkspaceSandboxRecord(info, config)
    if (existingRecord) {
      await logger?.info("create workspace found existing sandbox", {
        workspaceID: info.id,
        sandboxID: existingRecord.sandbox.sandboxId,
      })

      stage = "validate-existing-sandbox"
      try {
        await assertWorkspaceCompatibility({
          workspaceID: info.id,
          localRuntimeVersion: runtimeVersion,
          persistedContract: contract,
          sandboxContract: readSandboxContract(existingRecord.metadata),
          sandbox: existingRecord.sandbox,
          baseUrl: sandboxBaseUrl(existingRecord.sandbox, config),
          projectPath: config.projectPath,
          headers: sandboxTargetHeaders(existingRecord.sandbox, config),
        })

        await logger?.info("create workspace reusing compatible sandbox", {
          workspaceID: info.id,
          sandboxID: existingRecord.sandbox.sandboxId,
        })
        return
      } catch (error) {
        await logger?.warn("create workspace replacing incompatible sandbox", {
          workspaceID: info.id,
          sandboxID: existingRecord.sandbox.sandboxId,
          error: errorMessage(error),
        })
        try {
          await existingRecord.sandbox.kill()
        } finally {
          forgetSandboxCompatibility(existingRecord.sandbox.sandboxId)
        }
      }
    }

    stage = "create-sandbox"
    await logger?.info("create workspace provisioning sandbox", {
      workspaceID: info.id,
    })
    const sandbox = await createWorkspaceSandbox(info, config, env, contract)

    try {
      stage = "upload-snapshot"
      await logger?.info("create workspace uploading snapshot", {
        workspaceID: info.id,
        sandboxID: sandbox.sandboxId,
        localDirectory,
      })
      await uploadLocalSnapshot({
        sandbox,
        localRoot: localDirectory,
        remoteRoot: config.projectPath,
        upload: config.upload,
      })

      stage = "bootstrap-remote-opencode"
      await logger?.info("create workspace bootstrapping remote opencode", {
        workspaceID: info.id,
        sandboxID: sandbox.sandboxId,
      })
      await bootstrapWorkspace({
        sandbox,
        info,
        config,
      })

      await logger?.info("create workspace complete", {
        workspaceID: info.id,
        sandboxID: sandbox.sandboxId,
      })
    } catch (error) {
      await logger?.error("create workspace failed after sandbox provisioned", {
        workspaceID: info.id,
        sandboxID: sandbox.sandboxId,
        stage,
        error: errorMessage(error),
      })
      await sandbox.kill().catch(() => {
        // Ignore sandbox cleanup failures and preserve the original bootstrap error.
      })
      throw error
    }
  } catch (error) {
    await logger?.error("create workspace failed", {
      workspaceID: info.id,
      stage,
      error: errorMessage(error),
    })
    throw error
  }
}

/**
 * Cache the local runtime version lookup so repeated adaptor calls compare
 * against a single consistent controller version.
 */
function createLazyRuntimeVersionResolver(serverUrl: URL, logger: PluginLogger): () => Promise<string> {
  let runtimeVersionPromise: Promise<string> | undefined

  return () => {
    if (!runtimeVersionPromise) {
      runtimeVersionPromise = (async () => {
        await logger.info("resolving local runtime version", {
          serverUrl: serverUrl.toString(),
        })
        try {
          const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger)
          await logger.info("resolved local runtime version", {
            serverUrl: serverUrl.toString(),
            runtimeVersion,
          })
          return runtimeVersion
        } catch (error) {
          await logger.error("failed to resolve local runtime version", {
            serverUrl: serverUrl.toString(),
            error: errorMessage(error),
          })
          runtimeVersionPromise = undefined
          throw error
        }
      })()
    }
    return runtimeVersionPromise
  }
}

type PluginLogLevel = "info" | "warn" | "error"

type PluginLogger = {
  info(message: string, extra?: Record<string, unknown>): Promise<void>
  warn(message: string, extra?: Record<string, unknown>): Promise<void>
  error(message: string, extra?: Record<string, unknown>): Promise<void>
}

/**
 * Write plugin diagnostics through OpenCode's normal application log route so
 * they land in the standard log file during workspace debugging.
 */
function createPluginLogger(client: PluginInput["client"]): PluginLogger {
  async function write(level: PluginLogLevel, message: string, extra?: Record<string, unknown>) {
    await client.app
      .log({
        body: {
          service: "e2b-workspace-plugin",
          level,
          message,
          extra,
        },
      })
      .catch(() => {
        // Avoid masking the real workspace error if diagnostic logging fails.
      })
  }

  return {
    info(message, extra) {
      return write("info", message, extra)
    },
    warn(message, extra) {
      return write("warn", message, extra)
    },
    error(message, extra) {
      return write("error", message, extra)
    },
  }
}

/**
 * Normalize unknown thrown values into a readable message for log metadata.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
