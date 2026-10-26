import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, test } from "bun:test"
import { PULL_REF, bundleScript } from "../dist/v2/box/pull.js"
import { boxName, listBoxes, readBox, removeBox, saveBox } from "../dist/v2/box/registry.js"

const temp = mkdtempSync(path.join(os.tmpdir(), "opencode-e2b-box-"))
afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim()

function repo(name: string): string {
  const dir = path.join(temp, name)
  execFileSync("git", ["init", "-q", "-b", "main", dir])
  writeFileSync(path.join(dir, "a.txt"), "one\n")
  git(dir, "add", "a.txt")
  git(dir, "commit", "-qm", "base")
  return dir
}

const runScript = (dir: string, base: string | undefined, bundle: string) =>
  execFileSync("bash", ["-c", bundleScript(dir, "task", base, bundle)])
    .toString()
    .trim()

test("box names are safe as file names and branches", () => {
  assert.equal(boxName("Feature/Login Page"), "feature-login-page")
  assert.equal(boxName("..hidden.."), "hidden")
  assert.equal(boxName("fix_1.2"), "fix_1.2")
})

test("pull bundles commits and uncommitted work, and leaves the agent's index alone", () => {
  const box = repo("box")
  const base = git(box, "rev-parse", "HEAD")
  writeFileSync(path.join(box, "a.txt"), "two\n")
  git(box, "commit", "-qam", "agent commit")
  writeFileSync(path.join(box, "a.txt"), "three\n")
  writeFileSync(path.join(box, "new.txt"), "untracked\n")
  const statusBefore = git(box, "status", "--porcelain")

  const bundle = path.join(temp, "work.bundle")
  assert.equal(runScript(box, base, bundle), bundle)
  assert.equal(git(box, "status", "--porcelain"), statusBefore)

  const home = repo("home")
  git(home, "fetch", "-q", bundle, `+${PULL_REF}:refs/heads/e2b/task`)
  assert.deepEqual(git(home, "log", "--format=%s", `${base}..e2b/task`).split("\n"), [
    "Work in progress from box task",
    "agent commit",
  ])
  assert.equal(git(home, "show", "e2b/task:a.txt"), "three")
  assert.equal(git(home, "show", "e2b/task:new.txt"), "untracked")
})

test("pull reports nothing new when the box has no work", () => {
  const box = repo("idle")
  const base = git(box, "rev-parse", "HEAD")
  assert.equal(runScript(box, base, path.join(temp, "idle.bundle")), "OPENCODE_E2B_NOTHING_NEW")
})

test("records are private to the user and round-trip", async () => {
  process.env.XDG_STATE_HOME = path.join(temp, "state")
  const record = {
    name: "task",
    sandboxId: "sbx",
    url: "https://4096-sbx.e2b.app",
    password: "secret",
    root: "/work/project",
    template: "opencode",
    createdAt: new Date().toISOString(),
  }
  await saveBox(record)
  assert.equal(statSync(path.join(temp, "state", "opencode-e2b", "boxes", "task.json")).mode & 0o777, 0o600)
  assert.deepEqual(await readBox("task"), record)
  assert.deepEqual(await listBoxes(), [record])
  await removeBox("task")
  assert.equal(await readBox("task"), undefined)
})
