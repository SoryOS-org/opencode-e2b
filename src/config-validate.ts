import { posix } from "node:path"

import type { E2BWorkspacePluginOptions } from "./types.js"

/**
 * The workspace systemd service runs `opencode serve` as the sandbox `user`
 * account (home `/home/user`). The uploaded project must live under that home
 * so it is owned by the running user and passes git's dubious-ownership check;
 * a path outside it (e.g. `/root`, `/opt`) makes the run-as-user service trip
 * that check and silently breaks session warp.
 */
export const SANDBOX_PROJECT_ROOT = "/home/user"

export function isWithinSandboxProjectRoot(absolutePath: string): boolean {
  let normalized = posix.normalize(absolutePath)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1)
  }
  return normalized === SANDBOX_PROJECT_ROOT || normalized.startsWith(`${SANDBOX_PROJECT_ROOT}/`)
}

export function validatePluginOptions(raw: unknown): E2BWorkspacePluginOptions | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("E2B plugin options must be an object")
  }

  const options = raw as Record<string, unknown>
  const errors: string[] = []

  requireNonEmptyString(options.nodeVariant, "nodeVariant", errors)
  requireAbsoluteProjectPath(options.projectPath, "projectPath", errors)
  requirePositiveInteger(options.sandboxTimeoutMs, "sandboxTimeoutMs", errors)
  requireTcpPort(options.serverPort, "serverPort", errors)
  requireBoolean(options.secure, "secure", errors)
  requireStringRecord(options.metadata, "metadata", errors)

  requireObject(options.network, "network", errors, (network) => {
    requireBoolean(network.allowPublicTraffic, "network.allowPublicTraffic", errors)
    requireStringArray(network.allowOut, "network.allowOut", errors)
    requireStringArray(network.denyOut, "network.denyOut", errors)
    requireString(network.maskRequestHost, "network.maskRequestHost", errors)
  })

  requireObject(options.bootstrap, "bootstrap", errors, (bootstrap) => {
    requireStringArray(bootstrap.prepareCommands, "bootstrap.prepareCommands", errors)
    requireString(bootstrap.installCommand, "bootstrap.installCommand", errors)
    requireString(bootstrap.startCommand, "bootstrap.startCommand", errors)
    requireNonEmptyString(bootstrap.waitForPath, "bootstrap.waitForPath", errors)
    requirePositiveInteger(bootstrap.waitForTimeoutMs, "bootstrap.waitForTimeoutMs", errors)
  })

  requireObject(options.upload, "upload", errors, (upload) => {
    requireStringArray(upload.ignore, "upload.ignore", errors)
    requireBoolean(upload.includeDotGit, "upload.includeDotGit", errors)
    requirePositiveInteger(upload.batchSize, "upload.batchSize", errors)
    requireBoolean(upload.followSymlinks, "upload.followSymlinks", errors)
  })

  requireObject(options.templateGc, "templateGc", errors, (templateGc) => {
    requireBoolean(templateGc.enabled, "templateGc.enabled", errors)
    requirePositiveInteger(templateGc.ttlMs, "templateGc.ttlMs", errors)
    requirePositiveInteger(templateGc.cooldownMs, "templateGc.cooldownMs", errors)
  })

  if (errors.length > 0) {
    throw new Error(`Invalid E2B plugin options:\n  - ${errors.join("\n  - ")}`)
  }

  return options as E2BWorkspacePluginOptions
}

function requireObject(
  value: unknown,
  fieldName: string,
  errors: string[],
  validateFields: (value: Record<string, unknown>) => void,
): void {
  if (value === undefined) return
  if (!isObjectRecord(value)) {
    errors.push(`${fieldName} must be an object`)
    return
  }

  validateFields(value)
}

function requireString(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "string") {
    errors.push(`${fieldName} must be a string`)
  }
}

function requireNonEmptyString(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "string") {
    errors.push(`${fieldName} must be a string`)
    return
  }
  if (value.trim() === "") {
    errors.push(`${fieldName} must be a non-empty string`)
  }
}

function requireBoolean(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "boolean") {
    errors.push(`${fieldName} must be a boolean`)
  }
}

function requirePositiveInteger(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`${fieldName} must be a positive integer`)
  }
}

function requireTcpPort(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`${fieldName} must be a positive integer`)
    return
  }
  if (value > 65535) {
    errors.push(`${fieldName} must be between 1 and 65535`)
  }
}

function requireAbsoluteProjectPath(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (typeof value !== "string") {
    errors.push(`${fieldName} must be a string`)
    return
  }
  if (value.trim() === "") {
    errors.push(`${fieldName} must be a non-empty string`)
    return
  }
  if (!value.startsWith("/")) {
    errors.push(`${fieldName} must be an absolute POSIX path`)
    return
  }
  // The path is embedded in a single-quoted shell word inside a heredoc
  // (systemd start script); a control character (e.g. newline) would
  // terminate the heredoc early and corrupt the generated unit.
  if (containsControlCharacters(value)) {
    errors.push(`${fieldName} must not contain control characters`)
    return
  }
  if (!isWithinSandboxProjectRoot(value)) {
    errors.push(
      `${fieldName} must be within ${SANDBOX_PROJECT_ROOT} so the project is owned by the sandbox user`,
    )
  }
}

export function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function requireStringArray(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    errors.push(`${fieldName} must be an array of strings`)
  }
}

function requireStringRecord(value: unknown, fieldName: string, errors: string[]): void {
  if (value === undefined) return
  if (!isObjectRecord(value)) {
    errors.push(`${fieldName} must be an object mapping strings to strings`)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      errors.push(`${fieldName}.${key} must be a string`)
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
