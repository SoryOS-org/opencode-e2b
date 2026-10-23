/**
 * Keeps the sandbox copy of the project equal to the host copy, around each command,
 * with as few sandbox round trips as possible.
 *
 * The sandbox keeps its bookkeeping in a separate git directory. Its HEAD is the
 * state both sides last agreed on, and the plugin remembers the same state, so a
 * push needs no sandbox round trip to find what changed.
 *
 * Push: changed files go into a spool folder. Every command's wrapper applies the
 * spool (under a lock) before it runs, so an upload costs one round trip, or none
 * when nothing changed.
 * Pull: the wrapper lists and packs what the command changed and reports it on its
 * own stderr. Bringing the files back costs one round trip, only when something
 * changed. If the host file also changed meanwhile, the host copy wins and the
 * sandbox copy is saved under .git/opencode-e2b.
 *
 * The project's own .git is sent one way, host to sandbox, so git can read history
 * in the sandbox. A cheap fingerprint decides when to look at it at all.
 */

import { randomUUID } from "node:crypto"
import { rm, stat } from "node:fs/promises"
import path from "node:path"
import type { Sandbox } from "e2b"
import {
  type GitDirFiles,
  type ProjectFiles,
  diff,
  gitDirBytes,
  gitDirFiles,
  gitFingerprint,
  hostFiles,
  run,
} from "./files.js"
import { type Report, SPOOL } from "./remote.js"
import { download, unpack, upload } from "./transfer.js"

export interface Pulled {
  written: string[]
  removed: string[]
  /** Paths changed on both sides. The host copy was kept. */
  conflicts: string[]
  conflictDir?: string
}

/** What the plugin remembers about the sandbox between commands. */
export interface State {
  files: ProjectFiles
  /** Files under .git as last sent, keyed relative to .git. */
  git?: { fingerprint: string; files: GitDirFiles }
}

/** With git: 'auto', history is sent only up to this size. A 600 MB .git takes about 2 minutes to upload. */
export const GIT_AUTO_MAX_BYTES = 200 * 1024 * 1024

/**
 * Send what changed on the host since `state`, into the sandbox spool. One round trip
 * when something changed, none otherwise. Returns the new agreed state and the
 * number of files sent.
 */
export async function push(
  sandbox: Sandbox,
  root: string,
  state: State,
  shipGit: boolean | "auto",
): Promise<{ state: State; sent: number; gitSkipped?: string }> {
  const host = await hostFiles(root)
  const { changed, removed } = diff(state.files, host)
  let git = state.git
  const gitChanged: string[] = []
  const gitRemoved: string[] = []
  const gitDir = path.join(root, ".git")
  const isGitDir = await stat(gitDir).then(
    (s) => s.isDirectory(),
    () => false,
  )
  let gitSkipped: string | undefined
  if (shipGit !== false && isGitDir) {
    const fingerprint = await gitFingerprint(gitDir)
    const files = fingerprint === git?.fingerprint ? undefined : await gitDirFiles(gitDir)
    const total = files ? gitDirBytes(files) : 0
    if (files && shipGit === "auto" && total > GIT_AUTO_MAX_BYTES) {
      gitSkipped = `.git is ${Math.round(total / 1024 / 1024)} MB, over the ${GIT_AUTO_MAX_BYTES / 1024 / 1024} MB limit for git: "auto"`
      // Remember the fingerprint, so .git is not scanned again until it changes.
      git = { fingerprint, files: git?.files ?? new Map() }
    } else if (files) {
      const d = diff(git?.files ?? new Map(), files)
      gitChanged.push(...d.changed.map((p) => `.git/${p}`))
      gitRemoved.push(...d.removed.map((p) => `.git/${p}`))
      git = { fingerprint, files }
    }
  }

  const sent = changed.length + removed.length + gitChanged.length + gitRemoved.length
  if (sent > 0) {
    const id = `${SPOOL}/${Date.now()}-${randomUUID().slice(0, 8)}`
    await upload(
      sandbox,
      root,
      id,
      [...changed, ...gitChanged],
      [
        { path: `${id}.rm`, data: [...removed, ...gitRemoved].join("\0") },
        { path: `${id}.paths`, data: [...changed, ...removed].join("\0") },
      ],
    )
  }
  return { state: { files: host, git }, sent, gitSkipped }
}

/** Bring back what a command changed, as reported by the wrapper. One round trip, or none for small changes. */
export async function pull(
  sandbox: Sandbox,
  root: string,
  state: State,
  report: Report,
): Promise<{ state: State; pulled: Pulled }> {
  const host = await hostFiles(root)
  const hostMoved = (p: string) => host.get(p) !== state.files.get(p)
  const pulled: Pulled = {
    written: report.paths.filter((p) => report.files.has(p) && !hostMoved(p)),
    removed: report.paths.filter((p) => !report.files.has(p) && !hostMoved(p)),
    conflicts: report.paths.filter(hostMoved),
  }

  const gitDir = path.resolve(
    root,
    (await run("git", ["rev-parse", "--git-dir"], { cwd: root })).toString().trim(),
  )
  const ours = path.join(gitDir, "opencode-e2b")
  const keptInBox = pulled.conflicts.filter((p) => report.files.has(p))
  if (keptInBox.length > 0) {
    pulled.conflictDir = path.join(ours, "conflicts", new Date().toISOString().replaceAll(":", "-"))
  }
  await unpack(await download(sandbox, report.tarball), ours, [
    { paths: pulled.written, dest: root },
    ...(pulled.conflictDir ? [{ paths: keptInBox, dest: pulled.conflictDir }] : []),
  ])
  for (const p of pulled.removed) {
    await rm(path.join(root, p), { force: true })
  }

  // The sandbox state wins in the record, conflicts included, so the next push sends
  // the host version of a conflicted file back to the sandbox.
  const files = new Map(state.files)
  for (const p of report.paths) {
    const value = report.files.get(p)
    if (value === undefined) {
      files.delete(p)
    } else {
      files.set(p, value)
    }
  }
  return { state: { ...state, files }, pulled }
}
