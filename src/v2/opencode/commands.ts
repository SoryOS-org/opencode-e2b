/** Slash commands for the user: status, pull, snapshot, reset, and switching the sandbox off and on. */

import type { Plugin } from "@opencode/plugin"
import type { PluginContext } from "./context.js"
import { readStatus } from "./status.js"
import { fetchPaths } from "../sync/transfer.js"

type SessionID = Parameters<Plugin.Context["session"]["synthetic"]>[0]["sessionID"]

export async function registerCommands(plugin: PluginContext): Promise<void> {
  const { opencode, opts, root, projectSandbox, sandboxSwitch } = plugin

  // A command's result goes to the session as a synthetic message. The TUI shows only
  // its description, so that carries the answer; the text is the full version for the model.
  const reply = async (sessionID: SessionID, text: string, summary = text) => {
    await opencode.session.synthetic({
      sessionID,
      text: `[e2b] ${text}`,
      description: `e2b · ${summary}`,
      resume: false,
    })
  }

  // Registered unconditionally: OpenCode replays transforms on every reload.
  await opencode.command.transform((commands) => {
    commands.add({
      name: "e2b-status",
      description: "Show where commands run and the sandbox state",
      execute: async ({ sessionID }) => {
        const status = await readStatus(plugin)
        await reply(sessionID, status.text, status.line)
      },
    })

    commands.add({
      name: "e2b-pull",
      description: "Copy files that exist only in the sandbox (e.g. dist) to your machine: /e2b-pull <path>",
      execute: async ({ sessionID, prompt }) => {
        const paths = (prompt.text ?? "").trim().split(/\s+/).filter(Boolean)
        if (!root) {
          await reply(sessionID, "This folder is not a git repository.")
          return
        }
        if (paths.length === 0) {
          await reply(sessionID, "Usage: /e2b-pull <path> [more paths]")
          return
        }
        await fetchPaths(await projectSandbox.get(), root, paths)
        await reply(sessionID, `Copied from the sandbox: ${paths.join(", ")}`)
      },
    })

    commands.add({
      name: "e2b-reset",
      description: "Delete the sandbox. The next command starts a fresh one.",
      execute: async ({ sessionID }) => {
        const killed = await projectSandbox.kill()
        await reply(
          sessionID,
          killed
            ? "Sandbox deleted. The next command starts a fresh one."
            : "There was no sandbox to delete.",
        )
      },
    })

    commands.add({
      name: "e2b-snapshot",
      description:
        "Save the sandbox (installed dependencies, tools) as the start for new ones. /e2b-snapshot clear stops that.",
      execute: async ({ sessionID, prompt }) => {
        if ((prompt.text ?? "").trim() === "clear") {
          const cleared = await projectSandbox.clearSnapshot()
          await reply(
            sessionID,
            cleared
              ? `New sandboxes start from the ${opts.template} template again.`
              : "No snapshot was in use.",
          )
          return
        }
        const saved = await projectSandbox.snapshot()
        await reply(
          sessionID,
          `Saved snapshot ${saved.snapshotId}. New sandboxes for this project start from it, with what is installed now. Your files still sync from your machine.`,
        )
      },
    })

    commands.add({
      name: "e2b-off",
      description: "Run commands on your machine again, for this project",
      execute: async ({ sessionID }) => {
        await sandboxSwitch.setEnabled(false)
        await reply(sessionID, "Commands now run on your machine. /e2b-on switches back to the sandbox.")
      },
    })

    commands.add({
      name: "e2b-on",
      description: "Run commands in the E2B sandbox again, for this project",
      execute: async ({ sessionID }) => {
        await sandboxSwitch.setEnabled(true)
        await reply(sessionID, "Commands now run in the E2B sandbox.")
      },
    })
  })
}
