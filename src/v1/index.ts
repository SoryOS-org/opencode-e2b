import type { Plugin } from "@opencode-ai/plugin"

import { normalizeOptions, validatePluginOptions, warnDeprecatedBootstrapOptions } from "../core/config.js"
import { runTemplateGC } from "../core/gc.js"
import { createSandboxStore } from "../core/sandbox-store.js"
import { errorMessage } from "../core/shared.js"
import type { E2BWorkspacePluginOptions, PluginLogger } from "../core/types.js"
import { createPluginLogger } from "./logger.js"
import { createE2BWorkspaceAdapter } from "./workspace.js"

/** OpenCode 1 entry point: registers the "e2b" type with the experimental workspace API. */
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
