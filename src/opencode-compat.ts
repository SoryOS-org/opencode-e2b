import type { WorkspaceAdaptor, WorkspaceInfo } from "@opencode-ai/plugin"

import type { RuntimeWorkspaceAdaptor } from "./types.js"

type WorkspaceAdaptorWithRuntimeEnv = Omit<WorkspaceAdaptor, "create"> & {
  create(
    info: WorkspaceInfo,
    envOrFrom?: Record<string, string | undefined> | WorkspaceInfo,
    from?: WorkspaceInfo,
  ): Promise<void>
}

export function toPublishedWorkspaceAdaptor(adaptor: RuntimeWorkspaceAdaptor): WorkspaceAdaptor {
  const published: WorkspaceAdaptorWithRuntimeEnv = {
    name: adaptor.name,
    description: adaptor.description,
    configure(info) {
      return adaptor.configure(info)
    },
    create(info, envOrFrom, from) {
      const env = isWorkspaceInfo(envOrFrom) ? {} : envOrFrom
      const sourceWorkspace = isWorkspaceInfo(envOrFrom) ? envOrFrom : from
      return adaptor.create(info, env ?? {}, sourceWorkspace)
    },
    remove(info) {
      return adaptor.remove(info)
    },
    target(info) {
      return adaptor.target(info)
    },
  }

  return published
}

function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  return Boolean(value && typeof value === "object" && "projectID" in value)
}
