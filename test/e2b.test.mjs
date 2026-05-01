import assert from "node:assert/strict"
import test from "node:test"

import { normalizeOptions } from "../dist/config.js"
import { readSandboxCompatibility, sandboxBaseUrl, sandboxTargetHeaders } from "../dist/e2b.js"

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
