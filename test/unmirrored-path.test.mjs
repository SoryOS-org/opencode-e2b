import assert from "node:assert/strict"
import { test } from "bun:test"

import { reportUnmirroredProjectPath } from "../dist/v1/workspace.js"

function harness() {
  const logs = []
  const toasts = []
  const record = (level) => async (message, extra) => logs.push({ level, message, extra })
  return {
    logs,
    toasts,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    client: {
      tui: {
        async showToast(input) {
          toasts.push(input)
        },
      },
    },
  }
}

const info = { id: "wrk_test", projectID: "project-1", branch: null }

test("a mirrored path is silent", async () => {
  const h = harness()

  await reportUnmirroredProjectPath({
    info,
    localDirectory: "/Users/dev/demo",
    projectPath: "/Users/dev/demo",
    explicitlyConfigured: false,
    logger: h.logger,
    client: h.client,
  })

  assert.deepEqual(h.logs, [])
  assert.deepEqual(h.toasts, [])
})

test("an unmirrorable host (Windows) is surfaced in the TUI, not only the log", async () => {
  const h = harness()

  await reportUnmirroredProjectPath({
    info,
    localDirectory: "C:\\Users\\dev\\demo",
    projectPath: "/home/user/project",
    explicitlyConfigured: false,
    logger: h.logger,
    client: h.client,
  })

  const warning = h.logs.find((entry) => entry.level === "warn")
  assert.ok(warning, "expected a warning log")
  assert.equal(warning.extra.reason, "host path is not mirrorable")

  // The user did not choose this, so it must be visible without reading logs.
  assert.equal(h.toasts.length, 1)
  assert.equal(h.toasts[0].body.variant, "warning")
  assert.match(h.toasts[0].body.message, /cannot be mirrored/)
  assert.match(h.toasts[0].body.message, /warp it in explicitly/)
  assert.deepEqual(h.toasts[0].query, { directory: "C:\\Users\\dev\\demo" })
})

test("an explicitly configured projectPath is logged but not toasted", async () => {
  const h = harness()

  await reportUnmirroredProjectPath({
    info,
    localDirectory: "/Users/dev/demo",
    projectPath: "/home/user/custom",
    explicitlyConfigured: true,
    logger: h.logger,
    client: h.client,
  })

  const warning = h.logs.find((entry) => entry.level === "warn")
  assert.equal(warning.extra.reason, "projectPath option set explicitly")
  // The user asked for this path; don't nag them on every workspace create.
  assert.deepEqual(h.toasts, [])
})

test("a failing toast never breaks workspace configuration", async () => {
  const h = harness()
  const client = {
    tui: {
      async showToast() {
        throw new Error("tui unavailable")
      },
    },
  }

  await reportUnmirroredProjectPath({
    info,
    localDirectory: "C:\\Users\\dev\\demo",
    projectPath: "/home/user/project",
    explicitlyConfigured: false,
    logger: h.logger,
    client,
  })

  assert.ok(h.logs.some((entry) => entry.level === "warn"))
  assert.ok(h.logs.some((entry) => entry.level === "debug" && /toast failed/.test(entry.message)))
})
