#!/usr/bin/env node
/**
 * opencode-e2b: boxes (OpenCode running in an E2B sandbox) and the model keys they use.
 *
 *   opencode-e2b box up|attach|pull|list|stop|kill [name]
 *   opencode-e2b secrets set|list|remove [provider]
 */

import "../../core/e2b-sdk.js"
import { errorText } from "../shell/runner.js"
import { boxCommand } from "./box.js"
import { secretsCommand } from "./secrets.js"
import { UsageError } from "./usage-error.js"

const USAGE = `Usage:
  opencode-e2b box up [name] [--template <name>] [--hours <n>] [--attach]
                                 Start a box with this project and OpenCode in it
  opencode-e2b box attach [name] Open the OpenCode TUI on a box
  opencode-e2b box pull [name]   Bring the box's work home as branch e2b/<name>
  opencode-e2b box list          The boxes this machine started
  opencode-e2b box stop [name]   Pause a box. Attach wakes it.
  opencode-e2b box kill [name]   Delete a box. Pull first.
  opencode-e2b secrets set <provider>     Store a model key as an E2B secret
  opencode-e2b secrets list               The providers with a stored key
  opencode-e2b secrets remove <provider>  Delete a stored key

The box name defaults to the current git branch, or to the project's only box. Providers: anthropic, openai, openrouter.
The key for "secrets set" comes from the provider's variable (ANTHROPIC_API_KEY, ...) or stdin.
E2B_API_KEY selects the account, and E2B_DOMAIN or --domain the region.`

async function main(args: string[]): Promise<number> {
  const [group, ...rest] = args
  if (group === "box") {
    return boxCommand(rest)
  }
  if (group === "secrets") {
    return secretsCommand(rest)
  }
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    console.log(USAGE)
    return 0
  }
  throw new UsageError(`unknown command "${group}"`)
}

let code = 0
try {
  code = await main(process.argv.slice(2))
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`opencode-e2b: ${err.message}\n\n${USAGE}`)
    code = 2
  } else {
    console.error(errorText(err))
    code = 1
  }
}
// The E2B SDK keeps its HTTP/2 connections open, which would keep the process alive.
process.exit(code)
