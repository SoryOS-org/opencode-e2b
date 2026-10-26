/**
 * Bring a box's work home as a local branch, e2b/<name>. In the box, the work in
 * progress (uncommitted files too) is committed on a scratch ref, without touching the
 * agent's own branch or index, and packed as a git bundle with only the commits since
 * the box started. Locally, git fetches the bundle. No credentials are involved.
 */

import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Sandbox } from "e2b"
import type { E2BAccess } from "../sandbox/create.js"
import { run } from "../sync/files.js"
import { quote, sh } from "../sync/remote.js"
import type { BoxRecord } from "./registry.js"

export const PULL_REF = "refs/opencode-e2b/pull"
const NOTHING = "OPENCODE_E2B_NOTHING_NEW"

/** The script that runs in the box. It prints the bundle path, or NOTHING when there is no new work. */
export function bundleScript(root: string, name: string, base: string | undefined, bundle: string): string {
  const author = "-c user.name=opencode-e2b -c user.email=opencode-e2b@localhost"
  return `
set -e -o pipefail
cd ${quote(root)}
export GIT_INDEX_FILE=$(mktemp)
if git rev-parse -q --verify HEAD >/dev/null; then git read-tree HEAD; parent="-p HEAD"; else parent=""; fi
git add -A >/dev/null
tree=$(git write-tree)
rm -f "$GIT_INDEX_FILE"
unset GIT_INDEX_FILE
if [ -n "$parent" ] && [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  commit=$(git rev-parse HEAD)
else
  commit=$(git ${author} commit-tree "$tree" $parent -m ${quote(`Work in progress from box ${name}`)})
fi
${base ? `if [ "$commit" = ${quote(base)} ]; then echo ${NOTHING}; exit 0; fi` : ""}
git update-ref ${PULL_REF} "$commit"
git bundle create ${quote(bundle)} ${PULL_REF}${base ? ` ^${base}` : ""} 2>/dev/null
echo ${quote(bundle)}
`
}

export interface Pulled {
  /** The local branch with the box's work, or undefined when there was nothing new. */
  branch?: string
  /** `git log --oneline` of the new commits. */
  log: string
}

export async function pullBox(record: BoxRecord, access: E2BAccess): Promise<Pulled> {
  const sandbox = await Sandbox.connect(record.sandboxId, access)
  const remoteBundle = `/tmp/opencode-e2b-pull-${randomUUID()}.bundle`
  const out = (await sh(sandbox, bundleScript(record.root, record.name, record.base, remoteBundle))).trim()
  if (out.endsWith(NOTHING)) {
    return { log: "" }
  }
  const bytes = await sandbox.files.read(remoteBundle, { format: "bytes" })
  sandbox.files.remove(remoteBundle).catch(() => undefined)
  const localBundle = path.join(os.tmpdir(), `opencode-e2b-pull-${randomUUID()}.bundle`)
  const branch = `e2b/${record.name}`
  try {
    await writeFile(localBundle, Buffer.from(bytes))
    await run("git", ["fetch", "-q", localBundle, `+${PULL_REF}:refs/heads/${branch}`], { cwd: record.root })
  } finally {
    await rm(localBundle, { force: true })
  }
  const range = record.base ? `${record.base}..${branch}` : branch
  const log = (await run("git", ["log", "--oneline", range], { cwd: record.root })).toString().trim()
  return { branch, log }
}
