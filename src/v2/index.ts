/**
 * OpenCode 2 plugin: every shell command runs in an E2B sandbox, files stay local.
 *
 * OpenCode starts each shell command through Shell.create, which first calls the
 * plugin hook `shell.create.before`. The hook swaps the shell for a shim (bin/bash),
 * so OpenCode keeps its own permission checks, timeouts, background jobs and output
 * handling, and only the process runs somewhere else.
 *
 *   hooks.ts     where commands run, sync after edits, warm start, git rules
 *   tools.ts     tools for the agent
 *   commands.ts  slash commands for the user
 *   server.ts    the socket the shim (shim.ts) talks to, see protocol.ts
 *   runner.ts    runs a command in the sandbox with the sync around it (sync.ts)
 *   box.ts       one sandbox per project
 */

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import "../core/e2b-sdk.js"
import { createBox } from "./box.js"
import { registerCommands } from "./commands.js"
import { createMode } from "./context.js"
import { gitRoot } from "./files.js"
import { registerHooks } from "./hooks.js"
import { networkFor, parseOptions } from "./options.js"
import { createRunner } from "./runner.js"
import { startServer } from "./server.js"
import { registerTools } from "./tools.js"

const plugin: Plugin.Plugin = {
  id: "e2b",
  async setup(opencode) {
    const opts = parseOptions(opencode.options as Record<string, unknown> | undefined)
    const root = await gitRoot(opencode.location.directory)
    const project = root ?? opencode.location.directory
    const key = createHash("sha256").update(project).digest("hex").slice(0, 16)

    const box = createBox(opencode.storage, project, key, {
      apiKey: process.env.E2B_API_KEY,
      domain: opts.domain,
      template: opts.template,
      idleMs: opts.idleMs,
      network: networkFor(opts),
    })
    const runner = createRunner(root, box, opts.git)
    const server = await startServer(
      path.join(os.tmpdir(), `opencode-e2b-${process.pid}-${key}.sock`),
      runner,
    )
    const mode = await createMode(opencode.storage, `off:${key}`)

    const context = { opencode, opts, root, project, box, runner, mode }
    await registerHooks(context, server.socket)
    await registerTools(context)
    await registerCommands(context)

    return () => {
      runner.close()
      server.close()
    }
  },
}

export default plugin
