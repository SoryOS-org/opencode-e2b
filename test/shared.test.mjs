import assert from "node:assert/strict"
import test from "node:test"

import { errorMessage, shellSingleQuote } from "../dist/shared.js"

test("shellSingleQuote preserves values for POSIX shell embedding", () => {
  assert.equal(shellSingleQuote("simple"), "'simple'")
  assert.equal(shellSingleQuote("has space"), "'has space'")
  assert.equal(shellSingleQuote("can't"), "'can'\\''t'")
})

test("errorMessage handles common thrown value shapes", () => {
  assert.equal(errorMessage(new Error("boom")), "boom")
  assert.equal(errorMessage({ message: "sdk boom" }), "sdk boom")
  assert.equal(errorMessage("plain"), "plain")
})
