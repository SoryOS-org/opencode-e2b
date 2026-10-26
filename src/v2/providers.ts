/**
 * Model providers for boxes. A box runs OpenCode itself, so it needs a model key. The
 * key is stored once as an E2B secret; the box gets only a placeholder, and E2B's egress
 * proxy puts the real key into each HTTPS request to the provider. The box never holds it.
 */

import { Secret } from "e2b"
import type { E2BAccess, Network } from "./sandbox/create.js"

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDERS: Record<ProviderId, { env: string; host: string; header: string; prefix: string }> = {
  anthropic: { env: "ANTHROPIC_API_KEY", host: "api.anthropic.com", header: "x-api-key", prefix: "" },
  openai: { env: "OPENAI_API_KEY", host: "api.openai.com", header: "Authorization", prefix: "Bearer " },
  openrouter: {
    env: "OPENROUTER_API_KEY",
    host: "openrouter.ai",
    header: "Authorization",
    prefix: "Bearer ",
  },
}

/** The value OpenCode sees in the box. The egress proxy replaces it on the wire. */
const PLACEHOLDER = "set-by-the-e2b-egress-proxy"

export function isProvider(id: string): id is ProviderId {
  return PROVIDER_IDS.some((known) => known === id)
}

export function secretName(id: ProviderId): string {
  return `opencode-e2b-${id}`
}

/** Store or replace the key for `id`. */
export async function setProviderKey(id: ProviderId, value: string, access: E2BAccess): Promise<void> {
  const name = secretName(id)
  if (await Secret.exists(name, access)) {
    await Secret.update(name, value, access)
  } else {
    await Secret.create(name, value, access)
  }
}

/** Resolves true if a key was stored. */
export function removeProviderKey(id: ProviderId, access: E2BAccess): Promise<boolean> {
  return Secret.destroy(secretName(id), access)
}

/** Providers whose key is stored as an E2B secret. */
export async function storedProviders(access: E2BAccess): Promise<ProviderId[]> {
  const stored = await Promise.all(PROVIDER_IDS.map((id) => Secret.exists(secretName(id), access)))
  return PROVIDER_IDS.filter((_, i) => stored[i])
}

/** Egress rules that put each provider's stored key into requests to its API. */
export function providerNetwork(ids: ProviderId[]): Network | undefined {
  if (ids.length === 0) {
    return undefined
  }
  const rules = Object.fromEntries(
    ids.map((id) => {
      const { host, header, prefix } = PROVIDERS[id]
      return [host, [{ transform: { headers: { [header]: `${prefix}${Secret.fill(secretName(id))}` } } }]]
    }),
  )
  return { rules }
}

/** The environment OpenCode in the box needs to offer these providers: placeholders, never keys. */
export function placeholderEnv(ids: ProviderId[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [PROVIDERS[id].env, PLACEHOLDER]))
}
