/**
 * Plugin options, and the E2B network config they turn into.
 *
 * Secrets are never handled by the plugin. The user stores them in E2B, and the
 * plugin only names them in an egress rule. E2B's proxy adds the value to matching
 * HTTPS requests as they leave the sandbox, so the sandbox never sees it.
 */

import type { Plugin } from "@opencode/plugin"
import { Secret, type SandboxNetworkOpts } from "e2b"
import * as z from "zod"

const name = z.string().min(1)

/** A secret name alone means `Authorization: Bearer <secret>`. */
const SecretRule = z.union([
  name.transform((secret) => ({ secret, header: "Authorization", prefix: "Bearer " })),
  z.object({
    /** Name of a secret stored in E2B. */
    secret: name,
    /** Request header to set. */
    header: name.default("Authorization"),
    /** Text before the secret in the header value. */
    prefix: z.string().default("Bearer "),
  }),
])

const OptionsSchema = z
  .object({
    /** E2B region domain, for example e2b-juliett.dev for the EU. */
    domain: name.optional(),
    template: name.default("opencode"),
    idleMinutes: z.number().positive().default(15),
    /** Names of host environment variables to pass to commands. */
    env: z.array(name).default([]),
    /** Send .git to the sandbox: always, never, or "auto" (only when it is small enough). */
    git: z.union([z.boolean(), z.literal("auto")]).default("auto"),
    network: z.object({ allowOut: z.array(name).optional(), denyOut: z.array(name).optional() }).default({}),
    /** Host -> how to inject a stored secret into requests to that host. */
    secrets: z.record(z.string(), SecretRule).default({}),
  })
  .transform(({ idleMinutes, network, ...rest }) => ({
    ...rest,
    idleMs: idleMinutes * 60_000,
    allowOut: network.allowOut,
    denyOut: network.denyOut,
  }))

export type Options = z.output<typeof OptionsSchema>

/** Read the plugin options from OpenCode's config. Fails with a message that names the bad option. */
export function parseOptions(input: Plugin.Context["options"] | undefined): Options {
  const result = OptionsSchema.safeParse(input ?? {})
  if (!result.success) {
    throw new TypeError(`opencode-e2b options: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

/** The sandbox network config, or undefined to leave E2B's default (all egress allowed). */
export function networkFor(opts: Options): SandboxNetworkOpts | undefined {
  const hosts = Object.keys(opts.secrets)
  if (hosts.length === 0 && !opts.allowOut && !opts.denyOut) {
    return undefined
  }
  const rules = Object.fromEntries(
    Object.entries(opts.secrets).map(([host, rule]) => [
      host,
      [{ transform: { headers: { [rule.header]: `${rule.prefix}${Secret.fill(rule.secret)}` } } }],
    ]),
  )
  // A rule does not open egress on its own. When egress is restricted at all, the secret hosts go on the allow list.
  const restricted = opts.allowOut !== undefined || opts.denyOut !== undefined
  const allowOut = restricted ? [...new Set([...(opts.allowOut ?? []), ...hosts])] : undefined
  return {
    ...(allowOut ? { allowOut } : {}),
    ...(opts.denyOut ? { denyOut: opts.denyOut } : {}),
    ...(hosts.length > 0 ? { rules } : {}),
  }
}

/** One line for status output. */
export function describeNetwork(opts: Options): string {
  const parts: string[] = []
  if (opts.allowOut) {
    parts.push(`allow ${opts.allowOut.join(", ")}`)
  }
  if (opts.denyOut) {
    parts.push(`deny ${opts.denyOut.join(", ")}`)
  }
  const hosts = Object.entries(opts.secrets).map(([host, rule]) => `${host} (${rule.secret})`)
  if (hosts.length > 0) {
    parts.push(`secrets for ${hosts.join(", ")}`)
  }
  return parts.length > 0 ? parts.join("; ") : "all egress allowed, no secrets"
}
