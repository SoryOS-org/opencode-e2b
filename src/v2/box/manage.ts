/** Box actions shared by the CLI and the OpenCode slash commands. */

import { Sandbox } from "e2b"
import type { E2BAccess } from "../sandbox/create.js"
import { run } from "../sync/files.js"
import {
  type BoxRecord,
  type BoxState,
  boxName,
  boxState,
  listBoxes,
  readBox,
  removeBox,
} from "./registry.js"

/** `given`, or the current branch of `root`, as a box name. */
export async function defaultBoxName(root: string, given: string | undefined): Promise<string> {
  if (given) {
    return boxName(given)
  }
  const branch = await run("git", ["branch", "--show-current"], { cwd: root }).then(
    (out) => out.toString().trim(),
    () => "",
  )
  return boxName(branch || "main")
}

/**
 * The box to act on: the one named `given`, else the one named after the current branch,
 * else the only box of this project. Fails with a clear message otherwise.
 */
export async function findBox(root: string | undefined, given: string | undefined): Promise<BoxRecord> {
  if (given !== undefined || root === undefined) {
    const name = boxName(given ?? "")
    const record = await readBox(name)
    if (!record) {
      throw new Error(`no box named "${name}" on this machine. See the list with: opencode-e2b box list`)
    }
    return record
  }
  const byBranch = await readBox(await defaultBoxName(root, undefined))
  if (byBranch) {
    return byBranch
  }
  const mine = (await listBoxes()).filter((record) => record.root === root)
  if (mine.length === 1) {
    return mine[0]
  }
  throw new Error(
    mine.length === 0
      ? "this project has no box. Start one with: opencode-e2b box up"
      : `this project has several boxes, so name one: ${mine.map((record) => record.name).join(", ")}`,
  )
}

export async function listWithState(access: E2BAccess): Promise<{ record: BoxRecord; state: BoxState }[]> {
  const records = await listBoxes()
  return Promise.all(records.map(async (record) => ({ record, state: await boxState(record, access) })))
}

/** Pause a box. Its files, installed tools and the OpenCode session stay; attach wakes it. */
export async function stopBox(record: BoxRecord, access: E2BAccess): Promise<void> {
  await Sandbox.pause(record.sandboxId, access)
}

/** Delete a box and its record. Pull first: work that is only in the box is lost. */
export async function killBox(record: BoxRecord, access: E2BAccess): Promise<void> {
  await Sandbox.kill(record.sandboxId, access)
  await removeBox(record.name)
}

export function describeBoxes(boxes: { record: BoxRecord; state: BoxState }[]): string {
  if (boxes.length === 0) {
    return "No boxes yet. Start one with: opencode-e2b box up (or /e2b-box up in OpenCode)."
  }
  return boxes
    .map(
      ({ record, state }) =>
        `${record.name}  ${state}  ${record.root}  (started ${record.createdAt.slice(0, 16)})`,
    )
    .join("\n")
}
