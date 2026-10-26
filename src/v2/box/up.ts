/**
 * Start a box: a sandbox with the project at the same path (tracked and uncommitted
 * files, and .git), and OpenCode 2 serving there. The model key comes from E2B secrets.
 */

import { randomUUID } from "node:crypto"
import type { Sandbox } from "e2b"
import { placeholderEnv, providerNetwork, storedProviders } from "../providers.js"
import { type E2BAccess, type Network, createSandbox, mergeNetwork } from "../sandbox/create.js"
import { run } from "../sync/files.js"
import { push } from "../sync/push-pull.js"
import { applySpool, init, quote, sh } from "../sync/remote.js"
import { type BoxRecord, boxState, readBox, saveBox } from "./registry.js"
import { ensureOpencode, startServer } from "./server.js"

export interface UpRequest {
  root: string
  name: string
  template: string
  /** How long the box runs before E2B pauses it. Agents work without traffic from here. */
  lifetimeMs: number
  access: E2BAccess
  network?: Network
  progress: (step: string) => void
}

export async function upBox(request: UpRequest): Promise<BoxRecord> {
  const { root, name, access } = request
  const existing = await readBox(name)
  if (existing && (await boxState(existing, access)) !== "gone") {
    throw new Error(`box "${name}" already exists. Attach to it, pull it, or kill it first.`)
  }
  const providers = await storedProviders(access)
  if (providers.length === 0) {
    throw new Error(
      "no model key is stored yet. Store one as an E2B secret first: opencode-e2b secrets set anthropic (or /e2b-secrets set anthropic in OpenCode).",
    )
  }

  request.progress("creating the sandbox")
  const sandbox = await createSandbox(request.template, access, {
    metadata: { app: "opencode-e2b-box", box: name },
    idleMs: request.lifetimeMs,
    network: mergeNetwork(request.network, providerNetwork(providers)),
  })
  try {
    await init(sandbox, root)
    request.progress("uploading the project, with uncommitted files and .git")
    await push(sandbox, root, { files: new Map() }, true)
    await applySpool(sandbox, root)
    await copyGitIdentity(sandbox, root)
    request.progress("starting OpenCode in the box")
    await ensureOpencode(sandbox)
    const password = randomUUID()
    const url = await startServer(sandbox, root, password, {
      ...placeholderEnv(providers),
      // Only the providers with a stored key. Otherwise OpenCode may pick a free default model instead.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: providers }),
    })
    const record: BoxRecord = {
      name,
      sandboxId: sandbox.sandboxId,
      url,
      password,
      root,
      base: await headCommit(root),
      domain: access.domain,
      template: request.template,
      createdAt: new Date().toISOString(),
    }
    await saveBox(record)
    return record
  } catch (err) {
    // A box that did not come up is deleted, so it does not keep billing.
    await sandbox.kill().catch(() => undefined)
    throw err
  }
}

/** The agent commits in the box as the user, as it would on the user's machine. */
async function copyGitIdentity(sandbox: Sandbox, root: string): Promise<void> {
  const settings = await Promise.all(
    ["user.name", "user.email"].map(async (key) => {
      const value = await run("git", ["config", key], { cwd: root }).then(
        (out) => out.toString().trim(),
        () => "",
      )
      return value ? `git config --global ${key} ${quote(value)}` : undefined
    }),
  )
  const commands = settings.filter((command) => command !== undefined)
  if (commands.length > 0) {
    await sh(sandbox, commands.join(" && "))
  }
}

/** The commit the project is on, or undefined in a repository without commits. */
async function headCommit(root: string): Promise<string | undefined> {
  return run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root }).then(
    (out) => out.toString().trim(),
    () => undefined,
  )
}
