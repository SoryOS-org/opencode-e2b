/**
 * How the shim and the plugin talk: newline-delimited JSON over a unix socket.
 *
 *   shim -> plugin  {type: "run", command, cwd, env}, then maybe {type: "kill"}
 *   plugin -> shim  {type: "out", data: <base64>}..., then {type: "exit", code} or {type: "error", message}
 */

import type net from "node:net"
import * as z from "zod"

/** Environment variables the shell hook sets for the shim. */
export const ENV = {
  socket: "OPENCODE_E2B_SOCKET",
  /** OpenCode's own binary. It is Bun, which runs the shim. */
  runtime: "OPENCODE_E2B_RUNTIME",
  /** Comma-separated names of the variables to forward to the sandbox. */
  forward: "OPENCODE_E2B_ENV",
} as const

const RunRequestSchema = z.object({
  type: z.literal("run"),
  command: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
})

/** Messages from the shim to the plugin. */
export const ShimMessage = z.discriminatedUnion("type", [
  RunRequestSchema,
  z.object({ type: z.literal("kill") }),
])

/** Messages from the plugin to the shim. */
export const PluginMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("out"), data: z.string() }),
  z.object({ type: z.literal("exit"), code: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
])

export type RunRequest = z.infer<typeof RunRequestSchema>
export type ShimMessage = z.infer<typeof ShimMessage>
export type PluginMessage = z.infer<typeof PluginMessage>

export function encode(message: ShimMessage | PluginMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Calls `onMessage` for every complete line that arrives on `socket`, decoded with
 * `schema`. A line that is not a valid message goes to `onInvalid`.
 */
export function onMessages<Message>(
  socket: net.Socket,
  schema: z.ZodType<Message>,
  onMessage: (message: Message) => void,
  onInvalid: (line: string) => void,
): void {
  let buffered = ""
  socket.on("data", (chunk) => {
    buffered += chunk.toString()
    let newline = buffered.indexOf("\n")
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
      const decoded = decode(schema, line)
      if (decoded.success) {
        onMessage(decoded.data)
      } else {
        onInvalid(line)
      }
    }
  })
}

function decode<Message>(schema: z.ZodType<Message>, line: string) {
  try {
    return schema.safeParse(JSON.parse(line))
  } catch {
    return { success: false as const }
  }
}
