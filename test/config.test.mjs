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

test("projectPath defaults to the host directory so the path resolves on both sides", () => {
  // Mirrored: a POSIX-absolute host path is used verbatim in the sandbox.
  assert.equal(
    normalizeOptions(undefined, "/Users/dev/Documents/GitHub/demo").projectPath,
    "/Users/dev/Documents/GitHub/demo",
  )

  // An explicit option still wins over the host path.
  assert.equal(
    normalizeOptions({ projectPath: "/home/user/custom" }, "/Users/dev/demo").projectPath,
    "/home/user/custom",
  )

  // Not mirrorable -> keep the fallback. A Windows path has no form that is
  // absolute on both systems, so those hosts stay on /home/user/project.
  for (const unmirrorable of [undefined, "C:\\Users\\dev\\demo", "/C:/Users/dev/demo", "relative/dir"]) {
    assert.equal(
      normalizeOptions(undefined, unmirrorable).projectPath,
      "/home/user/project",
      `expected fallback for ${unmirrorable}`,
    )
  }
})

test("projectPath accepts any absolute path so it can mirror the host path", () => {
  // The sandbox project may live at the host's own path, so a session's
  // directory is valid on both sides (no symlink for realpath to collapse).
  // Ownership is guaranteed by chown in bootstrap, not by the path location.
  for (const good of [
    "/home/user/project",
    "/home/user",
    "/Users/dev/Documents/GitHub/demo",
    "/workspace/app",
  ]) {
    assert.equal(normalizeOptions({ projectPath: good }).projectPath, good)
  }

  // Still rejected: relative paths and the filesystem root.
  assert.throws(() => normalizeOptions({ projectPath: "relative/project" }), /absolute POSIX path/)
  assert.throws(() => normalizeOptions({ projectPath: "/" }), /filesystem root/)
})

test("validatePluginOptions accepts a host-mirroring projectPath but rejects the root", () => {
  assert.deepEqual(validatePluginOptions({ projectPath: "/Users/dev/demo" }), {
    projectPath: "/Users/dev/demo",
  })
  assert.throws(
    () => validatePluginOptions({ projectPath: "/" }),
    /projectPath must not be the filesystem root/,
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

test("normalizeOptions does not flag prepare commands as a compatibility feature", () => {
  const config = normalizeOptions({
    bootstrap: {
      prepareCommands: ["npm install"],
    },
  })

  assert.deepEqual(config.flags, ["sync:local-snapshot-upload", "repo:git-init", "install:node-base"])
})
