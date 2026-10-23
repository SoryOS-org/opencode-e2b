/**
 * Moving files between the host and the sandbox: chunked uploads into the spool,
 * downloads of what a command changed, and copies of sandbox-only files.
 */

import { openAsBlob } from "node:fs"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { Sandbox } from "e2b"
import { run } from "./files.js"
import { quote, sh } from "./remote.js"

const CHUNK_BYTES = 32 * 1024 * 1024
const DIRECT_BYTES = 8 * 1024 * 1024
/** Large first uploads can take minutes; a dead connection still fails the request. */
const UPLOAD_TIMEOUT_MS = 30 * 60_000

/**
 * Upload files for a spool entry. Small files go in gzipped tarballs of about
 * CHUNK_BYTES each, named <id>-<n>.tgz for the wrapper to unpack. A file of
 * DIRECT_BYTES or more (a git packfile, a big asset) streams straight to its final
 * path: it is usually compressed already, and one big request per file is simpler
 * than a huge tarball.
 */
export async function upload(
  sandbox: Sandbox,
  root: string,
  id: string,
  paths: string[],
  bookkeeping: { path: string; data: string }[],
): Promise<void> {
  const sized = await Promise.all(
    paths.map(async (p) => ({ path: p, size: (await stat(path.join(root, p))).size })),
  )
  const direct = sized.filter((file) => file.size >= DIRECT_BYTES)
  const chunks = chunk(sized.filter((file) => file.size < DIRECT_BYTES))
  const timeout = { requestTimeoutMs: UPLOAD_TIMEOUT_MS }

  // The common case, a few edited files: one tarball and the bookkeeping in a single request.
  // Order matters: the wrapper applies an entry only once its .paths file exists.
  if (direct.length === 0 && chunks.length <= 1) {
    const tarballs = chunks[0] ? [{ path: `${id}-0.tgz`, data: await tarballOf(root, chunks[0]) }] : []
    await sandbox.files.write([...tarballs, ...bookkeeping], timeout)
    return
  }

  // One request at a time: E2B's upload endpoint resets the connection when uploads overlap.
  for (const [n, files] of chunks.entries()) {
    await sandbox.files.write(`${id}-${n}.tgz`, await tarballOf(root, files), timeout)
  }
  for (const file of direct) {
    await sandbox.files.write(
      path.posix.join(root, file.path),
      await openAsBlob(path.join(root, file.path)),
      timeout,
    )
  }
  await sandbox.files.write(bookkeeping, timeout)
}

/** Group files into lists of about CHUNK_BYTES each, keeping their order. */
function chunk(files: { path: string; size: number }[]): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const file of files) {
    if (current.length > 0 && bytes + file.size > CHUNK_BYTES) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(file.path)
    bytes += file.size
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

async function tarballOf(root: string, paths: string[]): Promise<ArrayBuffer> {
  const tarball = await run("tar", ["-czf", "-", "--null", "-T", "-"], { cwd: root, input: paths.join("\0") })
  return new Uint8Array(tarball).buffer
}

/** The tarball a command's changes came in: inline in the report, or a file in the sandbox. */
export async function download(sandbox: Sandbox, where: string): Promise<Buffer> {
  if (where.startsWith("inline:")) {
    return Buffer.from(where.slice("inline:".length), "base64")
  }
  const bytes = await sandbox.files.read(where, { format: "bytes", requestTimeoutMs: UPLOAD_TIMEOUT_MS })
  sandbox.files.remove(where).catch(() => undefined)
  return Buffer.from(bytes)
}

/**
 * Unpack `tarball` and move exact paths to their destinations. Everything is unpacked
 * into a folder on the same disk first: extracting by a list of names would read
 * names such as [id].tsx as patterns.
 */
export async function unpack(
  tarball: Buffer,
  scratchDir: string,
  moves: { paths: string[]; dest: string }[],
): Promise<void> {
  const incoming = path.join(scratchDir, `incoming-${randomUUID()}`)
  try {
    await mkdir(incoming, { recursive: true })
    await run("tar", ["-xzf", "-", "-C", incoming], { cwd: incoming, input: tarball })
    for (const { paths, dest } of moves) {
      for (const p of paths) {
        await mkdir(path.dirname(path.join(dest, p)), { recursive: true })
        await rename(path.join(incoming, p), path.join(dest, p))
      }
    }
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
}

/** Copy `paths` (files or folders, ignored ones included) from the sandbox project into the host project. */
export async function fetchPaths(sandbox: Sandbox, root: string, paths: string[]): Promise<void> {
  const tmp = `/tmp/opencode-e2b-fetch-${randomUUID()}.tgz`
  await sh(sandbox, `cd ${quote(root)} && tar -czf ${tmp} -- ${paths.map(quote).join(" ")}`)
  const tarball = await sandbox.files.read(tmp, { format: "bytes" })
  sandbox.files.remove(tmp).catch(() => undefined)
  await run("tar", ["-xzf", "-", "-C", root], { cwd: root, input: Buffer.from(tarball) })
}
