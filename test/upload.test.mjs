import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { normalizeOptions } from "../dist/config.js"
import { uploadLocalSnapshot } from "../dist/upload.js"

test("uploadLocalSnapshot uploads project files and skips default ignores", async () => {
  const localRoot = await mkdtemp(path.join(tmpdir(), "opencode-e2b-upload-"))
  try {
    await mkdir(path.join(localRoot, "src"), { recursive: true })
    await mkdir(path.join(localRoot, "node_modules/pkg"), { recursive: true })
    await mkdir(path.join(localRoot, ".git"), { recursive: true })
    await writeFile(path.join(localRoot, "README.md"), "readme")
    await writeFile(path.join(localRoot, "src/index.ts"), "console.log('ok')")
    await writeFile(path.join(localRoot, "node_modules/pkg/index.js"), "ignored")
    await writeFile(path.join(localRoot, ".git/config"), "ignored")

    const sandbox = createFakeSandbox()
    await uploadLocalSnapshot({
      sandbox,
      localRoot,
      remoteRoot: "/home/user/project",
      upload: normalizeOptions().upload,
    })

    assert.deepEqual(
      sandbox.writes.map((entry) => entry.path).sort(),
      ["/home/user/project/README.md", "/home/user/project/src/index.ts"],
    )
    const readme = sandbox.writes.find((entry) => entry.path.endsWith("/README.md"))
    assert.equal(bufferText(readme.data), "readme")
    assert.match(sandbox.commandsRun[0], /mkdir -p/)
    assert.match(sandbox.commandsRun[0], /'\/home\/user\/project'/)
    assert.match(sandbox.commandsRun[0], /'\/home\/user\/project\/src'/)
  } finally {
    await rm(localRoot, { recursive: true, force: true })
  }
})

test("uploadLocalSnapshot refuses followed symlinks outside the workspace", async () => {
  const localRoot = await mkdtemp(path.join(tmpdir(), "opencode-e2b-upload-"))
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "opencode-e2b-outside-"))
  try {
    const outsideFile = path.join(outsideRoot, "secret.txt")
    await writeFile(outsideFile, "secret")
    await symlink(outsideFile, path.join(localRoot, "secret-link"))

    await assert.rejects(
      () =>
        uploadLocalSnapshot({
          sandbox: createFakeSandbox(),
          localRoot,
          remoteRoot: "/home/user/project",
          upload: {
            ...normalizeOptions().upload,
            followSymlinks: true,
          },
        }),
      /Refusing to follow symlink outside workspace root/,
    )
  } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  }
})

function createFakeSandbox() {
  const commandsRun = []
  const writes = []

  return {
    commandsRun,
    writes,
    commands: {
      run(command) {
        commandsRun.push(command)
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      },
    },
    files: {
      write(entries) {
        writes.push(...entries)
        return Promise.resolve()
      },
    },
  }
}

function bufferText(value) {
  return Buffer.from(new Uint8Array(value)).toString("utf8")
}
