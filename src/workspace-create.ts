import type { PluginInput, WorkspaceInfo } from "@opencode-ai/plugin"

import { bootstrapWorkspace } from "./bootstrap.js"
import { buildFreshCompatibility, resolveWorkspaceCompatibility, resolveWorkspaceConfig } from "./config.js"
import {
  buildWorkspaceSandboxMetadata,
  createWorkspaceSandbox,
  deleteCachedSandbox,
  findWorkspaceSandboxRecord,
  markSandboxFailed,
  markSandboxReady,
  readSandboxCompatibility,
  sandboxBaseUrl,
  sandboxTargetHeaders,
  upsertProvisioningSandbox,
} from "./e2b.js"
import {
  assertWorkspaceCompatibility,
  forgetSandboxCompatibility,
  resolveLocalPluginVersion,
  resolveLocalRuntimeVersion,
} from "./runtime.js"
import type { SandboxStore } from "./sandbox-store.js"
import { errorMessage } from "./shared.js"
import type { E2BWorkspacePluginOptions, NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"
import { SandboxNotFoundError } from "e2b"

export type ExistingSandboxPlan =
  | { action: "create" }
  | { action: "reuse"; sandboxId: string }
  | { action: "replace"; sandboxId: string; reason: unknown }

export async function createWorkspace(params: {
  info: WorkspaceInfo
  env: Record<string, string | undefined>
  localDirectory: string
  options: E2BWorkspacePluginOptions | undefined
  serverUrl: URL
  client: PluginInput["client"]
  logger?: PluginLogger
  store?: SandboxStore
}): Promise<void> {
  const config = resolveWorkspaceConfig(params.info, params.options)
  let stage = "resolve-runtime-version"

  await params.logger?.info("create workspace start", {
    workspaceID: params.info.id,
    localDirectory: params.localDirectory,
    projectPath: config.projectPath,
    nodeVariant: config.nodeVariant,
  })

  try {
    const runtimeVersion = await resolveLocalRuntimeVersion(params.serverUrl, params.logger, params.client)
    await params.logger?.info("create workspace resolved local runtime", {
      workspaceID: params.info.id,
      runtimeVersion,
    })

    stage = "resolve-compatibility"
    const compatibility = resolveWorkspaceCompatibility(params.info, config, runtimeVersion)

    stage = "find-existing-sandbox"
    const existingRecord = await findWorkspaceSandboxRecord(params.info, config, params.logger, params.store)
    const existingSandboxId = existingRecord?.sandbox.sandboxId
    if (existingRecord) {
      await params.logger?.info("create workspace found existing sandbox", {
        workspaceID: params.info.id,
        sandboxID: existingSandboxId,
      })

      stage = "validate-existing-sandbox"
      let compatibilityError: unknown
      try {
        const sandboxCompatibility = readSandboxCompatibility(existingRecord.metadata)

        await assertWorkspaceCompatibility({
          workspaceID: params.info.id,
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
        await params.logger?.info("create workspace reusing compatible sandbox", {
          workspaceID: params.info.id,
          sandboxID: plan.sandboxId,
        })
        return
      }

      if (plan.action === "replace") {
        await params.logger?.warn("create workspace replacing incompatible sandbox", {
          workspaceID: params.info.id,
          sandboxID: plan.sandboxId,
          error: errorMessage(plan.reason),
        })
        try {
          await existingRecord.sandbox.kill()
          await deleteCachedSandbox(
            params.store,
            params.info.id,
            existingRecord.sandbox.sandboxId,
            params.logger,
          )
        } catch (error) {
          if (error instanceof SandboxNotFoundError) {
            await deleteCachedSandbox(
              params.store,
              params.info.id,
              existingRecord.sandbox.sandboxId,
              params.logger,
            )
          } else {
            throw error
          }
        } finally {
          forgetSandboxCompatibility(existingRecord.sandbox.sandboxId)
        }
      }
    }

    stage = "provision-fresh-workspace"
    await provisionFreshWorkspace({
      info: params.info,
      env: params.env,
      config,
      runtimeVersion,
      localDirectory: params.localDirectory,
      logger: params.logger,
      store: params.store,
    })
  } catch (error) {
    await params.logger?.error("create workspace failed", {
      workspaceID: params.info.id,
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
  store?: SandboxStore
}): Promise<void> {
  let stage = "resolve-plugin-version"
  const pluginPackageVersion = await resolveLocalPluginVersion()

  stage = "create-sandbox"
  await params.logger?.info("create workspace provisioning sandbox", {
    workspaceID: params.info.id,
    pluginPackageVersion,
  })
  const freshCompatibility = buildFreshCompatibility(params.config, params.runtimeVersion)
  const metadata = buildWorkspaceSandboxMetadata(params.info, params.config, freshCompatibility)
  const sandbox = await createWorkspaceSandbox(
    params.info,
    params.config,
    freshCompatibility,
    params.runtimeVersion,
    pluginPackageVersion,
    params.logger,
  )
  const cacheInput = {
    workspaceID: params.info.id,
    sandboxID: sandbox.sandboxId,
    metadata,
  }
  await upsertProvisioningSandbox(params.store, cacheInput, params.logger)

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
    await markSandboxReady(params.store, cacheInput, params.logger)
  } catch (error) {
    await params.logger?.error("create workspace failed after sandbox provisioned", {
      workspaceID: params.info.id,
      sandboxID: sandbox.sandboxId,
      stage,
      error: errorMessage(error),
    })
    let cleanupComplete = false
    await sandbox
      .kill()
      .then(() => {
        cleanupComplete = true
      })
      .catch(async (killError: unknown) => {
        if (killError instanceof SandboxNotFoundError) {
          cleanupComplete = true
          return
        }
        await params.logger?.warn("create workspace failed to kill sandbox during cleanup", {
          workspaceID: params.info.id,
          sandboxID: sandbox.sandboxId,
          error: errorMessage(killError),
        })
      })
    if (cleanupComplete) {
      await deleteCachedSandbox(params.store, params.info.id, sandbox.sandboxId, params.logger)
    } else {
      await markSandboxFailed(params.store, params.info.id, sandbox.sandboxId, params.logger)
    }
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
