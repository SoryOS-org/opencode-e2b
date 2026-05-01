import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { posix } from "node:path"

import { Sandbox } from "e2b"

import { shellSingleQuote } from "./shared.js"
import type { E2BUploadOptions } from "./types.js"

/**
 * A single uploadable file represented only by its filesystem coordinates.
 * Contents are not held here — they are read lazily, one batch at a time, so
 * the peak memory cost of an upload is `batchSize * average file size` rather
 * than the full project snapshot.
 */
type SnapshotPath = {
  absolutePath: string
  relativePath: string
}

/**
 * State shared across the recursive directory walk so symlink handling stays
 * bounded to the workspace root and cannot revisit the same real directory.
 */
type WalkState = {
  rootRealPath: string
  visitedDirectories: Set<string>
}

/**
 * Copy the local workspace snapshot into the sandbox project directory.
 *
 * The upload runs in rolling batches: at any given time we hold file contents
 * for at most one batch, hand them to the E2B filesystem API, then let them
 * go before reading the next batch. This keeps the plugin usable for larger
 * projects without needing a git-aware or archive-based uploader.
 */
export async function uploadLocalSnapshot(params: {
  sandbox: Sandbox
  localRoot: string
  remoteRoot: string
  upload: Required<E2BUploadOptions>
}): Promise<void> {
  const paths = await collectSnapshotPaths(params.localRoot, params.upload)
  await ensureRemoteDirectories(params.sandbox, params.remoteRoot, paths)

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

/**
 * Recursively collect uploadable file paths from the local project directory.
 * Deliberately cheap — does not read any file contents.
 */
async function collectSnapshotPaths(
  localRoot: string,
  upload: Required<E2BUploadOptions>,
): Promise<SnapshotPath[]> {
  return walkDirectory(localRoot, localRoot, upload, {
    rootRealPath: await realpath(localRoot),
    visitedDirectories: new Set<string>(),
  })
}

/**
 * Walk a directory tree and return the relative/absolute paths that should be
 * uploaded. Skips configured ignore patterns, directory cycles, and out-of-root
 * symlinks.
 */
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

/**
 * Create remote directories before bulk file writes so nested paths work across
 * templates consistently.
 */
async function ensureRemoteDirectories(
  sandbox: Sandbox,
  remoteRoot: string,
  paths: SnapshotPath[],
): Promise<void> {
  const directories = new Set<string>([remoteRoot])

  for (const entry of paths) {
    const relativeDirectory = posix.dirname(entry.relativePath)
    if (relativeDirectory !== ".") {
      directories.add(toRemotePath(remoteRoot, relativeDirectory))
    }
  }

  for (const batch of chunk([...directories].sort(), 50)) {
    await sandbox.commands.run(`mkdir -p ${batch.map(shellSingleQuote).join(" ")}`)
  }
}

/**
 * Decide whether a local path should be excluded from the uploaded snapshot.
 */
function shouldIgnore(relativePath: string, upload: Required<E2BUploadOptions>): boolean {
  if (!upload.includeDotGit && (relativePath === ".git" || relativePath.startsWith(".git/"))) {
    return true
  }

  const segments = relativePath.split("/")
  return upload.ignore.some((pattern) => matchesIgnorePattern(relativePath, segments, pattern))
}

/**
 * Ignore entries are simple path literals, not glob patterns. A pattern
 * matches an exact relative path, a descendant prefix, or any path segment.
 */
function matchesIgnorePattern(relativePath: string, segments: string[], pattern: string): boolean {
  return relativePath === pattern || relativePath.startsWith(`${pattern}/`) || segments.includes(pattern)
}

/**
 * Normalize a relative path into portable slash-separated form.
 */
function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/")
}

/**
 * Ensure followed symlinks stay within the workspace root before any files are
 * read and uploaded into the sandbox.
 */
function assertWithinRoot(rootRealPath: string, candidateRealPath: string, sourcePath: string): void {
  const relativePath = path.relative(rootRealPath, candidateRealPath)
  const isWithinRoot =
    relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  if (isWithinRoot) {
    return
  }

  throw new Error(`Refusing to follow symlink outside workspace root: ${sourcePath}`)
}

/**
 * Join a sandbox project root and relative path using POSIX separators.
 */
function toRemotePath(remoteRoot: string, relativePath: string): string {
  return posix.join(remoteRoot, relativePath)
}

/**
 * Chunk an array into stable batch sizes.
 */
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
