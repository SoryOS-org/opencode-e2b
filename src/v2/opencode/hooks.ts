/**
 * The OpenCode hooks: where shell commands run, the sync after file edits, the warm
 * start, the git rules, and the note in the shell tool's description.
 */

import { fileURLToPath } from "node:url"
import type { PluginContext } from "./context.js"
import { GIT_WRITE, NO_HOOKS, isLocalGit } from "../shell/git.js"
import { ENV } from "../shell/protocol.js"

// dist/v2/opencode/hooks.js -> bin/bash at the package root.
const SHIM = fileURLToPath(new URL("../../../bin/bash", import.meta.url))
/** OpenCode tools that change files on the host. Their changes go to the sandbox right away. */
const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const SANDBOX_NOTE = [
  "Commands run in an isolated E2B Linux sandbox (bash), not on the user machine.",
  "The project is at the same path there. It is synced before and after every command: your file edits are visible to commands, and files that commands change come back.",
  "Gitignored files (node_modules, dist, build output, coverage, logs) exist only in the sandbox. Read them with e2b_read or this tool, not with the read tool.",
  "git commands given as a plain single command (git status, git add, git commit, git checkout...) run on the user machine, where the real repository is. Run each git command on its own, never combined with other commands. git hooks do not run for them.",
  "Servers must listen on 0.0.0.0. Use e2b_preview_url to give the user a link.",
].join(" ")

export async function registerHooks(plugin: PluginContext, socket: string): Promise<void> {
  const { opencode, opts, runner, mode } = plugin

  // The hook only sets env and the shell: it also runs for commands that the
  // permission check then denies, so the sandbox starts when the shim connects.
  await opencode.shell.hook("create.before", (invocation) => {
    if (mode.off) {
      return
    }
    if (isLocalGit(invocation.command)) {
      invocation.env = { ...invocation.env, ...NO_HOOKS }
      return
    }
    invocation.env = {
      ...invocation.env,
      [ENV.socket]: socket,
      [ENV.runtime]: process.execPath,
      [ENV.forward]: opts.env.join(","),
    }
    invocation.shell = SHIM
  })

  // Start the sandbox while the model thinks, so the first command does not wait for it.
  await opencode.session.hook("prompt", () => {
    if (!mode.off) {
      runner.warm()
    }
  })

  await opencode.tool.hook("execute.after", (input) => {
    if (!mode.off && input.status === "completed" && EDIT_TOOLS.has(input.tool)) {
      runner.syncSoon()
    }
  })

  await opencode.permission.hook("evaluate", (input) => {
    if (mode.off || input.action !== "shell" || input.effect === "deny") {
      return
    }
    // A plain git command runs on the user's machine (see the shell hook). Combined
    // with other commands it would run in the sandbox, where its history changes are lost.
    const plain = input.resources.length === 1 && isLocalGit(input.resources[0] ?? "")
    const blocked = input.resources.find((resource) => GIT_WRITE.test(resource.trim()))
    if (blocked && !plain) {
      input.effect = "deny"
      input.message = `"${blocked}" changes git history or the index, so it must run on the user's machine. That works only as a plain single git command: run it on its own, without other commands, pipes or variables.`
    }
  })

  const describe = (input: { tools: Record<string, { description: string }> }) => {
    const shell = input.tools.shell
    if (!mode.off && shell && !shell.description.includes(SANDBOX_NOTE)) {
      shell.description = `${shell.description}\n\n${SANDBOX_NOTE}`
    }
  }
  await opencode.session.hook("context", describe)
  await opencode.session.hook("compaction", describe)
  await opencode.session.hook("generate", describe)
}
