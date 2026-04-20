import { createHash } from "node:crypto"

import { Template, waitForProcess } from "e2b"

import type { PluginLogger } from "./types.js"

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
 * Build or reuse a derived E2B template that replaces the base template's
 * startup command with an inert process. `Sandbox.create()` cannot override a
 * template entrypoint directly, so provisioning must happen through a managed
 * template alias instead.
 */
export async function ensureManagedWorkspaceTemplate(
  baseTemplate: string,
  logger?: PluginLogger,
): Promise<string> {
  const alias = buildManagedTemplateAlias(baseTemplate)
  const existing = managedTemplatePromises.get(alias)
  if (existing) {
    return existing
  }

  const resolution = resolveManagedWorkspaceTemplate(baseTemplate, alias, logger)
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
async function resolveManagedWorkspaceTemplate(
  baseTemplate: string,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed template lookup start", {
    baseTemplate,
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
    baseTemplate,
    alias,
  })

  const template = Template()
    .fromTemplate(baseTemplate)
    .setStartCmd(IDLE_TEMPLATE_START_COMMAND, waitForProcess("tail"))

  try {
    await Template.build(template, alias)
    await logger?.info("managed template build complete", {
      baseTemplate,
      alias,
    })
    return alias
  } catch (error) {
    // A second OpenCode process may have published the same deterministic alias
    // while this build was running. Treat that as success instead of failing a
    // perfectly reusable startup override.
    if (await Template.exists(alias).catch(() => false)) {
      await logger?.warn("managed template build raced with existing alias", {
        baseTemplate,
        alias,
        error: errorMessage(error),
      })
      return alias
    }

    throw new Error(
      `Failed to build managed E2B template ${alias} from ${baseTemplate}: ${errorMessage(error)}`,
    )
  }
}

/**
 * Derive a stable alias from the requested base template so all workspaces can
 * share the same startup-override template instead of rebuilding one per
 * workspace.
 */
function buildManagedTemplateAlias(baseTemplate: string): string {
  const readableBase = normalizeAliasSegment(baseTemplate).slice(0, 32) || "template"
  const hash = createHash("sha256")
    .update(`${MANAGED_TEMPLATE_REVISION}\0${baseTemplate}`)
    .digest("hex")
    .slice(0, 12)

  return `opencode-idle-${readableBase}-r${MANAGED_TEMPLATE_REVISION}-${hash}`
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
