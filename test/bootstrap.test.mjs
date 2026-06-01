import assert from "node:assert/strict"
import { test } from "bun:test"

import { renderRuntimeEnvFile, waitForSyncReady } from "../dist/bootstrap.js"
import { normalizeOptions } from "../dist/config.js"

test("renderRuntimeEnvFile exports defined values and skips undefined entries", () => {
  assert.equal(
    renderRuntimeEnvFile({
      OPENCODE_WORKSPACE_ID: "workspace-123",
      OPTIONAL: undefined,
    }),
    [
      "# Written by opencode-e2b bootstrap; sourced by the managed template start command.",
      "# Do not edit: regenerated on every workspace create.",
      "export OPENCODE_WORKSPACE_ID='workspace-123'",
      "",
    ].join("\n"),
  )
})

test("renderRuntimeEnvFile shell-quotes auth payloads", () => {
  assert.match(
    renderRuntimeEnvFile({
      OPENCODE_AUTH_CONTENT: `{"token":"can't"}`,
    }),
    /export OPENCODE_AUTH_CONTENT='\{"token":"can'\\''t"\}'/,
  )
})

test("waitForSyncReady verifies and closes persistent sync endpoints", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let eventStreamCancelled = false

  globalThis.fetch = async (url, init) => {
    calls.push({ url: url.toString(), init })
    if (url.toString().endsWith("/global/event")) {
      const stream = new ReadableStream({
        cancel() {
          eventStreamCancelled = true
        },
      })
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
        },
      })
    }

    if (url.toString().endsWith("/sync/history")) {
      assert.equal(init.method, "POST")
      assert.equal(init.body, "{}")
      return Response.json([])
    }

    return new Response("unexpected", { status: 500 })
  }

  try {
    await waitForSyncReady(createSandbox(), normalizeOptions())
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/global/event", "/sync/history"],
  )
  assert.equal(calls[0].init.headers.accept, "text/event-stream")
  assert.equal(calls[1].init.headers["content-type"], "application/json")
  assert.equal(eventStreamCancelled, true)
})

test("waitForSyncReady fails when sync endpoints never become reachable", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("not ready", { status: 503 })

  try {
    await assert.rejects(
      waitForSyncReady(
        createSandbox(),
        normalizeOptions({
          bootstrap: {
            waitForTimeoutMs: 1,
          },
        }),
      ),
      /Timed out waiting for OpenCode sync endpoints/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

function createSandbox() {
  return {
    getHost(port) {
      return `sandbox-host-${port}.example.com`
    },
    files: {
      async exists() {
        return false
      },
    },
  }
}
