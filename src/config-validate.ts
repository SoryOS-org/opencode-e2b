import type { E2BWorkspacePluginOptions } from "./types.js"

/**
 * Shape-check the user-supplied plugin options. OpenCode loads plugin options
 * from arbitrary JSON, so runtime validation keeps bad config from surfacing
 * later as confusing E2B SDK errors.
 */
export function validatePluginOptions(raw: unknown): E2BWorkspacePluginOptions | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("E2B plugin options must be an object")
  }

  const options = raw as Record<string, unknown>
  const validator = new OptionValidator()

  validator.requireString(options.nodeVariant, "nodeVariant", false)
  validator.requireString(options.projectPath, "projectPath", false)
  validator.requirePositiveInteger(options.sandboxTimeoutMs, "sandboxTimeoutMs")
  validator.requirePositiveInteger(options.serverPort, "serverPort")
  validator.requireBoolean(options.secure, "secure")
  validator.requireStringRecord(options.metadata, "metadata")

  validator.requireObject(options.network, "network", (network) => {
    validator.requireBoolean(network.allowPublicTraffic, "network.allowPublicTraffic")
    validator.requireStringArray(network.allowOut, "network.allowOut")
    validator.requireStringArray(network.denyOut, "network.denyOut")
    validator.requireString(network.maskRequestHost, "network.maskRequestHost", true)
  })

  validator.requireObject(options.bootstrap, "bootstrap", (bootstrap) => {
    validator.requireStringArray(bootstrap.prepareCommands, "bootstrap.prepareCommands")
    validator.requireString(bootstrap.installCommand, "bootstrap.installCommand", true)
    validator.requireString(bootstrap.startCommand, "bootstrap.startCommand", true)
    validator.requireString(bootstrap.waitForPath, "bootstrap.waitForPath", false)
    validator.requirePositiveInteger(bootstrap.waitForTimeoutMs, "bootstrap.waitForTimeoutMs")
  })

  validator.requireObject(options.upload, "upload", (upload) => {
    validator.requireStringArray(upload.ignore, "upload.ignore")
    validator.requireBoolean(upload.includeDotGit, "upload.includeDotGit")
    validator.requirePositiveInteger(upload.batchSize, "upload.batchSize")
    validator.requireBoolean(upload.followSymlinks, "upload.followSymlinks")
  })

  validator.requireObject(options.templateGc, "templateGc", (templateGc) => {
    validator.requireBoolean(templateGc.enabled, "templateGc.enabled")
    validator.requirePositiveInteger(templateGc.ttlMs, "templateGc.ttlMs")
    validator.requirePositiveInteger(templateGc.cooldownMs, "templateGc.cooldownMs")
  })

  validator.assertValid()
  return options as E2BWorkspacePluginOptions
}

class OptionValidator {
  private errors: string[] = []

  requireObject(
    value: unknown,
    fieldName: string,
    validateFields: (value: Record<string, unknown>) => void,
  ): void {
    if (value === undefined) return
    if (!isPlainObject(value)) {
      this.errors.push(`${fieldName} must be an object`)
      return
    }

    validateFields(value)
  }

  requireString(value: unknown, fieldName: string, allowEmpty: boolean): void {
    if (value === undefined) return
    if (typeof value !== "string") {
      this.errors.push(`${fieldName} must be a string`)
      return
    }
    if (!allowEmpty && value.trim() === "") {
      this.errors.push(`${fieldName} must be a non-empty string`)
    }
  }

  requireBoolean(value: unknown, fieldName: string): void {
    if (value === undefined) return
    if (typeof value !== "boolean") {
      this.errors.push(`${fieldName} must be a boolean`)
    }
  }

  requirePositiveInteger(value: unknown, fieldName: string): void {
    if (value === undefined) return
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      this.errors.push(`${fieldName} must be a positive integer`)
    }
  }

  requireStringArray(value: unknown, fieldName: string): void {
    if (value === undefined) return
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      this.errors.push(`${fieldName} must be an array of strings`)
    }
  }

  requireStringRecord(value: unknown, fieldName: string): void {
    if (value === undefined) return
    if (!isPlainObject(value)) {
      this.errors.push(`${fieldName} must be an object mapping strings to strings`)
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        this.errors.push(`${fieldName}.${key} must be a string`)
      }
    }
  }

  assertValid(): void {
    if (this.errors.length === 0) return
    throw new Error(`Invalid E2B plugin options:\n  - ${this.errors.join("\n  - ")}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
