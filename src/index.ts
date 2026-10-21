/**
 * The package entry point. OpenCode 1 reads `server` (its PluginModule). Each entry point
 * imports its own code on first use.
 */

import type { Plugin as PluginV1 } from "@opencode-ai/plugin"

const server: PluginV1 = async (input, options) => (await import("./v1/index.js")).E2BWorkspacePlugin(input, options)

export default { id: "e2b", server }
