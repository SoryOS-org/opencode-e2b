import type { PluginInput, WorkspaceInfo } from "@opencode-ai/plugin"

import {
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceCompatibility,
  resolveWorkspaceConfig,
} from "./config.js"
import {
  readSandboxCompatibility,
  removeWorkspaceSandbox,
  requireWorkspaceSandboxRecord,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "./e2b.js"
import { runTemplateGC } from "./gc.js"
import { readLocalGitBranch } from "./local-git.js"
import { errorMessage } from "./shared.js"
import { assertWorkspaceCompatibility, resolveLocalRuntimeVersion } from "./runtime.js"
import type { SandboxStore } from "./sandbox-store.js"
import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PluginLogger,
  RuntimeWorkspaceAdapter,
} from "./types.js"
import { createWorkspace } from "./workspace-create.js"

type WorkspaceAdapterDeps = {
  client: PluginInput["client"]
  directory: string
  serverUrl: URL
  options: E2BWorkspacePluginOptions | undefined
  logger: PluginLogger
  gcConfig: NormalizedE2BWorkspaceConfig["templateGc"]
  sandboxStore?: SandboxStore
}

export function createE2BWorkspaceAdapter(deps: WorkspaceAdapterDeps): RuntimeWorkspaceAdapter {
  return {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, deps.options, deps.serverUrl, deps.logger, deps.client, deps.directory)
    },
    async create(info, env, from) {
      assertE2BApiKeyAvailable()
      await createWorkspace({
        info,
        env,
        from,
        localDirectory: deps.directory,
        options: deps.options,
        serverUrl: deps.serverUrl,
        client: deps.client,
        logger: deps.logger,
        store: deps.sandboxStore,
      })
    },
    async remove(info) {
      assertE2BApiKeyAvailable()
      const config = resolveWorkspaceConfig(info, deps.options)
      await removeWorkspaceSandbox(info, config, deps.logger, deps.sandboxStore)
      if (deps.gcConfig.enabled) {
        void runTemplateGC(deps.gcConfig, deps.logger).catch(() => {})
      }
    },
    async target(info) {
      assertE2BApiKeyAvailable()
      return resolveWorkspaceTarget({
        info,
        options: deps.options,
        serverUrl: deps.serverUrl,
        client: deps.client,
        logger: deps.logger,
        store: deps.sandboxStore,
      })
    },
  }
}

async function configureWorkspace(
  info: WorkspaceInfo,
  options: E2BWorkspacePluginOptions | undefined,
  serverUrl: URL,
  logger: PluginLogger,
  client: PluginInput["client"],
  localDirectory: string,
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options, localDirectory)
  await reportUnmirroredProjectPath({
    info,
    localDirectory,
    projectPath: config.projectPath,
    explicitlyConfigured: Boolean(options?.projectPath),
    logger,
    client,
  })
  // The TUI always creates workspaces with `branch: null`, so derive it from
  // the host repository. Without this the sandbox's `git init` invents a
  // branch the user never checked out, and the workspace falls back to being
  // named after its id.
  const branch = info.branch ?? (await readLocalGitBranch(localDirectory))
  await logger.info("configure workspace start", {
    workspaceID: info.id,
    branch: branch ?? undefined,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })
  const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger, client)

  await logger.info("configure workspace resolved local runtime", {
    workspaceID: info.id,
    runtimeVersion,
  })

  const configured: WorkspaceInfo = { ...info, ...(branch ? { branch } : {}) }
  return {
    ...configured,
    // Named from the branch when known (defaultWorkspaceName prefers it), so
    // workspaces read as `e2b-<branch>` instead of `e2b-<id suffix>`.
    name: defaultWorkspaceName(configured),
    directory: config.projectPath,
    extra: buildPersistedExtra(config, runtimeVersion),
  }
}

/**
 * Sessions carry the sandbox's project path, and the host later opens that
 * same path locally. When the sandbox cannot host the project at the host's
 * own path, `/new` from a warped session lands on a directory this machine
 * cannot resolve, which otherwise surfaces much later as an opaque
 * `realPath ENOENT`.
 *
 * A host that cannot be mirrored (Windows) is not the user's doing, so it is
 * surfaced in the TUI as well as the log. An explicitly configured
 * `projectPath` is the user's choice and only logged.
 */
export async function reportUnmirroredProjectPath(params: {
  info: WorkspaceInfo
  localDirectory: string
  projectPath: string
  explicitlyConfigured: boolean
  logger: PluginLogger
  client: PluginInput["client"]
}): Promise<void> {
  if (params.projectPath === params.localDirectory) return

  await params.logger.warn(
    "sandbox project path does not mirror the host path; new sessions may not resolve locally",
    {
      workspaceID: params.info.id,
      localDirectory: params.localDirectory,
      projectPath: params.projectPath,
      reason: params.explicitlyConfigured
        ? "projectPath option set explicitly"
        : "host path is not mirrorable",
    },
  )

  if (params.explicitlyConfigured) return

  try {
    await params.client.tui.showToast({
      body: {
        title: "E2B workspace",
        message:
          `This host's path cannot be mirrored in the sandbox, so the project lives at ${params.projectPath}. ` +
          "Warp works, but a new session started from a warped one will not resolve locally — warp it in explicitly.",
        variant: "warning",
        duration: 12_000,
      },
      query: { directory: params.localDirectory },
    })
  } catch (error) {
    // Never let notification failure block workspace configuration.
    await params.logger.debug("unmirrored project path toast failed", { error: errorMessage(error) })
  }
}

async function resolveWorkspaceTarget(params: {
  info: WorkspaceInfo
  options: E2BWorkspacePluginOptions | undefined
  serverUrl: URL
  client: PluginInput["client"]
  logger: PluginLogger
  store?: SandboxStore
}): Promise<{ type: "remote"; url: URL; headers?: HeadersInit }> {
  const localRuntimeVersion = await resolveLocalRuntimeVersion(params.serverUrl, params.logger, params.client)
  const config = resolveWorkspaceConfig(params.info, params.options)
  const compatibility = resolveWorkspaceCompatibility(params.info, config, localRuntimeVersion)
  const record = await requireWorkspaceSandboxRecord(params.info, config, params.logger, params.store)
  const baseUrl = sandboxBaseUrl(record.sandbox, config)
  const headers = sandboxTargetHeaders(record.sandbox, config)

  await assertWorkspaceCompatibility({
    workspaceID: params.info.id,
    localRuntimeVersion,
    persistedCompatibility: compatibility,
    sandboxCompatibility: readSandboxCompatibility(record.metadata),
    sandbox: record.sandbox,
    baseUrl,
    headers,
  })

  return {
    type: "remote",
    url: baseUrl,
    ...(headers ? { headers } : {}),
  }
}

function assertE2BApiKeyAvailable(env: NodeJS.ProcessEnv = process.env): void {
  const key = env.E2B_API_KEY
  if (key && key.trim() !== "") return

  throw new Error(
    "E2B_API_KEY is not set. Export it in your shell (or OpenCode launch env) " +
      "before enabling the e2b workspace plugin. Get a key at https://e2b.dev/dashboard.",
  )
}
