import { posix } from "node:path"

/**
 * Lexically normalize a POSIX path and strip trailing slashes ("/" stays "/").
 * Shared by every path comparison so edge handling cannot drift between the
 * validators and the mirror guard.
 */
export function normalizePosixPath(value: string): string {
  const normalized = posix.normalize(value).replace(/\/+$/, "")
  return normalized === "" ? "/" : normalized
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
