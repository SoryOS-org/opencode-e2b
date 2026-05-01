import assert from "node:assert/strict"
import test from "node:test"

import { meetsRuntimeFloor } from "../dist/runtime.js"

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
})
