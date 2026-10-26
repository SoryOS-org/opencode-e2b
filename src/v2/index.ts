/**
 * OpenCode 2 plugin: every shell command runs in an E2B sandbox, files stay local.
 *
 * OpenCode starts each shell command through Shell.create, which first calls the
 * plugin hook `shell.create.before`. The hook swaps the shell for a shim (bin/bash),
 * so OpenCode keeps its own permission checks, timeouts, background jobs and output
 * handling, and only the process runs somewhere else.
 *
 *   opencode/  the OpenCode side: hooks, tools, commands, status
 *   shell/     the shell redirect: shim, the socket it talks to, the runner, git routing
 *   sync/      keeping the sandbox copy equal to the host copy around each command
 *   sandbox/   one E2B sandbox per project
 *   box/       boxes: OpenCode itself running in a sandbox, for long tasks
 *   cli/       the opencode-e2b command for boxes and their model keys
 */

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import "../core/e2b-sdk.js"
import { createProjectSandbox } from "./sandbox/project-sandbox.js"
import { registerBoxCommands } from "./opencode/box-commands.js"
import { registerCommands } from "./opencode/commands.js"
import { createSandboxSwitch } from "./opencode/context.js"
import { gitRoot } from "./sync/files.js"
import { registerHooks } from "./opencode/hooks.js"
import { networkFor, parseOptions } from "./options.js"
import { createRunner } from "./shell/runner.js"
import { startServer } from "./shell/server.js"
import { registerTools } from "./opencode/tools.js"

const plugin: Plugin.Plugin = {
  id: "e2b",
  async setup(opencode) {
    const opts = parseOptions(opencode.options)
    const root = await gitRoot(opencode.location.directory)
    const project = root ?? opencode.location.directory
    const key = createHash("sha256").update(project).digest("hex").slice(0, 16)

    const projectSandbox = createProjectSandbox(opencode.storage, project, key, {
      apiKey: process.env.E2B_API_KEY,
      domain: opts.domain,
      template: opts.template,
      idleMs: opts.idleMs,
      network: networkFor(opts),
    })
    const runner = createRunner(root, projectSandbox, opts.git)
    const server = await startServer(
      path.join(os.tmpdir(), `opencode-e2b-${process.pid}-${key}.sock`),
      runner,
    )
    const sandboxSwitch = await createSandboxSwitch(opencode.storage, `off:${key}`)

    const context = { opencode, opts, root, project, projectSandbox, runner, sandboxSwitch }
    await registerHooks(context, server.socket)
    await registerTools(context)
    await registerCommands(context)
    await registerBoxCommands(context)

    return () => {
      runner.close()
      server.close()
    }
  },
}

export default plugin
