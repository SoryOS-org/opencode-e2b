/**
 * Stands in for bash. opencode spawns it with `-c "<command>"`; it hands the
 * command to the plugin over a unix socket, streams the output, and exits with
 * the command's exit code. A TERM from opencode (timeout, cancel) stops the
 * command in the sandbox too.
 */

import net from "node:net"
import type { RunRequest, ServerMessage } from "./server.js"

const KILL_GRACE_MS = 5_000

const socket = process.env.OPENCODE_E2B_SOCKET
const flag = process.argv.indexOf("-c")
const command = flag >= 0 ? process.argv[flag + 1] : undefined

if (!socket || command === undefined) {
  process.stderr.write("opencode-e2b: this shim only runs commands for the opencode e2b plugin\n")
  process.exit(127)
}

// Only the variables the user listed in the plugin options go to the sandbox.
const env: Record<string, string> = {}
for (const name of (process.env.OPENCODE_E2B_ENV ?? "").split(",").filter(Boolean)) {
  const value = process.env[name]
  if (value !== undefined) {
    env[name] = value
  }
}

const conn = net.createConnection(socket)
let finished = false
const request: RunRequest = { type: "run", command, cwd: process.cwd(), env }
conn.write(`${JSON.stringify(request)}\n`)

let buffered = ""
conn.on("data", (chunk) => {
  buffered += chunk.toString()
  let nl = buffered.indexOf("\n")
  while (nl >= 0) {
    const msg = JSON.parse(buffered.slice(0, nl)) as ServerMessage
    buffered = buffered.slice(nl + 1)
    nl = buffered.indexOf("\n")
    if (msg.type === "out") {
      process.stdout.write(Buffer.from(msg.data, "base64"))
    } else if (msg.type === "exit") {
      finished = true
      process.exitCode = msg.code
    } else {
      finished = true
      process.stdout.write(`${msg.message}\n`)
      process.exitCode = 1
    }
  }
})

conn.on("close", () => {
  if (!finished) {
    process.stdout.write("opencode-e2b: lost the connection to opencode before the command finished\n")
    process.exitCode = 1
  }
})

conn.on("error", (err) => {
  process.stdout.write(`opencode-e2b: cannot reach the plugin (${err.message}). Restart opencode.\n`)
  process.exitCode = 1
})

const stop = () => {
  conn.write(`${JSON.stringify({ type: "kill" })}\n`)
  setTimeout(() => process.exit(143), KILL_GRACE_MS).unref()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.on("SIGHUP", stop)
