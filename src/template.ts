import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import { Template } from "e2b"

import {
  createE2BApiClient,
  createE2BConnectionOptions,
  deleteE2BTemplate,
  findE2BTemplateByAlias,
  isE2BNotFoundError,
  listE2BTemplates,
  type E2BTemplateListEntry,
} from "./e2b-sdk.js"
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
const MANAGED_TEMPLATE_READY_TIMEOUT_MS = 30 * 60 * 1000
const MANAGED_TEMPLATE_READY_POLL_MS = 5 * 1000
const MANAGED_TEMPLATE_READY_MAX_POLL_MS = 30 * 1000

type ManagedTemplateState =
  | { kind: "missing" }
  | { kind: "ready"; template: E2BTemplateListEntry }
  | { kind: "pending"; template: E2BTemplateListEntry }
  | { kind: "failed"; template: E2BTemplateListEntry }

type ManagedBuildRaceResolution = "reuse" | "retry" | "unresolved"

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

  const existingTemplate = await findManagedTemplateState(alias, logger)
  if (existingTemplate.kind === "ready") {
    await logger?.info("managed template reuse", {
      alias,
    })
    return alias
  }
  if (existingTemplate.kind === "pending") {
    await logger?.info("managed template build already in progress", {
      alias,
      buildStatus: existingTemplate.template.buildStatus,
    })
    await waitForManagedTemplateReady(alias, logger)
    return alias
  }
  if (existingTemplate.kind === "failed") {
    await deleteFailedManagedTemplate(alias, existingTemplate.template, logger)
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
    await buildManagedTemplateOnce(template, alias, logger)
    await logger?.info("managed template build complete", {
      alias,
    })
    return alias
  } catch (error) {
    const raceResolution = await resolveManagedTemplateBuildRace(alias, logger)
    if (raceResolution === "retry") {
      try {
        await buildManagedTemplateOnce(template, alias, logger)
        await logger?.info("managed template build complete", {
          alias,
        })
        return alias
      } catch (retryError) {
        throw new Error(
          `Failed to build managed E2B template ${alias} from node image ${inputs.nodeVariant}: ${errorMessage(retryError)}`,
        )
      }
    }
    if (raceResolution === "reuse") {
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

async function templateHasDefaultTag(alias: string, logger?: PluginLogger): Promise<boolean> {
  try {
    return (
      await Template.getTags(alias, {
        ...createE2BConnectionOptions(logger),
      })
    ).some((item) => item.tag === "default")
  } catch (error) {
    if (isE2BNotFoundError(error)) {
      return false
    }

    throw error
  }
}

export function buildOpenCodeInstallCommand(runtimeVersion: string): string {
  return `npm install -g --omit=optional opencode-ai@${runtimeVersion}`
}

export function buildPrebuiltOpenCodeTemplateName(runtimeVersion: string): string {
  return `e2b/opencode:${runtimeVersion}`
}

async function findManagedTemplateState(alias: string, logger?: PluginLogger): Promise<ManagedTemplateState> {
  if (!(await templateHasDefaultTag(alias, logger))) {
    return { kind: "missing" }
  }

  return findListedManagedTemplateState(alias, logger)
}

async function findListedManagedTemplateState(
  alias: string,
  logger?: PluginLogger,
): Promise<ManagedTemplateState> {
  const client = createE2BApiClient(logger)
  const templates = await listE2BTemplates(client)
  const template = findE2BTemplateByAlias(templates, alias)
  if (!template) {
    return { kind: "missing" }
  }

  if (template.buildStatus === "ready") {
    return { kind: "ready", template }
  }
  if (template.buildStatus === "error") {
    return { kind: "failed", template }
  }

  return { kind: "pending", template }
}

async function resolveManagedTemplateBuildRace(
  alias: string,
  logger?: PluginLogger,
): Promise<ManagedBuildRaceResolution> {
  const state = await findManagedTemplateState(alias, logger)
  if (state.kind === "ready") {
    return "reuse"
  }
  if (state.kind === "pending") {
    await logger?.info("managed template build raced with in-progress alias", {
      alias,
      buildStatus: state.template.buildStatus,
    })
    await waitForManagedTemplateReady(alias, logger)
    return "reuse"
  }
  if (state.kind === "failed") {
    await deleteFailedManagedTemplate(alias, state.template, logger)
    return "retry"
  }

  return "unresolved"
}

async function waitForManagedTemplateReady(alias: string, logger?: PluginLogger): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + MANAGED_TEMPLATE_READY_TIMEOUT_MS
  let delayMs = MANAGED_TEMPLATE_READY_POLL_MS

  while (Date.now() < deadline) {
    const state = await findListedManagedTemplateState(alias, logger)
    if (state.kind === "ready") {
      await logger?.info("managed template build became ready", {
        alias,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    if (state.kind === "failed") {
      throw new Error(`Managed E2B template ${alias} build failed while waiting`)
    }
    if (state.kind === "missing") {
      throw new Error(`Managed E2B template ${alias} disappeared while waiting for build`)
    }

    await sleep(Math.min(delayMs, Math.max(deadline - Date.now(), 0)))
    delayMs = Math.min(delayMs * 2, MANAGED_TEMPLATE_READY_MAX_POLL_MS)
  }

  throw new Error(`Timed out waiting for managed E2B template ${alias} to become ready`)
}

async function deleteFailedManagedTemplate(
  alias: string,
  template: E2BTemplateListEntry,
  logger?: PluginLogger,
): Promise<void> {
  await logger?.warn("managed template previous build failed; deleting before rebuild", {
    alias,
    templateID: template.templateID,
    buildStatus: template.buildStatus,
  })
  await deleteE2BTemplate(createE2BApiClient(logger), template.templateID)
}

async function buildManagedTemplateOnce(
  template: Parameters<typeof Template.build>[0],
  alias: string,
  logger?: PluginLogger,
): Promise<void> {
  await Template.build(template, alias, createE2BConnectionOptions(logger))
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
