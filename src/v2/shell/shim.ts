/**
 * Stands in for bash. OpenCode spawns it with `-c "<command>"`; it hands the command to
 * the plugin over a unix socket, streams the output, and exits with the command's exit
 * code. A TERM from OpenCode (timeout, cancel) stops the command in the sandbox too.
 */

import net from "node:net"
import { ENV, type PluginMessage, type ShimMessage, encode, onMessages } from "./protocol.js"

const KILL_GRACE_MS = 5_000

const socket = process.env[ENV.socket]
const flag = process.argv.indexOf("-c")
const command = flag >= 0 ? process.argv[flag + 1] : undefined

if (!socket || command === undefined) {
  process.stderr.write("opencode-e2b: this shim only runs commands for the OpenCode e2b plugin\n")
  process.exit(127)
}

// Only the variables the user listed in the plugin options go to the sandbox.
const env: Record<string, string> = {}
for (const name of (process.env[ENV.forward] ?? "").split(",").filter(Boolean)) {
  const value = process.env[name]
  if (value !== undefined) {
    env[name] = value
  }
}

const conn = net.createConnection(socket)
const send = (message: ShimMessage) => {
  conn.write(encode(message))
}
let finished = false
send({ type: "run", command, cwd: process.cwd(), env })

onMessages<PluginMessage>(conn, (message) => {
  if (message.type === "out") {
    process.stdout.write(Buffer.from(message.data, "base64"))
  } else if (message.type === "exit") {
    finished = true
    process.exitCode = message.code
  } else {
    finished = true
    process.stdout.write(`${message.message}\n`)
    process.exitCode = 1
  }
})

conn.on("close", () => {
  if (!finished) {
    process.stdout.write("opencode-e2b: lost the connection to OpenCode before the command finished\n")
    process.exitCode = 1
  }
})

conn.on("error", (err) => {
  process.stdout.write(`opencode-e2b: cannot reach the plugin (${err.message}). Restart OpenCode.\n`)
  process.exitCode = 1
})

const stop = () => {
  send({ type: "kill" })
  setTimeout(() => process.exit(143), KILL_GRACE_MS).unref()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.on("SIGHUP", stop)
