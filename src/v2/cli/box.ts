/** opencode-e2b box <action> [name] */

import { parseArgs } from "node:util"
import { attachBox } from "../box/attach.js"
import { defaultBoxName, describeBoxes, findBox, killBox, listWithState, stopBox } from "../box/manage.js"
import { pullBox, pullSummary } from "../box/pull.js"
import { upBox } from "../box/up.js"
import type { E2BAccess } from "../sandbox/create.js"
import { gitRoot } from "../sync/files.js"
import { UsageError } from "./usage-error.js"

const ACTIONS = new Set(["up", "attach", "pull", "list", "stop", "kill"])

export async function boxCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      template: { type: "string", default: "opencode" },
      hours: { type: "string", default: "1" },
      domain: { type: "string" },
      attach: { type: "boolean", default: false },
    },
  })
  const [action, given, ...extra] = positionals
  if (action === undefined || !ACTIONS.has(action)) {
    throw new UsageError(action ? `unknown box action "${action}"` : "say what to do with the box")
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected arguments: ${extra.join(" ")}`)
  }
  const access: E2BAccess = {
    apiKey: process.env.E2B_API_KEY,
    domain: values.domain ?? process.env.E2B_DOMAIN,
  }

  if (action === "list") {
    console.log(describeBoxes(await listWithState(access)))
    return 0
  }

  const root = await gitRoot(process.cwd())
  if (action === "up") {
    if (!root) {
      throw new Error("a box starts from a git repository, and this folder is not in one")
    }
    const hours = Number(values.hours)
    if (!(hours > 0)) {
      throw new UsageError("--hours must be a positive number")
    }
    const record = await upBox({
      root,
      name: await defaultBoxName(root, given),
      template: values.template,
      lifetimeMs: hours * 3_600_000,
      access,
      progress: (step) => {
        console.error(`[e2b] ${step}`)
      },
    })
    console.error(`[e2b] box "${record.name}" is up`)
    if (values.attach) {
      return attachBox(record, recordAccess(record, access))
    }
    console.log(`Attach with: opencode-e2b box attach ${record.name}`)
    return 0
  }

  const record = await findBox(root, given)
  const boxAccess = recordAccess(record, access)
  if (action === "attach") {
    return attachBox(record, boxAccess)
  }
  if (action === "pull") {
    console.log(pullSummary(record.name, await pullBox(record, boxAccess)))
    return 0
  }
  if (action === "stop") {
    await stopBox(record, boxAccess)
    console.log(`Box "${record.name}" is paused. Attach wakes it.`)
    return 0
  }
  await killBox(record, boxAccess)
  console.log(`Box "${record.name}" is deleted.`)
  return 0
}

/** A box lives in the region it was started in. */
function recordAccess(record: { domain?: string }, access: E2BAccess): E2BAccess {
  return { ...access, domain: record.domain ?? access.domain }
}
