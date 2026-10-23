/**
 * Moving files between the host and the sandbox: chunked uploads into the spool,
 * downloads of what a command changed, and copies of sandbox-only files.
 */

import { createReadStream } from "node:fs"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { Sandbox } from "e2b"
import { run } from "./files.js"
import { quote, sh } from "./remote.js"

const CHUNK_BYTES = 32 * 1024 * 1024
const DIRECT_BYTES = 8 * 1024 * 1024
/** E2B's upload endpoint resets the connection (ENHANCE_YOUR_CALM) when uploads overlap, so one at a time. */
const UPLOAD_PARALLEL = 1
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
