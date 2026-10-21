/**
 * opencode 2 plugin: every shell command runs in an E2B sandbox, files stay local.
 *
 * opencode starts each shell command through Shell.create, which first calls the
 * plugin hook `shell.create.before`. The hook swaps the shell for our shim
 * (bin/bash), so opencode keeps its own permission checks, timeouts, background
 * jobs and output handling, and only the process runs somewhere else.
 *
 * The hook only sets env, because it also runs for commands that the permission
 * check then denies. The sandbox starts on the first command that actually runs.
 */

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import "../core/e2b-sdk.js"
import { createBox } from "./box.js"
import { startServer } from "./server.js"
import { GIT_WRITE, NO_HOOKS, isLocalGit } from "./git.js"
import { describeNetwork, networkFor, parseOptions } from "./options.js"
import { fetchPaths, gitRoot } from "./sync.js"

// dist/v2/index.js -> bin/bash at the package root.
const SHIM = fileURLToPath(new URL("../../bin/bash", import.meta.url))
const READ_LIMIT = 50_000
/** opencode tools that change files on the host. Their changes are sent to the sandbox right away. */
const EDIT_TOOLS = new Set(["edit", "write", "patch"])
const SANDBOX_NOTE = [
  "Commands run in an isolated E2B Linux sandbox (bash), not on the user machine.",
  "The project is at the same path there. It is synced before and after every command: your file edits are visible to commands, and files that commands change come back.",
  "Gitignored files (node_modules, dist, build output, coverage, logs) exist only in the sandbox. Read them with e2b_read or this tool, not with the read tool.",
  "git commands given as a plain single command (git status, git add, git commit, git checkout...) run on the user machine, where the real repository is. Run each git command on its own, never combined with other commands. git hooks do not run for them.",
  "Servers must listen on 0.0.0.0. Use e2b_preview_url to give the user a link.",
].join(" ")

const plugin: Plugin.Plugin = {
  id: "e2b",
  async setup(ctx) {
    const opts = parseOptions(ctx.options as Record<string, unknown> | undefined)
    const root = await gitRoot(ctx.location.directory)
    const project = root ?? ctx.location.directory
    const key = createHash("sha256").update(project).digest("hex").slice(0, 16)
    const box = createBox(ctx.storage, project, key, {
      apiKey: process.env.E2B_API_KEY,
      domain: opts.domain,
      template: opts.template,
      idleMs: opts.idleMs,
      network: networkFor(opts),
    })
    const server = await startServer(
      path.join(os.tmpdir(), `opencode-e2b-${process.pid}-${key}.sock`),
      root,
      box,
      opts.git,
    )

    const offKey = `off:${key}`
    let off = (await ctx.storage.get(offKey)) === true

    await ctx.shell.hook("create.before", (invocation) => {
      if (off) {
        return
      }
      if (isLocalGit(invocation.command)) {
        invocation.env = { ...invocation.env, ...NO_HOOKS }
        return
      }
      invocation.env = {
        ...invocation.env,
        OPENCODE_E2B_SOCKET: server.socket,
        // opencode's own binary is Bun, which runs the TypeScript shim.
        OPENCODE_E2B_RUNTIME: process.execPath,
        OPENCODE_E2B_ENV: opts.env.join(","),
      }
      invocation.shell = SHIM
    })

    // Start the sandbox while the model thinks, so the first command does not wait for it.
    await ctx.session.hook("prompt", () => {
      if (!off) {
        server.warm()
      }
    })
    await ctx.tool.hook("execute.after", (input) => {
      if (!off && input.status === "completed" && EDIT_TOOLS.has(input.tool)) {
        server.syncSoon()
      }
    })
    await ctx.permission.hook("evaluate", (input) => {
      if (off || input.action !== "shell" || input.effect === "deny") {
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
      if (!off && shell && !shell.description.includes(SANDBOX_NOTE)) {
        shell.description = `${shell.description}\n\n${SANDBOX_NOTE}`
      }
    }
    await ctx.session.hook("context", describe)
    await ctx.session.hook("compaction", describe)
    await ctx.session.hook("generate", describe)

    const status = async (): Promise<string> => {
      const sandbox = box.peek()
      const sync = server.lastSync()
      const [metrics, saved] = await Promise.all([box.metrics(), box.savedSnapshot()])
      const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
      return [
        `Commands run: ${off ? "on your machine (/e2b-on to use the sandbox)" : "in the E2B sandbox"}`,
        `Project: ${project}${root ? "" : " (not a git repository, so commands cannot run in the sandbox)"}`,
        `Sandbox: ${sandbox ? sandbox.sandboxId : "not connected (starts on the next command)"}`,
        `Template: ${opts.template}, pauses after ${opts.idleMs / 60_000} min idle`,
        `New sandboxes start from: ${saved ? `snapshot ${saved.snapshotId} (saved ${saved.at})` : `the ${opts.template} template`}`,
        ...(metrics
          ? [
              `Usage: CPU ${Math.round(metrics.cpuUsedPct)}% of ${metrics.cpuCount}, memory ${mb(metrics.memUsed)} of ${mb(metrics.memTotal)}, disk ${mb(metrics.diskUsed)} of ${mb(metrics.diskTotal)}`,
            ]
          : []),
        `Network: ${describeNetwork(opts)}`,
        `Git history in the sandbox: ${
          opts.git === false
            ? "off (git option is false)"
            : server.gitSkipped()
              ? `not sent: ${server.gitSkipped()}. Plain git commands still run on your machine. Set git: true to send it anyway.`
              : "sent"
        }`,
        sync
          ? `Last sync: ${sync.at.toLocaleTimeString()}, sent ${sync.sent} file(s), brought back ${sync.pulled.written.length + sync.pulled.removed.length}, conflicts ${sync.pulled.conflicts.length}`
          : "Last sync: none yet",
        ...(server.lastError() ? [`Last error: ${server.lastError()}`] : []),
      ].join("\n")
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "e2b_preview_url",
        description:
          "Get the public URL of a port served in the E2B sandbox. Use it after you start a server, so the user gets a link. The server must listen on 0.0.0.0.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
          required: ["port"],
          additionalProperties: false,
        },
        async execute(input) {
          const { port } = input as { port: number }
          const sandbox = await box.get()
          return { content: `https://${sandbox.getHost(port)}` }
        },
      })
      tools.add({
        name: "e2b_read",
        description: `Read a text file from the E2B sandbox, for files that exist only there (build output, coverage, logs, node_modules). Relative paths are relative to the project. Returns at most ${READ_LIMIT} bytes from offset.`,
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(input) {
          const { path: file, offset = 0 } = input as { path: string; offset?: number }
          const sandbox = await box.get()
          const bytes = await sandbox.files.read(path.resolve(project, file), { format: "bytes" })
          const slice = Buffer.from(bytes).subarray(offset, offset + READ_LIMIT)
          const rest = bytes.length - offset - slice.length
          return {
            content:
              rest > 0
                ? `${slice.toString()}\n\n[${rest} more bytes, read again with offset ${offset + slice.length}]`
                : slice.toString(),
          }
        },
      })
      tools.add({
        name: "e2b_status",
        description:
          "Show the E2B sandbox state: where commands run, the sandbox id, CPU, memory and disk use, network rules, and the last file sync.",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: await status() }),
      })
    })

    // A command result goes to the session as a synthetic message. The TUI shows only its
    // description, so that carries the answer; the text is the full version for the model.
    const reply = async (
      sessionID: Parameters<typeof ctx.session.synthetic>[0]["sessionID"],
      text: string,
      summary = text,
    ) => {
      await ctx.session.synthetic({
        sessionID,
        text: `[e2b] ${text}`,
        description: `e2b · ${summary}`,
        resume: false,
      })
    }
    const statusLine = async (): Promise<string> => {
      const sandbox = box.peek()
      const sync = server.lastSync()
      const metrics = await box.metrics()
      return [
        off
          ? "commands run on your machine"
          : sandbox
            ? `sandbox ${sandbox.sandboxId} running`
            : "no sandbox yet",
        sync
          ? `last sync ${sync.at.toLocaleTimeString()}, ${sync.pulled.conflicts.length} conflicts`
          : undefined,
        metrics
          ? `CPU ${Math.round(metrics.cpuUsedPct)}%, memory ${Math.round(metrics.memUsed / 1024 / 1024)} of ${Math.round(metrics.memTotal / 1024 / 1024)} MB`
          : undefined,
        server.lastError() ? `last error: ${server.lastError()}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    }
    const setOff = async (value: boolean) => {
      off = value
      await ctx.storage.set(offKey, value)
    }

    // Registered unconditionally: opencode replays transforms on every reload.
    await ctx.command.transform((commands) => {
      commands.add({
        name: "e2b-status",
        description: "Show where commands run and the sandbox state",
        execute: async ({ sessionID }) => reply(sessionID, await status(), await statusLine()),
      })
      commands.add({
        name: "e2b-pull",
        description:
          "Copy files that exist only in the sandbox (e.g. dist) to your machine: /e2b-pull <path>",
        execute: async ({ sessionID, prompt }) => {
          const paths = (prompt.text ?? "").trim().split(/\s+/).filter(Boolean)
          if (!root || paths.length === 0) {
            await reply(
              sessionID,
              root ? "Usage: /e2b-pull <path> [more paths]" : "This folder is not a git repository.",
            )
            return
          }
          await fetchPaths(await box.get(), root, paths)
          await reply(sessionID, `Copied from the sandbox: ${paths.join(", ")}`)
        },
      })
      commands.add({
        name: "e2b-reset",
        description: "Delete the sandbox. The next command starts a fresh one.",
        execute: async ({ sessionID }) => {
          const killed = await box.kill()
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
            const cleared = await box.clearSnapshot()
            await reply(
              sessionID,
              cleared
                ? `New sandboxes start from the ${opts.template} template again.`
                : "No snapshot was in use.",
            )
            return
          }
          const saved = await box.snapshot()
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
          await setOff(true)
          await reply(sessionID, "Commands now run on your machine. /e2b-on switches back to the sandbox.")
        },
      })
      commands.add({
        name: "e2b-on",
        description: "Run commands in the E2B sandbox again, for this project",
        execute: async ({ sessionID }) => {
          await setOff(false)
          await reply(sessionID, "Commands now run in the E2B sandbox.")
        },
      })
    })

    return () => {
      server.close()
    }
  },
}

export default plugin
