import assert from "node:assert/strict"
import test from "node:test"

import { assertE2BApiKeyAvailable } from "../dist/credentials.js"

test("assertE2BApiKeyAvailable accepts a non-empty E2B key", () => {
  assert.doesNotThrow(() => assertE2BApiKeyAvailable({ E2B_API_KEY: "key" }))
})

test("assertE2BApiKeyAvailable rejects missing or blank E2B keys", () => {
  assert.throws(() => assertE2BApiKeyAvailable({}), /E2B_API_KEY is not set/)
  assert.throws(() => assertE2BApiKeyAvailable({ E2B_API_KEY: "   " }), /E2B_API_KEY is not set/)
})
