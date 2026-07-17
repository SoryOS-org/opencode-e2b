import type { ApiClient } from "e2b"

import {
  createE2BApiClient,
  deleteE2BTemplate,
  E2BApiStatusError,
  type E2BTemplateListEntry,
  listE2BTemplates,
  templateCandidateNames,
} from "./e2b-sdk.js"
import { errorMessage } from "./shared.js"
import { forgetManagedTemplate, MANAGED_TEMPLATE_PREFIX } from "./template.js"
import type { E2BTemplateGCOptions, PluginLogger } from "./types.js"

export const DEFAULT_TEMPLATE_GC_TTL_MS = 72 * 60 * 60 * 1000
export const MIN_TEMPLATE_GC_TTL_MS = 60 * 60 * 1000
export const DEFAULT_TEMPLATE_GC_COOLDOWN_MS = 10 * 60 * 1000

const TEMPLATE_GC_DELETE_CONCURRENCY = 4

type ResolvedGCConfig = Required<E2BTemplateGCOptions>

type StaleTemplateCandidate = {
  entry: E2BTemplateListEntry
  alias: string
  ageMs: number
}

let gcPromise: Promise<void> | undefined
let lastGcAt = 0

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

async function performGC(config: ResolvedGCConfig, logger?: PluginLogger): Promise<void> {
  const startedAt = Date.now()
  await logger?.info("template gc start", {
    ttlMs: config.ttlMs,
    cooldownMs: config.cooldownMs,
  })

  const client = createE2BApiClient(logger)
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

async function listTemplates(client: ApiClient, logger?: PluginLogger): Promise<E2BTemplateListEntry[]> {
  try {
    return await listE2BTemplates(client)
  } catch (error) {
    if (error instanceof E2BApiStatusError && (error.status === 401 || error.status === 403)) {
      await logger?.warn("template gc list skipped due to auth failure", {
        status: error.status,
      })
      return []
    }
    throw new Error(`Failed to list E2B templates: ${errorMessage(error)}`)
  }
}

function isManagedTemplate(entry: E2BTemplateListEntry): boolean {
  return firstManagedAlias(entry) !== undefined
}

function firstManagedAlias(entry: E2BTemplateListEntry): string | undefined {
  return templateCandidateNames(entry).find((name) => name.startsWith(MANAGED_TEMPLATE_PREFIX))
}

function freshness(entry: E2BTemplateListEntry): number {
  return Math.max(
    parseTimestamp(entry.lastSpawnedAt),
    parseTimestamp(entry.updatedAt),
    parseTimestamp(entry.createdAt),
  )
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

async function deleteTemplate(
  client: ApiClient,
  candidate: StaleTemplateCandidate,
  logger?: PluginLogger,
): Promise<boolean> {
  try {
    await deleteE2BTemplate(client, candidate.entry.templateID)
    // Drop this process's cached alias resolution so the next create
    // re-ensures the template instead of spawning from the deleted alias.
    forgetManagedTemplate(candidate.alias)
    await logger?.info("template gc deleted", {
      templateID: candidate.entry.templateID,
      alias: candidate.alias,
      ageMs: candidate.ageMs,
    })
    return true
  } catch (error) {
    await logger?.warn("template gc delete failed", {
      templateID: candidate.entry.templateID,
      error: errorMessage(error),
    })
    return false
  }
}
