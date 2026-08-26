import type { E2BWorkspacePluginOptions } from "./types.js"

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
  if (value === "/") {
    errors.push(`${fieldName} must not be the filesystem root`)
  }
  // Note: the project no longer has to live under /home/user. Bootstrap chowns
  // projectPath to the sandbox user, which is what git's dubious-ownership
  // check actually cares about — see buildBootstrapCommand.
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
