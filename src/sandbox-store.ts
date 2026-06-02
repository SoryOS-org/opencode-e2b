import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "bun:sqlite"

import { errorMessage } from "./shared.js"
import type { PluginLogger } from "./types.js"

const STORE_SCHEMA_VERSION = 1
const PROVISIONING_LOCK_STALE_MS = 5 * 60 * 1000

export type CachedSandboxStatus = "provisioning" | "ready" | "failed"

export type CachedSandbox = {
  workspaceID: string
  sandboxID: string
  metadata: Record<string, string>
  status: CachedSandboxStatus
  updatedAtMs: number
  verifiedAtMs?: number
}

export type CachedSandboxInput = {
  workspaceID: string
  sandboxID: string
  metadata: Record<string, string>
}

export type SandboxStore = {
  get(workspaceID: string): Promise<CachedSandbox | undefined>
  claimProvisioning(input: CachedSandboxInput): Promise<boolean>
  upsertProvisioning(input: CachedSandboxInput): Promise<void>
  markReady(input: CachedSandboxInput): Promise<void>
  markFailed(workspaceID: string, sandboxID: string): Promise<void>
  delete(workspaceID: string, sandboxID?: string): Promise<void>
  close(): void
}

type WorkspaceSandboxRow = {
  workspace_id: string
  sandbox_id: string
  metadata_json: string
  status: CachedSandboxStatus
  updated_at_ms: number
  verified_at_ms: number | null
}

let loggedStorePathWarning = false

export async function createSandboxStore(logger?: PluginLogger): Promise<SandboxStore> {
  const dbPath = resolveSandboxStorePath()
  if (!dbPath) {
    if (!loggedStorePathWarning) {
      loggedStorePathWarning = true
      await logger?.warn("sandbox cache disabled; unable to resolve cache directory")
    }
    return createNoopSandboxStore()
  }

  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath, { create: true })
    try {
      initializeDatabase(db)
    } catch (error) {
      db.close()
      throw error
    }
    await logger?.info("sandbox cache enabled", { path: dbPath })
    return new SQLiteSandboxStore(db)
  } catch (error) {
    await logger?.warn("sandbox cache disabled; failed to initialize sqlite store", {
      path: dbPath,
      error: errorMessage(error),
    })
    return createNoopSandboxStore()
  }
}

export function resolveSandboxStorePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdgCacheHome = env.XDG_CACHE_HOME
  const cacheRoot =
    xdgCacheHome && path.isAbsolute(xdgCacheHome) ? xdgCacheHome : path.join(os.homedir(), ".cache")
  if (!cacheRoot || !path.isAbsolute(cacheRoot)) return undefined
  return path.join(cacheRoot, "opencode", "e2b-workspace", "sandboxes.sqlite")
}

export function createNoopSandboxStore(): SandboxStore {
  return {
    async get() {
      return undefined
    },
    async claimProvisioning() {
      return true
    },
    async upsertProvisioning() {},
    async markReady() {},
    async markFailed() {},
    async delete() {},
    close() {},
  }
}

function initializeDatabase(db: Database): void {
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA foreign_keys = ON")

  const currentVersion = readUserVersion(db)
  if (currentVersion > STORE_SCHEMA_VERSION) {
    throw new Error(`Unsupported sandbox cache schema version ${currentVersion}`)
  }

  if (currentVersion < 1) {
    db.transaction(() => {
      db.run(`
        CREATE TABLE workspace_sandbox (
          workspace_id TEXT PRIMARY KEY,
          sandbox_id TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed')),
          updated_at_ms INTEGER NOT NULL,
          verified_at_ms INTEGER
        )
      `)
      db.run(`
        CREATE INDEX workspace_sandbox_status_updated_idx
        ON workspace_sandbox (status, updated_at_ms)
      `)
      db.run("PRAGMA user_version = 1")
    })()
  }
}

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null
  return row?.user_version ?? 0
}

class SQLiteSandboxStore implements SandboxStore {
  constructor(private readonly db: Database) {}

  async get(workspaceID: string): Promise<CachedSandbox | undefined> {
    const row = this.db
      .query("SELECT * FROM workspace_sandbox WHERE workspace_id = $workspaceID")
      .get({ $workspaceID: workspaceID }) as WorkspaceSandboxRow | null
    if (!row) return undefined

    try {
      const metadata = JSON.parse(row.metadata_json)
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
      return {
        workspaceID: row.workspace_id,
        sandboxID: row.sandbox_id,
        metadata: metadata as Record<string, string>,
        status: row.status,
        updatedAtMs: row.updated_at_ms,
        ...(row.verified_at_ms === null ? {} : { verifiedAtMs: row.verified_at_ms }),
      }
    } catch {
      return undefined
    }
  }

  async upsertProvisioning(input: CachedSandboxInput): Promise<void> {
    this.upsert(input, "provisioning", undefined)
  }

  async claimProvisioning(input: CachedSandboxInput): Promise<boolean> {
    const now = Date.now()
    const result = this.db
      .query(
        `INSERT INTO workspace_sandbox (
           workspace_id, sandbox_id, metadata_json, status, updated_at_ms, verified_at_ms
         ) VALUES (
           $workspaceID, $sandboxID, $metadataJson, 'provisioning', $updatedAtMs, NULL
         ) ON CONFLICT(workspace_id) DO UPDATE SET
           sandbox_id = excluded.sandbox_id,
           metadata_json = excluded.metadata_json,
           status = 'provisioning',
           updated_at_ms = excluded.updated_at_ms,
           verified_at_ms = NULL
         WHERE workspace_sandbox.status = 'failed'
           OR (workspace_sandbox.status = 'provisioning' AND workspace_sandbox.updated_at_ms < $staleBeforeMs)`,
      )
      .run({
        $workspaceID: input.workspaceID,
        $sandboxID: input.sandboxID,
        $metadataJson: JSON.stringify(input.metadata),
        $updatedAtMs: now,
        $staleBeforeMs: now - PROVISIONING_LOCK_STALE_MS,
      }) as { changes?: number }

    return (result.changes ?? 0) > 0
  }

  async markReady(input: CachedSandboxInput): Promise<void> {
    const now = Date.now()
    this.upsert(input, "ready", now)
  }

  async markFailed(workspaceID: string, sandboxID: string): Promise<void> {
    this.db
      .query(
        `UPDATE workspace_sandbox
         SET status = 'failed', updated_at_ms = $updatedAtMs
         WHERE workspace_id = $workspaceID AND sandbox_id = $sandboxID`,
      )
      .run({ $workspaceID: workspaceID, $sandboxID: sandboxID, $updatedAtMs: Date.now() })
  }

  async delete(workspaceID: string, sandboxID?: string): Promise<void> {
    if (sandboxID) {
      this.db
        .query("DELETE FROM workspace_sandbox WHERE workspace_id = $workspaceID AND sandbox_id = $sandboxID")
        .run({ $workspaceID: workspaceID, $sandboxID: sandboxID })
      return
    }

    this.db
      .query("DELETE FROM workspace_sandbox WHERE workspace_id = $workspaceID")
      .run({ $workspaceID: workspaceID })
  }

  close(): void {
    this.db.close()
  }

  private upsert(
    input: CachedSandboxInput,
    status: CachedSandboxStatus,
    verifiedAtMs: number | undefined,
  ): void {
    this.db
      .query(
        `INSERT INTO workspace_sandbox (
           workspace_id, sandbox_id, metadata_json, status, updated_at_ms, verified_at_ms
         ) VALUES (
           $workspaceID, $sandboxID, $metadataJson, $status, $updatedAtMs, $verifiedAtMs
         ) ON CONFLICT(workspace_id) DO UPDATE SET
           sandbox_id = excluded.sandbox_id,
           metadata_json = excluded.metadata_json,
           status = excluded.status,
           updated_at_ms = excluded.updated_at_ms,
           verified_at_ms = excluded.verified_at_ms`,
      )
      .run({
        $workspaceID: input.workspaceID,
        $sandboxID: input.sandboxID,
        $metadataJson: JSON.stringify(input.metadata),
        $status: status,
        $updatedAtMs: Date.now(),
        $verifiedAtMs: verifiedAtMs ?? null,
      })
  }
}
