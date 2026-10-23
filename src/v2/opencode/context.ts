/** What the plugin's hooks, tools and commands share. */

import type { Plugin } from "@opencode/plugin"
import type { Box } from "../sandbox/box.js"
import type { Options } from "../options.js"
import type { Runner } from "../shell/runner.js"

/** Whether commands run in the sandbox (enabled) or on the user's machine, per project. Kept in plugin storage. */
export interface SandboxSwitch {
  readonly enabled: boolean
  setEnabled(enabled: boolean): Promise<void>
}

export interface PluginContext {
  opencode: Plugin.Context
  opts: Options
  /** The git checkout the plugin syncs, or undefined outside one. */
  root: string | undefined
  /** `root`, or the opened folder outside a git checkout. */
  project: string
  box: Box
  runner: Runner
  sandboxSwitch: SandboxSwitch
}

/** Stored as `off: true` when the user turned the sandbox off, so the default is on. */
export async function createSandboxSwitch(
  storage: Plugin.Context["storage"],
  key: string,
): Promise<SandboxSwitch> {
  let enabled = (await storage.get(key)) !== true
  return {
    get enabled() {
      return enabled
    },
    async setEnabled(value) {
      enabled = value
      await storage.set(key, !value)
    },
  }
}
