import { createHash } from "node:crypto"

import { ApiClient, ConnectionConfig, Template, TemplateError, waitForProcess } from "e2b"

import type { BaseTemplateFingerprint, PluginLogger, SandboxMetadataCompatibility } from "./types.js"

/**
 * Bump this whenever the managed template's startup behavior changes so the
 * plugin builds a fresh alias instead of reusing an older derived template.
 */
const MANAGED_TEMPLATE_REVISION = "1"

/**
 * The replacement template start command deliberately does nothing except keep
 * PID 1 alive. This prevents the baked template from auto-starting an old
 * OpenCode process before the plugin has a chance to install the pinned local
 * runtime version and launch the server itself.
 */
const IDLE_TEMPLATE_START_COMMAND = "tail -f /dev/null"

/**
 * Keep one in-flight build promise per managed alias so concurrent workspace
 * creations in the same OpenCode process do not race to publish the same
 * derived template.
 */
const managedTemplatePromises = new Map<string, Promise<string>>()

/**
 * Resolve the current upstream template/build identifiers behind the configured
 * base template reference. Aliases can move as E2B publishes new builds, so we
 * fingerprint the current build ID and use it as part of sandbox reuse logic.
 */
export async function resolveBaseTemplateFingerprint(
  requestedTemplate: string,
  logger?: PluginLogger,
): Promise<BaseTemplateFingerprint> {
  await logger?.info("base template fingerprint lookup start", {
    requestedTemplate,
  })

  const reference = parseTemplateReference(requestedTemplate)
  const client = new ApiClient(new ConnectionConfig())
  const templateId = await resolveTemplateId(client, reference.name)
  const buildId = reference.tag
    ? await resolveTaggedBuildId(templateId, reference.tag, requestedTemplate)
    : await resolveLatestReadyBuildId(client, templateId, requestedTemplate)

  const fingerprint = {
    requestedTemplate,
    templateId,
    buildId,
  }

  await logger?.info("base template fingerprint lookup complete", fingerprint)
  return fingerprint
}

/**
 * Build or reuse a derived E2B template that replaces the base template's
 * startup command with an inert process. `Sandbox.create()` cannot override a
 * template entrypoint directly, so provisioning must happen through a managed
 * template alias instead.
 */
export async function ensureManagedWorkspaceTemplate(
  baseTemplate: BaseTemplateFingerprint,
  logger?: PluginLogger,
): Promise<string> {
  const alias = buildManagedTemplateAlias(baseTemplate)
  const existing = managedTemplatePromises.get(alias)
  if (existing) {
    return existing
  }

  const resolution = buildManagedWorkspaceTemplate(baseTemplate, alias, logger)
  managedTemplatePromises.set(alias, resolution)

  try {
    return await resolution
  } catch (error) {
    if (managedTemplatePromises.get(alias) === resolution) {
      managedTemplatePromises.delete(alias)
    }
    throw error
  }
}

/**
 * Resolve the derived template alias, building it once if the alias has not
 * been published yet.
 */
async function buildManagedWorkspaceTemplate(
  baseTemplate: BaseTemplateFingerprint,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed template lookup start", {
    baseTemplate: baseTemplate.requestedTemplate,
    baseTemplateId: baseTemplate.templateId,
    baseTemplateBuildId: baseTemplate.buildId,
    alias,
    revision: MANAGED_TEMPLATE_REVISION,
  })

  if (await Template.exists(alias)) {
    await logger?.info("managed template reuse", {
      baseTemplate,
      alias,
    })
    return alias
  }

  await logger?.info("managed template build start", {
    baseTemplate: baseTemplate.requestedTemplate,
    baseTemplateId: baseTemplate.templateId,
    baseTemplateBuildId: baseTemplate.buildId,
    alias,
  })

  const template = Template()
    .fromTemplate(baseTemplate.requestedTemplate)
    .setStartCmd(IDLE_TEMPLATE_START_COMMAND, waitForProcess("tail"))

  try {
    await Template.build(template, alias)
    await logger?.info("managed template build complete", {
      baseTemplate: baseTemplate.requestedTemplate,
      baseTemplateId: baseTemplate.templateId,
      baseTemplateBuildId: baseTemplate.buildId,
      alias,
    })
    return alias
  } catch (error) {
    // A second OpenCode process may have published the same deterministic alias
    // while this build was running. Treat that as success instead of failing a
    // perfectly reusable startup override.
    if (await Template.exists(alias).catch(() => false)) {
      await logger?.warn("managed template build raced with existing alias", {
        baseTemplate: baseTemplate.requestedTemplate,
        baseTemplateId: baseTemplate.templateId,
        baseTemplateBuildId: baseTemplate.buildId,
        alias,
        error: errorMessage(error),
      })
      return alias
    }

    throw new Error(
      `Failed to build managed E2B template ${alias} from ${baseTemplate.requestedTemplate}: ${errorMessage(error)}`,
    )
  }
}

/**
 * Decide whether an existing sandbox should be replaced because the configured
 * base template now resolves to a different upstream build. Missing metadata is
 * treated as outdated so older sandboxes get one clean reprovision onto the new
 * tracking scheme.
 */
export function describeBaseTemplateMismatch(
  currentBaseTemplate: BaseTemplateFingerprint,
  sandboxCompatibility: SandboxMetadataCompatibility,
): string | undefined {
  if (!sandboxCompatibility.baseTemplateBuildId) {
    return "sandbox metadata is missing the tracked base template build ID"
  }
  if (sandboxCompatibility.baseTemplateBuildId !== currentBaseTemplate.buildId) {
    return (
      `sandbox was created from base template build ${sandboxCompatibility.baseTemplateBuildId}, ` +
      `but ${currentBaseTemplate.requestedTemplate} now resolves to ${currentBaseTemplate.buildId}`
    )
  }
  if (sandboxCompatibility.baseTemplateId && sandboxCompatibility.baseTemplateId !== currentBaseTemplate.templateId) {
    return (
      `sandbox was created from template ${sandboxCompatibility.baseTemplateId}, ` +
      `but ${currentBaseTemplate.requestedTemplate} now resolves to ${currentBaseTemplate.templateId}`
    )
  }
  if (sandboxCompatibility.baseTemplate && sandboxCompatibility.baseTemplate !== currentBaseTemplate.requestedTemplate) {
    return (
      `sandbox was created from configured base template ${sandboxCompatibility.baseTemplate}, ` +
      `but the workspace now requests ${currentBaseTemplate.requestedTemplate}`
    )
  }

  return undefined
}

/**
 * Derive a stable alias from the requested base template and the upstream build
 * it currently resolves to. When E2B publishes a newer build behind the same
 * alias, the managed template alias changes automatically and the plugin builds
 * a fresh idle-start derivative on demand.
 */
function buildManagedTemplateAlias(baseTemplate: BaseTemplateFingerprint): string {
  const readableBase = normalizeAliasSegment(baseTemplate.requestedTemplate).slice(0, 32) || "template"
  const hash = createHash("sha256")
    .update(`${MANAGED_TEMPLATE_REVISION}\0${baseTemplate.templateId}\0${baseTemplate.buildId}`)
    .digest("hex")
    .slice(0, 12)

  return `opencode-idle-${readableBase}-r${MANAGED_TEMPLATE_REVISION}-${hash}`
}

/**
 * Split an E2B template reference into name and optional tag. We only treat a
 * colon after the last slash as a tag separator so namespaced templates like
 * `team/template` keep their namespace intact.
 */
function parseTemplateReference(reference: string): { name: string; tag?: string } {
  const slashIndex = reference.lastIndexOf("/")
  const colonIndex = reference.lastIndexOf(":")
  if (colonIndex <= slashIndex) {
    return { name: reference }
  }

  return {
    name: reference.slice(0, colonIndex),
    tag: reference.slice(colonIndex + 1),
  }
}

/**
 * Resolve the provider template ID for a configured base template reference.
 * Aliases need an extra lookup, while raw template IDs can be used directly.
 */
async function resolveTemplateId(client: ApiClient, reference: string): Promise<string> {
  const aliasResponse = await client.api.GET("/templates/aliases/{alias}", {
    params: {
      path: {
        alias: reference,
      },
    },
  })

  if (aliasResponse.response.status === 404) {
    return reference
  }

  if (aliasResponse.error) {
    throw new TemplateError(`${aliasResponse.response.status}: ${errorMessage(aliasResponse.error)}`)
  }

  const templateId = aliasResponse.data?.templateID
  if (!templateId) {
    throw new Error(`Template alias lookup returned no template ID for ${reference}`)
  }

  return templateId
}

/**
 * Read the newest successful build from a template's build history.
 */
async function resolveLatestReadyBuildId(
  client: ApiClient,
  templateId: string,
  requestedTemplate: string,
): Promise<string> {
  const response = await client.api.GET("/templates/{templateID}", {
    params: {
      path: {
        templateID: templateId,
      },
    },
  })

  if (response.error) {
    throw new TemplateError(`${response.response.status}: ${errorMessage(response.error)}`)
  }

  const latestReadyBuild = [...(response.data?.builds ?? [])]
    .filter((build) => build.status === "ready")
    .sort(compareBuildRecency)
    .at(-1)
  if (!latestReadyBuild) {
    throw new Error(`Template ${requestedTemplate} (${templateId}) has no ready build to derive from`)
  }

  return latestReadyBuild.buildID
}

/**
 * Resolve the build targeted by an explicit template tag.
 */
async function resolveTaggedBuildId(templateId: string, tag: string, requestedTemplate: string): Promise<string> {
  const tags = await Template.getTags(templateId)
  const match = tags.find((entry) => entry.tag === tag)
  if (!match) {
    throw new Error(`Template ${requestedTemplate} does not have tag ${tag}`)
  }

  return match.buildId
}

/**
 * Compare template builds by the freshest timestamp we can extract from the
 * build record.
 */
function compareBuildRecency(
  left: { finishedAt?: string; updatedAt: string; createdAt: string },
  right: { finishedAt?: string; updatedAt: string; createdAt: string },
): number {
  return resolveBuildTimestamp(left) - resolveBuildTimestamp(right)
}

/**
 * Pick the best available timestamp for a template build.
 */
function resolveBuildTimestamp(build: { finishedAt?: string; updatedAt: string; createdAt: string }): number {
  const timestamp = build.finishedAt ?? build.updatedAt ?? build.createdAt
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Convert a provider template name into an alias-safe slug.
 */
function normalizeAliasSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Normalize unknown thrown values into a readable message for logging.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
