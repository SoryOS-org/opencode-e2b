/**
 * Keeps the sandbox copy of the project equal to the host copy, around each command,
 * with as few sandbox round trips as possible.
 *
 * Both sides describe files the same way: git's `<mode> <hash>` per path. The host
 * side comes from `git add -A` into a scratch index, so .gitignore applies and
 * ignored files (node_modules, dist, .env) are never sent and never brought back.
 *
 * The sandbox keeps its bookkeeping in a separate git directory. Its HEAD is the
 * state both sides last agreed on, and the plugin remembers the same state, so a
 * push needs no sandbox round trip to find what changed.
 *
 * Push: changed files go up as one tarball into a spool folder. Every command's
 * wrapper applies the spool (under a lock) before it runs, so an upload costs one
 * round trip, or none when nothing changed.
 * Pull: the wrapper itself lists and packs what the command changed, after it exits,
 * and reports it on its own stderr. Bringing the files back costs one round trip,
 * only when something changed. If the host file also changed meanwhile, the host
 * copy wins and the sandbox copy is saved under .git/opencode-e2b.
 *
 * The project's own .git is sent one way, host to sandbox, so git can read history
 * in the sandbox. A cheap fingerprint decides when to look at it at all.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { CommandExitError, type Sandbox } from "e2b"

/** path -> "<mode> <hash>" for project files, or "<size> <mtime seconds>" for files under .git */
export type Files = Map<string, string>

export interface Pulled {
  written: string[]
  removed: string[]
  /** Paths changed on both sides. The host copy was kept. */
  conflicts: string[]
  conflictDir?: string
}

/** What the plugin remembers about the sandbox between commands. */
export interface State {
  files: Files
  /** Files under .git as last sent, keyed relative to .git. */
  git?: { fingerprint: string; files: Files }
}

const SYNC_GIT_DIR = "/home/user/.opencode-e2b/sync.git"
const SPOOL = "/home/user/.opencode-e2b/spool"
const SYNC_MARK = "OPENCODE_E2B_SYNC "
const INLINE_LIMIT = 256 * 1024
const CHUNK_BYTES = 32 * 1024 * 1024
const DIRECT_BYTES = 8 * 1024 * 1024
/** E2B's upload endpoint resets the connection (ENHANCE_YOUR_CALM) when uploads overlap, so one at a time. */
const UPLOAD_PARALLEL = 1
/** With git: 'auto', history is sent only up to this size. A 600 MB .git takes about 2 minutes to upload. */
export const GIT_AUTO_MAX_BYTES = 200 * 1024 * 1024
/** Large first uploads can take minutes; a dead connection still fails the request. */
const UPLOAD_TIMEOUT_MS = 30 * 60_000
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

async function sh(sandbox: Sandbox, command: string, envs?: Record<string, string>): Promise<string> {
  try {
    return (await sandbox.commands.run(command, { envs, timeoutMs: 10 * 60_000 })).stdout
  } catch (err) {
    if (err instanceof CommandExitError) {
      throw new Error(`sync step failed in the sandbox: ${err.stderr.trim() || err.message}`)
    }
    throw err
  }
}

function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}

/** Parse `git ls-files -s -z`. Submodules (mode 160000) are skipped: their files are not in this index. */
export function parseIndex(out: string): Files {
  const files: Files = new Map()
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
export function parseTree(out: string): Files {
  const files: Files = new Map()
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
export function diff(base: Files, next: Files): { changed: string[]; removed: string[] } {
  const changed = [...next].filter(([p, v]) => base.get(p) !== v).map(([p]) => p)
  const removed = [...base.keys()].filter((p) => !next.has(p))
  return { changed, removed }
}

/** Root of the git checkout that contains `cwd`, or undefined. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  return run("git", ["rev-parse", "--show-toplevel"], { cwd }).then(
    (out) => out.toString().trim(),
    () => undefined,
  )
}

/** The host working tree as git sees it. Uses a copy of the host index, so `git add` is fast and the real index is untouched. */
export async function hostFiles(root: string): Promise<Files> {
  const index = path.resolve(
    root,
    (await run("git", ["rev-parse", "--git-path", "index"], { cwd: root })).toString().trim(),
  )
  const scratch = path.join(os.tmpdir(), `opencode-e2b-index-${randomUUID()}`)
  try {
    await copyFile(index, scratch).catch(() => undefined)
    const env = { GIT_INDEX_FILE: scratch }
    await run("git", ["add", "-A", "--", "."], { cwd: root, env })
    return parseIndex((await run("git", ["ls-files", "-s", "-z"], { cwd: root, env })).toString())
  } finally {
    await rm(scratch, { force: true })
  }
}

async function gitFingerprint(gitDir: string): Promise<string> {
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
export async function gitDirFiles(gitDir: string): Promise<Files> {
  const files: Files = new Map()
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

/** Create the project folder at the host's path, the bookkeeping repository, and the spool. */
export async function init(sandbox: Sandbox, root: string): Promise<void> {
  const git = `GIT_DIR=${SYNC_GIT_DIR} GIT_WORK_TREE=${quote(root)} git -c user.name=opencode-e2b -c user.email=opencode-e2b@localhost`
  await sh(
    sandbox,
    [
      `sudo mkdir -p ${quote(root)} && sudo chown user:user ${quote(root)}`,
      `mkdir -p ${SPOOL}`,
      `if [ ! -d ${SYNC_GIT_DIR} ]; then ${git} init -q -b main && ${git} commit -q --allow-empty -m start; fi`,
    ].join(" && "),
  )
}

/** The agreed state as the sandbox recorded it: its HEAD, and its .git files. One round trip, used once per opencode process. */
export async function boxState(sandbox: Sandbox, root: string): Promise<State> {
  const gitDir = quote(`${root}/.git`)
  const out = await sh(
    sandbox,
    `GIT_DIR=${SYNC_GIT_DIR} git ls-tree -r -z HEAD; printf '\\0--git--\\0'; if [ -d ${gitDir} ]; then cd ${gitDir} && find . -type f ! -name '*.lock' -printf '%P\\t%s %T@\\0'; fi`,
  )
  const [tree = "", gitList = ""] = out.split("\0--git--\0")
  const git: Files = new Map()
  for (const entry of gitList.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab > 0) {
      const [size, mtime] = entry.slice(tab + 1).split(" ")
      git.set(entry.slice(0, tab), `${size} ${Math.floor(Number(mtime))}`)
    }
  }
  return { files: parseTree(tree), git: { fingerprint: "", files: git } }
}

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
    const total = files ? [...files.values()].reduce((sum, v) => sum + Number(v.split(" ")[0]), 0) : 0
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

/**
 * Upload files for a spool entry. Small files go in gzipped tarballs of about
 * CHUNK_BYTES each, named <id>-<n>.tgz for the wrapper to unpack. A file of
 * DIRECT_BYTES or more (a git packfile, a big asset) streams straight to its final
 * path: it is usually compressed already, and one big request per file is simpler
 * than a huge tarball.
 */
async function upload(
  sandbox: Sandbox,
  root: string,
  id: string,
  paths: string[],
  bookkeeping: { path: string; data: string }[],
): Promise<void> {
  const sized = await Promise.all(
    paths.map(async (p) => ({ p, size: (await stat(path.join(root, p)).catch(() => undefined))?.size ?? 0 })),
  )
  const direct = sized.filter((f) => f.size >= DIRECT_BYTES)
  const chunks: string[][] = []
  let chunk: string[] = []
  let bytes = 0
  for (const { p, size } of sized) {
    if (size >= DIRECT_BYTES) {
      continue
    }
    if (chunk.length > 0 && bytes + size > CHUNK_BYTES) {
      chunks.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(p)
    bytes += size
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }

  // The common case, a few edited files: one tarball and the bookkeeping in a single request.
  if (direct.length === 0 && chunks.length <= 1) {
    const writes: { path: string; data: ArrayBuffer | string }[] = []
    if (chunks[0]) {
      const tarball = await run("tar", ["-czf", "-", "--null", "-T", "-"], {
        cwd: root,
        input: chunks[0].join("\0"),
      })
      writes.push({ path: `${id}-0.tgz`, data: new Uint8Array(tarball).buffer })
    }
    // Order matters: the wrapper applies an entry only once its .paths file exists.
    await sandbox.files.write([...writes, ...bookkeeping], { requestTimeoutMs: UPLOAD_TIMEOUT_MS })
    return
  }

  const tasks = [
    ...chunks.map((files, n) => async () => {
      const tarball = await run("tar", ["-czf", "-", "--null", "-T", "-"], {
        cwd: root,
        input: files.join("\0"),
      })
      await sandbox.files.write(`${id}-${n}.tgz`, new Uint8Array(tarball).buffer, {
        requestTimeoutMs: UPLOAD_TIMEOUT_MS,
      })
    }),
    ...direct.map(({ p }) => async () => {
      const stream = Readable.toWeb(createReadStream(path.join(root, p))) as unknown as ReadableStream
      await sandbox.files.write(path.posix.join(root, p), stream, { requestTimeoutMs: UPLOAD_TIMEOUT_MS })
    }),
  ]
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!
      await task()
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, tasks.length) }, worker))
  // Last: the wrapper applies an entry only once its .paths file exists.
  await sandbox.files.write(bookkeeping, { requestTimeoutMs: UPLOAD_TIMEOUT_MS })
}

/**
 * Wraps every command. Under a lock it applies the spool, then runs the command in its
 * own process group (setsid) with output in a file that `tail --pid` streams: E2B
 * returns only when output pipes close, and `npm run dev &` keeps them open. The
 * process group id goes to a file named after the wrapper's pid, so a cancel can
 * kill the command but not the wrapper. After the command, again under the lock, it
 * packs what changed and reports it on stderr, which the command's output never uses.
 */
export const WRAPPER = `
root=$OPENCODE_E2B_ROOT; cmd=$OPENCODE_E2B_COMMAND; mode=$OPENCODE_E2B_MODE
unset OPENCODE_E2B_ROOT OPENCODE_E2B_COMMAND OPENCODE_E2B_MODE
# Sync steps run in subshells, so GIT_DIR never reaches the user's command. Paths are
# literal: a file named routes/[id].tsx must not be read as a glob.
sync() { ( export GIT_DIR=${SYNC_GIT_DIR} GIT_WORK_TREE="$root" GIT_LITERAL_PATHSPECS=1; cd "$root" && "$@" ); }
git_id='-c user.name=opencode-e2b -c user.email=opencode-e2b@localhost'
untar() { tar --warning=no-unknown-keyword -xzf "$1" -C "$root"; }
locked() { exec 9>/tmp/opencode-e2b.lock; flock 9; rm -f ${SYNC_GIT_DIR}/index.lock; }
unlock() { flock -u 9; exec 9>&-; }

locked
for paths in $(ls ${SPOOL}/*.paths 2>/dev/null | sort); do
  id=${SPOOL}/$(basename "$paths" .paths)
  for part in "$id"-*.tgz; do [ -f "$part" ] && untar "$part"; done
  [ -s "$id.rm" ] && sync xargs -0 rm -f -- < "$id.rm"
  [ -s "$paths" ] && sync git add -A -f --pathspec-from-file="$paths" --pathspec-file-nul >/dev/null && sync git $git_id commit -q --no-verify -m 'sync from host' >/dev/null
  rm -f "$id"-*.tgz "$id.rm" "$paths"
done
unlock
[ "$mode" = sync ] && exit 0

out=$(mktemp)
setsid bash -c "$cmd" >"$out" 2>&1 </dev/null &
pid=$!
echo "$pid" > /tmp/opencode-e2b-$$.pgid
tail -s 0.02 -n +1 --pid="$pid" -f "$out"
wait "$pid"; rc=$?
rm -f "$out" /tmp/opencode-e2b-$$.pgid

locked
changed=$(mktemp)
sync git add -A -- . >/dev/null && sync git diff --cached --name-only -z HEAD > "$changed"
if [ -s "$changed" ]; then
  tgz=/tmp/opencode-e2b-out-$$.tgz
  sync xargs -0 git ls-files -z -- < "$changed" | sync tar -czf "$tgz" --null -T -
  state=$(sync xargs -0 git ls-files -s -z -- < "$changed" | base64 -w0)
  sync git $git_id commit -q --no-verify -m 'sync to host' >/dev/null
  # Small changes travel inline, which saves a round trip to fetch the tarball.
  if [ "$(stat -c %s "$tgz")" -le ${INLINE_LIMIT} ]; then
    where="inline:$(base64 -w0 < "$tgz")"; rm -f "$tgz"
  else
    where=$tgz
  fi
  printf '${SYNC_MARK}%s %s %s\\n' "$where" "$(base64 -w0 < "$changed")" "$state" >&2
fi
rm -f "$changed"
unlock
exit "$rc"
`

/** A pull report from the wrapper's stderr, or undefined if the command changed nothing. */
export interface Report {
  tarball: string
  paths: string[]
  files: Files
}

export function parseReport(stderr: string): Report | undefined {
  const line = stderr.split("\n").findLast((l) => l.startsWith(SYNC_MARK))
  if (!line) {
    return undefined
  }
  const [tarball = "", names = "", state = ""] = line.slice(SYNC_MARK.length).split(" ")
  return {
    tarball,
    paths: Buffer.from(names, "base64").toString().split("\0").filter(Boolean),
    files: parseIndex(Buffer.from(state, "base64").toString()),
  }
}

/** Bring back what a command changed, as reported by the wrapper. One round trip. */
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

  let tarball: Buffer
  if (report.tarball.startsWith("inline:")) {
    tarball = Buffer.from(report.tarball.slice("inline:".length), "base64")
  } else {
    tarball = Buffer.from(
      await sandbox.files.read(report.tarball, { format: "bytes", requestTimeoutMs: UPLOAD_TIMEOUT_MS }),
    )
    sandbox.files.remove(report.tarball).catch(() => undefined)
  }
  // Unpack everything into a folder on the same disk, then move the exact paths into
  // place. Extracting by name list would read names such as [id].tsx as patterns.
  const gitDir = path.resolve(
    root,
    (await run("git", ["rev-parse", "--git-dir"], { cwd: root })).toString().trim(),
  )
  const incoming = path.join(gitDir, "opencode-e2b", `incoming-${randomUUID()}`)
  try {
    await mkdir(incoming, { recursive: true })
    await run("tar", ["-xzf", "-", "-C", incoming], { cwd: incoming, input: tarball })
    const place = async (paths: string[], dest: string) => {
      for (const p of paths) {
        await mkdir(path.dirname(path.join(dest, p)), { recursive: true })
        await rename(path.join(incoming, p), path.join(dest, p))
      }
    }
    await place(pulled.written, root)
    const keptInBox = pulled.conflicts.filter((p) => report.files.has(p))
    if (keptInBox.length > 0) {
      pulled.conflictDir = path.join(
        gitDir,
        "opencode-e2b",
        "conflicts",
        new Date().toISOString().replaceAll(":", "-"),
      )
      await place(keptInBox, pulled.conflictDir)
    }
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
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

/** Copy `paths` (files or folders, ignored ones included) from the sandbox project into the host project. */
export async function fetchPaths(sandbox: Sandbox, root: string, paths: string[]): Promise<void> {
  const tmp = `/tmp/opencode-e2b-fetch-${randomUUID()}.tgz`
  await sh(sandbox, `cd ${quote(root)} && tar -czf ${tmp} -- ${paths.map(quote).join(" ")}`)
  const tarball = await sandbox.files.read(tmp, { format: "bytes" })
  sandbox.files.remove(tmp).catch(() => undefined)
  await run("tar", ["-xzf", "-", "-C", root], { cwd: root, input: Buffer.from(tarball) })
}

/** Apply the spool without running a command. Used after an eager push and on warm start. */
export async function applySpool(sandbox: Sandbox, root: string): Promise<void> {
  await sh(sandbox, WRAPPER, { OPENCODE_E2B_ROOT: root, OPENCODE_E2B_COMMAND: "", OPENCODE_E2B_MODE: "sync" })
}
