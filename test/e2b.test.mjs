import assert from "node:assert/strict"
import test from "node:test"

import { RateLimitError, Sandbox, Template } from "e2b"

import { normalizeOptions } from "../dist/config.js"
import {
  createWorkspaceSandbox,
  readSandboxCompatibility,
  sandboxBaseUrl,
  sandboxTargetHeaders,
} from "../dist/e2b.js"
import { buildManagedTemplateAlias } from "../dist/template.js"

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
  assert.equal(sandboxTargetHeaders({}, secureConfig), undefined)
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

test("createWorkspaceSandbox creates from versioned published template first", async () => {
  const originalCreate = Sandbox.create
  const calls = []

  Sandbox.create = async (template, options) => {
    calls.push([template, options.metadata.opencodeWorkspaceId])
    return { sandboxId: "prebuilt-sandbox" }
  }

  try {
    const sandbox = await createWorkspaceSandbox(
      workspaceInfo,
      normalizeOptions(),
      compatibility,
      "1.14.39",
      "prebuilt-create-test",
    )

    assert.equal(sandbox.sandboxId, "prebuilt-sandbox")
    assert.deepEqual(calls, [["e2b/opencode:1.14.39", "workspace-id"]])
  } finally {
    Sandbox.create = originalCreate
  }
})

test("createWorkspaceSandbox falls back to managed template when published create fails", async () => {
  const originalCreate = Sandbox.create
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const runtimeVersion = "1.14.38"
  const pluginPackageVersion = "managed-fallback-test"
  const alias = buildManagedTemplateAlias({
    nodeVariant: normalizeOptions().nodeVariant,
    runtimeVersion,
    projectPath: normalizeOptions().projectPath,
    serverPort: normalizeOptions().serverPort,
    pluginPackageVersion,
  })

  Sandbox.create = async (template) => {
    calls.push(["create", template])
    if (calls.length === 1) {
      throw new Error("404: tag does not exist")
    }
    return { sandboxId: "managed-sandbox" }
  }
  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return []
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }

  try {
    const sandbox = await createWorkspaceSandbox(
      workspaceInfo,
      normalizeOptions(),
      compatibility,
      runtimeVersion,
      pluginPackageVersion,
    )

    assert.equal(sandbox.sandboxId, "managed-sandbox")
    assert.deepEqual(calls, [
      ["create", "e2b/opencode:1.14.38"],
      ["getTags", alias],
      ["build", alias],
      ["create", alias],
    ])
  } finally {
    Sandbox.create = originalCreate
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("createWorkspaceSandbox does not fall back on prebuilt rate limits", async () => {
  const originalCreate = Sandbox.create
  const originalBuild = Template.build

  Sandbox.create = async () => {
    throw new RateLimitError("limited")
  }
  Template.build = async () => {
    throw new Error("managed template build should not run")
  }

  try {
    await assert.rejects(
      createWorkspaceSandbox(workspaceInfo, normalizeOptions(), compatibility, "1.14.37", "rate-limit-test"),
      RateLimitError,
    )
  } finally {
    Sandbox.create = originalCreate
    Template.build = originalBuild
  }
})
