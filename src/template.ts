import { createHash } from "node:crypto"
import { posix } from "node:path"

import { ApiClient, ConnectionConfig, Template, TemplateError } from "e2b"

import { errorMessage, shellSingleQuote } from "./shared.js"
import type { BaseTemplateFingerprint, PluginLogger, SandboxMetadataCompatibility } from "./types.js"

/**
 * Bump this whenever the managed template's *build recipe* or *start behavior*
 * changes. The revision is stirred into the alias hash, so bumping it forces
 * every workspace to build a fresh derived template the next time it runs and
 * effectively retires templates produced by earlier plugin versions.
 *
 * Revision history:
 *   - "1": Idle derived template (`tail -f /dev/null`), install + start at
 *          sandbox spawn time.
 *   - "2": Runtime-baked template (opencode installed at build time, start
 *          command waits for bootstrap marker, then execs the pinned binary).
 *   - "3": Same as rev 2, but the baked start command also sources a
 *          per-sandbox env file (`RUNTIME_ENV_FILE`) before exec'ing so the
 *          workspace-specific envs OpenCode delivers via `adaptor.create`
 *          (OPENCODE_WORKSPACE_ID, OPENCODE_EXPERIMENTAL_WORKSPACES,
 *          OPENCODE_AUTH_CONTENT, OTEL_*) actually reach the server. Rev 2
 *          was effectively running opencode without these, which disabled
 *          sync entirely on the remote.
 */
const MANAGED_TEMPLATE_REVISION = "3"

/**
 * Absolute path inside the sandbox where the plugin writes an empty file to
 * signal that per-workspace provisioning (snapshot upload, project marker)
 * has finished and the baked `opencode` server may start serving. Chosen to
 * live outside the project tree so it does not pollute uploaded snapshots or
 * accidentally get committed by users.
 */
export const BOOTSTRAP_READY_MARKER = "/tmp/.opencode-e2b-bootstrap-ready"

/**
 * Absolute path inside the sandbox where the baked start command records the
 * post-install location of the `opencode` binary. Computed once at template
 * build time after the pinned runtime has been installed, so the start
 * command can `exec` it by absolute path without relying on PATH ordering at
 * spawn time.
 */
const BAKED_BIN_PATH_FILE = "/opt/opencode-e2b/bin-path"

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
 * Compatibility flag emitted into sandbox metadata by the current plugin.
 * Sandboxes created before the runtime-baked template design carry
 * `template:managed-idle-start` instead; the mismatch detector below treats
 * that as incompatible so they get replaced on next reuse.
 */
export const RUNTIME_BAKED_FLAG = "template:runtime-baked"

/**
 * Compatibility flag emitted alongside `RUNTIME_BAKED_FLAG` starting at rev
 * 3 to indicate the baked start command sources a per-sandbox env file
 * before exec'ing opencode. Sandboxes created at rev 2 have the runtime
 * baked but no env delivery, which silently disables sync on the remote; we
 * detect their missing flag to force a clean replacement.
 */
export const ENV_INJECTED_STARTUP_FLAG = "template:env-injected-startup"

/**
 * Compatibility flag emitted by the previous (idle + spawn-time install)
 * plugin version. Detected so we can reject sandboxes provisioned under the
 * old design instead of silently attaching to them and never starting a
 * server.
 */
const LEGACY_IDLE_FLAG = "template:managed-idle-start"

/**
 * Keep one in-flight build promise per managed alias so concurrent workspace
 * creations in the same OpenCode process do not race to publish the same
 * derived template.
 */
const managedTemplatePromises = new Map<string, Promise<string>>()

/**
 * Inputs that influence the baked start command and therefore the managed
 * template identity. Changing any of these produces a different alias and a
 * fresh template build.
 */
export type ManagedTemplateInputs = {
  /** Upstream base template identity resolved from the user-configured name. */
  baseTemplate: BaseTemplateFingerprint
  /** Pinned controller version to install into the template at build time. */
  runtimeVersion: string
  /** Absolute path inside the sandbox where uploaded project files live. */
  projectPath: string
  /** TCP port that `opencode serve` should bind to. */
  serverPort: number
}

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

  const fingerprint = await (async (): Promise<BaseTemplateFingerprint> => {
    try {
      const templateId = await resolveTemplateId(client, reference.name)
      const buildId = reference.tag
        ? await resolveTaggedBuildId(templateId, reference.tag, requestedTemplate)
        : await resolveLatestReadyBuildId(client, templateId, requestedTemplate)

      return {
        requestedTemplate,
        templateId,
        buildId,
      }
    } catch (error) {
      if (!isOpaqueTemplateAccessError(error)) {
        throw error
      }

      await logger?.warn("base template fingerprint lookup fell back to requested template", {
        requestedTemplate,
        error: errorMessage(error),
      })

      // Public provider templates like `opencode` can be spawnable without
      // exposing their template metadata through the template API. In that
      // case we still proceed with managed-template startup override, but we
      // cannot track upstream build churn for automatic replacement.
      return {
        requestedTemplate,
      }
    }
  })()

  await logger?.info("base template fingerprint lookup complete", fingerprint)
  return fingerprint
}

/**
 * Build or reuse a derived E2B template that bakes the pinned OpenCode runtime
 * into the image and uses a start command which waits for the plugin's
 * bootstrap marker before execing `opencode serve`. `Sandbox.create()` cannot
 * override a template entrypoint directly, so provisioning must happen through
 * a managed template alias.
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
 * Resolve the derived template alias, building it once if the alias has not
 * been published yet.
 */
async function buildManagedWorkspaceTemplate(
  inputs: ManagedTemplateInputs,
  alias: string,
  logger?: PluginLogger,
): Promise<string> {
  await logger?.info("managed template lookup start", {
    baseTemplate: inputs.baseTemplate.requestedTemplate,
    baseTemplateId: inputs.baseTemplate.templateId ?? undefined,
    baseTemplateBuildId: inputs.baseTemplate.buildId ?? undefined,
    runtimeVersion: inputs.runtimeVersion,
    projectPath: inputs.projectPath,
    serverPort: inputs.serverPort,
    alias,
    revision: MANAGED_TEMPLATE_REVISION,
  })

  if (await Template.exists(alias)) {
    await logger?.info("managed template reuse", {
      alias,
    })
    return alias
  }

  await logger?.info("managed template build start", {
    baseTemplate: inputs.baseTemplate.requestedTemplate,
    runtimeVersion: inputs.runtimeVersion,
    alias,
  })

  // Build commands run as root so we can delete any pre-baked `opencode`
  // binary from the base image and install the pinned version into the
  // system-wide npm prefix. Running as the template's default user would be
  // safer in principle, but would reintroduce the PATH shadowing problem the
  // purge step is specifically here to solve.
  const template = Template()
    .fromTemplate(inputs.baseTemplate.requestedTemplate)
    // Purge every executable called `opencode` anywhere under the paths where
    // base images typically install it, so only the version we install below
    // is present after the build. `|| true` keeps the build green when there
    // is nothing to remove (base images that ship without opencode pre-baked).
    .runCmd(
      "sh -c \"find /usr /opt /home /root -maxdepth 6 -name opencode -type f -executable 2>/dev/null | xargs -r rm -f; true\"",
      { user: "root" },
    )
    // Bake the pinned controller version into the template. Subsequent
    // sandboxes spawned from this alias start with exactly this binary — no
    // spawn-time install, no PATH races, no version drift.
    .runCmd(`npm install -g opencode-ai@${inputs.runtimeVersion}`, { user: "root" })
    // Record the post-install binary path once, at build time, so the start
    // command can `exec` it by absolute path at spawn time without re-running
    // `command -v` (which would depend on spawn-time PATH).
    .runCmd(
      `sh -c "mkdir -p ${posix.dirname(BAKED_BIN_PATH_FILE)} && command -v opencode > ${BAKED_BIN_PATH_FILE}"`,
      { user: "root" },
    )
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
      `Failed to build managed E2B template ${alias} from ${inputs.baseTemplate.requestedTemplate}: ${errorMessage(error)}`,
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
 *   5. `exec` the absolute path recorded at build time, replacing this shell
 *      so opencode becomes PID 1 and signals sandbox exit if it dies.
 */
function buildBakedStartCommand(projectPath: string, serverPort: number): string {
  const quotedProjectPath = shellSingleQuote(projectPath)
  return [
    `exec >${START_COMMAND_LOG_PATH} 2>&1`,
    `for _ in $(seq 1 2400); do [ -f ${BOOTSTRAP_READY_MARKER} ] && break; sleep 0.25; done`,
    `if [ -f ${RUNTIME_ENV_FILE} ]; then set -a; . ${RUNTIME_ENV_FILE}; set +a; fi`,
    `cd ${quotedProjectPath} 2>/dev/null || true`,
    `exec "$(cat ${BAKED_BIN_PATH_FILE})" serve --hostname 0.0.0.0 --port ${serverPort}`,
  ].join(" && ")
}

/**
 * Decide whether an existing sandbox should be replaced because the
 * configured base template now resolves to a different upstream build, or
 * because it was provisioned under an older plugin design whose bootstrap
 * contract we no longer honor. Missing metadata is treated as outdated so
 * older sandboxes get one clean reprovision onto the new tracking scheme.
 */
export function describeBaseTemplateMismatch(
  currentBaseTemplate: BaseTemplateFingerprint,
  sandboxCompatibility: SandboxMetadataCompatibility,
): string | undefined {
  // Sandboxes tagged with the legacy idle-start flag were spawned with a
  // `tail -f /dev/null` main command and expect the plugin to run install +
  // start at attach time. The current design bakes opencode into the
  // template and does not re-run any install, so the legacy sandbox would
  // never have a server listening after attach. Force a replacement.
  if (sandboxCompatibility.flags.includes(LEGACY_IDLE_FLAG) && !sandboxCompatibility.flags.includes(RUNTIME_BAKED_FLAG)) {
    return "sandbox was provisioned under the legacy idle-start plugin design; runtime-baked template is required"
  }

  // Sandboxes from managed template rev 2 have the pinned opencode baked
  // in, but their start command does not source the per-sandbox env file
  // the plugin now writes. Without the envs (most importantly
  // OPENCODE_EXPERIMENTAL_WORKSPACES), the remote server runs sync-disabled
  // and the workspace silently fails to propagate session state back to
  // local. Detect the absence of the rev-3 flag and force a fresh sandbox.
  if (
    sandboxCompatibility.flags.includes(RUNTIME_BAKED_FLAG) &&
    !sandboxCompatibility.flags.includes(ENV_INJECTED_STARTUP_FLAG)
  ) {
    return "sandbox was provisioned before per-workspace env delivery was wired into the baked start command"
  }

  if (
    sandboxCompatibility.baseTemplate &&
    sandboxCompatibility.baseTemplate !== currentBaseTemplate.requestedTemplate
  ) {
    return (
      `sandbox was created from configured base template ${sandboxCompatibility.baseTemplate}, ` +
      `but the workspace now requests ${currentBaseTemplate.requestedTemplate}`
    )
  }
  if (!currentBaseTemplate.buildId) {
    return undefined
  }
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

  return undefined
}

/**
 * Derive a stable alias from the managed template inputs. Any change to the
 * base template identity, pinned runtime version, project path, or server
 * port produces a different alias and — because
 * `ensureManagedWorkspaceTemplate` keys off the alias — a fresh template
 * build on next use.
 */
function buildManagedTemplateAlias(inputs: ManagedTemplateInputs): string {
  const readableBase = normalizeAliasSegment(inputs.baseTemplate.requestedTemplate).slice(0, 24) || "template"
  const baseIdentity = inputs.baseTemplate.buildId ?? inputs.baseTemplate.templateId ?? inputs.baseTemplate.requestedTemplate
  // Use NUL as a separator so the hash is injective across inputs that happen
  // to share suffixes/prefixes. The version is embedded so a plugin upgrade
  // which changes the start-command template automatically rebuilds.
  const hash = createHash("sha256")
    .update(
      [MANAGED_TEMPLATE_REVISION, baseIdentity, inputs.runtimeVersion, inputs.projectPath, String(inputs.serverPort)].join("\0"),
    )
    .digest("hex")
    .slice(0, 12)

  return `opencode-rt-${readableBase}-r${MANAGED_TEMPLATE_REVISION}-${hash}`
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
 * Detect template API failures where the alias is usable for sandbox creation
 * but its metadata is intentionally hidden from the current API key.
 */
function isOpaqueTemplateAccessError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes("403") || message.includes("don't have access to this template alias")
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




