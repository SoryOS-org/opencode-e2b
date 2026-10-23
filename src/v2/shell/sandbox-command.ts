/** Running one shell command in the sandbox, through the sync wrapper, with cancel support. */

import { CommandExitError, type Sandbox } from "e2b"
import { WRAPPER } from "../sync/remote.js"
import type { RunRequest } from "./protocol.js"

/**
 * Run one command in the sandbox through the wrapper, streaming its output. Resolves
 * with the exit code and the wrapper's own stderr, which carries the sync report.
 */
export async function runCommand(
  sandbox: Sandbox,
  root: string,
  request: RunRequest,
  onData: (data: string) => void,
  killed: AbortSignal,
  keepAlive: () => void,
): Promise<{ code: number; stderr: string }> {
  let stderr = ""
  const handle = await sandbox.commands.run(WRAPPER, {
    background: true,
    cwd: request.cwd,
    // The host env is not forwarded: it holds model API keys and other secrets.
    envs: {
      ...request.env,
      OPENCODE_E2B_ROOT: root,
      OPENCODE_E2B_COMMAND: request.command,
      OPENCODE_E2B_MODE: "run",
    },
    timeoutMs: 0,
    onStdout: onData,
    onStderr: (data) => {
      stderr += data
    },
  })
  // Kill the command's process group only. The wrapper then finishes its sync step
  // and exits, so a cancel never leaves the bookkeeping half-written.
  const stop = () => {
    const group = `$(cat /tmp/opencode-e2b-${handle.pid}.pgid 2>/dev/null)`
    sandbox.commands
      .run(
        `g=${group}; [ -n "$g" ] && { kill -TERM -- -$g; sleep 1; kill -KILL -- -$g; } 2>/dev/null; true`,
        {
          timeoutMs: 10_000,
        },
      )
      .catch(() => handle.kill())
  }
  killed.addEventListener("abort", stop, { once: true })
  // Long commands must not hit the idle timeout.
  const heartbeat = setInterval(keepAlive, 60_000)
  try {
    return { code: (await handle.wait()).exitCode, stderr }
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { code: err.exitCode, stderr }
    }
    throw err
  } finally {
    clearInterval(heartbeat)
    killed.removeEventListener("abort", stop)
  }
}
