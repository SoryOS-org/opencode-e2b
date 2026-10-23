/** What the plugin's hooks, tools and commands share. */

import type { Plugin } from "@opencode/plugin"
import type { Box } from "./box.js"
import type { Options } from "./options.js"
import type { Runner } from "./runner.js"

/** Whether commands run in the sandbox or on the user's machine, per project. Kept in plugin storage. */
export interface Mode {
  readonly off: boolean
  set(off: boolean): Promise<void>
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
  mode: Mode
}

export async function createMode(storage: Plugin.Context["storage"], key: string): Promise<Mode> {
  let off = (await storage.get(key)) === true
  return {
    get off() {
      return off
    },
    async set(value) {
      off = value
      await storage.set(key, value)
    },
  }
}
