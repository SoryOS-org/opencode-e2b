/**
 * Slash commands for boxes: /e2b-box and /e2b-secrets. They do what the CLI does,
 * except attach, which needs its own terminal. Replies never show a box password or a key.
 */

import type { Plugin } from "@opencode/plugin"
import { defaultBoxName, describeBoxes, findBox, killBox, listWithState, stopBox } from "../box/manage.js"
import { pullBox } from "../box/pull.js"
import { upBox } from "../box/up.js"
import { networkFor } from "../options.js"
import {
  PROVIDERS,
  PROVIDER_IDS,
  isProvider,
  removeProviderKey,
  secretName,
  setProviderKey,
  storedProviders,
} from "../providers.js"
import type { E2BAccess } from "../sandbox/create.js"
import type { PluginContext } from "./context.js"

type SessionID = Parameters<Plugin.Context["session"]["synthetic"]>[0]["sessionID"]

const BOX_USAGE =
  "Usage: /e2b-box up|pull|list|stop|kill [name]. The name defaults to the current branch, or the project's only box."
const BOX_ACTIONS = new Set(["up", "pull", "list", "stop", "kill"])
const SECRETS_USAGE = `Usage: /e2b-secrets set|remove <provider>, or /e2b-secrets list. Providers: ${PROVIDER_IDS.join(", ")}.`

export async function registerBoxCommands(plugin: PluginContext): Promise<void> {
  const { opencode, opts, root } = plugin
  const access: E2BAccess = { apiKey: process.env.E2B_API_KEY, domain: opts.domain }

  const reply = async (sessionID: SessionID, text: string, summary = text) => {
    await opencode.session.synthetic({
      sessionID,
      text: `[e2b] ${text}`,
      description: `e2b · ${summary}`,
      resume: false,
    })
  }

  /** The text of the reply to `/e2b-box <action> [name]`. */
  const box = async (action: string | undefined, given: string | undefined): Promise<string> => {
    if (action === undefined || !BOX_ACTIONS.has(action)) {
      return BOX_USAGE
    }
    if (action === "list") {
      return describeBoxes(await listWithState(access))
    }
    if (!root) {
      return "Boxes need a git repository, and this folder is not in one."
    }
    if (action === "up") {
      const record = await upBox({
        root,
        name: await defaultBoxName(root, given),
        template: opts.template,
        lifetimeMs: opts.boxLifetimeMs,
        access,
        network: networkFor(opts),
        progress: () => undefined,
      })
      return `Box "${record.name}" is up with this project and OpenCode in it. Open it in a terminal with: opencode-e2b box attach ${record.name}`
    }
    const record = await findBox(root, given)
    const boxAccess = { ...access, domain: record.domain ?? access.domain }
    if (action === "pull") {
      const pulled = await pullBox(record, boxAccess)
      return pulled.branch
        ? `Branch ${pulled.branch} has the box's work (${pulled.log.split("\n").length} commits):\n${pulled.log}`
        : `Box "${record.name}" has no new work.`
    }
    if (action === "stop") {
      await stopBox(record, boxAccess)
      return `Box "${record.name}" is paused. Attach wakes it.`
    }
    await killBox(record, boxAccess)
    return `Box "${record.name}" is deleted.`
  }

  /** The text of the reply to `/e2b-secrets <action> [provider]`. */
  const secrets = async (action: string | undefined, provider: string | undefined): Promise<string> => {
    if (action === "list") {
      const stored = await storedProviders(access)
      return stored.length > 0 ? `Model keys stored for: ${stored.join(", ")}` : "No model keys stored yet."
    }
    if ((action !== "set" && action !== "remove") || provider === undefined || !isProvider(provider)) {
      return SECRETS_USAGE
    }
    if (action === "remove") {
      return (await removeProviderKey(provider, access))
        ? `Deleted the stored ${provider} key.`
        : `No ${provider} key was stored.`
    }
    // The key comes from OpenCode's own environment, never from the prompt: prompts are kept in the session.
    const value = process.env[PROVIDERS[provider].env]
    if (!value) {
      return `${PROVIDERS[provider].env} is not set where OpenCode runs. Set it, or run: opencode-e2b secrets set ${provider}`
    }
    await setProviderKey(provider, value, access)
    return `Stored ${PROVIDERS[provider].env} as E2B secret ${secretName(provider)}. Boxes get it through the egress proxy only.`
  }

  const words = (text: string | undefined) => (text ?? "").trim().split(/\s+/).filter(Boolean)

  await opencode.command.transform((commands) => {
    commands.add({
      name: "e2b-box",
      description: "Run OpenCode in an E2B box: /e2b-box up|pull|list|stop|kill [name]",
      execute: async ({ sessionID, prompt }) => {
        const [action, name] = words(prompt.text)
        const text = await box(action, name)
        await reply(sessionID, text, text.split("\n")[0])
      },
    })

    commands.add({
      name: "e2b-secrets",
      description: "Store model keys for boxes as E2B secrets: /e2b-secrets set|list|remove [provider]",
      execute: async ({ sessionID, prompt }) => {
        const [action, provider] = words(prompt.text)
        await reply(sessionID, await secrets(action, provider))
      },
    })
  })
}
