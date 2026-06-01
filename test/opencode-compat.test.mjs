import assert from "node:assert/strict"
import { test } from "bun:test"

import { toPublishedWorkspaceAdapter } from "../dist/opencode-compat.js"

test("toPublishedWorkspaceAdapter forwards env and source workspace", async () => {
  const info = { id: "target", projectID: "project", type: "e2b" }
  const from = { id: "source", projectID: "project", type: "local" }
  const env = { OPENCODE_WORKSPACE_ID: "target" }
  let captured

  const adapter = toPublishedWorkspaceAdapter({
    name: "E2B",
    description: "test",
    configure(input) {
      return input
    },
    async create(createdInfo, createdEnv, createdFrom) {
      captured = { info: createdInfo, env: createdEnv, from: createdFrom }
    },
    async remove() {},
    async target() {
      return { type: "remote", url: new URL("https://example.com") }
    },
  })

  await adapter.create(info, env, from)

  assert.deepEqual(captured, { info, env, from })
})

test("toPublishedWorkspaceAdapter preserves old source-as-second-arg calls", async () => {
  const info = { id: "target", projectID: "project", type: "e2b" }
  const from = { id: "source", projectID: "project", type: "local" }
  let captured

  const adapter = toPublishedWorkspaceAdapter({
    name: "E2B",
    description: "test",
    configure(input) {
      return input
    },
    async create(createdInfo, createdEnv, createdFrom) {
      captured = { info: createdInfo, env: createdEnv, from: createdFrom }
    },
    async remove() {},
    async target() {
      return { type: "remote", url: new URL("https://example.com") }
    },
  })

  await adapter.create(info, from)

  assert.deepEqual(captured, { info, env: {}, from })
})
