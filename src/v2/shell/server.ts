/**
 * The plugin's end of the shim. OpenCode spawns the shim as its shell; the shim
 * connects to this unix socket and the runner runs the command in the sandbox.
 * See protocol.ts for the messages.
 */

import { rmSync } from "node:fs"
import net from "node:net"
import { type PluginMessage, type ShimMessage, encode, onMessages } from "./protocol.js"
import { type Runner, errorText } from "./runner.js"

export interface Server {
  socket: string
  close(): void
}

export function startServer(socket: string, runner: Runner): Promise<Server> {
  const server = net.createServer((conn) => {
    const killed = new AbortController()
    const send = (message: PluginMessage) => {
      conn.write(encode(message))
    }
    const output = {
      data(data: string) {
        send({ type: "out", data: Buffer.from(data).toString("base64") })
      },
      note(text: string) {
        output.data(`[e2b] ${text}\n`)
      },
    }
    let started = false
    onMessages<ShimMessage>(conn, (message) => {
      if (message.type === "kill") {
        killed.abort()
      } else if (!started) {
        started = true
        runner
          .run(message, output, killed.signal)
          .then(
            (code) => send({ type: "exit", code }),
            (err: unknown) => send({ type: "error", message: errorText(err) }),
          )
          .finally(() => conn.end())
      }
    })
    // The shim died, for example killed by OpenCode: stop the command too.
    conn.on("close", () => killed.abort())
    conn.on("error", () => killed.abort())
  })

  rmSync(socket, { force: true })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      resolve({
        socket,
        close() {
          server.close()
          rmSync(socket, { force: true })
        },
      })
    })
  })
}
