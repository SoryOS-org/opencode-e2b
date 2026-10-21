import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { posix } from "node:path"

import { Sandbox } from "e2b"

import type { E2BUploadOptions } from "./types.js"

type SnapshotPath = {
  absolutePath: string
  relativePath: string
}

type WalkState = {
  rootRealPath: string
  visitedDirectories: Set<string>
}

/**
 * Copy the local workspace snapshot into the sandbox project directory.
 *
 * Files are read in batches so upload memory usage scales with batch size,
 * not with the full project snapshot.
 */
export async function uploadLocalSnapshot(params: {
  sandbox: Sandbox
  localRoot: string
  remoteRoot: string
  upload: Required<E2BUploadOptions>
}): Promise<void> {
  const paths = await collectSnapshotPaths(params.localRoot, params.upload)

  for (const batch of chunk(paths, params.upload.batchSize)) {
    const entries = await Promise.all(
      batch.map(async (entry) => ({
        path: toRemotePath(params.remoteRoot, entry.relativePath),
        data: await readFileAsArrayBuffer(entry.absolutePath),
      })),
    )
    await params.sandbox.files.write(entries)
  }
}

async function collectSnapshotPaths(
  localRoot: string,
  upload: Required<E2BUploadOptions>,
): Promise<SnapshotPath[]> {
  return walkDirectory(localRoot, localRoot, upload, {
    rootRealPath: await realpath(localRoot),
    visitedDirectories: new Set<string>(),
  })
}

async function walkDirectory(
  currentPath: string,
  localRoot: string,
  upload: Required<E2BUploadOptions>,
  state: WalkState,
): Promise<SnapshotPath[]> {
  const currentRealPath = await realpath(currentPath)
  assertWithinRoot(state.rootRealPath, currentRealPath, currentPath)
  if (state.visitedDirectories.has(currentRealPath)) {
    return []
  }
  state.visitedDirectories.add(currentRealPath)

  const discovered = await readdir(currentPath, { withFileTypes: true })
  const files: SnapshotPath[] = []

  for (const entry of discovered) {
    const absolutePath = path.join(currentPath, entry.name)
    const relativePath = normalizeRelativePath(path.relative(localRoot, absolutePath))
    if (shouldIgnore(relativePath, upload)) continue

    const entryLstat = await lstat(absolutePath)
    if (entryLstat.isSymbolicLink()) {
      if (!upload.followSymlinks) continue

      const resolvedPath = await realpath(absolutePath)
      assertWithinRoot(state.rootRealPath, resolvedPath, absolutePath)
    }

    const entryStat = await stat(absolutePath)
    if (entryStat.isDirectory()) {
      files.push(...(await walkDirectory(absolutePath, localRoot, upload, state)))
      continue
    }

    if (entryStat.isFile()) {
      files.push({ absolutePath, relativePath })
    }
  }

  return files
}

function shouldIgnore(relativePath: string, upload: Required<E2BUploadOptions>): boolean {
  if (!upload.includeDotGit && (relativePath === ".git" || relativePath.startsWith(".git/"))) {
    return true
  }

  const segments = relativePath.split("/")
  return upload.ignore.some((pattern) => matchesIgnorePattern(relativePath, segments, pattern))
}

function matchesIgnorePattern(relativePath: string, segments: string[], pattern: string): boolean {
  return relativePath === pattern || relativePath.startsWith(`${pattern}/`) || segments.includes(pattern)
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/")
}

function assertWithinRoot(rootRealPath: string, candidateRealPath: string, sourcePath: string): void {
  const relativePath = path.relative(rootRealPath, candidateRealPath)
  const isWithinRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  if (isWithinRoot) {
    return
  }

  throw new Error(`Refusing to follow symlink outside workspace root: ${sourcePath}`)
}

function toRemotePath(remoteRoot: string, relativePath: string): string {
  return posix.join(remoteRoot, relativePath)
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

/**
 * Read a file into a standalone ArrayBuffer suitable for the E2B SDK.
 *
 * Node Buffers are backed by a shared pool, so `buffer.buffer` may expose
 * unrelated bytes if handed directly to a consumer that expects a tight
 * ArrayBuffer. Slicing the underlying buffer by the exact byte range gives
 * us a fresh, owned ArrayBuffer without the allocation + copy that the
 * previous `new Uint8Array(len); .set(buffer)` pattern performed.
 */
async function readFileAsArrayBuffer(absolutePath: string): Promise<ArrayBuffer> {
  const buffer = await readFile(absolutePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}
