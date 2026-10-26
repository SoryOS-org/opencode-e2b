import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, test } from "bun:test"

const state = mkdtempSync(path.join(os.tmpdir(), "opencode-e2b-cli-"))
afterAll(() => {
  rmSync(state, { recursive: true, force: true })
})

const cli = (...args: string[]) => {
  const result = spawnSync("node", [path.resolve("dist/v2/cli/main.js"), ...args], {
    env: { ...process.env, XDG_STATE_HOME: state, ANTHROPIC_API_KEY: "" },
    input: "",
  })
  return { code: result.status, out: result.stdout.toString(), err: result.stderr.toString() }
}

test("help prints the usage", () => {
  const { code, out } = cli()
  assert.equal(code, 0)
  assert.match(out, /opencode-e2b box up/)
})

test("mistakes exit 2 with the usage", () => {
  for (const args of [["nope"], ["box", "dance", "x"], ["secrets", "set", "acme"], ["box", "up", "a", "b"]]) {
    const { code, err } = cli(...args)
    assert.equal(code, 2, args.join(" "))
    assert.match(err, /Usage:/)
  }
})

test("an empty key is refused before E2B is called", () => {
  const { code, err } = cli("secrets", "set", "anthropic")
  assert.equal(code, 2)
  assert.match(err, /empty/)
})

test("box list works without any boxes", () => {
  const { code, out } = cli("box", "list")
  assert.equal(code, 0)
  assert.match(out, /No boxes yet/)
})
