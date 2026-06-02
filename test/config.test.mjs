import assert from "node:assert/strict"
import { test } from "bun:test"

import {
  buildPersistedExtra,
  normalizeOptions,
  resolveWorkspaceConfig,
  validatePluginOptions,
} from "../dist/config.js"

test("normalizeOptions applies stable defaults", () => {
  const config = normalizeOptions()

  assert.equal(config.workspaceApiVersion, "1")
  assert.equal(config.nodeVariant, "22-slim")
  assert.equal(config.sandboxTimeoutMs, 60 * 60 * 1000)
  assert.equal(config.projectPath, "/home/user/project")
  assert.equal(config.serverPort, 4096)
  assert.equal(config.secure, true)
  assert.equal(config.network.allowPublicTraffic, true)
  assert.deepEqual(config.upload.ignore, [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".DS_Store",
  ])
  assert.deepEqual(config.flags, ["sync:local-snapshot-upload", "repo:git-init", "install:node-base"])
})

test("validatePluginOptions reports all invalid fields in one pass", () => {
  assert.throws(
    () =>
      validatePluginOptions({
        nodeVariant: "",
        secure: "yes",
        network: {
          allowOut: "0.0.0.0/0",
        },
        upload: {
          batchSize: 0,
        },
      }),
    (error) => {
      assert.match(error.message, /nodeVariant must be a non-empty string/)
      assert.match(error.message, /secure must be a boolean/)
      assert.match(error.message, /network.allowOut must be an array of strings/)
      assert.match(error.message, /upload.batchSize must be a positive integer/)
      return true
    },
  )
})

test("resolveWorkspaceConfig keeps persisted workspace identity stable", () => {
  const persistedConfig = normalizeOptions({
    nodeVariant: "20-slim",
    projectPath: "/workspace/project",
    serverPort: 7777,
    secure: true,
    metadata: {
      owner: "original",
    },
  })
  const info = {
    id: "workspace-123",
    type: "e2b",
    name: "workspace",
    branch: null,
    directory: null,
    projectID: "project-123",
    extra: buildPersistedExtra(persistedConfig, "1.14.30"),
  }

  const resolved = resolveWorkspaceConfig(info, {
    nodeVariant: "22-slim",
    projectPath: "/different",
    serverPort: 4096,
    secure: false,
    metadata: {
      owner: "new",
      region: "us",
    },
  })

  assert.equal(resolved.nodeVariant, "20-slim")
  assert.equal(resolved.projectPath, "/workspace/project")
  assert.equal(resolved.serverPort, 7777)
  assert.equal(resolved.secure, true)
  assert.deepEqual(resolved.metadata, {
    owner: "original",
    region: "us",
  })
})
