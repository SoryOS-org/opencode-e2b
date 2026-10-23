/** Tools for the agent: a preview link, reading sandbox-only files, and the status. */

import path from "node:path"
import type { PluginContext } from "./context.js"
import { readStatus } from "./status.js"

const READ_LIMIT = 50_000

export async function registerTools(plugin: PluginContext): Promise<void> {
  const { opencode, project, box } = plugin
  await opencode.tool.transform((tools) => {
    tools.add({
      name: "e2b_preview_url",
      description:
        "Get the public URL of a port served in the E2B sandbox. Use it after you start a server, so the user gets a link. The server must listen on 0.0.0.0.",
      options: { codemode: false },
      input: {
        type: "object",
        properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
        required: ["port"],
        additionalProperties: false,
      },
      async execute(input) {
        const { port } = input as { port: number }
        const sandbox = await box.get()
        return { content: `https://${sandbox.getHost(port)}` }
      },
    })

    tools.add({
      name: "e2b_read",
      description: `Read a text file from the E2B sandbox, for files that exist only there (build output, coverage, logs, node_modules). Relative paths are relative to the project. Returns at most ${READ_LIMIT} bytes from offset.`,
      options: { codemode: false },
      input: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 } },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input) {
        const { path: file, offset = 0 } = input as { path: string; offset?: number }
        const sandbox = await box.get()
        const bytes = await sandbox.files.read(path.resolve(project, file), { format: "bytes" })
        const slice = Buffer.from(bytes).subarray(offset, offset + READ_LIMIT)
        const rest = bytes.length - offset - slice.length
        return {
          content:
            rest > 0
              ? `${slice.toString()}\n\n[${rest} more bytes, read again with offset ${offset + slice.length}]`
              : slice.toString(),
        }
      },
    })

    tools.add({
      name: "e2b_status",
      description:
        "Show the E2B sandbox state: where commands run, the sandbox id, CPU, memory and disk use, network rules, and the last file sync.",
      options: { codemode: false },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: (await readStatus(plugin)).text }),
    })
  })
}
