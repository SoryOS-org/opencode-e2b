import {
  ApiClient,
  ConnectionConfig,
  type ConnectionOpts,
  type Logger as E2BLogger,
  type components,
} from "e2b"

import { errorMessage } from "./shared.js"
import type { PluginLogger } from "./types.js"

export type E2BTemplateListEntry = components["schemas"]["Template"]

export class E2BApiStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    error: unknown,
  ) {
    super(`${message} failed with status ${status}: ${errorMessage(error)}`)
    this.name = "E2BApiStatusError"
  }
}

export function createE2BConnectionOptions(logger?: PluginLogger): ConnectionOpts {
  return {
    logger: createE2BSDKLogger(logger),
  }
}

export function createE2BApiClient(logger?: PluginLogger): ApiClient {
  return new ApiClient(new ConnectionConfig(createE2BConnectionOptions(logger)), {
    requireApiKey: true,
  })
}

export async function listE2BTemplates(client: ApiClient): Promise<E2BTemplateListEntry[]> {
  const response = await client.api.GET("/templates", {
    params: {
      query: {},
    },
  })
  const status = response.response.status

  if (status >= 400) {
    throw new E2BApiStatusError("Template list", status, response.error ?? `Unexpected status ${status}`)
  }

  if (!Array.isArray(response.data)) {
    throw new Error("Template list returned unexpected payload")
  }

  return response.data as E2BTemplateListEntry[]
}

export async function deleteE2BTemplate(client: ApiClient, templateID: string): Promise<void> {
  const response = await client.api.DELETE("/templates/{templateID}", {
    params: {
      path: {
        templateID,
      },
    },
  })
  const status = response.response.status

  if ((status >= 200 && status < 300) || status === 404) {
    return
  }

  throw new E2BApiStatusError("Template delete", status, response.error ?? `Unexpected status ${status}`)
}

export function findE2BTemplateByAlias(
  templates: E2BTemplateListEntry[],
  alias: string,
): E2BTemplateListEntry | undefined {
  return templates.find((entry) => templateCandidateNames(entry).some((name) => name === alias))
}

export function templateCandidateNames(entry: Pick<E2BTemplateListEntry, "names" | "aliases">): string[] {
  return [...candidateValues(entry.names), ...candidateValues(entry.aliases)].map(stripE2BNamespace)
}

export function isE2BNotFoundError(error: unknown): boolean {
  // The SDK wraps template 404s as TemplateError messages rather than a typed
  // NotFoundError, so keep this string check contained at the SDK boundary.
  return /^404:/.test(errorMessage(error))
}

function createE2BSDKLogger(logger?: PluginLogger): E2BLogger | undefined {
  if (!logger) return undefined

  // SDK calls that fail are logged again with workspace context by callers.
  // Keep raw SDK chatter one level quieter to avoid duplicate prominent logs.
  return {
    debug: (...args: unknown[]) => writeLog(logger, "debug", args),
    info: (...args: unknown[]) => writeLog(logger, "debug", args),
    warn: (...args: unknown[]) => writeLog(logger, "info", args),
    error: (...args: unknown[]) => writeLog(logger, "warn", args),
  }
}

function writeLog(logger: PluginLogger, level: keyof PluginLogger, args: unknown[]): void {
  try {
    void Promise.resolve(logger[level](formatLogArgs(args))).catch(() => {})
  } catch {
    // SDK logging must never affect the request it is observing.
  }
}

function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogArg).join(" ")
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function stripE2BNamespace(name: string): string {
  const slashIndex = name.lastIndexOf("/")
  return slashIndex >= 0 ? name.slice(slashIndex + 1) : name
}

function candidateValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
