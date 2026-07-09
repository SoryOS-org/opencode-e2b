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
import { reviveResumedSandbox } from "./bootstrap.js"
import { runTemplateGC } from "./gc.js"
import { startResumeProxy, type ResumeProxyHandle, type UpstreamTarget } from "./resume-proxy.js"
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

// One long-lived proxy per workspace (see resolveWorkspaceTarget). Keyed by
// workspace id so repeated target() calls reuse the same stable local URL.
const workspaceProxies = new Map<string, ResumeProxyHandle>()

function resumeProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.E2B_RESUME_PROXY
  return value === "1" || value === "true"
}

export function createE2BWorkspaceAdapter(deps: WorkspaceAdapterDeps): RuntimeWorkspaceAdapter {
  return {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, deps.options, deps.serverUrl, deps.logger, deps.client)
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
      const proxy = workspaceProxies.get(info.id)
      if (proxy) {
        proxy.stop()
        workspaceProxies.delete(info.id)
      }
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
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options)
  await logger.info("configure workspace start", {
    workspaceID: info.id,
    branch: info.branch ?? undefined,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })
  const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger, client)

  await logger.info("configure workspace resolved local runtime", {
    workspaceID: info.id,
    runtimeVersion,
  })

  return {
    ...info,
    name: defaultWorkspaceName(info),
    directory: config.projectPath,
    extra: buildPersistedExtra(config, runtimeVersion),
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

  // Experimental: front the sandbox with a local resume-on-demand proxy so a
  // paused/dropped sandbox is transparently revived and reconnected underneath,
  // instead of the workspace going permanently red (OpenCode never retries target()).
  if (resumeProxyEnabled()) {
    const proxy = getOrStartResumeProxy(params, config)
    return { type: "remote", url: proxy.url }
  }

  return {
    type: "remote",
    url: baseUrl,
    ...(headers ? { headers } : {}),
  }
}

function getOrStartResumeProxy(
  params: {
    info: WorkspaceInfo
    options: E2BWorkspacePluginOptions | undefined
    logger: PluginLogger
    store?: SandboxStore
  },
  config: NormalizedE2BWorkspaceConfig,
): ResumeProxyHandle {
  const existing = workspaceProxies.get(params.info.id)
  if (existing) return existing

  // Resolve (and, on revive, resurrect) the sandbox this workspace points at.
  // Cache the result so normal requests don't re-list E2B every call — only a
  // forward failure (revive=true) re-resolves and health-gates.
  let cached: UpstreamTarget | undefined
  const resolveUpstream = async (revive: boolean): Promise<UpstreamTarget> => {
    if (cached && !revive) return cached
    const record = await requireWorkspaceSandboxRecord(params.info, config, params.logger, params.store)
    if (revive) {
      const alive = await reviveResumedSandbox({ sandbox: record.sandbox, config, logger: params.logger })
      if (!alive) throw new Error(`E2B sandbox for workspace ${params.info.id} could not be revived`)
    }
    const headers = sandboxTargetHeaders(record.sandbox, config)
    cached = { baseUrl: sandboxBaseUrl(record.sandbox, config), ...(headers ? { headers } : {}) }
    return cached
  }

  const proxy = startResumeProxy({ resolveUpstream, logger: params.logger })
  workspaceProxies.set(params.info.id, proxy)
  void params.logger.info("resume proxy started", {
    workspaceID: params.info.id,
    url: proxy.url.toString(),
  })
  return proxy
}

function assertE2BApiKeyAvailable(env: NodeJS.ProcessEnv = process.env): void {
  const key = env.E2B_API_KEY
  if (key && key.trim() !== "") return

  throw new Error(
    "E2B_API_KEY is not set. Export it in your shell (or OpenCode launch env) " +
      "before enabling the e2b workspace plugin. Get a key at https://e2b.dev/dashboard.",
  )
}
