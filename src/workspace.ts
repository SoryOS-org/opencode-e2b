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
import { assertWorkspaceCompatibility, resolveLocalRuntimeVersion } from "./runtime.js"
import type { SandboxStore } from "./sandbox-store.js"
import { errorMessage } from "./shared.js"
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
      return withErrorToast(deps, "Configuring E2B workspace", () =>
        configureWorkspace(info, deps.options, deps.serverUrl, deps.logger, deps.client),
      )
    },
    async create(info, env, from) {
      return withErrorToast(deps, "Creating E2B workspace", async () => {
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
      })
    },
    async remove(info) {
      return withErrorToast(deps, "Removing E2B workspace", async () => {
        assertE2BApiKeyAvailable()
        const config = resolveWorkspaceConfig(info, deps.options)
        await removeWorkspaceSandbox(info, config, deps.logger, deps.sandboxStore)
        if (deps.gcConfig.enabled) {
          void runTemplateGC(deps.gcConfig, deps.logger).catch(() => {})
        }
      })
    },
    async target(info) {
      return withErrorToast(deps, "Connecting to E2B workspace", () => {
        assertE2BApiKeyAvailable()
        return resolveWorkspaceTarget({
          info,
          options: deps.options,
          serverUrl: deps.serverUrl,
          client: deps.client,
          logger: deps.logger,
          store: deps.sandboxStore,
        })
      })
    },
  }
}

const TOAST_MESSAGE_MAX_LENGTH = 300

/**
 * Run an adapter lifecycle operation and, on failure, surface the error to the
 * user as a TUI toast before rethrowing. OpenCode logs adapter errors but does
 * not always show them, so the toast is what makes provisioning failures
 * visible. The toast is best-effort (TUI-only and a no-op in headless servers)
 * and must never mask or replace the original error.
 */
async function withErrorToast<T>(
  deps: WorkspaceAdapterDeps,
  action: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    await showErrorToast(deps, action, error)
    throw error
  }
}

async function showErrorToast(deps: WorkspaceAdapterDeps, action: string, error: unknown): Promise<void> {
  try {
    await deps.client.tui.showToast({
      body: {
        title: "E2B workspace",
        message: `${action} failed: ${truncate(errorMessage(error), TOAST_MESSAGE_MAX_LENGTH)}`,
        variant: "error",
      },
      query: { directory: deps.directory },
    })
  } catch (toastError) {
    // Toasts are best-effort and only available in the TUI; never let a failed
    // toast mask the workspace error being reported.
    await deps.logger.debug("failed to show error toast", {
      action,
      error: errorMessage(toastError),
    })
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
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
