/**
 * Cross-cutting helpers shared by the plugin's top-level modules. Kept
 * intentionally small so new utilities have a clear, discoverable home
 * without being spread across unrelated files.
 */

/**
 * Normalize unknown thrown values into a readable message for log metadata.
 * Accepts `Error` instances, duck-typed `{ message: string }` objects (for
 * SDK errors that don't subclass Error), and anything else via `String()`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
