/**
 * Everything that runs inside the sandbox: the bookkeeping repository, the spool,
 * and the wrapper script that applies the spool, runs a command and reports what
 * the command changed.
 */

import { CommandExitError, type Sandbox } from "e2b"
import { type GitDirFiles, type ProjectFiles, parseIndex, parseTree } from "./files.js"
import type { State } from "./push-pull.js"

export const SYNC_GIT_DIR = "/home/user/.opencode-e2b/sync.git"
export const SPOOL = "/home/user/.opencode-e2b/spool"
export const SYNC_MARK = "OPENCODE_E2B_SYNC "
/** Starts a line in which the wrapper reports a failed sync step. */
export const SYNC_FAILED = "OPENCODE_E2B_SYNC_FAILED "
/** The wrapper's exit code when it could not apply the spool and did not run the command. */
export const APPLY_FAILED_EXIT = 97
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
  const git: GitDirFiles = new Map()
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
set -o pipefail
root=$OPENCODE_E2B_ROOT; cmd=$OPENCODE_E2B_COMMAND; mode=$OPENCODE_E2B_MODE
unset OPENCODE_E2B_ROOT OPENCODE_E2B_COMMAND OPENCODE_E2B_MODE
# Sync steps run in subshells, so GIT_DIR never reaches the user's command. Paths are
# literal: a file named routes/[id].tsx must not be read as a glob.
sync() { ( export GIT_DIR=${SYNC_GIT_DIR} GIT_WORK_TREE="$root" GIT_LITERAL_PATHSPECS=1; cd "$root" && "$@" ); }
commit() { sync git diff --cached --quiet || sync git -c user.name=opencode-e2b -c user.email=opencode-e2b@localhost commit -q --no-verify -m "$1" >/dev/null; }
untar() { tar --warning=no-unknown-keyword -xzf "$1" -C "$root"; }
# Holding the lock, no other sync step runs, so an index.lock left behind is stale.
locked() { exec 9>/tmp/opencode-e2b.lock && flock 9 && rm -f ${SYNC_GIT_DIR}/index.lock; }
unlock() { flock -u 9; exec 9>&-; }
failed() { printf '${SYNC_FAILED}%s\\n' "$1" >&2; }

# Unpack one upload, delete what the host deleted, and record it as agreed.
apply_entry() {
  for part in "$1"-*.tgz; do
    if [ -f "$part" ]; then untar "$part" || return 1; fi
  done
  if [ -s "$1.rm" ]; then sync xargs -0 rm -f -- < "$1.rm" || return 1; fi
  if [ -s "$1.paths" ]; then
    sync git add -A -f --pathspec-from-file="$1.paths" --pathspec-file-nul >/dev/null || return 1
    commit 'sync from host' || return 1
  fi
}

# Apply every upload in the spool, in name order, which is upload order (names start
# with a timestamp). An entry that fails moves to spool/failed, so it cannot block the
# next command: the plugin then reads the sandbox's state again and sends the difference.
apply_spool() {
  for paths in ${SPOOL}/*.paths; do
    [ -e "$paths" ] || continue
    id=\${paths%.paths}
    if ! apply_entry "$id"; then
      mkdir -p ${SPOOL}/failed && mv "$id"-*.tgz "$id.rm" "$paths" ${SPOOL}/failed/ 2>/dev/null
      return 1
    fi
    rm -f "$id"-*.tgz "$id.rm" "$paths"
  done
}

# List and pack what the command changed, record it as agreed, and report it on stderr.
report_changes() {
  changed=$(mktemp)
  sync git add -A -- . >/dev/null && sync git diff --cached --name-only -z HEAD > "$changed" || return 1
  if [ -s "$changed" ]; then
    tgz=/tmp/opencode-e2b-out-$$.tgz
    sync xargs -0 git ls-files -z -- < "$changed" | sync tar -czf "$tgz" --null -T - || return 1
    state=$(sync xargs -0 git ls-files -s -z -- < "$changed" | base64 -w0) || return 1
    names=$(base64 -w0 < "$changed") || return 1
    # Small changes travel inline, which saves a round trip to fetch the tarball.
    if [ "$(stat -c %s "$tgz")" -le ${INLINE_LIMIT} ]; then
      encoded=$(base64 -w0 < "$tgz") || return 1
      where="inline:$encoded"
    else
      where=$tgz
    fi
    # Record the new agreed state only once the report is ready.
    commit 'sync to host' || return 1
    if [ "$where" != "$tgz" ]; then rm -f "$tgz"; fi
    printf '${SYNC_MARK}%s %s %s\\n' "$where" "$names" "$state" >&2
  fi
  rm -f "$changed"
}

if ! locked; then
  failed "the sync lock could not be taken, so the command did not run"
  exit ${APPLY_FAILED_EXIT}
fi
if ! apply_spool; then
  failed "your changes could not be applied in the sandbox, so the command did not run"
  unlock
  exit ${APPLY_FAILED_EXIT}
fi
unlock
[ "$mode" = sync ] && exit 0

out=$(mktemp)
setsid bash -c "$cmd" >"$out" 2>&1 </dev/null &
pid=$!
echo "$pid" > /tmp/opencode-e2b-$$.pgid
tail -s 0.02 -n +1 --pid="$pid" -f "$out"
wait "$pid"; rc=$?
rm -f "$out" /tmp/opencode-e2b-$$.pgid

if locked; then
  report_changes || failed "the files the command changed could not be collected, so they may not be on your machine"
  unlock
else
  failed "the sync lock could not be taken, so the files the command changed may not be on your machine"
fi
exit "$rc"
`

/** A pull report from the wrapper's stderr, or undefined if the command changed nothing. */
export interface Report {
  tarball: string
  paths: string[]
  files: ProjectFiles
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

/** A sync step that failed in the wrapper, if one did. */
export function syncFailure(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .find((line) => line.startsWith(SYNC_FAILED))
    ?.slice(SYNC_FAILED.length)
}

/** Lines the wrapper wrote to stderr that are not its own reports: real problems to show. */
export function syncWarnings(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith(SYNC_MARK) && !line.startsWith(SYNC_FAILED))
}
