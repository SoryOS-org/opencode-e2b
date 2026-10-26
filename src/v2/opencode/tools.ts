/** Tools for the agent: a preview link, reading sandbox-only files, and the status. */

import path from "node:path"
import * as z from "zod"
import type { PluginContext } from "./context.js"
import { readStatus } from "./status.js"

const READ_LIMIT = 50_000

export async function registerTools(plugin: PluginContext): Promise<void> {
  const { opencode, project, projectSandbox } = plugin
  await opencode.tool.transform((tools) => {
    tools.add({
      name: "e2b_preview_url",
      description:
        "Get the public URL of a port served in the E2B sandbox. Use it after you start a server, so the user gets a link. The server must listen on 0.0.0.0.",
      options: { codemode: false },
      input: z.object({ port: z.int().min(1).max(65535) }),
      async execute({ port }) {
        const sandbox = await projectSandbox.get()
        return { content: `https://${sandbox.getHost(port)}` }
      },
    })

    tools.add({
      name: "e2b_read",
      description: `Read a text file from the E2B sandbox, for files that exist only there (build output, coverage, logs, node_modules). Relative paths are relative to the project. Returns at most ${READ_LIMIT} bytes from offset.`,
      options: { codemode: false },
      input: z.object({ path: z.string().min(1), offset: z.int().min(0).default(0) }),
      async execute({ path: file, offset }) {
        const sandbox = await projectSandbox.get()
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
      input: z.object({}),
      execute: async () => ({ content: (await readStatus(plugin)).text }),
    })
  })
}
