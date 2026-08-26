import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import { Template, TemplateBase, type TemplateClass } from "e2b"

import {
  createE2BApiClient,
  createE2BConnectionOptions,
  deleteE2BTemplate,
  findE2BTemplateByAlias,
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

const SYSTEMD_SERVICE_NAME = "opencode-e2b.service"
const SYSTEMD_SERVICE_PATH = `/etc/systemd/system/${SYSTEMD_SERVICE_NAME}`
const SYSTEMD_START_SCRIPT_PATH = "/usr/local/bin/opencode-e2b-start"

// Run opencode as the project-owning user, not root (`User=` is how a systemd
// service drops root). As root, git's dubious-ownership check rejects the
// user-owned repo, so opencode can't detect the git project and a warped
// session's insert fails with a remote FOREIGN KEY error (opaque 500).
const SANDBOX_USER = "user"

/**
 * E2B's `Sandbox.create({ envs })` only affects later commands, not the
 * template init command, so OpenCode env is delivered through this file.
 */
export const RUNTIME_ENV_FILE = "/tmp/.opencode-e2b.env"

const managedTemplatePromises = new Map<string, Promise<string>>()
const MANAGED_TEMPLATE_READY_TIMEOUT_MS = 30 * 60 * 1000
const MANAGED_TEMPLATE_READY_POLL_MS = 5 * 1000
const MANAGED_TEMPLATE_READY_MAX_POLL_MS = 30 * 1000
const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

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

export type ManagedBaseTemplateInputs = {
  nodeVariant: string
  runtimeVersion: string
  pluginPackageVersion: string
}

export type ManagedWorkspaceTemplateInputs = ManagedTemplateInputs & {
  baseTemplate: string
}

export async function ensureManagedBaseTemplate(
  inputs: ManagedBaseTemplateInputs,
  logger?: PluginLogger,
): Promise<string> {
  const alias = buildManagedBaseTemplateAlias(inputs)
  const existing = managedTemplatePromises.get(alias)
  if (existing) {
    return existing
  }

  const resolution = buildManagedBaseTemplate(inputs, alias, logger)
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

export async function ensureManagedWorkspaceTemplate(
  inputs: ManagedWorkspaceTemplateInputs,
  logger?: PluginLogger,
): Promise<string> {
  const alias = buildManagedWorkspaceTemplateAlias(inputs)
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

async function buildManagedBaseTemplate(
  inputs: ManagedBaseTemplateInputs,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed base template lookup start", {
    nodeVariant: inputs.nodeVariant,
    runtimeVersion: inputs.runtimeVersion,
    pluginPackageVersion: inputs.pluginPackageVersion,
    alias,
  })

  const existingTemplate = await findManagedTemplateState(alias, logger)
  if (existingTemplate.kind === "ready") {
    await logger?.info("managed base template reuse", {
      alias,
    })
    return alias
  }
  if (existingTemplate.kind === "pending") {
    await logger?.info("managed base template build already in progress", {
      alias,
      buildStatus: existingTemplate.template.buildStatus,
    })
    await waitForManagedTemplateReady(alias, logger)
    return alias
  }
  if (existingTemplate.kind === "failed") {
    await deleteFailedManagedTemplate(alias, existingTemplate.template, logger)
  }

  await logger?.info("managed base template build start", {
    nodeVariant: inputs.nodeVariant,
    runtimeVersion: inputs.runtimeVersion,
    alias,
  })

  const template = Template()
    .fromNodeImage(inputs.nodeVariant)
    .runCmd(buildOpenCodeInstallCommand(inputs.runtimeVersion), { user: "root" })

  try {
    await buildManagedTemplateOnce(template, alias, logger)
    await logger?.info("managed base template build complete", {
      alias,
    })
    return alias
  } catch (error) {
    const raceResolution = await resolveManagedTemplateBuildRace(alias, logger)
    if (raceResolution === "retry") {
      try {
        await buildManagedTemplateOnce(template, alias, logger)
        await logger?.info("managed base template build complete", {
          alias,
        })
        return alias
      } catch (retryError) {
        throw new Error(
          `Failed to build managed E2B base template ${alias} from node image ${inputs.nodeVariant}: ${errorMessage(retryError)}`,
        )
      }
    }
    if (raceResolution === "reuse") {
      await logger?.warn("managed base template build raced with existing alias", {
        alias,
        error: errorMessage(error),
      })
      return alias
    }

    throw new Error(
      `Failed to build managed E2B base template ${alias} from node image ${inputs.nodeVariant}: ${errorMessage(error)}`,
    )
  }
}

async function buildManagedWorkspaceTemplate(
  inputs: ManagedWorkspaceTemplateInputs,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed template lookup start", {
    baseTemplate: inputs.baseTemplate,
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
    baseTemplate: inputs.baseTemplate,
    alias,
  })

  const template = Template()
    .fromTemplate(inputs.baseTemplate)
    .runCmd(buildSystemdServiceInstallCommand(inputs.projectPath, inputs.serverPort), { user: "root" })
    .setStartCmd(
      buildSystemdStartCommand(),
      // E2B polls the ready command during `Sandbox.create()`. Because our
      // systemd service blocks on a marker that only the plugin writes *after*
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
          `Failed to build managed E2B workspace template ${alias} from base template ${inputs.baseTemplate}: ${errorMessage(retryError)}`,
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
      `Failed to build managed E2B workspace template ${alias} from base template ${inputs.baseTemplate}: ${errorMessage(error)}`,
    )
  }
}

export function buildOpenCodeInstallCommand(runtimeVersion: string): string {
  if (!RUNTIME_VERSION_PATTERN.test(runtimeVersion)) {
    throw new Error("OpenCode runtime version must be a valid SemVer string")
  }
  return `npm install -g --omit=optional ${shellSingleQuote(`opencode-ai@${runtimeVersion}`)}`
}

export function buildPrebuiltOpenCodeTemplateName(runtimeVersion: string): string {
  return `e2b/opencode:v${runtimeVersion}`
}

async function findManagedTemplateState(alias: string, logger?: PluginLogger): Promise<ManagedTemplateState> {
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
  template: TemplateClass,
  alias: string,
  logger?: PluginLogger,
): Promise<void> {
  await TemplateBase.build(template, alias, createE2BConnectionOptions(logger))
}

export function buildSystemdServiceInstallCommand(projectPath: string, serverPort: number): string {
  return [
    `cat >${SYSTEMD_START_SCRIPT_PATH} <<'EOF'`,
    buildSystemdStartScript(projectPath, serverPort),
    "EOF",
    `chmod +x ${SYSTEMD_START_SCRIPT_PATH}`,
    `cat >${SYSTEMD_SERVICE_PATH} <<'EOF'`,
    buildSystemdUnitContent(),
    "EOF",
  ].join("\n")
}

export function buildSystemdStartCommand(): string {
  return [
    "sudo systemctl daemon-reload",
    `sudo systemctl restart ${SYSTEMD_SERVICE_NAME}`,
    `sudo journalctl -fu ${SYSTEMD_SERVICE_NAME} -o cat`,
  ].join(" && ")
}

export function buildSystemdUnitContent(): string {
  return [
    "[Unit]",
    "Description=OpenCode E2B workspace server",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${SANDBOX_USER}`,
    "Restart=on-failure",
    "RestartSec=1",
    "KillSignal=SIGINT",
    "TimeoutStopSec=10",
    "StandardOutput=journal",
    "StandardError=journal",
    `ExecStart=${SYSTEMD_START_SCRIPT_PATH}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n")
}

/**
 * The systemd service starts before project upload finishes, so it waits on a
 * marker file. The cap prevents a stuck sandbox if provisioning dies mid-flight.
 */
export function buildSystemdStartScript(projectPath: string, serverPort: number): string {
  const quotedProjectPath = shellSingleQuote(projectPath)
  return [
    "#!/bin/sh",
    `echo "waiting for ${BOOTSTRAP_READY_MARKER}"`,
    `for _ in $(seq 1 2400); do [ -f ${BOOTSTRAP_READY_MARKER} ] && break; sleep 0.25; done`,
    `if [ ! -f ${BOOTSTRAP_READY_MARKER} ]; then echo "timed out waiting for ${BOOTSTRAP_READY_MARKER}"; exit 1; fi`,
    `if [ -f ${RUNTIME_ENV_FILE} ]; then set -a; . ${RUNTIME_ENV_FILE}; set +a; fi`,
    `cd ${quotedProjectPath}`,
    `exec /usr/local/bin/opencode serve --hostname 0.0.0.0 --port ${serverPort}`,
    "",
  ].join("\n")
}

export function buildManagedBaseTemplateAlias(inputs: ManagedBaseTemplateInputs): string {
  const readableNodeVariant = normalizeAliasSegment(inputs.nodeVariant).slice(0, 18) || "node"
  const hash = createHash("sha256")
    .update(
      [
        inputs.nodeVariant,
        inputs.runtimeVersion,
        inputs.pluginPackageVersion,
        // Hash the baked install command too, so changing it produces a new alias and a fresh build.
        buildOpenCodeInstallCommand(inputs.runtimeVersion),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12)

  return `${MANAGED_TEMPLATE_PREFIX}base-${readableNodeVariant}-${hash}`
}

export function buildManagedWorkspaceTemplateAlias(inputs: ManagedWorkspaceTemplateInputs): string {
  const readableNodeVariant = normalizeAliasSegment(inputs.nodeVariant).slice(0, 16) || "node"
  const hash = createHash("sha256")
    .update(
      [
        inputs.baseTemplate,
        inputs.nodeVariant,
        inputs.runtimeVersion,
        inputs.projectPath,
        String(inputs.serverPort),
        inputs.pluginPackageVersion,
        // Hash the baked systemd unit + start command, so a unit change (e.g. User=) yields a
        // new alias and forces a rebuild instead of reusing a stale template.
        buildSystemdServiceInstallCommand(inputs.projectPath, inputs.serverPort),
        buildSystemdStartCommand(),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12)

  return `${MANAGED_TEMPLATE_PREFIX}workspace-${readableNodeVariant}-${hash}`
}

export function buildManagedTemplateAlias(inputs: ManagedWorkspaceTemplateInputs): string {
  return buildManagedWorkspaceTemplateAlias(inputs)
}

function normalizeAliasSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
