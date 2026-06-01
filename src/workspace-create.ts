import type { PluginInput, WorkspaceInfo } from "@opencode-ai/plugin"

import { bootstrapWorkspace } from "./bootstrap.js"
import { buildFreshCompatibility, resolveWorkspaceCompatibility, resolveWorkspaceConfig } from "./config.js"
import {
  createWorkspaceSandbox,
  findWorkspaceSandboxRecord,
  readSandboxCompatibility,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "./e2b.js"
import {
  assertWorkspaceCompatibility,
  forgetSandboxCompatibility,
  resolveLocalPluginVersion,
  resolveLocalRuntimeVersion,
} from "./runtime.js"
import { errorMessage } from "./shared.js"
import type { E2BWorkspacePluginOptions, NormalizedE2BWorkspaceConfig, PluginLogger } from "./types.js"
import { uploadLocalSnapshot } from "./upload.js"

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
    const existingRecord = await findWorkspaceSandboxRecord(params.info, config, params.logger)
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
