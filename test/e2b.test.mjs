import assert from "node:assert/strict"
import { test } from "bun:test"

import { Sandbox, SandboxNotFoundError, Template } from "e2b"

import { normalizeOptions } from "../dist/config.js"
import {
  createWorkspaceSandbox,
  findWorkspaceSandboxRecord,
  readSandboxCompatibility,
  removeWorkspaceSandbox,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "../dist/e2b.js"
import { buildManagedBaseTemplateAlias, buildManagedWorkspaceTemplateAlias } from "../dist/template.js"

const workspaceInfo = {
  id: "workspace-id",
  projectID: "project-id",
}

const compatibility = {
  workspaceApiVersion: "1",
  runtimeVersion: "1.14.39",
  flags: [],
}

test("sandboxBaseUrl builds the gateway URL for the configured server port", () => {
  const sandbox = {
    getHost(port) {
      return `sandbox-host-${port}.example.com`
    },
  }

  assert.equal(
    sandboxBaseUrl(sandbox, normalizeOptions()).toString(),
    "https://sandbox-host-4096.example.com/",
  )
})

test("sandboxTargetHeaders returns secure access headers only when needed", () => {
  const secureConfig = normalizeOptions({ secure: true })
  const publicConfig = normalizeOptions({ secure: false })

  assert.deepEqual(sandboxTargetHeaders({ trafficAccessToken: "token" }, secureConfig), {
    "X-Access-Token": "token",
  })
  assert.equal(sandboxTargetHeaders({ trafficAccessToken: "token" }, publicConfig), undefined)
  assert.throws(() => sandboxTargetHeaders({}, secureConfig), /did not provide an access token/)
})

test("readSandboxCompatibility parses valid metadata flags", () => {
  assert.deepEqual(
    readSandboxCompatibility({
      opencodeWorkspaceApiVersion: "1",
      opencodeRuntimeVersion: "1.14.30",
      opencodeFlags: JSON.stringify(["sync:local-snapshot-upload"]),
    }),
    {
      workspaceApiVersion: "1",
      runtimeVersion: "1.14.30",
      flags: ["sync:local-snapshot-upload"],
    },
  )
})

test("readSandboxCompatibility treats invalid flags as unknown", () => {
  assert.deepEqual(readSandboxCompatibility({ opencodeFlags: "not json" }), {
    workspaceApiVersion: undefined,
    runtimeVersion: undefined,
    flags: [],
  })
  assert.deepEqual(readSandboxCompatibility({ opencodeFlags: JSON.stringify([1]) }).flags, [])
})

test("createWorkspaceSandbox wraps versioned published templates", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const originalFetch = globalThis.fetch
  const originalCreate = Sandbox.create
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const runtimeVersion = "1.14.39"
  const pluginPackageVersion = "prebuilt-create-test"
  const config = normalizeOptions()
  const alias = buildManagedWorkspaceTemplateAlias({
    baseTemplate: "e2b/opencode:v1.14.39",
    nodeVariant: config.nodeVariant,
    runtimeVersion,
    projectPath: config.projectPath,
    serverPort: config.serverPort,
    pluginPackageVersion,
  })

  Sandbox.create = async (template, options) => {
    calls.push(["create", template, options.metadata.opencodeWorkspaceId])
    return { sandboxId: "workspace-sandbox" }
  }
  process.env.E2B_API_KEY = "e2b_test"
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? input.method ?? "GET"
    calls.push(["fetch", method])
    return jsonResponse([])
  }
  Template.getTags = async () => {
    throw new Error("workspace sandbox creation should not call getTags")
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }

  try {
    const sandbox = await createWorkspaceSandbox(
      workspaceInfo,
      config,
      compatibility,
      runtimeVersion,
      pluginPackageVersion,
    )

    assert.equal(sandbox.sandboxId, "workspace-sandbox")
    assert.deepEqual(calls, [
      ["fetch", "GET"],
      ["build", alias],
      ["create", alias, "workspace-id"],
    ])
  } finally {
    restoreTestEnv(originalApiKey)
    globalThis.fetch = originalFetch
    Sandbox.create = originalCreate
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("createWorkspaceSandbox builds a managed base when published template is missing", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const originalFetch = globalThis.fetch
  const originalCreate = Sandbox.create
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const runtimeVersion = "1.14.38"
  const pluginPackageVersion = "managed-fallback-test"
  const config = normalizeOptions()
  const publishedWrapperAlias = buildManagedWorkspaceTemplateAlias({
    baseTemplate: "e2b/opencode:v1.14.38",
    nodeVariant: config.nodeVariant,
    runtimeVersion,
    projectPath: config.projectPath,
    serverPort: config.serverPort,
    pluginPackageVersion,
  })
  const baseAlias = buildManagedBaseTemplateAlias({
    nodeVariant: config.nodeVariant,
    runtimeVersion,
    pluginPackageVersion,
  })
  const wrapperAlias = buildManagedWorkspaceTemplateAlias({
    baseTemplate: baseAlias,
    nodeVariant: config.nodeVariant,
    runtimeVersion,
    projectPath: config.projectPath,
    serverPort: config.serverPort,
    pluginPackageVersion,
  })

  Sandbox.create = async (template) => {
    calls.push(["create", template])
    return { sandboxId: "managed-sandbox" }
  }
  process.env.E2B_API_KEY = "e2b_test"
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? input.method ?? "GET"
    calls.push(["fetch", method])
    return jsonResponse([])
  }
  Template.getTags = async () => {
    throw new Error("workspace sandbox creation should not call getTags")
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
    if (name === publishedWrapperAlias) {
      throw new Error("published template unavailable")
    }
  }

  try {
    const sandbox = await createWorkspaceSandbox(
      workspaceInfo,
      config,
      compatibility,
      runtimeVersion,
      pluginPackageVersion,
    )

    assert.equal(sandbox.sandboxId, "managed-sandbox")
    assert.deepEqual(calls, [
      ["fetch", "GET"],
      ["build", publishedWrapperAlias],
      ["fetch", "GET"],
      ["fetch", "GET"],
      ["build", baseAlias],
      ["fetch", "GET"],
      ["build", wrapperAlias],
      ["create", wrapperAlias],
    ])
  } finally {
    restoreTestEnv(originalApiKey)
    globalThis.fetch = originalFetch
    Sandbox.create = originalCreate
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("createWorkspaceSandbox never calls template getTags", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const originalFetch = globalThis.fetch
  const originalCreate = Sandbox.create
  const originalGetTags = Template.getTags
  const originalBuild = Template.build

  process.env.E2B_API_KEY = "e2b_test"
  globalThis.fetch = async () => jsonResponse([])
  Sandbox.create = async () => ({ sandboxId: "workspace-sandbox" })
  Template.getTags = async () => {
    throw new Error("getTags should not be called")
  }
  Template.build = async () => {}

  try {
    const sandbox = await createWorkspaceSandbox(
      workspaceInfo,
      normalizeOptions(),
      compatibility,
      "1.14.37",
      "no-get-tags-test",
    )

    assert.equal(sandbox.sandboxId, "workspace-sandbox")
  } finally {
    restoreTestEnv(originalApiKey)
    globalThis.fetch = originalFetch
    Sandbox.create = originalCreate
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("findWorkspaceSandboxRecord connects cached ready sandbox without listing", async () => {
  const originalConnect = Sandbox.connect
  const originalList = Sandbox.list
  const store = createMemoryStore({
    workspaceID: workspaceInfo.id,
    sandboxID: "cached-sandbox",
    metadata: { opencodeWorkspaceId: workspaceInfo.id },
    status: "ready",
  })

  Sandbox.connect = async (sandboxId) => ({ sandboxId })
  Sandbox.list = () => {
    throw new Error("list should not be called")
  }

  try {
    const record = await findWorkspaceSandboxRecord(workspaceInfo, normalizeOptions(), undefined, store)
    assert.equal(record.sandbox.sandboxId, "cached-sandbox")
  } finally {
    Sandbox.connect = originalConnect
    Sandbox.list = originalList
  }
})

test("findWorkspaceSandboxRecord deletes stale cache and falls back to limited list", async () => {
  const originalConnect = Sandbox.connect
  const originalList = Sandbox.list
  const store = createMemoryStore({
    workspaceID: workspaceInfo.id,
    sandboxID: "stale-sandbox",
    metadata: { opencodeWorkspaceId: workspaceInfo.id },
    status: "ready",
  })
  const calls = []

  Sandbox.connect = async (sandboxId) => {
    calls.push(["connect", sandboxId])
    if (sandboxId === "stale-sandbox") throw new SandboxNotFoundError("gone")
    return { sandboxId }
  }
  Sandbox.list = (options) => {
    calls.push(["list", options.limit])
    return createPaginator([
      [
        {
          sandboxId: "listed-sandbox",
          metadata: { opencodeWorkspaceId: workspaceInfo.id },
        },
      ],
    ])
  }

  try {
    const record = await findWorkspaceSandboxRecord(workspaceInfo, normalizeOptions(), undefined, store)
    assert.equal(record.sandbox.sandboxId, "listed-sandbox")
    assert.equal(store.deleted.length, 1)
    assert.deepEqual(calls, [
      ["connect", "stale-sandbox"],
      ["list", 2],
      ["connect", "listed-sandbox"],
    ])
    assert.equal(store.row.sandboxID, "listed-sandbox")
    assert.equal(store.row.status, "ready")
  } finally {
    Sandbox.connect = originalConnect
    Sandbox.list = originalList
  }
})

test("removeWorkspaceSandbox deletes stale cache and falls back to list cleanup", async () => {
  const originalConnect = Sandbox.connect
  const originalList = Sandbox.list
  const killed = []
  const store = createMemoryStore({
    workspaceID: workspaceInfo.id,
    sandboxID: "gone-sandbox",
    metadata: { opencodeWorkspaceId: workspaceInfo.id },
    status: "ready",
  })

  Sandbox.connect = async (sandboxId) => {
    if (sandboxId === "gone-sandbox") throw new SandboxNotFoundError("gone")
    return {
      sandboxId,
      async kill() {
        killed.push(sandboxId)
      },
    }
  }
  Sandbox.list = () =>
    createPaginator([
      [
        {
          sandboxId: "listed-sandbox",
          metadata: { opencodeWorkspaceId: workspaceInfo.id },
        },
      ],
    ])

  try {
    await removeWorkspaceSandbox(workspaceInfo, normalizeOptions(), undefined, store)
    assert.deepEqual(killed, ["listed-sandbox"])
    assert.equal(store.deleted.length, 2)
  } finally {
    Sandbox.connect = originalConnect
    Sandbox.list = originalList
  }
})

test("removeWorkspaceSandbox ignores listed sandboxes that are already gone", async () => {
  const originalConnect = Sandbox.connect
  const originalList = Sandbox.list
  const store = createMemoryStore(undefined)

  Sandbox.connect = async () => {
    throw new SandboxNotFoundError("gone")
  }
  Sandbox.list = () =>
    createPaginator([
      [
        {
          sandboxId: "gone-listed-sandbox",
          metadata: { opencodeWorkspaceId: workspaceInfo.id },
        },
      ],
    ])

  try {
    await removeWorkspaceSandbox(workspaceInfo, normalizeOptions(), undefined, store)
    assert.deepEqual(store.deleted, [[workspaceInfo.id, "gone-listed-sandbox"]])
  } finally {
    Sandbox.connect = originalConnect
    Sandbox.list = originalList
  }
})

test("removeWorkspaceSandbox rethrows cached sandbox kill errors", async () => {
  const originalConnect = Sandbox.connect
  const originalList = Sandbox.list
  const store = createMemoryStore({
    workspaceID: workspaceInfo.id,
    sandboxID: "cached-sandbox",
    metadata: { opencodeWorkspaceId: workspaceInfo.id },
    status: "ready",
  })

  Sandbox.connect = async (sandboxId) => ({
    sandboxId,
    async kill() {
      throw new Error("kill failed")
    },
  })
  Sandbox.list = () => {
    throw new Error("list should not be called")
  }

  try {
    await assert.rejects(
      removeWorkspaceSandbox(workspaceInfo, normalizeOptions(), undefined, store),
      /kill failed/,
    )
    assert.equal(store.deleted.length, 0)
  } finally {
    Sandbox.connect = originalConnect
    Sandbox.list = originalList
  }
})

function createPaginator(pages) {
  let index = 0
  return {
    get hasNext() {
      return index < pages.length
    },
    async nextItems() {
      return pages[index++] ?? []
    },
  }
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

function restoreTestEnv(originalApiKey) {
  if (originalApiKey === undefined) {
    delete process.env.E2B_API_KEY
  } else {
    process.env.E2B_API_KEY = originalApiKey
  }
}

function createMemoryStore(row) {
  return {
    row,
    deleted: [],
    async get(workspaceID) {
      return this.row?.workspaceID === workspaceID ? this.row : undefined
    },
    async upsertProvisioning(input) {
      this.row = { ...input, status: "provisioning" }
    },
    async markReady(input) {
      this.row = { ...input, status: "ready" }
    },
    async markFailed(workspaceID, sandboxID) {
      if (this.row?.workspaceID === workspaceID && this.row.sandboxID === sandboxID) {
        this.row = { ...this.row, status: "failed" }
      }
    },
    async delete(workspaceID, sandboxID) {
      this.deleted.push([workspaceID, sandboxID])
      if (this.row?.workspaceID === workspaceID && (!sandboxID || this.row.sandboxID === sandboxID)) {
        this.row = undefined
      }
    },
    close() {},
  }
}
