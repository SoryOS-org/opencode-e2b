import { createHash } from "node:crypto"

import { Template } from "e2b"

import { errorMessage, shellSingleQuote } from "./shared.js"
import type { PluginLogger } from "./types.js"

/**
 * Managed workspace templates are deterministic Node-image builds keyed by the
 * Node image variant, pinned OpenCode runtime version, project path, server
 * port, and this plugin's own package version. Any change to those inputs
 * produces a fresh alias and therefore a fresh template build.
 */
export const MANAGED_TEMPLATE_PREFIX = "opencode-rt-"

/**
 * Absolute path inside the sandbox where the plugin writes an empty file to
 * signal that per-workspace provisioning (snapshot upload, project marker)
 * has finished and the baked `opencode` server may start serving. Chosen to
 * live outside the project tree so it does not pollute uploaded snapshots or
 * accidentally get committed by users.
 */
export const BOOTSTRAP_READY_MARKER = "/tmp/.opencode-e2b-bootstrap-ready"

/**
 * Absolute path inside the sandbox where the baked start command redirects
 * stdout/stderr so the plugin can tail it on readiness timeout. Matches the
 * log path bootstrap.ts reads from.
 */
const START_COMMAND_LOG_PATH = "/tmp/opencode-serve.log"

/**
 * Absolute path inside the sandbox where the plugin writes a POSIX-sh
 * compatible env file right before releasing the bootstrap marker. The baked
 * start command sources this file so workspace-specific envs delivered by
 * OpenCode via `adaptor.create(config, env)` are visible to `opencode serve`.
 *
 * E2B's `Sandbox.create({envs})` only affects subsequent `commands.run`
 * calls, not the template's init command, so the env file is the only
 * reliable delivery channel for per-sandbox variables like
 * `OPENCODE_WORKSPACE_ID` or `OPENCODE_AUTH_CONTENT`. Exported so bootstrap
 * writes to the same path the start command reads from.
 */
export const RUNTIME_ENV_FILE = "/tmp/.opencode-e2b.env"

/**
 * Keep one in-flight build promise per managed alias so concurrent workspace
 * creations in the same OpenCode process do not race to publish the same
 * managed template.
 */
const managedTemplatePromises = new Map<string, Promise<string>>()

/**
 * Inputs that influence the managed template identity. Changing any of these
 * produces a different alias and a fresh template build.
 */
export type ManagedTemplateInputs = {
  /** Node Docker variant passed to `Template().fromNodeImage(...)`. */
  nodeVariant: string
  /** Pinned controller version to install into the template at build time. */
  runtimeVersion: string
  /** Absolute path inside the sandbox where uploaded project files live. */
  projectPath: string
  /** TCP port that `opencode serve` should bind to. */
  serverPort: number
  /** Version from this plugin's own package.json, used as a rebuild escape hatch. */
  pluginPackageVersion: string
}

/**
 * Build or reuse a managed E2B template that starts from a Node image,
 * installs the pinned OpenCode runtime globally, and bakes a start command
 * which waits for the plugin's bootstrap marker before exec'ing
 * `opencode serve`.
 */
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

/**
 * Resolve the managed template alias, building it once if the alias has not
 * been published yet.
 */
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

  if (await Template.exists(alias)) {
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
    // Build as root so npm installs the pinned controller into the image's
    // global prefix at /usr/local/bin, where the baked start command execs it.
    .runCmd(`npm install -g opencode-ai@${inputs.runtimeVersion}`, { user: "root" })
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
    // A second OpenCode process may have published the same deterministic alias
    // while this build was running. Treat that as success instead of failing a
    // perfectly reusable template.
    if (await Template.exists(alias).catch(() => false)) {
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

/**
 * Construct the shell snippet executed as PID 1 of every sandbox spawned from
 * this managed template. Steps, in order:
 *
 *   1. Redirect stdout+stderr to a known log path so readiness timeouts in the
 *      plugin can tail real server output instead of a generic timeout.
 *   2. Wait up to 10 minutes (2400 * 250ms) for the plugin to finish per-
 *      workspace provisioning by creating `BOOTSTRAP_READY_MARKER`. The cap
 *      prevents a zombie wait from keeping the sandbox alive indefinitely if
 *      the plugin crashes mid-provision.
 *   3. Source the per-sandbox env file the plugin writes before signalling
 *      the marker. `set -a` / `.` / `set +a` exports every assignment in the
 *      file so the subsequent `exec` inherits them. The `-f` guard keeps the
 *      template usable even when the env file is absent (e.g. manual
 *      sandbox debugging from the same alias).
 *   4. Chdir into the uploaded project path so `opencode serve` resolves the
 *      workspace root without any extra flags.
 *   5. `exec` the npm-global binary path provided by the Node base image so
 *      opencode becomes PID 1 and signals sandbox exit if it dies.
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

/**
 * Derive a stable alias from the managed template inputs. Any change to the
 * Node image variant, pinned runtime version, project path, server port, or
 * plugin package version produces a different alias and therefore a fresh
 * template build on next use.
 */
function buildManagedTemplateAlias(inputs: ManagedTemplateInputs): string {
  const readableNodeVariant = normalizeAliasSegment(inputs.nodeVariant).slice(0, 24) || "node"
  // Use NUL as a separator so the hash is injective across inputs that happen
  // to share suffixes/prefixes.
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

/**
 * Convert a Node image variant into an alias-safe slug.
 */
function normalizeAliasSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
