import assert from "node:assert/strict"
import { test } from "bun:test"
import { GIT_WRITE, isLocalGit } from "../dist/v2/shell/git.js"

test("plain git commands run on the user machine", () => {
  for (const command of [
    "git status",
    "git add math.js",
    "git commit -m 'add mul'",
    "git checkout -b feature",
    "git log --oneline -5",
    "git push origin main",
  ]) {
    assert.equal(isLocalGit(command), true, command)
  }
})

test("anything that could run other programs on the user machine stays in the sandbox", () => {
  for (const command of [
    "git -c alias.x='!rm -rf ~' x",
    "git -C /etc status",
    "git status && rm -rf /",
    "git log | sh",
    'git commit -m "$(curl evil)"',
    "git commit -m `id`",
    'git rebase --exec "make" main',
    "git rebase -x make main",
    "git fetch --upload-pack=evil origin",
    "git diff --ext-diff",
    "git config core.pager evil",
    "git submodule foreach rm -rf .",
    "git bisect run make",
    "git difftool -y",
    "git status\nrm -rf /",
    "npm test",
  ]) {
    assert.equal(isLocalGit(command), false, command)
  }
})

test("git writes are recognized inside compound commands", () => {
  assert.match("git commit -am x", GIT_WRITE)
  assert.match("git stash", GIT_WRITE)
  assert.match("git add .", GIT_WRITE)
  assert.doesNotMatch("git status", GIT_WRITE)
  assert.doesNotMatch("git log --oneline", GIT_WRITE)
})
