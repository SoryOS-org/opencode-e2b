/**
 * Everything that runs inside the sandbox: the bookkeeping repository, the spool,
 * and the wrapper script that applies the spool, runs a command and reports what
 * the command changed.
 */

import { CommandExitError, type Sandbox } from "e2b"
import { type Files, parseIndex, parseTree } from "./files.js"
import type { RunRequest } from "./protocol.js"
import type { State } from "./sync.js"

export const SYNC_GIT_DIR = "/home/user/.opencode-e2b/sync.git"
export const SPOOL = "/home/user/.opencode-e2b/spool"
export const SYNC_MARK = "OPENCODE_E2B_SYNC "
const INLINE_LIMIT = 256 * 1024

export async function sh(sandbox: Sandbox, command: string, envs?: Record<string, string>): Promise<string> {
  try {
    return (await sandbox.commands.run(command, { envs, timeoutMs: 10 * 60_000 })).stdout
  } catch (err) {
    if (err instanceof CommandExitError) {
      throw new Error(`sync step failed in the sandbox: ${err.stderr.trim() || err.message}`)
    }
    throw err
  }
}

export function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}

/** Create the project folder at the host's path, the bookkeeping repository, and the spool. */
export async function init(sandbox: Sandbox, root: string): Promise<void> {
  const git = `GIT_DIR=${SYNC_GIT_DIR} GIT_WORK_TREE=${quote(root)} git -c user.name=opencode-e2b -c user.email=opencode-e2b@localhost`
  await sh(
    sandbox,
    [
      `sudo mkdir -p ${quote(root)} && sudo chown user:user ${quote(root)}`,
      `mkdir -p ${SPOOL}`,
      `if [ ! -d ${SYNC_GIT_DIR} ]; then ${git} init -q -b main && ${git} commit -q --allow-empty -m start; fi`,
    ].join(" && "),
  )
}

/** The agreed state as the sandbox recorded it: its HEAD, and its .git files. One round trip, used once per opencode process. */
export async function boxState(sandbox: Sandbox, root: string): Promise<State> {
  const gitDir = quote(`${root}/.git`)
  const out = await sh(
    sandbox,
    `GIT_DIR=${SYNC_GIT_DIR} git ls-tree -r -z HEAD; printf '\\0--git--\\0'; if [ -d ${gitDir} ]; then cd ${gitDir} && find . -type f ! -name '*.lock' -printf '%P\\t%s %T@\\0'; fi`,
  )
  const [tree = "", gitList = ""] = out.split("\0--git--\0")
  const git: Files = new Map()
  for (const entry of gitList.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab > 0) {
      const [size, mtime] = entry.slice(tab + 1).split(" ")
      git.set(entry.slice(0, tab), `${size} ${Math.floor(Number(mtime))}`)
    }
  }
  return { files: parseTree(tree), git: { fingerprint: "", files: git } }
}

/**
 * Wraps every command. Under a lock it applies the spool, then runs the command in its
 * own process group (setsid) with output in a file that `tail --pid` streams: E2B
 * returns only when output pipes close, and `npm run dev &` keeps them open. The
 * process group id goes to a file named after the wrapper's pid, so a cancel can
 * kill the command but not the wrapper. After the command, again under the lock, it
 * packs what changed and reports it on stderr, which the command's output never uses.
 */
export const WRAPPER = `
root=$OPENCODE_E2B_ROOT; cmd=$OPENCODE_E2B_COMMAND; mode=$OPENCODE_E2B_MODE
unset OPENCODE_E2B_ROOT OPENCODE_E2B_COMMAND OPENCODE_E2B_MODE
# Sync steps run in subshells, so GIT_DIR never reaches the user's command. Paths are
# literal: a file named routes/[id].tsx must not be read as a glob.
sync() { ( export GIT_DIR=${SYNC_GIT_DIR} GIT_WORK_TREE="$root" GIT_LITERAL_PATHSPECS=1; cd "$root" && "$@" ); }
git_id='-c user.name=opencode-e2b -c user.email=opencode-e2b@localhost'
untar() { tar --warning=no-unknown-keyword -xzf "$1" -C "$root"; }
locked() { exec 9>/tmp/opencode-e2b.lock; flock 9; rm -f ${SYNC_GIT_DIR}/index.lock; }
unlock() { flock -u 9; exec 9>&-; }

locked
for paths in $(ls ${SPOOL}/*.paths 2>/dev/null | sort); do
  id=${SPOOL}/$(basename "$paths" .paths)
  for part in "$id"-*.tgz; do [ -f "$part" ] && untar "$part"; done
  [ -s "$id.rm" ] && sync xargs -0 rm -f -- < "$id.rm"
  [ -s "$paths" ] && sync git add -A -f --pathspec-from-file="$paths" --pathspec-file-nul >/dev/null && sync git $git_id commit -q --no-verify -m 'sync from host' >/dev/null
  rm -f "$id"-*.tgz "$id.rm" "$paths"
done
unlock
[ "$mode" = sync ] && exit 0

out=$(mktemp)
setsid bash -c "$cmd" >"$out" 2>&1 </dev/null &
pid=$!
echo "$pid" > /tmp/opencode-e2b-$$.pgid
tail -s 0.02 -n +1 --pid="$pid" -f "$out"
wait "$pid"; rc=$?
rm -f "$out" /tmp/opencode-e2b-$$.pgid

locked
changed=$(mktemp)
sync git add -A -- . >/dev/null && sync git diff --cached --name-only -z HEAD > "$changed"
if [ -s "$changed" ]; then
  tgz=/tmp/opencode-e2b-out-$$.tgz
  sync xargs -0 git ls-files -z -- < "$changed" | sync tar -czf "$tgz" --null -T -
  state=$(sync xargs -0 git ls-files -s -z -- < "$changed" | base64 -w0)
  sync git $git_id commit -q --no-verify -m 'sync to host' >/dev/null
  # Small changes travel inline, which saves a round trip to fetch the tarball.
  if [ "$(stat -c %s "$tgz")" -le ${INLINE_LIMIT} ]; then
    where="inline:$(base64 -w0 < "$tgz")"; rm -f "$tgz"
  else
    where=$tgz
  fi
  printf '${SYNC_MARK}%s %s %s\\n' "$where" "$(base64 -w0 < "$changed")" "$state" >&2
fi
rm -f "$changed"
unlock
exit "$rc"
`

/** A pull report from the wrapper's stderr, or undefined if the command changed nothing. */
export interface Report {
  tarball: string
  paths: string[]
  files: Files
}

export function parseReport(stderr: string): Report | undefined {
  const line = stderr.split("\n").findLast((l) => l.startsWith(SYNC_MARK))
  if (!line) {
    return undefined
  }
  const [tarball = "", names = "", state = ""] = line.slice(SYNC_MARK.length).split(" ")
  return {
    tarball,
    paths: Buffer.from(names, "base64").toString().split("\0").filter(Boolean),
    files: parseIndex(Buffer.from(state, "base64").toString()),
  }
}

/** Apply the spool without running a command. Used after an eager push and on warm start. */
export async function applySpool(sandbox: Sandbox, root: string): Promise<void> {
  await sh(sandbox, WRAPPER, { OPENCODE_E2B_ROOT: root, OPENCODE_E2B_COMMAND: "", OPENCODE_E2B_MODE: "sync" })
}

/**
 * Run one command in the sandbox through the wrapper, streaming its output. Resolves
 * with the exit code and the wrapper's own stderr, which carries the sync report.
 */
export async function runCommand(
  sandbox: Sandbox,
  root: string,
  request: RunRequest,
  onData: (data: string) => void,
  killed: AbortSignal,
  keepAlive: () => void,
): Promise<{ code: number; stderr: string }> {
  let stderr = ""
  const handle = await sandbox.commands.run(WRAPPER, {
    background: true,
    cwd: request.cwd,
    // The host env is not forwarded: it holds model API keys and other secrets.
    envs: {
      ...request.env,
      OPENCODE_E2B_ROOT: root,
      OPENCODE_E2B_COMMAND: request.command,
      OPENCODE_E2B_MODE: "run",
    },
    timeoutMs: 0,
    onStdout: onData,
    onStderr: (data) => {
      stderr += data
    },
  })
  // Kill the command's process group only. The wrapper then finishes its sync step
  // and exits, so a cancel never leaves the bookkeeping half-written.
  const stop = () => {
    const group = `$(cat /tmp/opencode-e2b-${handle.pid}.pgid 2>/dev/null)`
    sandbox.commands
      .run(
        `g=${group}; [ -n "$g" ] && { kill -TERM -- -$g; sleep 1; kill -KILL -- -$g; } 2>/dev/null; true`,
        {
          timeoutMs: 10_000,
        },
      )
      .catch(() => handle.kill())
  }
  killed.addEventListener("abort", stop, { once: true })
  // Long commands must not hit the idle timeout.
  const heartbeat = setInterval(keepAlive, 60_000)
  try {
    return { code: (await handle.wait()).exitCode, stderr }
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { code: err.exitCode, stderr }
    }
    throw err
  } finally {
    clearInterval(heartbeat)
    killed.removeEventListener("abort", stop)
  }
}

/** Lines the wrapper wrote to stderr that are not the sync report: real problems to show. */
export function syncWarnings(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.trim() !== "" && !line.startsWith(SYNC_MARK))
}
