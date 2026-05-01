import type { WorkspaceInfo } from "@opencode-ai/plugin"

import { bootstrapWorkspace } from "./bootstrap.js"
import {
  buildFreshCompatibility,
  buildPersistedExtra,
  defaultWorkspaceName,
  normalizeOptions,
  resolveWorkspaceCompatibility,
  resolveWorkspaceConfig,
} from "./config.js"
import {
  createWorkspaceSandbox,
  findWorkspaceSandboxRecord,
  removeWorkspaceSandbox,
  readSandboxCompatibility,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "./e2b.js"
import { runTemplateGC } from "./gc.js"
import {
  assertWorkspaceCompatibility,
  forgetSandboxCompatibility,
  resolveLocalPluginVersion,
  resolveLocalRuntimeVersion,
} from "./runtime.js"
import { errorMessage } from "./shared.js"
import type {
  E2BWorkspacePluginOptions,
  NormalizedE2BWorkspaceConfig,
  PluginLogger,
  RuntimeWorkspaceAdaptor,
} from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"
import { resolveWorkspaceTarget } from "./workspace-target.js"

type WorkspaceAdaptorDeps = {
  directory: string
  serverUrl: URL
  options: E2BWorkspacePluginOptions | undefined
  logger: PluginLogger
  gcConfig: NormalizedE2BWorkspaceConfig["templateGc"]
}

export type ExistingSandboxPlan =
  | { action: "create" }
  | { action: "reuse"; sandboxId: string }
  | { action: "replace"; sandboxId: string; reason: unknown }

/**
 * Build the OpenCode workspace adaptor around the E2B lifecycle operations.
 * Keeping this outside the plugin entrypoint makes `index.ts` responsible for
 * wiring only, while this module owns workspace behavior.
 */
export function createE2BWorkspaceAdaptor(deps: WorkspaceAdaptorDeps): RuntimeWorkspaceAdaptor {
  return {
    name: "E2B Sandbox",
    description: "Provision a sandboxed OpenCode workspace in E2B",
    async configure(info) {
      return configureWorkspace(info, deps.options, deps.serverUrl, deps.logger)
    },
    async create(info, env) {
      assertE2BApiKeyAvailable()
      await createWorkspace(info, env, deps.directory, deps.options, deps.serverUrl, deps.logger)
    },
    async remove(info) {
      assertE2BApiKeyAvailable()
      const config = resolveWorkspaceConfig(info, deps.options)
      await removeWorkspaceSandbox(info, config)
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
        logger: deps.logger,
      })
    },
  }
}

/**
 * Build the persisted workspace record before sandbox creation begins.
 */
async function configureWorkspace(
  info: WorkspaceInfo,
  options: E2BWorkspacePluginOptions | undefined,
  serverUrl: URL,
  logger: PluginLogger,
): Promise<WorkspaceInfo> {
  const config = normalizeOptions(options)
  await logger.info("configure workspace start", {
    workspaceID: info.id,
    branch: info.branch ?? undefined,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })
  const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger)

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

/**
 * Create the E2B-backed workspace, upload the local project snapshot, and
 * bootstrap the remote OpenCode server.
 */
async function createWorkspace(
  info: WorkspaceInfo,
  env: Record<string, string | undefined>,
  localDirectory: string,
  options: E2BWorkspacePluginOptions | undefined,
  serverUrl: URL,
  logger?: PluginLogger,
): Promise<void> {
  const config = resolveWorkspaceConfig(info, options)
  let stage = "resolve-runtime-version"

  await logger?.info("create workspace start", {
    workspaceID: info.id,
    localDirectory,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })

  try {
    const runtimeVersion = await resolveLocalRuntimeVersion(serverUrl, logger)
    await logger?.info("create workspace resolved local runtime", {
      workspaceID: info.id,
      runtimeVersion,
    })

    stage = "resolve-compatibility"
    const compatibility = resolveWorkspaceCompatibility(info, config, runtimeVersion)

    stage = "find-existing-sandbox"
    const existingRecord = await findWorkspaceSandboxRecord(info, config)
    const existingSandboxId = existingRecord?.sandbox.sandboxId
    if (existingRecord) {
      await logger?.info("create workspace found existing sandbox", {
        workspaceID: info.id,
        sandboxID: existingSandboxId,
      })

      stage = "validate-existing-sandbox"
      let compatibilityError: unknown
      try {
        const sandboxCompatibility = readSandboxCompatibility(existingRecord.metadata)

        await assertWorkspaceCompatibility({
          workspaceID: info.id,
          localRuntimeVersion: runtimeVersion,
          persistedCompatibility: compatibility,
          sandboxCompatibility,
          sandbox: existingRecord.sandbox,
          baseUrl: sandboxBaseUrl(existingRecord.sandbox, config),
          headers: sandboxTargetHeaders(existingRecord.sandbox, config),
        })

      } catch (error) {
        compatibilityError = error
      }

      const plan = planExistingSandbox({
        existingSandboxId,
        compatibilityError,
      })

      if (plan.action === "reuse") {
        await logger?.info("create workspace reusing compatible sandbox", {
          workspaceID: info.id,
          sandboxID: plan.sandboxId,
        })
        return
      }

      if (plan.action === "replace") {
        await logger?.warn("create workspace replacing incompatible sandbox", {
          workspaceID: info.id,
          sandboxID: plan.sandboxId,
          error: errorMessage(plan.reason),
        })
        try {
          await existingRecord.sandbox.kill()
        } finally {
          forgetSandboxCompatibility(existingRecord.sandbox.sandboxId)
        }
      }
    }

    stage = "provision-fresh-workspace"
    await provisionFreshWorkspace({
      info,
      env,
      config,
      runtimeVersion,
      localDirectory,
      logger,
    })
  } catch (error) {
    await logger?.error("create workspace failed", {
      workspaceID: info.id,
      stage,
      error: errorMessage(error),
    })
    throw error
  }
}

async function provisionFreshWorkspace(params: {
  info: WorkspaceInfo
  env: Record<string, string | undefined>
  config: NormalizedE2BWorkspaceConfig
  runtimeVersion: string
  localDirectory: string
  logger?: PluginLogger
}): Promise<void> {
  let stage = "resolve-plugin-version"
  const pluginPackageVersion = await resolveLocalPluginVersion()

  stage = "create-sandbox"
  await params.logger?.info("create workspace provisioning sandbox", {
    workspaceID: params.info.id,
    pluginPackageVersion,
  })
  const freshCompatibility = buildFreshCompatibility(params.config, params.runtimeVersion)
  const sandbox = await createWorkspaceSandbox(
    params.info,
    params.config,
    freshCompatibility,
    params.runtimeVersion,
    pluginPackageVersion,
    params.logger,
  )

  try {
    stage = "upload-snapshot"
    await params.logger?.info("create workspace uploading snapshot", {
      workspaceID: params.info.id,
      sandboxID: sandbox.sandboxId,
      localDirectory: params.localDirectory,
    })
    await uploadLocalSnapshot({
      sandbox,
      localRoot: params.localDirectory,
      remoteRoot: params.config.projectPath,
      upload: params.config.upload,
    })

    stage = "bootstrap-remote-opencode"
    await params.logger?.info("create workspace bootstrapping remote opencode", {
      workspaceID: params.info.id,
      sandboxID: sandbox.sandboxId,
    })
    await bootstrapWorkspace({
      sandbox,
      info: params.info,
      config: params.config,
      env: params.env,
      logger: params.logger,
    })

    await params.logger?.info("create workspace complete", {
      workspaceID: params.info.id,
      sandboxID: sandbox.sandboxId,
    })
  } catch (error) {
    await params.logger?.error("create workspace failed after sandbox provisioned", {
      workspaceID: params.info.id,
      sandboxID: sandbox.sandboxId,
      stage,
      error: errorMessage(error),
    })
    await sandbox.kill().catch(async (killError: unknown) => {
      await params.logger?.warn("create workspace failed to kill sandbox during cleanup", {
        workspaceID: params.info.id,
        sandboxID: sandbox.sandboxId,
        error: errorMessage(killError),
      })
    })
    forgetSandboxCompatibility(sandbox.sandboxId)
    throw error
  }
}

export function planExistingSandbox(params: {
  existingSandboxId?: string
  compatibilityError?: unknown
}): ExistingSandboxPlan {
  if (!params.existingSandboxId) {
    return { action: "create" }
  }

  if (params.compatibilityError) {
    return {
      action: "replace",
      sandboxId: params.existingSandboxId,
      reason: params.compatibilityError,
    }
  }

  return {
    action: "reuse",
    sandboxId: params.existingSandboxId,
  }
}

/**
 * Preflight check for the E2B credential the SDK reads from the environment.
 * The SDK itself validates this at API call time, but doing it up front lets
 * us deliver a plugin-specific error before workspace provisioning starts.
 */
function assertE2BApiKeyAvailable(): void {
  const key = process.env.E2B_API_KEY
  if (key && key.trim() !== "") return

  throw new Error(
    "E2B_API_KEY is not set. Export it in your shell (or OpenCode launch env) " +
      "before enabling the e2b workspace plugin. Get a key at https://e2b.dev/dashboard.",
  )
}
