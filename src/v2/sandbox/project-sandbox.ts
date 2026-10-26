/**
 * One E2B sandbox per project, found again across opencode restarts.
 *
 * E2B metadata is the source of truth: every sandbox carries the project key and
 * template, so it can always be found by listing. opencode's plugin storage only
 * caches the id, which saves the list call on the hot path.
 *
 * Sandboxes pause when idle instead of being killed, so installed dependencies
 * and build caches survive until the next command. A saved snapshot of the
 * project's sandbox, if any, is the starting point for new ones.
 */

import { NotFoundError, Sandbox, type SandboxMetrics, SandboxNotFoundError } from "e2b"
import * as z from "zod"
import type { Plugin } from "@opencode/plugin"
import { init } from "../sync/remote.js"
import { type Network, createSandbox } from "./create.js"

export interface ProjectSandboxOptions {
  apiKey?: string
  /** E2B region domain, for example e2b-juliett.dev for the EU. Defaults to E2B_DOMAIN or e2b.app. */
  domain?: string
  template: string
  /** Idle time before E2B pauses the sandbox. Every command restarts it. */
  idleMs: number
  /** Egress rules: allow and deny lists, and per-host request transforms that inject stored secrets. */
  network?: Network
}

type Storage = Plugin.Context["storage"]

const CachedBox = z.object({ sandboxId: z.string(), template: z.string() })

const SavedSnapshot = z.object({ snapshotId: z.string(), template: z.string(), at: z.string() })
export type SavedSnapshot = z.infer<typeof SavedSnapshot>

export interface ProjectSandbox {
  /** The sandbox, created on first use. `onCreate` runs before a new sandbox starts. */
  get(onCreate?: () => void): Promise<Sandbox>
  /** The sandbox if one is connected now. Never creates one. */
  peek(): Sandbox | undefined
  keepAlive(): void
  /** Drop the connected sandbox, for example after E2B reports it gone. The next get() finds or creates one. */
  forget(): void
  kill(): Promise<boolean>
  /** Save the sandbox as the starting point for this project's new sandboxes. */
  snapshot(): Promise<SavedSnapshot>
  clearSnapshot(): Promise<boolean>
  savedSnapshot(): Promise<SavedSnapshot | undefined>
  metrics(): Promise<SandboxMetrics | undefined>
}

export function createProjectSandbox(
  storage: Storage,
  root: string,
  key: string,
  opts: ProjectSandboxOptions,
): ProjectSandbox {
  const region = opts.domain ?? process.env.E2B_DOMAIN ?? "e2b.app"
  const cacheKey = `projectSandbox:${region}:${key}`
  const snapshotKey = `snapshot:${region}:${key}`
  const api = { apiKey: opts.apiKey, domain: opts.domain }
  const metadata = { app: "opencode-e2b", project: key, template: opts.template }
  /** A stored record, or undefined when it is missing or from an older plugin version. */
  const read = async <T>(storageKey: string, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await storage.get(storageKey))
    return parsed.success ? parsed.data : undefined
  }
  let current: Sandbox | undefined
  let pending: Promise<Sandbox> | undefined

  async function connect(sandboxId: string): Promise<Sandbox | undefined> {
    try {
      // connect() resumes a paused sandbox.
      return await Sandbox.connect(sandboxId, { ...api, timeoutMs: opts.idleMs })
    } catch (err) {
      if (err instanceof SandboxNotFoundError) {
        return undefined
      }
      throw err
    }
  }

  async function find(): Promise<Sandbox | undefined> {
    const cached = await read(cacheKey, CachedBox)
    if (cached?.template === opts.template) {
      const sandbox = await connect(cached.sandboxId)
      if (sandbox) {
        return sandbox
      }
    }
    const listed = await Sandbox.list({
      ...api,
      query: { metadata, state: ["running", "paused"] },
    }).nextItems()
    // Without a cached id, take the oldest: if two OpenCode processes raced to create
    // a sandbox for the project, both then pick the same one.
    const oldest = listed.toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0]
    return oldest ? connect(oldest.sandboxId) : undefined
  }

  async function create(): Promise<Sandbox> {
    const create = (from: string) =>
      createSandbox(from, api, { metadata, idleMs: opts.idleMs, network: opts.network })
    const saved = await read(snapshotKey, SavedSnapshot)
    if (saved?.template === opts.template) {
      try {
        return await create(saved.snapshotId)
      } catch (err) {
        // A deleted snapshot falls back to the template. Anything else is a real error.
        if (!(err instanceof NotFoundError || err instanceof SandboxNotFoundError)) {
          throw err
        }
        await storage.remove(snapshotKey)
      }
    }
    return create(opts.template)
  }

  async function open(onCreate?: () => void): Promise<Sandbox> {
    let sandbox = await find()
    if (sandbox) {
      // The network config may have changed since the sandbox was created. Empty
      // lists and rules reset what an earlier config set.
      await sandbox.updateNetwork({
        allowOut: opts.network?.allowOut ?? [],
        denyOut: opts.network?.denyOut ?? [],
        rules: opts.network?.rules ?? {},
      })
    } else {
      onCreate?.()
      sandbox = await create()
    }
    // Idempotent, so a sandbox whose first setup failed is repaired here.
    await init(sandbox, root)
    await storage.set(cacheKey, { sandboxId: sandbox.sandboxId, template: opts.template } satisfies z.infer<
      typeof CachedBox
    >)
    return sandbox
  }

  return {
    async get(onCreate) {
      if (current) {
        return current
      }
      pending ??= open(onCreate).finally(() => {
        pending = undefined
      })
      current = await pending
      return current
    },
    peek: () => current,
    keepAlive() {
      current?.setTimeout(opts.idleMs).catch((err) => {
        // A sandbox that is gone is found or created again on the next command. Any
        // other failure (a network blip) keeps it: the next heartbeat tries again.
        if (err instanceof SandboxNotFoundError) {
          current = undefined
        }
      })
    },
    forget() {
      current = undefined
    },
    async kill() {
      const sandbox = current ?? (await find())
      current = undefined
      await storage.remove(cacheKey)
      return sandbox ? Sandbox.kill(sandbox.sandboxId, api) : false
    },
    async snapshot() {
      const sandbox = current ?? (await this.get())
      // The same name every time, so a new snapshot replaces the project's previous one.
      const info = await sandbox.createSnapshot({ name: `opencode-e2b-${key}` })
      const saved: SavedSnapshot = {
        snapshotId: info.snapshotId,
        template: opts.template,
        at: new Date().toISOString(),
      }
      await storage.set(snapshotKey, saved)
      return saved
    },
    async clearSnapshot() {
      const saved = await read(snapshotKey, SavedSnapshot)
      if (saved) {
        // Delete first: if that fails, the record stays, so clearing again retries it.
        // deleteSnapshot resolves false when the snapshot is already gone.
        await Sandbox.deleteSnapshot(saved.snapshotId, api)
      }
      await storage.remove(snapshotKey)
      return saved !== undefined
    },
    savedSnapshot: () => read(snapshotKey, SavedSnapshot),
    async metrics() {
      if (!current) {
        return undefined
      }
      // Status must still answer when E2B has no metrics for the sandbox yet.
      const all = await Sandbox.getMetrics(current.sandboxId, api).catch(() => [])
      return all.at(-1)
    },
  }
}
