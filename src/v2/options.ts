/**
 * Plugin options, and the E2B network config they turn into.
 *
 * Secrets are never handled by the plugin. The user stores them in E2B, and the
 * plugin only names them in an egress rule. E2B's proxy adds the value to matching
 * HTTPS requests as they leave the sandbox, so the sandbox never sees it.
 */

import { Secret, type SandboxNetworkOpts } from "e2b"

export interface SecretRule {
  /** Name of a secret stored in E2B. */
  secret: string
  /** Request header to set. */
  header: string
  /** Text before the secret in the header value, for example "Bearer ". */
  prefix: string
}

export interface Options {
  domain?: string
  template: string
  idleMs: number
  env: string[]
  /** Send .git to the sandbox: always, never, or 'auto' (only when it is small enough). */
  git: boolean | "auto"
  allowOut?: string[]
  denyOut?: string[]
  /** host -> how to inject a stored secret into requests to that host */
  secrets: Record<string, SecretRule>
}

const DEFAULT_TEMPLATE = "opencode"

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new TypeError(`opencode-e2b option ${name} must be a list of strings`)
  }
  return value
}

function secretRule(host: string, value: unknown): SecretRule {
  if (typeof value === "string" && value !== "") {
    return { secret: value, header: "Authorization", prefix: "Bearer " }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { secret, header = "Authorization", prefix = "Bearer " } = value as Record<string, unknown>
    if (
      typeof secret === "string" &&
      secret !== "" &&
      typeof header === "string" &&
      header !== "" &&
      typeof prefix === "string"
    ) {
      return { secret, header, prefix }
    }
  }
  throw new TypeError(
    `opencode-e2b option secrets["${host}"] must be a secret name, or { secret, header?, prefix? }`,
  )
}

export function parseOptions(raw: Record<string, unknown> | undefined): Options {
  const input = raw ?? {}
  const template = input.template ?? DEFAULT_TEMPLATE
  const idleMinutes = input.idleMinutes ?? 15
  const git = input.git ?? "auto"
  const domain = input.domain
  if (domain !== undefined && (typeof domain !== "string" || domain === "")) {
    throw new TypeError("opencode-e2b option domain must be an E2B domain, for example e2b-juliett.dev")
  }
  if (typeof template !== "string" || template === "") {
    throw new TypeError("opencode-e2b option template must be a template name")
  }
  if (typeof idleMinutes !== "number" || idleMinutes <= 0) {
    throw new TypeError("opencode-e2b option idleMinutes must be a positive number")
  }
  if (typeof git !== "boolean" && git !== "auto") {
    throw new TypeError('opencode-e2b option git must be true, false or "auto"')
  }
  const network = input.network ?? {}
  if (typeof network !== "object" || network === null || Array.isArray(network)) {
    throw new TypeError("opencode-e2b option network must be { allowOut?, denyOut? }")
  }
  const { allowOut, denyOut } = network as Record<string, unknown>
  const secretsInput = input.secrets ?? {}
  if (typeof secretsInput !== "object" || secretsInput === null || Array.isArray(secretsInput)) {
    throw new TypeError("opencode-e2b option secrets must map hosts to secret names")
  }
  const secrets: Record<string, SecretRule> = {}
  for (const [host, value] of Object.entries(secretsInput)) {
    secrets[host] = secretRule(host, value)
  }
  return {
    domain,
    template,
    idleMs: idleMinutes * 60_000,
    env: stringList(input.env, "env") ?? [],
    git,
    allowOut: stringList(allowOut, "network.allowOut"),
    denyOut: stringList(denyOut, "network.denyOut"),
    secrets,
  }
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
