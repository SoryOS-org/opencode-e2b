import assert from "node:assert/strict"
import { test } from "bun:test"

import { normalizeOptions } from "../dist/config.js"
import { assertWorkspaceCompatibility } from "../dist/runtime.js"
import { planExistingSandbox } from "../dist/workspace-create.js"

test("planExistingSandbox creates a sandbox when no existing sandbox was found", () => {
  assert.deepEqual(planExistingSandbox({}), {
    action: "create",
  })
})

test("planExistingSandbox reuses a compatible existing sandbox", () => {
  assert.deepEqual(planExistingSandbox({ existingSandboxId: "sandbox-123" }), {
    action: "reuse",
    sandboxId: "sandbox-123",
  })
})

test("planExistingSandbox replaces an incompatible existing sandbox", () => {
  const reason = new Error("runtime mismatch")

  assert.deepEqual(
    planExistingSandbox({
      existingSandboxId: "sandbox-123",
      compatibilityError: reason,
    }),
    {
      action: "replace",
      sandboxId: "sandbox-123",
      reason,
    },
  )
})

test("a sandbox missing the fs:mirror-local-path flag is planned as replace, not reuse", async () => {
  // The current plugin expects the mirror flag; configure() refreshes the persisted
  // workspace extra to this set. A sandbox provisioned before the mirror change still
  // carries the old flags in its metadata, so it must be replaced (its reuse path never
  // re-runs bootstrap, so it would otherwise be missing the local-path mirror).
  const expectedFlags = normalizeOptions().flags
  assert.ok(expectedFlags.includes("fs:mirror-local-path"))

  const staleFlags = expectedFlags.filter((flag) => flag !== "fs:mirror-local-path")

  let compatibilityError
  try {
    await assertWorkspaceCompatibility({
      workspaceID: "workspace-mirror",
      localRuntimeVersion: "1.16.0",
      persistedCompatibility: {
        workspaceApiVersion: "1",
        runtimeVersion: "1.16.0",
        flags: expectedFlags,
      },
      sandboxCompatibility: {
        workspaceApiVersion: "1",
        runtimeVersion: "1.16.0",
        flags: staleFlags,
      },
      sandbox: { sandboxId: "sandbox-stale-mirror" },
      baseUrl: new URL("https://sandbox.example.com"),
    })
  } catch (error) {
    compatibilityError = error
  }

  assert.ok(compatibilityError, "expected the stale sandbox to be flagged incompatible")
  assert.match(compatibilityError.message, /sandbox flags do not match/)

  assert.deepEqual(
    planExistingSandbox({
      existingSandboxId: "sandbox-stale-mirror",
      compatibilityError,
    }),
    {
      action: "replace",
      sandboxId: "sandbox-stale-mirror",
      reason: compatibilityError,
    },
  )
})
