/**
 * Runs shell commands in the project's sandbox, with the file sync around them, and
 * remembers what the sandbox has between commands.
 */

import { type Sandbox, SandboxNotFoundError } from "e2b"
import type { Box } from "./box.js"
import type { RunRequest } from "./protocol.js"
import { applySpool, boxState, parseReport, runCommand, syncWarnings } from "./remote.js"
import { type Pulled, type State, pull, push } from "./sync.js"

export interface SyncInfo {
  at: Date
  sent: number
  pulled: Pulled
}

/** Where a command's output goes: the command's own bytes, and the plugin's notes. */
export interface Output {
  data(data: string): void
  note(text: string): void
}

export interface Runner {
  /** Run one command. Resolves with its exit code. */
  run(request: RunRequest, output: Output, killed: AbortSignal): Promise<number>
  /** Start the sandbox and upload the project in the background, before the first command needs it. */
  warm(): void
  /** Send host changes in the background soon, if the sandbox is running. Called after the agent edits files. */
  syncSoon(): void
  lastSync(): SyncInfo | undefined
  lastError(): string | undefined
  /** Why the project's .git was not sent, if it was not. */
  gitSkipped(): string | undefined
  close(): void
}

const SYNC_SOON_MS = 150
const LIST_LIMIT = 5
const NOTHING_PULLED: Pulled = { written: [], removed: [], conflicts: [] }
const NOT_A_REPO =
  "opencode-e2b runs commands in a sandbox copy of your git repository, and this folder is not in one. Run `git init`, or turn the sandbox off with /e2b-off."

export function createRunner(root: string | undefined, box: Box, shipGit: boolean | "auto"): Runner {
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

  /** Upload what changed into the sandbox spool. Resolves with the number of files sent. */
  const prepare = (sandbox: Sandbox, project: string) =>
    locked(async () => {
      const current = state?.sandboxId === sandbox.sandboxId ? state.value : await boxState(sandbox, project)
      const result = await push(sandbox, project, current, shipGit)
      state = { sandboxId: sandbox.sandboxId, value: result.state }
      gitSkipped = result.gitSkipped ?? gitSkipped
      return result.sent
    })

  /** Connect (or create) the sandbox and send what changed. A sandbox that is gone is replaced once. */
  async function connectAndPrepare(project: string, output: Output) {
    const attempt = async () => {
      const sandbox = await box.get(() => {
        output.note("starting a sandbox for this project and uploading it (first command only)")
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

  async function bringBack(sandbox: Sandbox, project: string, stderr: string): Promise<Pulled> {
    const report = parseReport(stderr)
    if (!report) {
      return NOTHING_PULLED
    }
    return locked(async () => {
      if (state?.sandboxId !== sandbox.sandboxId) {
        throw new Error(
          "the sandbox changed while the command ran, so its file changes were not brought back",
        )
      }
      const result = await pull(sandbox, project, state.value, report)
      state = { sandboxId: sandbox.sandboxId, value: result.state }
      return result.pulled
    })
  }

  async function run(request: RunRequest, output: Output, killed: AbortSignal): Promise<number> {
    if (!root) {
      throw new Error(NOT_A_REPO)
    }
    await warming?.catch(() => undefined)
    const { sandbox, sent } = await connectAndPrepare(root, output)
    const { code, stderr } = await runCommand(sandbox, root, request, output.data, killed, box.keepAlive)
    for (const warning of syncWarnings(stderr)) {
      output.note(`sync warning: ${warning}`)
    }
    const pulled = await bringBack(sandbox, root, stderr)
    last = { at: new Date(), sent, pulled }
    if (pulled.written.length > 0 || pulled.removed.length > 0) {
      output.note(`synced to your machine: ${summary([...pulled.written, ...pulled.removed])}`)
    }
    if (pulled.conflicts.length > 0) {
      output.note(
        `you changed ${summary(pulled.conflicts)} while the command ran, so your version was kept. The sandbox version is in ${pulled.conflictDir ?? "the sandbox only (deleted on your machine)"}.`,
      )
    }
    return code
  }

  /** Send host changes and apply them now, without a command. */
  const syncNow = async (sandbox: Sandbox, project: string) => {
    if ((await prepare(sandbox, project)) > 0) {
      await applySpool(sandbox, project)
    }
  }

  const background = (task: () => Promise<void>) =>
    task().catch((err: unknown) => {
      lastError = errorText(err)
    })

  return {
    async run(request, output, killed) {
      try {
        return await run(request, output, killed)
      } catch (err) {
        lastError = errorText(err)
        throw err
      }
    },
    warm() {
      if (!root || box.peek() || warming) {
        return
      }
      warming = background(async () => syncNow(await box.get(), root)).finally(() => {
        warming = undefined
      })
    },
    syncSoon() {
      clearTimeout(soon)
      soon = setTimeout(() => {
        const sandbox = box.peek()
        if (root && sandbox) {
          void background(() => syncNow(sandbox, root))
        }
      }, SYNC_SOON_MS)
    },
    lastSync: () => last,
    lastError: () => lastError,
    gitSkipped: () => gitSkipped,
    close() {
      clearTimeout(soon)
    },
  }
}

export function errorText(err: unknown): string {
  return `opencode-e2b: ${err instanceof Error ? err.message : String(err)}`
}

function summary(paths: string[]): string {
  const shown = paths.slice(0, LIST_LIMIT).join(", ")
  return paths.length > LIST_LIMIT ? `${shown} and ${paths.length - LIST_LIMIT} more` : shown
}
