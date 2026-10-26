/** opencode-e2b secrets set|list|remove [provider] */

import { text } from "node:stream/consumers"
import { parseArgs } from "node:util"
import {
  PROVIDERS,
  PROVIDER_IDS,
  type ProviderId,
  isProvider,
  removeProviderKey,
  secretName,
  setProviderKey,
  storedProviders,
} from "../providers.js"
import type { E2BAccess } from "../sandbox/create.js"
import { UsageError } from "./usage-error.js"

export async function secretsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { domain: { type: "string" } },
  })
  const [action, provider] = positionals
  const access: E2BAccess = {
    apiKey: process.env.E2B_API_KEY,
    domain: values.domain ?? process.env.E2B_DOMAIN,
  }

  if (action === "list") {
    const stored = await storedProviders(access)
    console.log(
      stored.length > 0
        ? stored.map((id) => `${id}  (E2B secret ${secretName(id)})`).join("\n")
        : "No model keys stored yet.",
    )
    return 0
  }
  if (action !== "set" && action !== "remove") {
    throw new UsageError(action ? `unknown secrets action "${action}"` : "say what to do with the secrets")
  }
  const id = parseProvider(provider)
  if (action === "set") {
    await setProviderKey(id, await readKey(id), access)
    console.log(
      `Stored the ${id} key as E2B secret ${secretName(id)}. Boxes get it through the egress proxy only.`,
    )
    return 0
  }
  const removed = await removeProviderKey(id, access)
  console.log(removed ? `Deleted the stored ${id} key.` : `No ${id} key was stored.`)
  return 0
}

function parseProvider(raw: string | undefined): ProviderId {
  if (raw === undefined || !isProvider(raw)) {
    throw new UsageError(`name a provider: ${PROVIDER_IDS.join(", ")}`)
  }
  return raw
}

/** The key from the provider's environment variable, else from piped stdin. Never from an argument: shells keep history. */
async function readKey(id: ProviderId): Promise<string> {
  const fromEnv = process.env[PROVIDERS[id].env]
  if (fromEnv) {
    return fromEnv
  }
  if (process.stdin.isTTY) {
    throw new UsageError(`set ${PROVIDERS[id].env}, or pipe the key in`)
  }
  const fromStdin = (await text(process.stdin)).trim()
  if (fromStdin === "") {
    throw new UsageError("the key on stdin is empty")
  }
  return fromStdin
}
