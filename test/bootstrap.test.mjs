import assert from "node:assert/strict"
import { test } from "bun:test"

import {
  bootstrapWorkspace,
  buildBootstrapCommand,
  ensureMirroredLocalPath,
  renderRuntimeEnvFile,
  waitForSyncReady,
} from "../dist/bootstrap.js"
import { normalizeOptions } from "../dist/config.js"
import { BOOTSTRAP_READY_MARKER } from "../dist/template.js"

test("renderRuntimeEnvFile exports defined values and skips undefined entries", () => {
  assert.equal(
    renderRuntimeEnvFile({
      OPENCODE_WORKSPACE_ID: "workspace-123",
      OPTIONAL: undefined,
    }),
    [
      "# Written by opencode-e2b bootstrap; sourced by the managed template systemd service.",
      "# Do not edit: regenerated on every workspace create.",
      "export OPENCODE_WORKSPACE_ID='workspace-123'",
      "",
    ].join("\n"),
  )
})

test("renderRuntimeEnvFile shell-quotes auth payloads", () => {
  assert.match(
    renderRuntimeEnvFile({
      OPENCODE_AUTH_CONTENT: `{"token":"can't"}`,
    }),
    /export OPENCODE_AUTH_CONTENT='\{"token":"can'\\''t"\}'/,
  )
})

test("renderRuntimeEnvFile skips names that are not shell identifiers", () => {
  assert.equal(
    renderRuntimeEnvFile({
      GOOD_NAME: "kept",
      "BAD-NAME": "skipped",
      "$(touch /tmp/pwned)": "skipped",
    }),
    [
      "# Written by opencode-e2b bootstrap; sourced by the managed template systemd service.",
      "# Do not edit: regenerated on every workspace create.",
      "export GOOD_NAME='kept'",
      "",
    ].join("\n"),
  )
})

test("buildBootstrapCommand combines prepare commands and git initialization", () => {
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "feature/test" },
    normalizeOptions({
      projectPath: "/home/user/project",
      bootstrap: {
        prepareCommands: ["npm install", "  ", "npm run build"],
      },
    }),
  )

  assert.equal(
    command,
    [
      "mkdir -p '/home/user/project'",
      "cd '/home/user/project'",
      "(npm install)",
      "(npm run build)",
      "if [ ! -d .git ]; then git init -b 'feature/test'; fi",
    ].join(" && "),
  )
})

test("buildBootstrapCommand mirrors the local directory path onto the remote project", () => {
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "main" },
    normalizeOptions({ projectPath: "/home/user/project" }),
    "/Users/johndoe/Documents/GitHub/acme-app",
  )

  // A warped session keeps its local directory; the remote must resolve it.
  // The path can be outside $HOME, so the mirror runs with sudo.
  assert.match(command, /sudo mkdir -p '\/Users\/johndoe\/Documents\/GitHub'/)
  assert.match(
    command,
    /sudo ln -sfn '\/home\/user\/project' '\/Users\/johndoe\/Documents\/GitHub\/acme-app'/,
  )
})

test("buildBootstrapCommand skips the mirror when local path equals the project path", () => {
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "main" },
    normalizeOptions({ projectPath: "/home/user/project" }),
    "/home/user/project",
  )

  assert.doesNotMatch(command, /ln -sfn/)
})

test("buildBootstrapCommand skips the mirror for a trailing-slash variant of the project path", () => {
  // Not string-equal to projectPath, but the same directory: a mirror here
  // would plant a self-referential symlink inside the repo before git init.
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "main" },
    normalizeOptions({ projectPath: "/home/user/project" }),
    "/home/user/project/",
  )

  assert.doesNotMatch(command, /ln -sfn/)
})

test("buildBootstrapCommand skips the mirror when the local path is an ancestor of the project path", () => {
  // `ln -sfn <project> <ancestor>` would try to replace the freshly uploaded
  // project directory and abort the provision ("Is a directory").
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "main" },
    normalizeOptions({ projectPath: "/home/user/project" }),
    "/home/user",
  )

  assert.doesNotMatch(command, /ln -sfn/)
})

test("buildBootstrapCommand skips the mirror when the local path is inside the project path", () => {
  const command = buildBootstrapCommand(
    { id: "workspace-123", projectID: "project-456", branch: "main" },
    normalizeOptions({ projectPath: "/home/user/project" }),
    "/home/user/project/packages/app",
  )

  assert.doesNotMatch(command, /ln -sfn/)
})

test("ensureMirroredLocalPath re-runs the idempotent mirror commands on a sandbox", async () => {
  const commandRuns = []
  const sandbox = {
    commands: {
      async run(command) {
        commandRuns.push(command)
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    },
  }

  await ensureMirroredLocalPath(sandbox, "/Users/dev/projects/demo", "/home/user/project")

  assert.equal(commandRuns.length, 1)
  assert.match(commandRuns[0], /sudo mkdir -p '\/Users\/dev\/projects'/)
  assert.match(commandRuns[0], /sudo ln -sfn '\/home\/user\/project' '\/Users\/dev\/projects\/demo'/)
})

test("ensureMirroredLocalPath skips equal paths silently and warns on nested paths", async () => {
  const warns = []
  const logger = {
    async info() {},
    async debug() {},
    async warn(message, extra) {
      warns.push([message, extra])
    },
    async error() {},
  }
  const sandbox = {
    commands: {
      async run() {
        throw new Error("must not run any command")
      },
    },
  }

  // Same directory: nothing to mirror, nothing to warn about.
  await ensureMirroredLocalPath(sandbox, "/home/user/project", "/home/user/project", logger)
  assert.equal(warns.length, 0)

  // Nested local path: deliberately unmirrorable — must say so.
  await ensureMirroredLocalPath(sandbox, "/home/user", "/home/user/project", logger)
  assert.equal(warns.length, 1)
  assert.equal(warns[0][0], "local path mirror skipped")
  assert.deepEqual(warns[0][1], { localDirectory: "/home/user", projectPath: "/home/user/project" })
})

test("bootstrapWorkspace releases the systemd opencode service with a marker", async () => {
  const originalFetch = globalThis.fetch
  const commandRuns = []
  const writes = []

  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(url.toString()).pathname
    if (pathname === "/global/health") {
      return Response.json({ healthy: true, version: "1.2.3" })
    }
    if (pathname === "/global/event") {
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (pathname === "/sync/history") {
      assert.equal(init.method, "POST")
      return Response.json([])
    }

    return new Response("unexpected", { status: 500 })
  }

  const sandbox = {
    trafficAccessToken: "token",
    getHost(port) {
      return `sandbox-host-${port}.example.com`
    },
    files: {
      async write(path, content) {
        writes.push([path, content])
      },
      async exists() {
        return false
      },
    },
    commands: {
      async run(command, options = {}) {
        commandRuns.push([command, options])
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    },
  }

  try {
    await bootstrapWorkspace({
      sandbox,
      info: { id: "workspace-123", projectID: "project-456", branch: "main" },
      config: normalizeOptions({ projectPath: "/home/user/project", serverPort: 4096 }),
      env: { OPENCODE_WORKSPACE_ID: "workspace-123" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(commandRuns.length, 1)
  assert.match(commandRuns[0][0], /mkdir -p '\/home\/user\/project'/)
  assert.match(commandRuns[0][0], /git init -b 'main'/)
  assert.equal(commandRuns[0][1].cwd, undefined)
  assert.ok(commandRuns.every(([command]) => !command.includes("opencode serve")))
  assert.deepEqual(
    writes.map(([path]) => path),
    ["/home/user/project/.git/opencode", "/tmp/.opencode-e2b.env", BOOTSTRAP_READY_MARKER],
  )
})

test("waitForSyncReady verifies and closes persistent sync endpoints", async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let eventStreamCancelled = false

  globalThis.fetch = async (url, init) => {
    calls.push({ url: url.toString(), init })
    if (url.toString().endsWith("/global/event")) {
      const stream = new ReadableStream({
        cancel() {
          eventStreamCancelled = true
        },
      })
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
        },
      })
    }

    if (url.toString().endsWith("/sync/history")) {
      assert.equal(init.method, "POST")
      assert.equal(init.body, "{}")
      return Response.json([])
    }

    return new Response("unexpected", { status: 500 })
  }

  try {
    await waitForSyncReady(createSandbox(), normalizeOptions())
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/global/event", "/sync/history"],
  )
  assert.equal(calls[0].init.headers.accept, "text/event-stream")
  assert.equal(calls[1].init.headers["content-type"], "application/json")
  assert.equal(eventStreamCancelled, true)
})

test("waitForSyncReady fails when sync endpoints never become reachable", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("not ready", { status: 503 })

  try {
    await assert.rejects(
      waitForSyncReady(
        createSandbox(),
        normalizeOptions({
          bootstrap: {
            waitForTimeoutMs: 1,
          },
        }),
      ),
      /Timed out waiting for OpenCode sync endpoints/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

function createSandbox() {
  return {
    trafficAccessToken: "token",
    getHost(port) {
      return `sandbox-host-${port}.example.com`
    },
    files: {
      async exists() {
        return false
      },
    },
  }
}
