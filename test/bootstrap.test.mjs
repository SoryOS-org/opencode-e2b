import assert from "node:assert/strict"
import test from "node:test"

import { renderRuntimeEnvFile } from "../dist/bootstrap.js"

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
