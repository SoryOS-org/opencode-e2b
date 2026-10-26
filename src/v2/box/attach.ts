/** Open this machine's OpenCode TUI on a box. */

import { spawn } from "node:child_process"
import { Sandbox } from "e2b"
import type { E2BAccess } from "../sandbox/create.js"
import { run } from "../sync/files.js"
import type { BoxRecord } from "./registry.js"
import { waitHealthy } from "./server.js"

/**
 * Wake the box first: traffic alone wakes a paused box, but the request that woke it
 * hangs. Then run the local TUI against the box's server. Resolves with its exit code.
 */
export async function attachBox(record: BoxRecord, access: E2BAccess): Promise<number> {
  await Sandbox.connect(record.sandboxId, access)
  await waitHealthy(record.url)
  const opencode = await localOpencode2()
  return new Promise((resolve, reject) => {
    const child = spawn(opencode, ["--server", record.url], {
      cwd: record.root,
      stdio: "inherit",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: record.password },
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      resolve(code ?? 0)
    })
  })
}

/** `opencode2` if installed, else `opencode` when it is OpenCode 2. */
async function localOpencode2(): Promise<string> {
  for (const bin of ["opencode2", "opencode"]) {
    const version = await run(bin, ["--version"], { cwd: process.cwd() }).then(
      (out) => out.toString(),
      () => "",
    )
    if (/\bv?2\.\d+/.test(version)) {
      return bin
    }
  }
  throw new Error("OpenCode 2 is not installed here. Install it with: npm install -g @opencode/cli")
}
