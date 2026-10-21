/**
 * The plugin side of the shim. opencode spawns the shim as its shell; the shim
 * connects here over a unix socket and this server runs the command in the sandbox,
 * with the file sync around it.
 *
 * Protocol: newline-delimited JSON.
 *   shim -> server  {type:'run', command, cwd, env}  then optionally {type:'kill'}
 *   server -> shim  {type:'out', data:<base64>}...   then {type:'exit', code} or {type:'error', message}
 */

import { rmSync } from "node:fs"
import net from "node:net"
import { CommandExitError, type Sandbox, SandboxNotFoundError } from "e2b"
import type { Box } from "./box.js"
import { type Pulled, type State, WRAPPER, applySpool, boxState, parseReport, pull, push } from "./sync.js"

export interface RunRequest {
  type: "run"
  command: string
  cwd: string
  env: Record<string, string>
}

export type ServerMessage =
  | { type: "out"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }

export interface SyncInfo {
  at: Date
  sent: number
  pulled: Pulled
}

export interface Server {
  socket: string
  lastSync(): SyncInfo | undefined
  lastError(): string | undefined
  /** Why the project's .git was not sent, if it was not. */
  gitSkipped(): string | undefined
  /** Start the sandbox and upload the project in the background, before the first command needs it. */
  warm(): void
  /** Send host changes in the background soon, if the sandbox is running. Called after the agent edits files. */
  syncSoon(): void
  close(): void
}

const LIST_LIMIT = 5
const SYNC_SOON_MS = 150
const NOTHING_PULLED: Pulled = { written: [], removed: [], conflicts: [] }

export function startServer(
  socket: string,
  root: string | undefined,
  box: Box,
  shipGit: boolean | "auto",
): Promise<Server> {
  /** The agreed file state, valid for the sandbox with this id. */
  let state: { sandboxId: string; value: State } | undefined
  let last: SyncInfo | undefined
  let lastError: string | undefined
  let gitSkipped: string | undefined
  let warming: Promise<void> | undefined
  let soon: ReturnType<typeof setTimeout> | undefined

  // Pushes and pulls change the agreed state, so they run one at a time. Commands run in parallel.
  let chain: Promise<unknown> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn)
    chain = result.catch(() => undefined)
    return result
  }

  /** Upload what changed into the sandbox spool. Returns the number of files sent. */
  const prepare = (sandbox: Sandbox, project: string) =>
    locked(async () => {
      const current = state?.sandboxId === sandbox.sandboxId ? state.value : await boxState(sandbox, project)
      const result = await push(sandbox, project, current, shipGit)
      state = { sandboxId: sandbox.sandboxId, value: result.state }
      gitSkipped = result.gitSkipped ?? gitSkipped
      return result.sent
    })

  async function connectAndPrepare(project: string, say: (text: string) => void) {
    const attempt = async () => {
      const sandbox = await box.get(() => {
        say("starting a sandbox for this project and uploading it (first command only)")
      })
      return { sandbox, sent: await prepare(sandbox, project) }
    }
    try {
      return await attempt()
    } catch (err) {
      if (!(err instanceof SandboxNotFoundError)) {
        throw err
      }
      box.forget()
      return attempt()
    }
  }

  async function handle(conn: net.Socket, req: RunRequest, killed: AbortSignal): Promise<void> {
    const send = (msg: ServerMessage) => {
      conn.write(`${JSON.stringify(msg)}\n`)
    }
    const out = (data: Uint8Array | string) => {
      send({ type: "out", data: Buffer.from(data).toString("base64") })
    }
    const say = (text: string) => {
      out(`[e2b] ${text}\n`)
    }

    if (!root) {
      send({
        type: "error",
        message:
          "opencode-e2b runs commands in a sandbox copy of your git repository, and this folder is not in one. Run `git init`, or turn the sandbox off with /e2b-off.",
      })
      return
    }

    await warming?.catch(() => undefined)
    const { sandbox, sent } = await connectAndPrepare(root, say)
    const { code, stderr } = await exec(sandbox, root, req, out, killed, box)
    for (const line of stderr.split("\n")) {
      if (line.trim() && !line.startsWith("OPENCODE_E2B_SYNC ")) {
        say(`sync warning: ${line}`)
      }
    }

    const report = parseReport(stderr)
    let pulled = NOTHING_PULLED
    if (report) {
      pulled = await locked(async () => {
        if (state?.sandboxId !== sandbox.sandboxId) {
          throw new Error(
            "the sandbox changed while the command ran, so its file changes were not brought back",
          )
        }
        const result = await pull(sandbox, root, state.value, report)
        state = { sandboxId: sandbox.sandboxId, value: result.state }
        return result.pulled
      })
    }
    last = { at: new Date(), sent, pulled }
    if (pulled.written.length > 0 || pulled.removed.length > 0) {
      say(`synced to your machine: ${summary([...pulled.written, ...pulled.removed])}`)
    }
    if (pulled.conflicts.length > 0) {
      say(
        `you changed ${summary(pulled.conflicts)} while the command ran, so your version was kept. The sandbox version is in ${pulled.conflictDir ?? "the sandbox only (deleted on your machine)"}.`,
      )
    }
    send({ type: "exit", code })
  }

  const server = net.createServer((conn) => {
    const abort = new AbortController()
    let buffered = ""
    let started = false
    conn.on("data", (chunk) => {
      buffered += chunk.toString()
      let nl = buffered.indexOf("\n")
      while (nl >= 0) {
        const msg = JSON.parse(buffered.slice(0, nl)) as RunRequest | { type: "kill" }
        buffered = buffered.slice(nl + 1)
        nl = buffered.indexOf("\n")
        if (msg.type === "kill") {
          abort.abort()
        } else if (!started) {
          started = true
          handle(conn, msg, abort.signal)
            .catch((err: unknown) => {
              lastError = errorText(err)
              conn.write(`${JSON.stringify({ type: "error", message: lastError } satisfies ServerMessage)}\n`)
            })
            .finally(() => conn.end())
        }
      }
    })
    // The shim died, for example killed by opencode: stop the command too.
    conn.on("close", () => {
      abort.abort()
    })
    conn.on("error", () => {
      abort.abort()
    })
  })

  const background = (task: () => Promise<void>) =>
    task().catch((err: unknown) => {
      lastError = errorText(err)
    })

  rmSync(socket, { force: true })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      resolve({
        socket,
        lastSync: () => last,
        lastError: () => lastError,
        gitSkipped: () => gitSkipped,
        warm() {
          if (!root || box.peek() || warming) {
            return
          }
          warming = background(async () => {
            const sandbox = await box.get()
            if ((await prepare(sandbox, root)) > 0) {
              await applySpool(sandbox, root)
            }
          }).finally(() => {
            warming = undefined
          })
        },
        syncSoon() {
          clearTimeout(soon)
          soon = setTimeout(() => {
            const sandbox = box.peek()
            if (!root || !sandbox) {
              return
            }
            void background(async () => {
              if ((await prepare(sandbox, root)) > 0) {
                await applySpool(sandbox, root)
              }
            })
          }, SYNC_SOON_MS)
        },
        close() {
          clearTimeout(soon)
          server.close()
          rmSync(socket, { force: true })
        },
      })
    })
  })
}

/** Run one command in the sandbox, streaming its output. Resolves with the exit code and the wrapper's own stderr. */
async function exec(
  sandbox: Sandbox,
  root: string,
  req: RunRequest,
  onData: (data: string) => void,
  killed: AbortSignal,
  box: Box,
): Promise<{ code: number; stderr: string }> {
  let stderr = ""
  const handle = await sandbox.commands.run(WRAPPER, {
    background: true,
    cwd: req.cwd,
    // The host env is not forwarded: it holds model API keys and other secrets.
    envs: {
      ...req.env,
      OPENCODE_E2B_ROOT: root,
      OPENCODE_E2B_COMMAND: req.command,
      OPENCODE_E2B_MODE: "run",
    },
    timeoutMs: 0,
    onStdout: onData,
    onStderr: (data) => {
      stderr += data
    },
  })
  // Kill the command's process group only. The wrapper then finishes its sync step
  // and exits, so a cancel never leaves the bookkeeping half-written.
  const stop = () => {
    const group = `$(cat /tmp/opencode-e2b-${handle.pid}.pgid 2>/dev/null)`
    sandbox.commands
      .run(
        `g=${group}; [ -n "$g" ] && { kill -TERM -- -$g; sleep 1; kill -KILL -- -$g; } 2>/dev/null; true`,
        {
          timeoutMs: 10_000,
        },
      )
      .catch(() => handle.kill())
  }
  killed.addEventListener("abort", stop, { once: true })
  // Long commands must not hit the idle timeout.
  const heartbeat = setInterval(() => {
    box.keepAlive()
  }, 60_000)
  try {
    return { code: (await handle.wait()).exitCode, stderr }
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { code: err.exitCode, stderr }
    }
    throw err
  } finally {
    clearInterval(heartbeat)
    killed.removeEventListener("abort", stop)
  }
}

function summary(paths: string[]): string {
  const shown = paths.slice(0, LIST_LIMIT).join(", ")
  return paths.length > LIST_LIMIT ? `${shown} and ${paths.length - LIST_LIMIT} more` : shown
}

function errorText(err: unknown): string {
  return `opencode-e2b: ${err instanceof Error ? err.message : String(err)}`
}
