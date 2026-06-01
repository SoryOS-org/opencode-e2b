import { createHash } from "node:crypto"

import { Template } from "e2b"

import { errorMessage, shellSingleQuote } from "./shared.js"
import type { PluginLogger } from "./types.js"

/**
 * Prefix for templates managed by this plugin. GC uses it as the ownership
 * boundary.
 */
export const MANAGED_TEMPLATE_PREFIX = "opencode-e2b-"

/**
 * Absolute path inside the sandbox where the plugin writes an empty file to
 * release the baked `opencode serve` command.
 */
export const BOOTSTRAP_READY_MARKER = "/tmp/.opencode-e2b-bootstrap-ready"

const START_COMMAND_LOG_PATH = "/tmp/opencode-serve.log"

/**
 * E2B's `Sandbox.create({ envs })` only affects later commands, not the
 * template init command, so OpenCode env is delivered through this file.
 */
export const RUNTIME_ENV_FILE = "/tmp/.opencode-e2b.env"

const managedTemplatePromises = new Map<string, Promise<string>>()

export type ManagedTemplateInputs = {
  nodeVariant: string
  runtimeVersion: string
  projectPath: string
  serverPort: number
  pluginPackageVersion: string
}

export async function ensureManagedWorkspaceTemplate(
  inputs: ManagedTemplateInputs,
  logger?: PluginLogger,
): Promise<string> {
  const prebuilt = await resolvePrebuiltOpenCodeTemplate(inputs, logger)
  if (prebuilt) {
    return prebuilt
  }

  const alias = buildManagedTemplateAlias(inputs)
  const existing = managedTemplatePromises.get(alias)
  if (existing) {
    return existing
  }

  const resolution = buildManagedWorkspaceTemplate(inputs, alias, logger)
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

async function resolvePrebuiltOpenCodeTemplate(
  inputs: ManagedTemplateInputs,
  logger?: PluginLogger,
): Promise<string | undefined> {
  const templateName = buildPrebuiltOpenCodeTemplateName(inputs.runtimeVersion)

  await logger?.info("prebuilt template lookup start", {
    templateName,
    runtimeVersion: inputs.runtimeVersion,
  })

  let exists: boolean
  try {
    exists = await Template.exists(templateName)
  } catch (error) {
    throw new Error(`Failed to check for prebuilt E2B template ${templateName}: ${errorMessage(error)}`)
  }

  if (!exists) {
    await logger?.info("prebuilt template missing; falling back to managed template", {
      templateName,
    })
    return undefined
  }

  await logger?.info("prebuilt template reuse", {
    templateName,
  })
  return templateName
}

async function buildManagedWorkspaceTemplate(
  inputs: ManagedTemplateInputs,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed template lookup start", {
    nodeVariant: inputs.nodeVariant,
    runtimeVersion: inputs.runtimeVersion,
    projectPath: inputs.projectPath,
    serverPort: inputs.serverPort,
    pluginPackageVersion: inputs.pluginPackageVersion,
    alias,
  })

  if (await templateHasDefaultTag(alias)) {
    await logger?.info("managed template reuse", {
      alias,
    })
    return alias
  }

  await logger?.info("managed template build start", {
    nodeVariant: inputs.nodeVariant,
    runtimeVersion: inputs.runtimeVersion,
    alias,
  })

  const template = Template()
    .fromNodeImage(inputs.nodeVariant)
    .runCmd(buildOpenCodeInstallCommand(inputs.runtimeVersion), { user: "root" })
    .setStartCmd(
      buildBakedStartCommand(inputs.projectPath, inputs.serverPort),
      // E2B polls the ready command during `Sandbox.create()`. Because our
      // start command blocks on a marker that only the plugin writes *after*
      // create returns, any real readiness probe (waitForPort, waitForFile)
      // would deadlock sandbox creation. `true` always exits 0, so E2B
      // considers the sandbox ready as soon as init completes; the plugin
      // drives a second readiness wait against /global/health once the
      // bootstrap marker has been written.
      "true",
    )

  try {
    await Template.build(template, alias)
    await logger?.info("managed template build complete", {
      alias,
    })
    return alias
  } catch (error) {
    if (await templateHasDefaultTag(alias)) {
      await logger?.warn("managed template build raced with existing alias", {
        alias,
        error: errorMessage(error),
      })
      return alias
    }

    throw new Error(
      `Failed to build managed E2B template ${alias} from node image ${inputs.nodeVariant}: ${errorMessage(error)}`,
    )
  }
}

async function templateHasDefaultTag(alias: string): Promise<boolean> {
  try {
    return (await Template.getTags(alias)).some((item) => item.tag === "default")
  } catch {
    return false
  }
}

export function buildOpenCodeInstallCommand(runtimeVersion: string): string {
  return `npm install -g --include=optional opencode-ai@${runtimeVersion}`
}

export function buildPrebuiltOpenCodeTemplateName(runtimeVersion: string): string {
  return `e2b/opencode:${runtimeVersion}`
}

/**
 * The template starts before project upload finishes, so it waits on a marker
 * file. The cap prevents a stuck sandbox if provisioning dies mid-flight.
 */
function buildBakedStartCommand(projectPath: string, serverPort: number): string {
  const quotedProjectPath = shellSingleQuote(projectPath)
  return [
    `exec >${START_COMMAND_LOG_PATH} 2>&1`,
    `for _ in $(seq 1 2400); do [ -f ${BOOTSTRAP_READY_MARKER} ] && break; sleep 0.25; done`,
    `if [ -f ${RUNTIME_ENV_FILE} ]; then set -a; . ${RUNTIME_ENV_FILE}; set +a; fi`,
    `cd ${quotedProjectPath} 2>/dev/null || true`,
    `exec /usr/local/bin/opencode serve --hostname 0.0.0.0 --port ${serverPort}`,
  ].join(" && ")
}

export function buildManagedTemplateAlias(inputs: ManagedTemplateInputs): string {
  const readableNodeVariant = normalizeAliasSegment(inputs.nodeVariant).slice(0, 24) || "node"
  const hash = createHash("sha256")
    .update(
      [
        inputs.nodeVariant,
        inputs.runtimeVersion,
        inputs.projectPath,
        String(inputs.serverPort),
        inputs.pluginPackageVersion,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12)

  return `${MANAGED_TEMPLATE_PREFIX}${readableNodeVariant}-${hash}`
}

function normalizeAliasSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
