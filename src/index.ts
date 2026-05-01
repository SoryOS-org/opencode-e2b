import type { Plugin, PluginInput, WorkspaceAdaptor, WorkspaceInfo } from "@opencode-ai/plugin"

import { normalizeOptions, validatePluginOptions, warnDeprecatedBootstrapOptions } from "./config.js"
import { runTemplateGC } from "./gc.js"
import { errorMessage } from "./shared.js"
import type { E2BWorkspacePluginOptions, PluginLogger, RuntimeWorkspaceAdaptor } from "./types.js"
import { createE2BWorkspaceAdaptor } from "./workspace.js"

/**
 * OpenCode plugin entrypoint for the E2B workspace adaptor.
 */
export const E2BWorkspacePlugin: Plugin = async (
  { client, directory, experimental_workspace, serverUrl },
  rawOptions,
) => {
  const logger = createPluginLogger(client)
  let options: E2BWorkspacePluginOptions | undefined

  // OpenCode loads plugin options from user-controlled JSON, so shape-check
  // them before any workspace lifecycle code trusts field types. Keep plugin
  // load side-effect-light: commands such as `opencode debug config` load
  // plugins before a local controller is guaranteed to be listening, so
  // network/runtime probes belong in configure/create/target.
  try {
    options = validatePluginOptions(rawOptions)
  } catch (error) {
    await logger.error("plugin load failed", {
      error: errorMessage(error),
    })
    throw error
  }

  await logger.info("registering workspace adaptor", {
    directory,
    serverUrl: serverUrl.toString(),
  })
  // Warn once per process if deprecated bootstrap.* options are set; their
  // values are validated for schema compatibility but no longer affect
  // runtime behavior.
  await warnDeprecatedBootstrapOptions(options, logger)
  const gcConfig = normalizeOptions(options).templateGc

  const adaptor = createE2BWorkspaceAdaptor({
    directory,
    serverUrl,
    options,
    logger,
    gcConfig,
  })

  experimental_workspace.register("e2b", toPublishedWorkspaceAdaptor(adaptor))

  if (gcConfig.enabled) {
    void runTemplateGC(gcConfig, logger).catch(() => {})
  }

  return {}
}

export default E2BWorkspacePlugin

type WorkspaceAdaptorWithRuntimeEnv = Omit<WorkspaceAdaptor, "create"> & {
  create(
    info: WorkspaceInfo,
    envOrFrom?: Record<string, string | undefined> | WorkspaceInfo,
    from?: WorkspaceInfo,
  ): Promise<void>
}

function toPublishedWorkspaceAdaptor(adaptor: RuntimeWorkspaceAdaptor): WorkspaceAdaptor {
  const published: WorkspaceAdaptorWithRuntimeEnv = {
    name: adaptor.name,
    description: adaptor.description,
    configure(info) {
      return adaptor.configure(info)
    },
    create(info, envOrFrom, from) {
      const env = isWorkspaceInfo(envOrFrom) ? {} : envOrFrom
      const sourceWorkspace = isWorkspaceInfo(envOrFrom) ? envOrFrom : from
      return adaptor.create(info, env ?? {}, sourceWorkspace)
    },
    remove(info) {
      return adaptor.remove(info)
    },
    target(info) {
      return adaptor.target(info)
    },
  }

  return published
}

function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  return Boolean(value && typeof value === "object" && "projectID" in value)
}

type PluginLogLevel = "info" | "warn" | "error"

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
