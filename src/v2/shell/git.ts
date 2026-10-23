/**
 * A plain git command runs on the user's machine, where the real repository is and
 * the files are already in sync. That keeps commits, branches and the index where
 * the user works. Only known subcommands qualify, with no global options (`-c` could
 * define an alias that runs anything) and no options that run programs. Hooks are
 * turned off for these commands, because the agent can edit hook scripts that live
 * in the project (for example .husky) from the sandbox.
 */
const LOCAL_GIT =
  /^git\s+(status|diff|log|show|blame|shortlog|describe|rev-parse|ls-files|branch|tag|add|rm|mv|restore|commit|checkout|switch|reset|stash|merge|rebase|cherry-pick|revert|fetch|pull|push)(\s|$)/
const UNSAFE_GIT_ARGS = /\s(--exec|-x|--upload-pack|--receive-pack|--config|--ext-diff|--textconv)(\s|=|$)/
const SHELL_SYNTAX = /[;&|<>`$()\\\n]/
/** git commands that change history, refs or the index. In the sandbox their changes would be lost. */
export const GIT_WRITE =
  /^git\s+(?:\S+\s+)*?(add|rm|mv|restore|commit|checkout|switch|reset|stash|merge|rebase|cherry-pick|revert|tag|fetch|pull|push|apply|am)(\s|$)/
export const NO_HOOKS = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
}

/** A git command that runs on its own on the user's machine. */
export function isLocalGit(command: string): boolean {
  const trimmed = command.trim()
  return LOCAL_GIT.test(trimmed) && !SHELL_SYNTAX.test(trimmed) && !UNSAFE_GIT_ARGS.test(trimmed)
}
