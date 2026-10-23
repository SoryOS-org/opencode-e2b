/** One status, in two views: the full text for /e2b-status and e2b_status, and one line for the TUI. */

import type { PluginContext } from "./context.js"
import { describeNetwork } from "../options.js"

export async function readStatus(plugin: PluginContext): Promise<{ text: string; line: string }> {
  const { opts, root, project, box, runner, mode } = plugin
  const sandbox = box.peek()
  const sync = runner.lastSync()
  const error = runner.lastError()
  const [metrics, saved] = await Promise.all([box.metrics(), box.savedSnapshot()])
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
  const usage = metrics
    ? `CPU ${Math.round(metrics.cpuUsedPct)}% of ${metrics.cpuCount}, memory ${mb(metrics.memUsed)} of ${mb(metrics.memTotal)}, disk ${mb(metrics.diskUsed)} of ${mb(metrics.diskTotal)}`
    : undefined
  const gitSkipped = runner.gitSkipped()

  const text = [
    `Commands run: ${mode.off ? "on your machine (/e2b-on to use the sandbox)" : "in the E2B sandbox"}`,
    `Project: ${project}${root ? "" : " (not a git repository, so commands cannot run in the sandbox)"}`,
    `Sandbox: ${sandbox ? sandbox.sandboxId : "not connected (starts on the next command)"}`,
    `Template: ${opts.template}, pauses after ${opts.idleMs / 60_000} min idle`,
    `New sandboxes start from: ${saved ? `snapshot ${saved.snapshotId} (saved ${saved.at})` : `the ${opts.template} template`}`,
    ...(usage ? [`Usage: ${usage}`] : []),
    `Network: ${describeNetwork(opts)}`,
    `Git history in the sandbox: ${
      opts.git === false
        ? "off (git option is false)"
        : gitSkipped
          ? `not sent: ${gitSkipped}. Plain git commands still run on your machine. Set git: true to send it anyway.`
          : "sent"
    }`,
    sync
      ? `Last sync: ${sync.at.toLocaleTimeString()}, sent ${sync.sent} file(s), brought back ${sync.pulled.written.length + sync.pulled.removed.length}, conflicts ${sync.pulled.conflicts.length}`
      : "Last sync: none yet",
    ...(error ? [`Last error: ${error}`] : []),
  ].join("\n")

  const line = [
    mode.off
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
