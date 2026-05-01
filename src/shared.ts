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
