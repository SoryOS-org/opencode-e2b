/** OpenCode 2 serving inside a box, behind a password. */

import type { Sandbox } from "e2b"
import { sh } from "../sync/remote.js"

export const PORT = 4096
const HEALTH_TIMEOUT_MS = 90_000

/**
 * Make sure the box has OpenCode 2. The public opencode template gets it as `opencode2`;
 * until then it is installed next to OpenCode 1, the same way the template does it.
 */
export async function ensureOpencode(sandbox: Sandbox): Promise<void> {
  const present = (await sh(sandbox, "command -v opencode2 || true")).trim()
  if (present === "") {
    await sh(
      sandbox,
      "sudo npm install -g --prefix /opt/opencode2 @opencode/cli >/dev/null && sudo ln -sf /opt/opencode2/bin/opencode2 /usr/local/bin/opencode2",
    )
  }
}

/** Start `opencode2 serve` in `root` and wait until it answers. Resolves with the public URL. */
export async function startServer(
  sandbox: Sandbox,
  root: string,
  password: string,
  env: Record<string, string>,
): Promise<string> {
  await sandbox.commands.run(
    `opencode2 serve --hostname 0.0.0.0 --port ${PORT} >/tmp/opencode-e2b-box.log 2>&1`,
    {
      background: true,
      cwd: root,
      envs: { ...env, OPENCODE_SERVER_PASSWORD: password },
      timeoutMs: 0,
    },
  )
  const url = `https://${sandbox.getHost(PORT)}`
  await waitHealthy(url)
  return url
}

export async function waitHealthy(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/global/health`).catch(() => undefined)
    if (response?.ok) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `OpenCode in the box did not start within ${HEALTH_TIMEOUT_MS / 1000} s (log: /tmp/opencode-e2b-box.log)`,
  )
}
