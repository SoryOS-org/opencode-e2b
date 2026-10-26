/**
 * The boxes this machine started. Each box has a local record with its server URL and
 * password; the password never goes to E2B. Records live in the user's state directory,
 * one file per box, readable only by the user.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Sandbox, SandboxNotFoundError } from "e2b"
import * as z from "zod"
import type { E2BAccess } from "../sandbox/create.js"

const BoxRecord = z.object({
  name: z.string(),
  sandboxId: z.string(),
  url: z.string(),
  password: z.string(),
  /** The project folder: on this machine, and at the same path in the box. */
  root: z.string(),
  /** The commit the box started from. Pull sends only the work after it. */
  base: z.string().optional(),
  domain: z.string().optional(),
  template: z.string(),
  createdAt: z.string(),
})
export type BoxRecord = z.infer<typeof BoxRecord>

export type BoxState = "running" | "paused" | "gone"

function boxesDir(): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode-e2b", "boxes")
}

/** A box name that is safe as a file name, a git branch and E2B metadata. */
export function boxName(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
}

export async function saveBox(record: BoxRecord): Promise<void> {
  await mkdir(boxesDir(), { recursive: true, mode: 0o700 })
  await writeFile(path.join(boxesDir(), `${record.name}.json`), JSON.stringify(record, null, 2), {
    mode: 0o600,
  })
}

export async function readBox(name: string): Promise<BoxRecord | undefined> {
  const raw = await readFile(path.join(boxesDir(), `${name}.json`), "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        return undefined
      }
      throw err
    },
  )
  if (raw === undefined) {
    return undefined
  }
  const parsed = BoxRecord.safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data : undefined
}

export async function listBoxes(): Promise<BoxRecord[]> {
  const files = await readdir(boxesDir()).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return []
    }
    throw err
  })
  const records = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map((file) => readBox(file.slice(0, -".json".length))),
  )
  return records.filter((record) => record !== undefined)
}

export async function removeBox(name: string): Promise<void> {
  await rm(path.join(boxesDir(), `${name}.json`), { force: true })
}

export async function boxState(record: BoxRecord, access: E2BAccess): Promise<BoxState> {
  try {
    const info = await Sandbox.getInfo(record.sandboxId, access)
    return info.state === "paused" ? "paused" : "running"
  } catch (err) {
    if (err instanceof SandboxNotFoundError) {
      return "gone"
    }
    throw err
  }
}
