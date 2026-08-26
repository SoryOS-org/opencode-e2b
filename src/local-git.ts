import { readFile } from "node:fs/promises"
import path from "node:path"

const HEAD_REF_PREFIX = "ref: refs/heads/"

/**
 * Current branch of the local repository, or undefined when the directory is
 * not a repository or HEAD is detached.
 *
 * OpenCode's TUI always sends `branch: null` when creating a workspace, but
 * both `defaultWorkspaceName` and the bootstrap `git init -b` have expected a
 * branch since the initial commit. Reading it here fills that gap so the
 * sandbox repository starts on the same branch as the host — otherwise the
 * sandbox reports a branch the user never checked out.
 *
 * Reads `.git/HEAD` directly rather than shelling out to git: no subprocess,
 * and it works the same for worktrees (where `.git` is a file pointing at the
 * real git directory).
 */
export async function readLocalGitBranch(directory: string): Promise<string | undefined> {
  const gitDirectory = await resolveGitDirectory(directory)
  if (!gitDirectory) return undefined

  const head = await readFileSafe(path.join(gitDirectory, "HEAD"))
  if (!head) return undefined

  const trimmed = head.trim()
  // A raw commit id means detached HEAD, which has no branch to mirror.
  if (!trimmed.startsWith(HEAD_REF_PREFIX)) return undefined

  const branch = trimmed.slice(HEAD_REF_PREFIX.length).trim()
  return branch === "" ? undefined : branch
}

async function resolveGitDirectory(directory: string): Promise<string | undefined> {
  const dotGit = path.join(directory, ".git")

  // Plain repository: `.git` is a directory.
  if (await readFileSafe(path.join(dotGit, "HEAD"))) return dotGit

  // Worktree or submodule: `.git` is a file containing `gitdir: <path>`.
  const pointer = await readFileSafe(dotGit)
  if (!pointer) return undefined

  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim())
  const target = match?.[1]?.trim()
  if (!target) return undefined

  return path.isAbsolute(target) ? target : path.resolve(directory, target)
}

async function readFileSafe(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return undefined
  }
}
