import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "bun:test"

import plugin from "../dist/index.js"
import rootEntry from "../index.js"

test("one default export serves OpenCode 1 (server) and OpenCode 2 (id, setup)", () => {
  assert.equal(plugin.id, "e2b")
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof plugin.setup, "function")
})

test("the package root re-exports the same plugin, for OpenCode 2 loading a folder", () => {
  assert.equal(rootEntry, plugin)
})

test("both export paths resolve to the same file", () => {
  const require = createRequire(import.meta.url)
  const pkg = require("../package.json")
  assert.deepEqual(pkg.exports["."], pkg.exports["./server"])
})
