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
  assert.equal(config.network.allowPublicTraffic, false)
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
        projectPath: "relative/project",
        serverPort: 70000,
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
      assert.match(error.message, /projectPath must be an absolute POSIX path/)
      assert.match(error.message, /serverPort must be between 1 and 65535/)
      assert.match(error.message, /secure must be a boolean/)
      assert.match(error.message, /network.allowOut must be an array of strings/)
      assert.match(error.message, /upload.batchSize must be a positive integer/)
      return true
    },
  )
})

test("normalizeOptions validates path and port ranges", () => {
  assert.throws(() => normalizeOptions({ projectPath: "relative/project" }), /absolute POSIX path/)
  assert.throws(() => normalizeOptions({ serverPort: 70000 }), /between 1 and 65535/)
})

test("projectPath must live under /home/user", () => {
  // Accepted: the home root itself and any descendant.
  assert.equal(normalizeOptions({ projectPath: "/home/user" }).projectPath, "/home/user")
  assert.equal(
    normalizeOptions({ projectPath: "/home/user/app/nested" }).projectPath,
    "/home/user/app/nested",
  )
  assert.equal(normalizeOptions({ projectPath: "/home/user/app/" }).projectPath, "/home/user/app/")

  // Rejected: outside the sandbox user's home.
  for (const bad of ["/root/project", "/opt/app", "/home/other", "/home/user2", "/home/user/../root"]) {
    assert.throws(
      () => normalizeOptions({ projectPath: bad }),
      /within \/home\/user/,
      `expected ${bad} to be rejected`,
    )
  }
})

test("validatePluginOptions rejects a projectPath outside /home/user", () => {
  assert.throws(
    () => validatePluginOptions({ projectPath: "/opt/app" }),
    /projectPath must be within \/home\/user/,
  )
})

test("projectPath must not contain control characters", () => {
  // The path is baked into a single-quoted word inside a heredoc (systemd
  // start script); a newline would terminate the heredoc and corrupt the unit.
  assert.throws(
    () => normalizeOptions({ projectPath: "/home/user/app\nEOF\n" }),
    /control characters/,
  )
  assert.throws(
    () => validatePluginOptions({ projectPath: "/home/user/app\nEOF\n" }),
    /projectPath must not contain control characters/,
  )
  assert.throws(() => normalizeOptions({ projectPath: "/home/user/app\tdir" }), /control characters/)
})

test("resolveWorkspaceConfig keeps persisted workspace identity stable", () => {
  const persistedConfig = normalizeOptions({
    nodeVariant: "20-slim",
    projectPath: "/home/user/workspace",
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
    projectPath: "/home/user/different",
    serverPort: 4096,
    secure: false,
    metadata: {
      owner: "new",
      region: "us",
    },
  })

  assert.equal(resolved.nodeVariant, "20-slim")
  assert.equal(resolved.projectPath, "/home/user/workspace")
  assert.equal(resolved.serverPort, 7777)
  assert.equal(resolved.secure, true)
  assert.deepEqual(resolved.metadata, {
    owner: "original",
    region: "us",
  })
})

test("normalizeOptions does not flag prepare commands as a compatibility feature", () => {
  const config = normalizeOptions({
    bootstrap: {
      prepareCommands: ["npm install"],
    },
  })

  // The intent is only that prepareCommands must not ALTER the flag set; the
  // literal default list is asserted once, in the defaults test above.
  assert.deepEqual(config.flags, normalizeOptions().flags)
})
