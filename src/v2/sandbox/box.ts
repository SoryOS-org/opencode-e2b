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

import { Sandbox, type SandboxMetrics, type SandboxNetworkOpts, SandboxNotFoundError } from "e2b"
import type { Plugin } from "@opencode/plugin"
import { init } from "../sync/remote.js"

export interface BoxOptions {
  apiKey?: string
  /** E2B region domain, for example e2b-juliett.dev for the EU. Defaults to E2B_DOMAIN or e2b.app. */
  domain?: string
  template: string
  /** Idle time before E2B pauses the sandbox. Every command restarts it. */
  idleMs: number
  /** Egress rules: allow and deny lists, and per-host request transforms that inject stored secrets. */
  network?: SandboxNetworkOpts
}

type Storage = Plugin.Context["storage"]

interface CachedBox {
  sandboxId: string
  template: string
}

interface SavedSnapshot {
  snapshotId: string
  template: string
  at: string
}

export interface Box {
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

export function createBox(storage: Storage, root: string, key: string, opts: BoxOptions): Box {
  const region = opts.domain ?? process.env.E2B_DOMAIN ?? "e2b.app"
  const cacheKey = `box:${region}:${key}`
  const snapshotKey = `snapshot:${region}:${key}`
  const api = { apiKey: opts.apiKey, domain: opts.domain }
  const metadata = { app: "opencode-e2b", project: key, template: opts.template }
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
    const cached = (await storage.get(cacheKey)) as CachedBox | undefined
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
    // Oldest first, so two opencode processes that raced to create one converge on the same sandbox.
    const oldest = listed.toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0]
    return oldest ? connect(oldest.sandboxId) : undefined
  }

  async function create(): Promise<Sandbox> {
    const create = (from: string) =>
      Sandbox.create(from, {
        ...api,
        metadata,
        timeoutMs: opts.idleMs,
        lifecycle: { onTimeout: "pause", autoResume: true },
        network: opts.network,
      })
    const saved = (await storage.get(snapshotKey)) as SavedSnapshot | undefined
    if (saved?.template === opts.template) {
      try {
        return await create(saved.snapshotId)
      } catch (err) {
        // A deleted snapshot falls back to the template. Anything else is a real error.
        if (!(err instanceof SandboxNotFoundError) && !/not found/i.test(String(err))) {
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
    await storage.set(cacheKey, { sandboxId: sandbox.sandboxId, template: opts.template } satisfies CachedBox)
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
      current?.setTimeout(opts.idleMs).catch(() => {
        // A sandbox that is gone is found or created again on the next command.
        current = undefined
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
      await storage.set(snapshotKey, saved as never)
      return saved
    },
    async clearSnapshot() {
      const saved = (await storage.get(snapshotKey)) as SavedSnapshot | undefined
      await storage.remove(snapshotKey)
      if (saved) {
        await Sandbox.deleteSnapshot(saved.snapshotId, api).catch(() => false)
      }
      return saved !== undefined
    },
    savedSnapshot: async () => (await storage.get(snapshotKey)) as SavedSnapshot | undefined,
    async metrics() {
      if (!current) {
        return undefined
      }
      const all = await Sandbox.getMetrics(current.sandboxId, api).catch(() => [])
      return all.at(-1)
    },
  }
}
