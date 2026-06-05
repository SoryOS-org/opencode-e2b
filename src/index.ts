import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { normalizeOptions, validatePluginOptions, warnDeprecatedBootstrapOptions } from "./config.js"
import { runTemplateGC } from "./gc.js"
import { createSandboxStore } from "./sandbox-store.js"
import { errorMessage } from "./shared.js"
import type { E2BWorkspacePluginOptions, PluginLogger } from "./types.js"
import { createE2BWorkspaceAdapter } from "./workspace.js"

export const E2BWorkspacePlugin: Plugin = async (
  { client, directory, experimental_workspace, serverUrl },
  rawOptions,
) => {
  const logger = createPluginLogger(client)
  let options: E2BWorkspacePluginOptions | undefined

  // Keep plugin load side-effect-light: `opencode debug config` can load
  // plugins before the local controller is listening.
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
  await warnDeprecatedBootstrapOptions(options, logger)
  const gcConfig = normalizeOptions(options).templateGc
  const sandboxStore = await createSandboxStore(logger)

  const adapter = createE2BWorkspaceAdapter({
    client,
    directory,
    serverUrl,
    options,
    logger,
    gcConfig,
    sandboxStore,
  })

  experimental_workspace.register("e2b", adapter)

  if (gcConfig.enabled) {
    void runTemplateGC(gcConfig, logger).catch(() => {})
  }

  return {}
}

export default E2BWorkspacePlugin

type PluginLogLevel = "debug" | "info" | "warn" | "error"

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
        // Logging must not mask the workspace error being reported.
      })
  }

  return {
    debug(message, extra) {
      return write("debug", message, extra)
    },
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
