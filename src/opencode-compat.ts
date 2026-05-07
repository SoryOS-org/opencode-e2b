import type { WorkspaceAdapter, WorkspaceInfo } from "@opencode-ai/plugin"

import type { RuntimeWorkspaceAdapter } from "./types.js"

type WorkspaceAdapterWithRuntimeEnv = Omit<WorkspaceAdapter, "create"> & {
  create(
    info: WorkspaceInfo,
    envOrFrom?: Record<string, string | undefined> | WorkspaceInfo,
    from?: WorkspaceInfo,
  ): Promise<void>
}

export function toPublishedWorkspaceAdapter(adapter: RuntimeWorkspaceAdapter): WorkspaceAdapter {
  const published: WorkspaceAdapterWithRuntimeEnv = {
    name: adapter.name,
    description: adapter.description,
    configure(info) {
      return adapter.configure(info)
    },
    create(info, envOrFrom) {
      const env = isWorkspaceInfo(envOrFrom) ? {} : envOrFrom
      return adapter.create(info, env ?? {})
    },
    remove(info) {
      return adapter.remove(info)
    },
    target(info) {
      return adapter.target(info)
    },
  }

  return published
}

function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  return Boolean(value && typeof value === "object" && "projectID" in value)
}
