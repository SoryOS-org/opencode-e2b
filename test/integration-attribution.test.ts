import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "bun:test"

import { ConnectionConfig } from "e2b"

// Importing the module runs ConnectionConfig.setIntegration(...) at load time. This
// uses the real e2b module, so it checks the User-Agent the SDK actually sends.
import "../dist/core/e2b-sdk.js"

test("tags E2B requests with the plugin name and version for attribution", () => {
  const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const userAgent = new ConnectionConfig().headers?.["User-Agent"] ?? ""
  assert.ok(userAgent.split(/\s+/).includes(`${name}/${version}`), `User-Agent was: ${userAgent}`)
})
