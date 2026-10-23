/**
 * How the shim and the plugin talk: newline-delimited JSON over a unix socket.
 *
 *   shim -> plugin  {type: "run", command, cwd, env}, then maybe {type: "kill"}
 *   plugin -> shim  {type: "out", data: <base64>}..., then {type: "exit", code} or {type: "error", message}
 */

import type net from "node:net"

/** Environment variables the shell hook sets for the shim. */
export const ENV = {
  socket: "OPENCODE_E2B_SOCKET",
  /** OpenCode's own binary. It is Bun, which runs the shim. */
  runtime: "OPENCODE_E2B_RUNTIME",
  /** Comma-separated names of the variables to forward to the sandbox. */
  forward: "OPENCODE_E2B_ENV",
} as const

export interface RunRequest {
  type: "run"
  command: string
  cwd: string
  env: Record<string, string>
}

export type ShimMessage = RunRequest | { type: "kill" }

export type PluginMessage =
  | { type: "out"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }

export function encode(message: ShimMessage | PluginMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** Calls `onMessage` for every complete line that arrives on `socket`. */
export function onMessages<T extends ShimMessage | PluginMessage>(
  socket: net.Socket,
  onMessage: (message: T) => void,
): void {
  let buffered = ""
  socket.on("data", (chunk) => {
    buffered += chunk.toString()
    let newline = buffered.indexOf("\n")
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
      onMessage(JSON.parse(line) as T)
    }
  })
}
