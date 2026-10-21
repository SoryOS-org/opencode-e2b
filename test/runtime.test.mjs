import assert from "node:assert/strict"
import { test } from "bun:test"

import {
  assertWorkspaceCompatibility,
  clearLocalRuntimeVersionCacheForTest,
  meetsRuntimeFloor,
  resolveLocalRuntimeVersion,
} from "../dist/core/runtime.js"

test("meetsRuntimeFloor accepts versions equal to or newer than the floor", () => {
  assert.equal(meetsRuntimeFloor("1.14.20", "1.14.20"), true)
  assert.equal(meetsRuntimeFloor("1.14.21", "1.14.20"), true)
  assert.equal(meetsRuntimeFloor("1.15.0", "1.14.20"), true)
  assert.equal(meetsRuntimeFloor("2.0.0", "1.14.20"), true)
})

test("meetsRuntimeFloor rejects versions below the floor", () => {
  assert.equal(meetsRuntimeFloor("1.14.19", "1.14.20"), false)
  assert.equal(meetsRuntimeFloor("1.13.99", "1.14.20"), false)
  assert.equal(meetsRuntimeFloor("0.99.0", "1.14.20"), false)
})

test("meetsRuntimeFloor compares numeric semver triples and ignores suffixes", () => {
  assert.equal(meetsRuntimeFloor("1.14.20-beta.1", "1.14.20"), true)
  assert.equal(meetsRuntimeFloor("1.14.20+build.1", "1.14.20"), true)
  assert.equal(meetsRuntimeFloor("1.14.2", "1.14.10"), false)
})

test("meetsRuntimeFloor rejects non-semver prefixes", () => {
  assert.throws(() => meetsRuntimeFloor("v1.14.20", "1.14.20"), /numeric MAJOR\.MINOR\.PATCH/)
  assert.throws(() => meetsRuntimeFloor("1.14", "1.14.20"), /numeric MAJOR\.MINOR\.PATCH/)
  assert.throws(() => meetsRuntimeFloor("1.14.20dev", "1.14.20"), /numeric MAJOR\.MINOR\.PATCH/)
  assert.throws(() => meetsRuntimeFloor("1.14.20; touch /tmp/pwned", "1.14.20"), /valid SemVer/)
})

test("resolveLocalRuntimeVersion uses the injected OpenCode client transport", async () => {
  clearLocalRuntimeVersionCacheForTest()
  let requested
  const client = {
    _client: {
      async get(options) {
        requested = options
        return {
          data: {
            healthy: true,
            version: "1.18.23",
          },
        }
      },
    },
  }

  const version = await resolveLocalRuntimeVersion(new URL("http://127.0.0.1:1"), undefined, client)

  assert.equal(version, "1.18.23")
  assert.equal(requested.url, "/global/health")
  assert.ok(requested.signal instanceof AbortSignal)
})

test("assertWorkspaceCompatibility rejects mismatched runtime metadata", async () => {
  await assert.rejects(
    assertWorkspaceCompatibility({
      workspaceID: "workspace-123",
      localRuntimeVersion: "1.14.40",
      persistedCompatibility: compatibility("1.14.39"),
      sandboxCompatibility: compatibility("1.14.39"),
      sandbox: { sandboxId: "sandbox-runtime-local" },
      baseUrl: new URL("https://sandbox.example.com"),
    }),
    /local runtime is 1\.14\.40/,
  )

  await assert.rejects(
    assertWorkspaceCompatibility({
      workspaceID: "workspace-123",
      localRuntimeVersion: "1.14.39",
      persistedCompatibility: compatibility("1.14.39"),
      sandboxCompatibility: compatibility("1.14.38"),
      sandbox: { sandboxId: "sandbox-runtime-remote" },
      baseUrl: new URL("https://sandbox.example.com"),
    }),
    /sandbox runtime 1\.14\.38/,
  )
})

test("assertWorkspaceCompatibility rejects mismatched flags", async () => {
  await assert.rejects(
    assertWorkspaceCompatibility({
      workspaceID: "workspace-123",
      localRuntimeVersion: "1.14.39",
      persistedCompatibility: compatibility("1.14.39", ["sync:local-snapshot-upload"]),
      sandboxCompatibility: compatibility("1.14.39", ["repo:git-init"]),
      sandbox: { sandboxId: "sandbox-flags" },
      baseUrl: new URL("https://sandbox.example.com"),
    }),
    /sandbox flags do not match/,
  )
})

function compatibility(runtimeVersion, flags = []) {
  return {
    workspaceApiVersion: "1",
    runtimeVersion,
    flags,
  }
}
