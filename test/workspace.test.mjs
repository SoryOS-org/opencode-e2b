import assert from "node:assert/strict"
import { test } from "bun:test"

import { clearLocalRuntimeVersionCacheForTest } from "../dist/runtime.js"
import { createE2BWorkspaceAdapter } from "../dist/workspace.js"
import { planExistingSandbox } from "../dist/workspace-create.js"

const workspaceInfo = {
  id: "workspace-id",
  type: "e2b",
  name: "workspace",
  branch: null,
  directory: null,
  extra: null,
  projectID: "project-id",
}

function noopLogger() {
  return {
    async debug() {},
    async info() {},
    async warn() {},
    async error() {},
  }
}

function createToastClient(showToast) {
  return {
    tui: { showToast },
    app: { log: async () => {} },
  }
}

function buildAdapter(client, overrides = {}) {
  return createE2BWorkspaceAdapter({
    client,
    directory: "/tmp/project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    options: undefined,
    logger: noopLogger(),
    gcConfig: { enabled: false },
    sandboxStore: undefined,
    ...overrides,
  })
}

function withoutApiKey(run) {
  const original = process.env.E2B_API_KEY
  delete process.env.E2B_API_KEY
  return (async () => {
    try {
      return await run()
    } finally {
      if (original === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = original
    }
  })()
}

test("adapter surfaces create failures as an error toast and rethrows", async () => {
  await withoutApiKey(async () => {
    const toasts = []
    const adapter = buildAdapter(
      createToastClient(async (options) => {
        toasts.push(options)
        return { data: true }
      }),
    )

    await assert.rejects(adapter.create(workspaceInfo, {}, undefined), /E2B_API_KEY is not set/)

    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].body.variant, "error")
    assert.match(toasts[0].body.message, /Creating E2B workspace failed: E2B_API_KEY is not set/)
    assert.equal(toasts[0].query.directory, "/tmp/project")
  })
})

test("adapter still rethrows the original error when the toast itself fails", async () => {
  await withoutApiKey(async () => {
    const adapter = buildAdapter(
      createToastClient(async () => {
        throw new Error("no TUI attached")
      }),
    )

    await assert.rejects(adapter.target(workspaceInfo), /E2B_API_KEY is not set/)
  })
})

test("adapter does not toast when an operation succeeds", async () => {
  clearLocalRuntimeVersionCacheForTest()
  let toastCount = 0
  const client = {
    tui: {
      showToast: async () => {
        toastCount += 1
        return { data: true }
      },
    },
    app: { log: async () => {} },
    _client: {
      async get() {
        return { data: { healthy: true, version: "1.17.11" } }
      },
    },
  }
  const adapter = buildAdapter(client)

  const configured = await adapter.configure(workspaceInfo)

  assert.equal(toastCount, 0)
  assert.equal(configured.directory, "/home/user/project")
})

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
