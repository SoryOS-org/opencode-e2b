/**
 * The host side of the sync: what the project's files are, as git sees them.
 *
 * Project files are described as "<mode> <hash>" per path, from `git add -A` into a
 * scratch index, so .gitignore applies. Files under .git are described as
 * "<size> <mtime seconds>", because .git is sent as plain files.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Project file path -> "<mode> <hash>", as git's index has it. Equal values mean equal files. */
export type ProjectFiles = Map<string, string>

/** Path under .git -> "<size> <mtime seconds>". .git is sent as plain files, so it is compared by size and time. */
export type GitDirFiles = Map<string, string>

/** Total size of the files in .git. */
export function gitDirBytes(files: GitDirFiles): number {
  let bytes = 0
  for (const value of files.values()) {
    bytes += Number(value.split(" ")[0])
  }
  return bytes
}

/** Files that tell whether anything in .git changed: commits, checkouts, staging, fetches. */
const GIT_FINGERPRINT = ["HEAD", "index", "packed-refs", "logs/HEAD", "FETCH_HEAD", "ORIG_HEAD"]

/** Run a host command; resolves with stdout, rejects with stderr. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; input?: Buffer | string; env?: Record<string, string> },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // COPYFILE_DISABLE stops macOS tar from adding `._*` metadata files.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, COPYFILE_DISABLE: "1", ...opts.env },
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d))
    child.stderr.on("data", (d: Buffer) => err.push(d))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out))
      } else {
        reject(new Error(`${cmd} ${args[0]}: ${Buffer.concat(err).toString().trim()}`))
      }
    })
    child.stdin.end(opts.input)
  })
}

/** Parse `git ls-files -s -z`. Submodules (mode 160000) are skipped: their files are not in this index. */
export function parseIndex(out: string): ProjectFiles {
  const files: ProjectFiles = new Map()
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) {
      continue
    }
    const [mode, hash] = entry.slice(0, tab).split(" ")
    if (mode !== "160000") {
      files.set(entry.slice(tab + 1), `${mode} ${hash}`)
    }
  }
  return files
}

/** Parse `git ls-tree -r -z HEAD` into the same shape as parseIndex. */
export function parseTree(out: string): ProjectFiles {
  const files: ProjectFiles = new Map()
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) {
      continue
    }
    const [mode, type, hash] = entry.slice(0, tab).split(" ")
    if (type === "blob") {
      files.set(entry.slice(tab + 1), `${mode} ${hash}`)
    }
  }
  return files
}

/** Paths in `next` that differ from `base`, and paths only in `base`. */
export function diff(base: Map<string, string>, next: Map<string, string>) {
  const changed: string[] = []
  for (const [p, value] of next) {
    if (base.get(p) !== value) {
      changed.push(p)
    }
  }
  const removed = [...base.keys()].filter((p) => !next.has(p))
  return { changed, removed }
}

/** Root of the git checkout that contains `cwd`, or undefined outside one. Other git failures throw. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).toString().trim()
  } catch (err) {
    if (err instanceof Error && /not a git repository/i.test(err.message)) {
      return undefined
    }
    throw err
  }
}

/** The host working tree as git sees it. Uses a copy of the host index, so `git add` is fast and the real index is untouched. */
export async function hostFiles(root: string): Promise<ProjectFiles> {
  const index = path.resolve(
    root,
    (await run("git", ["rev-parse", "--git-path", "index"], { cwd: root })).toString().trim(),
  )
  const scratch = path.join(os.tmpdir(), `opencode-e2b-index-${randomUUID()}`)
  try {
    // A repository with no commits and nothing staged has no index yet; git add starts one.
    await copyFile(index, scratch).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        throw err
      }
    })
    const env = { GIT_INDEX_FILE: scratch }
    await run("git", ["add", "-A", "--", "."], { cwd: root, env })
    return parseIndex((await run("git", ["ls-files", "-s", "-z"], { cwd: root, env })).toString())
  } finally {
    await rm(scratch, { force: true })
  }
}

export async function gitFingerprint(gitDir: string): Promise<string> {
  const parts = await Promise.all(
    GIT_FINGERPRINT.map((f) =>
      stat(path.join(gitDir, f)).then(
        (s) => `${f}:${s.size}:${s.mtimeMs}`,
        () => `${f}:-`,
      ),
    ),
  )
  return parts.join("|")
}

/** Every file under .git as "<size> <mtime seconds>", keyed relative to .git. Lock files and our own folder are skipped. */
export async function gitDirFiles(gitDir: string): Promise<GitDirFiles> {
  const files: ProjectFiles = new Map()
  for (const entry of await readdir(gitDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".lock")) {
      continue
    }
    const rel = path.relative(gitDir, path.join(entry.parentPath, entry.name))
    if (rel.startsWith("opencode-e2b")) {
      continue
    }
    const s = await stat(path.join(gitDir, rel)).catch(() => undefined)
    if (s) {
      files.set(rel, `${s.size} ${Math.floor(s.mtimeMs / 1000)}`)
    }
  }
  return files
}
