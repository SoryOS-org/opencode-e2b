import { ApiClient, ConnectionConfig } from "e2b"

import { errorMessage } from "./shared.js"
import { MANAGED_TEMPLATE_PREFIX } from "./template.js"
import type { E2BTemplateGCOptions, PluginLogger } from "./types.js"

export const DEFAULT_TEMPLATE_GC_TTL_MS = 72 * 60 * 60 * 1000
export const MIN_TEMPLATE_GC_TTL_MS = 60 * 60 * 1000
export const DEFAULT_TEMPLATE_GC_COOLDOWN_MS = 10 * 60 * 1000

const TEMPLATE_GC_DELETE_CONCURRENCY = 4

type ResolvedGCConfig = Required<E2BTemplateGCOptions>

/**
 * Minimal template shape consumed by the GC pass. The SDK exposes many more
 * fields, but these are the only ones needed for ownership, staleness, and
 * deletion decisions.
 */
type E2BTemplateListEntry = {
  templateID: string
  names?: string[]
  aliases?: string[]
  buildStatus?: string
  lastSpawnedAt?: string | null
  updatedAt?: string
  createdAt?: string
}

/**
 * Derived deletion candidate metadata computed once up front so logging and
 * deletion do not have to recompute alias ownership or freshness.
 */
type StaleTemplateCandidate = {
  entry: E2BTemplateListEntry
  alias: string
  ageMs: number
}

let gcPromise: Promise<void> | undefined
let lastGcAt = 0

/**
 * Best-effort garbage collection of managed templates older than the configured
 * TTL. The returned promise always resolves; all failures are logged through
 * the plugin logger and swallowed so callers never block or fail.
 */
export function runTemplateGC(config: ResolvedGCConfig, logger?: PluginLogger): Promise<void> {
  if (!config.enabled) {
    return Promise.resolve()
  }

  const now = Date.now()
  if (gcPromise) {
    return gcPromise
  }
  if (now - lastGcAt < config.cooldownMs) {
    return Promise.resolve()
  }

  lastGcAt = now
  const run = performGC(config, logger)
    .catch(async (error) => {
      await logger?.error("template gc failed", {
        error: errorMessage(error),
      })
    })
    .finally(() => {
      if (gcPromise === run) {
        gcPromise = undefined
      }
    })

  gcPromise = run
  return run
}

/**
 * List templates from E2B, filter to managed stale candidates, and delete them
 * with bounded parallelism. Any per-template failure is logged and does not
 * stop the remainder of the sweep.
 */
async function performGC(config: ResolvedGCConfig, logger?: PluginLogger): Promise<void> {
  const startedAt = Date.now()
  await logger?.info("template gc start", {
    ttlMs: config.ttlMs,
    cooldownMs: config.cooldownMs,
  })

  const client = new ApiClient(new ConnectionConfig(), {
    requireApiKey: true,
  })
  const templates = await listTemplates(client, logger)
  const managedTemplates = templates.filter(isManagedTemplate)
  const staleTemplates = selectStaleManagedTemplates(templates, startedAt, config.ttlMs)
  const skippedInFlight = managedTemplates.filter((entry) => entry.buildStatus !== "ready").length

  await logger?.info("template gc listed templates", {
    total: templates.length,
    managed: managedTemplates.length,
    ready: managedTemplates.length - skippedInFlight,
    stale: staleTemplates.length,
  })

  let deleted = 0
  let failed = 0

  for (let index = 0; index < staleTemplates.length; index += TEMPLATE_GC_DELETE_CONCURRENCY) {
    const batch = staleTemplates.slice(index, index + TEMPLATE_GC_DELETE_CONCURRENCY)
    const results = await Promise.all(batch.map((candidate) => deleteTemplate(client, candidate, logger)))
    deleted += results.filter(Boolean).length
    failed += results.filter((wasDeleted) => !wasDeleted).length
  }

  await logger?.info("template gc complete", {
    deleted,
    failed,
    skippedInFlight,
    durationMs: Date.now() - startedAt,
  })
}

export function selectStaleManagedTemplates(
  templates: E2BTemplateListEntry[],
  now: number,
  ttlMs: number,
): StaleTemplateCandidate[] {
  return templates.flatMap((entry) => {
    const alias = firstManagedAlias(entry)
    if (!alias || entry.buildStatus !== "ready") {
      return []
    }

    const ageMs = now - freshness(entry)
    if (ageMs <= ttlMs) {
      return []
    }

    return [{ entry, alias, ageMs }]
  })
}

/**
 * Fetch the account's template list once. Authentication failures are logged as
 * warnings and treated as a no-op so GC stays best-effort during degraded auth
 * states.
 */
async function listTemplates(client: ApiClient, logger?: PluginLogger): Promise<E2BTemplateListEntry[]> {
  try {
    const response = await client.api.GET("/templates", {
      params: {
        query: {},
      },
    })
    const status = response.response.status

    if (status === 401 || status === 403) {
      await logger?.warn("template gc list skipped due to auth failure", {
        status,
      })
      return []
    }

    if (status >= 400) {
      throw new Error(`Template list failed with status ${status}`)
    }

    if (!Array.isArray(response.data)) {
      await logger?.warn("template gc list returned unexpected payload", {
        status,
      })
      return []
    }

    return response.data as E2BTemplateListEntry[]
  } catch (error) {
    throw new Error(`Failed to list E2B templates: ${errorMessage(error)}`)
  }
}

/**
 * Return whether the template advertises at least one managed alias. Namespaced
 * `team/alias` entries are normalized to the suffix after the last slash.
 */
function isManagedTemplate(entry: E2BTemplateListEntry): boolean {
  return firstManagedAlias(entry) !== undefined
}

/**
 * Resolve the first managed alias from the provider response. `names` is the
 * canonical source; deprecated `aliases` is only used when `names` is absent or
 * empty so we remain tolerant of API shape quirks.
 */
function firstManagedAlias(entry: E2BTemplateListEntry): string | undefined {
  return listCandidateNames(entry)
    .map(stripNamespace)
    .find((name) => name.startsWith(MANAGED_TEMPLATE_PREFIX))
}

/**
 * Select the provider field that carries alias-like names. The newer `names`
 * field wins whenever it has entries.
 */
function listCandidateNames(entry: E2BTemplateListEntry): string[] {
  if (Array.isArray(entry.names) && entry.names.length > 0) {
    return entry.names
  }
  if (Array.isArray(entry.aliases)) {
    return entry.aliases
  }
  return []
}

/**
 * Strip any provider namespace prefix such as `team/alias`, keeping only the
 * final path segment for managed-prefix matching.
 */
function stripNamespace(name: string): string {
  const slashIndex = name.lastIndexOf("/")
  return slashIndex >= 0 ? name.slice(slashIndex + 1) : name
}

/**
 * Compute freshness as the maximum valid timestamp across last spawn, update,
 * and creation time. Invalid or missing timestamps contribute zero.
 */
function freshness(entry: E2BTemplateListEntry): number {
  return Math.max(
    parseTimestamp(entry.lastSpawnedAt),
    parseTimestamp(entry.updatedAt),
    parseTimestamp(entry.createdAt),
  )
}

/**
 * Parse an ISO timestamp into epoch milliseconds. Invalid values are folded to
 * zero so they do not make the template look newer than it is.
 */
function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Delete a stale managed template. HTTP 404 is treated as success because the
 * template may already have been removed by another process between list and
 * delete.
 */
async function deleteTemplate(
  client: ApiClient,
  candidate: StaleTemplateCandidate,
  logger?: PluginLogger,
): Promise<boolean> {
  try {
    const response = await client.api.DELETE("/templates/{templateID}", {
      params: {
        path: {
          templateID: candidate.entry.templateID,
        },
      },
    })
    const status = response.response.status

    if ((status >= 200 && status < 300) || status === 404) {
      await logger?.info("template gc deleted", {
        templateID: candidate.entry.templateID,
        alias: candidate.alias,
        ageMs: candidate.ageMs,
      })
      return true
    }

    await logger?.warn("template gc delete failed", {
      templateID: candidate.entry.templateID,
      status,
      error: errorMessage(response.error ?? `Unexpected status ${status}`),
    })
    return false
  } catch (error) {
    await logger?.warn("template gc delete failed", {
      templateID: candidate.entry.templateID,
      error: errorMessage(error),
    })
    return false
  }
}
