import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { Sandbox } from "e2b"

import { forgetSandboxCompatibility } from "./runtime.js"
import { ensureManagedWorkspaceTemplate } from "./template.js"
import type {
  BaseTemplateFingerprint,
  NormalizedE2BWorkspaceConfig,
  PersistedWorkspaceCompatibility,
  PluginLogger,
  SandboxMetadataCompatibility,
} from "./types.js"

const WORKSPACE_ID_METADATA_KEY = "opencodeWorkspaceId"
const PROJECT_ID_METADATA_KEY = "opencodeProjectId"
const WORKSPACE_API_VERSION_METADATA_KEY = "opencodeWorkspaceApiVersion"
const RUNTIME_VERSION_METADATA_KEY = "opencodeRuntimeVersion"
const FLAGS_METADATA_KEY = "opencodeFlags"
const BASE_TEMPLATE_METADATA_KEY = "opencodeBaseTemplate"
const BASE_TEMPLATE_ID_METADATA_KEY = "opencodeBaseTemplateId"
const BASE_TEMPLATE_BUILD_ID_METADATA_KEY = "opencodeBaseTemplateBuildId"

type WorkspaceSandboxRecord = {
  sandboxId: string
  sandbox: Sandbox
  metadata: Record<string, string>
}

/**
 * Lightweight sandbox match data returned from E2B listing before a concrete
 * sandbox connection is opened.
 */
type WorkspaceSandboxMatch = {
  sandboxId: string
  metadata: Record<string, string>
}

/**
 * Build the metadata attached to each E2B sandbox so later adaptor calls can
 * rediscover the sandbox without storing the generated sandbox ID locally.
 */
export function buildSandboxMetadata(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  compatibility: PersistedWorkspaceCompatibility,
  baseTemplate: BaseTemplateFingerprint,
): Record<string, string> {
  return {
    ...config.metadata,
    [WORKSPACE_ID_METADATA_KEY]: info.id,
    [PROJECT_ID_METADATA_KEY]: info.projectID,
    [WORKSPACE_API_VERSION_METADATA_KEY]: compatibility.workspaceApiVersion,
    [RUNTIME_VERSION_METADATA_KEY]: compatibility.runtimeVersion,
    [FLAGS_METADATA_KEY]: JSON.stringify(compatibility.flags),
    [BASE_TEMPLATE_METADATA_KEY]: baseTemplate.requestedTemplate,
    ...(baseTemplate.templateId ? { [BASE_TEMPLATE_ID_METADATA_KEY]: baseTemplate.templateId } : {}),
    ...(baseTemplate.buildId ? { [BASE_TEMPLATE_BUILD_ID_METADATA_KEY]: baseTemplate.buildId } : {}),
  }
}

/**
 * Create an E2B sandbox for the requested workspace. The sandbox spawns from
 * a managed derived template that bakes in the pinned OpenCode runtime, so
 * the only per-workspace state the plugin needs to inject after create is the
 * uploaded project, the per-workspace env file, and the bootstrap-ready
 * marker — no runtime install, no `opencode serve` command, no stale-process
 * cleanup.
 *
 * `Sandbox.create({envs})` is intentionally *not* set here: E2B applies those
 * only to subsequent `commands.run` invocations, not to the template's init
 * command. The per-workspace envs OpenCode delivers via `adaptor.create` are
 * written to a sandbox-local env file in bootstrap.ts, which the baked start
 * command sources before exec'ing opencode. Setting `envs` here in addition
 * would just duplicate that delivery for the (currently empty) set of
 * `commands.run` callers that care about inherited envs.
 */
export async function createWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
  compatibility: PersistedWorkspaceCompatibility,
  baseTemplate: BaseTemplateFingerprint,
  runtimeVersion: string,
  logger?: PluginLogger,
): Promise<Sandbox> {
  const template = await ensureManagedWorkspaceTemplate(
    {
      baseTemplate,
      runtimeVersion,
      projectPath: config.projectPath,
      serverPort: config.serverPort,
    },
    logger,
  )

  return Sandbox.create(template, {
    timeoutMs: config.sandboxTimeoutMs,
    metadata: buildSandboxMetadata(info, config, compatibility, baseTemplate),
    secure: config.secure,
    network: {
      allowPublicTraffic: config.network.allowPublicTraffic,
      allowOut: config.network.allowOut.length ? config.network.allowOut : undefined,
      denyOut: config.network.denyOut.length ? config.network.denyOut : undefined,
      maskRequestHost: config.network.maskRequestHost || undefined,
    },
  })
}

/**
 * Find and connect to the sandbox associated with a workspace while preserving
 * its stored E2B metadata for later compatibility checks.
 */
export async function findWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<WorkspaceSandboxRecord | undefined> {
  const matches = await listWorkspaceSandboxMatches(info)
  if (matches.length === 0) {
    return undefined
  }
  if (matches.length > 1) {
    throw new Error(buildDuplicateSandboxError(info, matches))
  }

  const [match] = matches
  if (!match) {
    return undefined
  }

  return {
    sandboxId: match.sandboxId,
    sandbox: await Sandbox.connect(match.sandboxId, {
      timeoutMs: config.sandboxTimeoutMs,
    }),
    metadata: match.metadata,
  }
}

/**
 * List every running or paused sandbox that advertises the workspace metadata
 * compatibility fields, so callers can decide whether a missing, single, or
 * duplicate match is acceptable for the current lifecycle operation.
 */
async function listWorkspaceSandboxMatches(info: WorkspaceInfo): Promise<WorkspaceSandboxMatch[]> {
  const paginator = Sandbox.list({
    query: {
      metadata: {
        [WORKSPACE_ID_METADATA_KEY]: info.id,
      },
      state: ["running", "paused"],
    },
    limit: 100,
  })

  const matches: WorkspaceSandboxMatch[] = []

  while (paginator.hasNext) {
    const sandboxes = await paginator.nextItems()
    for (const sandboxInfo of sandboxes) {
      matches.push({
        sandboxId: sandboxInfo.sandboxId,
        metadata: sandboxInfo.metadata ?? {},
      })
    }
  }

  return matches
}

/**
 * Require an existing sandbox record and fail with a clear workspace-scoped
 * error message when it is missing.
 */
export async function requireWorkspaceSandboxRecord(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<WorkspaceSandboxRecord> {
  const record = await findWorkspaceSandboxRecord(info, config)
  if (!record) {
    throw new Error(`No E2B sandbox found for workspace ${info.id}`)
  }
  return record
}

/**
 * Convert the sandbox host and configured port into the remote base URL used
 * by OpenCode's remote workspace target.
 */
export function sandboxBaseUrl(sandbox: Sandbox, config: NormalizedE2BWorkspaceConfig): URL {
  return new URL(`https://${sandbox.getHost(config.serverPort)}`)
}

/**
 * Build the request headers required to reach a secured sandbox. E2B exposes
 * a per-sandbox `trafficAccessToken` when `secure: true` is enabled, which
 * must be passed to every HTTP request through the sandbox gateway. For
 * non-secure sandboxes or sandboxes that somehow lack a token we return
 * undefined so callers can continue without touching their fetch headers.
 */
export function sandboxTargetHeaders(
  sandbox: Sandbox,
  config: NormalizedE2BWorkspaceConfig,
): Record<string, string> | undefined {
  if (!config.secure) return undefined
  if (!sandbox.trafficAccessToken) return undefined
  return { "X-Access-Token": sandbox.trafficAccessToken }
}

/**
 * Remove the sandbox if it exists. Missing sandboxes are treated as already
 * deleted so workspace cleanup stays idempotent.
 */
export async function removeWorkspaceSandbox(
  info: WorkspaceInfo,
  config: NormalizedE2BWorkspaceConfig,
): Promise<void> {
  const matches = await listWorkspaceSandboxMatches(info)
  if (matches.length === 0) return

  await Promise.all(
    matches.map(async (match) => {
      const sandbox = await Sandbox.connect(match.sandboxId, {
        timeoutMs: config.sandboxTimeoutMs,
      })
      try {
        await sandbox.kill()
      } finally {
        // Drop any cached compatibility verdict so a replacement sandbox that
        // happens to reuse the ID is re-validated on next access.
        forgetSandboxCompatibility(match.sandboxId)
      }
    }),
  )
}

/**
 * Parse workspace compatibility fields back out of raw E2B metadata. Invalid
 * or missing values are treated as absent so older sandboxes remain
 * inspectable.
 */
export function readSandboxCompatibility(metadata: Record<string, string>): SandboxMetadataCompatibility {
  return {
    workspaceApiVersion: metadata[WORKSPACE_API_VERSION_METADATA_KEY],
    runtimeVersion: metadata[RUNTIME_VERSION_METADATA_KEY],
    flags: parseFlags(metadata[FLAGS_METADATA_KEY]),
    baseTemplate: metadata[BASE_TEMPLATE_METADATA_KEY],
    baseTemplateId: metadata[BASE_TEMPLATE_ID_METADATA_KEY],
    baseTemplateBuildId: metadata[BASE_TEMPLATE_BUILD_ID_METADATA_KEY],
  }
}

/**
 * Parse the serialized sandbox flags. Invalid payloads degrade gracefully to an
 * empty list so metadata bugs do not break workspace teardown.
 */
function parseFlags(rawFlags: string | undefined): string[] {
  if (!rawFlags) return []

  try {
    const parsed = JSON.parse(rawFlags)
    if (Array.isArray(parsed) && parsed.every((flag) => typeof flag === "string")) {
      return parsed
    }
  } catch {
    // Ignore invalid metadata and fall back to an empty flag list.
  }

  return []
}

/**
 * Build a deterministic duplicate-sandbox error instead of silently choosing an
 * arbitrary match from the provider list order.
 */
function buildDuplicateSandboxError(info: WorkspaceInfo, matches: WorkspaceSandboxMatch[]): string {
  const sandboxIds = matches.map((match) => match.sandboxId).join(", ")
  return `Found multiple E2B sandboxes for workspace ${info.id}: ${sandboxIds}`
}
