/** Creating sandboxes the same way in both modes: paused when idle, woken by traffic, with network rules. */

import { Sandbox, type SandboxNetworkRule } from "e2b"

/** Which E2B account and region to use. */
export interface E2BAccess {
  apiKey?: string
  /** E2B region domain, for example e2b-juliett.dev for the EU. Defaults to E2B_DOMAIN or e2b.app. */
  domain?: string
}

/** The part of E2B's network config this plugin sets: plain lists and a rule per host. */
export interface Network {
  allowOut?: string[]
  denyOut?: string[]
  rules?: Record<string, SandboxNetworkRule[]>
}

export interface CreateSettings {
  metadata: Record<string, string>
  /** Idle time before E2B pauses the sandbox. */
  idleMs: number
  network?: Network
}

/** `from` is a template name or a snapshot id. */
export function createSandbox(from: string, access: E2BAccess, settings: CreateSettings): Promise<Sandbox> {
  return Sandbox.create(from, {
    ...access,
    metadata: settings.metadata,
    timeoutMs: settings.idleMs,
    lifecycle: { onTimeout: "pause", autoResume: true },
    network: settings.network,
  })
}

/** Combine two network configs. Allow and deny lists add up; for the same host, `extra`'s rules win. */
export function mergeNetwork(base: Network | undefined, extra: Network | undefined): Network | undefined {
  if (!base || !extra) {
    return base ?? extra
  }
  const list = (a: string[] = [], b: string[] = []) => {
    const items = [...a, ...b]
    return items.length > 0 ? [...new Set(items)] : undefined
  }
  return {
    allowOut: list(base.allowOut, extra.allowOut),
    denyOut: list(base.denyOut, extra.denyOut),
    rules: { ...base.rules, ...extra.rules },
  }
}
