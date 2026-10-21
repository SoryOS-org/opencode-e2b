import type { PluginInput } from "@opencode-ai/plugin"

import type { PluginLogger } from "../core/types.js"

type PluginLogLevel = "debug" | "info" | "warn" | "error"

export function createPluginLogger(client: PluginInput["client"]): PluginLogger {
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
