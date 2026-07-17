import assert from "node:assert/strict"
import { test } from "bun:test"

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

// Note: pre-mirror WORKSPACES cannot be caught by the flag comparison —
// their persisted extra carries the same old flag set as their sandbox
// metadata, so compatibility passes. Reuse therefore re-runs the idempotent
// mirror commands instead (ensureMirroredLocalPath, covered in
// bootstrap.test.mjs).
