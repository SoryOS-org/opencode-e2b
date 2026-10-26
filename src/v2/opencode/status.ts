/** One status, in two views: the full text for /e2b-status and e2b_status, and one line for the TUI. */

import type { PluginContext } from "./context.js"
import { describeNetwork } from "../options.js"
import type { GitHistory } from "../shell/runner.js"

export async function readStatus(plugin: PluginContext): Promise<{ text: string; line: string }> {
  const { opts, root, project, projectSandbox, runner, sandboxSwitch } = plugin
  const sandbox = projectSandbox.peek()
  const sync = runner.lastSync()
  const error = runner.lastError()
  const [metrics, saved] = await Promise.all([projectSandbox.metrics(), projectSandbox.savedSnapshot()])
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
  const usage = metrics
    ? `CPU ${Math.round(metrics.cpuUsedPct)}% of ${metrics.cpuCount}, memory ${mb(metrics.memUsed)} of ${mb(metrics.memTotal)}, disk ${mb(metrics.diskUsed)} of ${mb(metrics.diskTotal)}`
    : undefined
  const history = runner.gitHistory()

  const text = [
    `Commands run: ${sandboxSwitch.enabled ? "in the E2B sandbox" : "on your machine (/e2b-on to use the sandbox)"}`,
    `Project: ${project}${root ? "" : " (not a git repository, so commands cannot run in the sandbox)"}`,
    `Sandbox: ${sandbox ? sandbox.sandboxId : "not connected (starts on the next command)"}`,
    `Template: ${opts.template}, pauses after ${opts.idleMs / 60_000} min idle`,
    `New sandboxes start from: ${saved ? `snapshot ${saved.snapshotId} (saved ${saved.at})` : `the ${opts.template} template`}`,
    ...(usage ? [`Usage: ${usage}`] : []),
    `Network: ${describeNetwork(opts)}`,
    `Git history in the sandbox: ${describeHistory(history)}`,
    sync
      ? `Last sync: ${sync.at.toLocaleTimeString()}, sent ${sync.sent} file(s), brought back ${sync.pulled.written.length + sync.pulled.removed.length}, conflicts ${sync.pulled.conflicts.length}`
      : "Last sync: none yet",
    ...(error ? [`Last error: ${error}`] : []),
  ].join("\n")

  const line = [
    !sandboxSwitch.enabled
      ? "commands run on your machine"
      : sandbox
        ? `sandbox ${sandbox.sandboxId} running`
        : "no sandbox yet",
    sync ? `last sync ${sync.at.toLocaleTimeString()}, ${sync.pulled.conflicts.length} conflicts` : undefined,
    metrics
      ? `CPU ${Math.round(metrics.cpuUsedPct)}%, memory ${mb(metrics.memUsed)} of ${mb(metrics.memTotal)}`
      : undefined,
    error ? `last error: ${error}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")

  return { text, line }
}

function describeHistory(history: GitHistory): string {
  switch (history.state) {
    case "off":
      return "off (git option is false)"
    case "pending":
      return "not sent yet (it goes with the first command)"
    case "sent":
      return "sent"
    case "skipped":
      return `not sent: ${history.reason}. Plain git commands still run on your machine. Set git: true to send it anyway.`
  }
}
