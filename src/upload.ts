import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { posix } from "node:path"

import { Sandbox } from "e2b"

import type { E2BUploadOptions } from "./types.js"

type SnapshotFile = {
  localPath: string
  relativePath: string
  data: Buffer
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
 * This implementation is intentionally simple and recursive so it is easy to
 * replace later with git-aware or archive-based upload strategies.
 */
export async function uploadLocalSnapshot(params: {
  sandbox: Sandbox
  localRoot: string
  remoteRoot: string
  upload: Required<E2BUploadOptions>
}): Promise<void> {
  const files = await collectSnapshotFiles(params.localRoot, params.upload)
  await ensureRemoteDirectories(params.sandbox, params.remoteRoot, files)

  for (const batch of chunk(files, params.upload.batchSize)) {
    await params.sandbox.files.write(
      batch.map((file) => ({
        path: toRemotePath(params.remoteRoot, file.relativePath),
        data: toArrayBuffer(file.data),
      })),
    )
  }
}

/**
 * Recursively collect uploadable files from the local project directory.
 */
async function collectSnapshotFiles(localRoot: string, upload: Required<E2BUploadOptions>): Promise<SnapshotFile[]> {
  const entries = await walkDirectory(localRoot, localRoot, upload, {
    rootRealPath: await realpath(localRoot),
    visitedDirectories: new Set<string>(),
  })
  const files: SnapshotFile[] = []

  for (const entry of entries) {
    files.push({
      localPath: entry,
      relativePath: normalizeRelativePath(path.relative(localRoot, entry)),
      data: await readFile(entry),
    })
  }

  return files
}

/**
 * Walk a directory tree and return local file paths that should be uploaded.
 */
async function walkDirectory(
  currentPath: string,
  localRoot: string,
  upload: Required<E2BUploadOptions>,
  state: WalkState,
): Promise<string[]> {
  const currentRealPath = await realpath(currentPath)
  assertWithinRoot(state.rootRealPath, currentRealPath, currentPath)
  if (state.visitedDirectories.has(currentRealPath)) {
    return []
  }
  state.visitedDirectories.add(currentRealPath)

  const discovered = await readdir(currentPath, { withFileTypes: true })
  const files: string[] = []

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
      files.push(absolutePath)
    }
  }

  return files
}

/**
 * Create remote directories before bulk file writes so nested paths work across
 * templates consistently.
 */
async function ensureRemoteDirectories(sandbox: Sandbox, remoteRoot: string, files: SnapshotFile[]): Promise<void> {
  const directories = new Set<string>([remoteRoot])

  for (const file of files) {
    const relativeDirectory = posix.dirname(file.relativePath)
    if (relativeDirectory !== ".") {
      directories.add(toRemotePath(remoteRoot, relativeDirectory))
    }
  }

  for (const batch of chunk([...directories].sort(), 50)) {
    await sandbox.commands.run(`mkdir -p ${batch.map(shellQuote).join(" ")}`)
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
  return upload.ignore.some((pattern) => segments.includes(pattern) || relativePath === pattern || relativePath.startsWith(`${pattern}/`))
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
 * Quote a shell path for remote command execution.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Convert a Node buffer into a plain `ArrayBuffer` for the E2B SDK.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy.buffer
}
