import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "bun:test"
import { diff, hostFiles, parseIndex, run } from "../dist/v2/sync.js"

test("parseIndex reads modes and hashes and skips submodules", () => {
  const out = ["100644 aaa 0\ta.txt", "100755 bbb 0\tbin/run", "160000 ccc 0\tvendor/lib", ""].join("\x00")
  assert.deepEqual(
    parseIndex(out),
    new Map([
      ["a.txt", "100644 aaa"],
      ["bin/run", "100755 bbb"],
    ]),
  )
})

test("diff finds changed, new and removed paths", () => {
  const base = new Map([
    ["same", "100644 1"],
    ["edited", "100644 2"],
    ["gone", "100644 3"],
  ])
  const next = new Map([
    ["same", "100644 1"],
    ["edited", "100644 9"],
    ["added", "100644 4"],
  ])
  assert.deepEqual(diff(base, next), { changed: ["edited", "added"], removed: ["gone"] })
})

test("a mode change alone counts as a change", () => {
  assert.deepEqual(diff(new Map([["x", "100644 1"]]), new Map([["x", "100755 1"]])), {
    changed: ["x"],
    removed: [],
  })
})

test("hostFiles lists tracked and untracked files, skips ignored ones, and leaves the real index alone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-e2b-test-"))
  try {
    await run("git", ["init", "-q"], { cwd: root })
    writeFileSync(path.join(root, ".gitignore"), "dist/\n.env\n")
    writeFileSync(path.join(root, "tracked.txt"), "one")
    await run("git", ["add", "."], { cwd: root })
    writeFileSync(path.join(root, "tracked.txt"), "edited, not staged")
    writeFileSync(path.join(root, "new.txt"), "untracked")
    writeFileSync(path.join(root, ".env"), "SECRET=1")
    rmSync(path.join(root, "dist"), { recursive: true, force: true })

    const files = await hostFiles(root)
    assert.deepEqual([...files.keys()].toSorted(), [".gitignore", "new.txt", "tracked.txt"])

    const staged = (await run("git", ["diff", "--cached", "--name-only"], { cwd: root })).toString().trim()
    assert.equal(staged, ".gitignore\ntracked.txt", "the real index must keep only what the user staged")
    const unstaged = (await run("git", ["diff", "--name-only"], { cwd: root })).toString().trim()
    assert.equal(unstaged, "tracked.txt", "the unstaged edit must stay unstaged")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
