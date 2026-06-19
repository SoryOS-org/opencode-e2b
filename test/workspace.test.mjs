import assert from "node:assert/strict"
import { test } from "bun:test"

import { Sandbox } from "e2b"

import { normalizeOptions } from "../dist/config.js"
import { clearLocalRuntimeVersionCacheForTest } from "../dist/runtime.js"
import { createWorkspace, planExistingSandbox } from "../dist/workspace-create.js"

test("planExistingSandbox creates a sandbox when no existing sandbox was found", () => {
  assert.deepEqual(planExistingSandbox({}), {
    action: "create",
  })
})

test("planExistingSandbox reuses a compatible existing sandbox", () => {
  assert.deepEqual(planExistingSandbox({ existingSandboxId: "sandbox-123" }), {
    action: "reuse",
    sandboxId: "sandbox-123",
  })
})

test("planExistingSandbox replaces an incompatible existing sandbox", () => {
  const reason = new Error("runtime mismatch")

  assert.deepEqual(
    planExistingSandbox({
      existingSandboxId: "sandbox-123",
      compatibilityError: reason,
    }),
    {
      action: "replace",
      sandboxId: "sandbox-123",
      reason,
    },
  )
})

test("createWorkspace resumes a compatible cached sandbox without provisioning", async () => {
  clearLocalRuntimeVersionCacheForTest()

  const originalConnect = Sandbox.connect
  const originalCreate = Sandbox.create
  const originalList = Sandbox.list
  const originalFetch = globalThis.fetch
  const calls = []
  const config = normalizeOptions()
  const metadata = {
    opencodeWorkspaceId: "workspace-id",
    opencodeProjectId: "project-id",
    opencodeWorkspaceApiVersion: config.workspaceApiVersion,
    opencodeRuntimeVersion: "1.16.0",
    opencodeFlags: JSON.stringify(config.flags),
  }
  const store = createMemoryStore({
    workspaceID: "workspace-id",
    sandboxID: "cached-resume-sandbox",
    metadata,
    status: "ready",
  })
  const client = {
    _client: {
      async get(options) {
        calls.push(["client-get", options.url])
        return {
          data: {
            healthy: true,
            version: "1.16.0",
          },
        }
      },
    },
  }

  Sandbox.connect = async (sandboxId) => {
    calls.push(["connect", sandboxId])
    return {
      sandboxId,
      trafficAccessToken: "traffic-token",
      getHost(port) {
        calls.push(["getHost", port])
        return `resume-${port}.example.com`
      },
    }
  }
  Sandbox.create = () => {
    throw new Error("create should not be called")
  }
  Sandbox.list = () => {
    throw new Error("list should not be called")
  }
  globalThis.fetch = async (input, init) => {
    calls.push(["fetch", input.toString(), init.headers?.["e2b-traffic-access-token"]])
    return jsonResponse({
      healthy: true,
      version: "1.16.0",
    })
  }

  try {
    await createWorkspace({
      info: {
        id: "workspace-id",
        type: "e2b",
        name: "workspace",
        branch: "main",
        directory: null,
        extra: null,
        projectID: "project-id",
      },
      env: {},
      localDirectory: "/tmp/project",
      options: undefined,
      serverUrl: new URL("http://127.0.0.1:4096"),
      client,
      store,
    })

    assert.deepEqual(calls, [
      ["client-get", "/global/health"],
      ["connect", "cached-resume-sandbox"],
      ["getHost", 4096],
      ["fetch", "https://resume-4096.example.com/global/health", "traffic-token"],
    ])
    assert.equal(store.row.status, "ready")
  } finally {
    clearLocalRuntimeVersionCacheForTest()
    Sandbox.connect = originalConnect
    Sandbox.create = originalCreate
    Sandbox.list = originalList
    globalThis.fetch = originalFetch
  }
})

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

function createMemoryStore(row) {
  return {
    row,
    async get(workspaceID) {
      return this.row?.workspaceID === workspaceID ? this.row : undefined
    },
    async claimProvisioning() {
      throw new Error("claimProvisioning should not be called")
    },
    async upsertProvisioning() {
      throw new Error("upsertProvisioning should not be called")
    },
    async markReady() {
      throw new Error("markReady should not be called")
    },
    async markFailed() {
      throw new Error("markFailed should not be called")
    },
    async delete() {
      throw new Error("delete should not be called")
    },
    close() {},
  }
}
