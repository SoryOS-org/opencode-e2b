/**
 * One package for OpenCode 1 and OpenCode 2.
 *
 * OpenCode 1 reads `server` (its PluginModule) and OpenCode 2 reads `id` and `setup`
 * (its Plugin). Each entry point imports its own code on first use, so a runtime never
 * loads the other release's code.
 */

import type { Plugin as PluginV1 } from "@opencode-ai/plugin"
import type { Plugin as PluginV2 } from "@opencode/plugin"

const server: PluginV1 = async (input, options) =>
  (await import("./v1/index.js")).E2BWorkspacePlugin(input, options)

const setup: PluginV2.Plugin["setup"] = async (context) =>
  (await import("./v2/index.js")).default.setup(context)

export default { id: "e2b", setup, server }
