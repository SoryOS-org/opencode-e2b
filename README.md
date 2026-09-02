# OpenCode E2B Workspace Plugin

TypeScript plugin for OpenCode's experimental workspace API. It registers an `e2b` workspace type that provisions remote OpenCode workspaces in E2B sandboxes.

## Install

```bash
bun install
bun run build
```

Register the built plugin in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-e2b/dist/index.js",
      {
        "nodeVariant": "22-slim",
        "sandboxTimeoutMs": 3600000
      }
    ]
  ]
}
```

Start OpenCode with workspace support enabled:

```bash
E2B_API_KEY=... OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

## Development

```bash
bun run format:check
bun run typecheck
bun run test
```

The plugin is loaded by OpenCode's Bun runtime and uses Bun as its development runtime. `bun run test` builds `dist/` first, then runs the Bun test runner against `test/*.test.mjs`.

## Runtime Behavior

The plugin builds sandboxes from a local workspace wrapper template. That wrapper first tries to layer on top of the published E2B template `e2b/opencode:v<runtimeVersion>`. E2B cannot call `get_tags` across teams, so the plugin does not preflight published template tags; it tries the published base directly and falls back if that wrapper build fails. If the published runtime template is unavailable, the plugin builds a managed base template from the configured Node image and installs the pinned OpenCode runtime there, then builds the same workspace wrapper on top of that base.

Managed base and workspace templates use the `opencode-e2b-` alias prefix. Base templates are keyed by Node image, OpenCode runtime version, and plugin package version. Workspace wrapper templates are keyed by the selected base template, project path, server port, and plugin package version.

On workspace create, the plugin:

- finds an existing compatible sandbox for the workspace or creates a new one;
- uploads the local project snapshot into the sandbox;
- ensures the uploaded project has a git repository with the snapshot committed, and writes `.git/opencode`;
- writes per-workspace OpenCode env values to `/tmp/.opencode-e2b.env`;
- releases the managed workspace template's marker-gated systemd `opencode serve` service;
- waits for `/global/health`, then for the sync endpoints (`/global/event` and `/sync/history`) before returning the remote workspace target.

OpenCode persists `configure()` before `create()`, so the plugin does not store E2B sandbox IDs in the OpenCode workspace row. Instead it writes workspace metadata to E2B and later finds sandboxes with `Sandbox.list`.

## Session Warp

_Session warp_ moves a session's sync history into a target workspace — or detaches it back to the local project. It runs through OpenCode's `experimental/workspace/warp` endpoint.

When a session is warped out of a workspace, OpenCode offers to move the workspace's file changes with it. Those changes are the sandbox repository's working-tree diff against the snapshot the plugin committed at bootstrap, applied as a patch to your project: your local history is untouched, and work the agent commits inside the sandbox does not travel back. Your project must be a git repository root for the patch to apply.

> **Heads up:** OpenCode's experimental workspace API is still unstable, so re-check this when bumping the supported runtime.

## Known limitations

**1. Experimental foundation.**
This plugin uses the `experimental_workspace` API of OpenCode. You must set `OPENCODE_EXPERIMENTAL_WORKSPACES=true`. OpenCode can change this API without notice.

**2. macOS and Linux hosts only.**
The sandbox stores the project at the same path as the host. This makes a session directory valid on both machines. Windows paths cannot exist on both machines. On Windows, the plugin uses `/home/user/project` in the sandbox instead. The host cannot open that path. You can create a workspace on Windows. But a prompt inside that workspace does not get a reply. A warped session does not work either.

**3. A sandbox does not survive an idle period.**
E2B pauses a sandbox after `sandboxTimeoutMs`. The default is 1 hour. OpenCode does not reconnect to a paused sandbox. The workspace shows as unavailable. You must create the workspace again. For long sessions, set a higher `sandboxTimeoutMs`.

**4. Warp of a session with history can fail.**
A warp of a new session is reliable. A warp of a session with existing messages can fail with a sync error ("sequence mismatch"). If this happens, try the warp again, or start the session inside the workspace.

## Compatibility

- Minimum supported OpenCode runtime: `1.16.0`.
- The plugin targets `@opencode-ai/plugin` `1.18.23` (with `e2b` `2.46.0`) and registers the current `WorkspaceAdapter` shape directly. The `WorkspaceAdapter` shape is unchanged across `1.16.x`–`1.18.x`, so the runtime floor is independent of the SDK version.
- Minimum supported Bun runtime: `1.3.0`; the exact Bun version is intentionally left to OpenCode.
- The local runtime version is probed from `PluginInput.serverUrl`.
- The remote runtime version is probed from the sandbox `/global/health` endpoint.
- Reuse requires a matching workspace API version and a remote runtime at or above the supported floor.
- Plugin registration does not probe the local server, so config/debug commands can load the plugin before the OpenCode controller is listening.

## Options

Common options:

- `nodeVariant`: Node image variant for E2B managed templates. Default: `22-slim`.
- `sandboxTimeoutMs`: E2B sandbox timeout. Default: 1 hour.
- `projectPath`: project directory inside the sandbox. Default: `/home/user/project`.
- `serverPort`: remote OpenCode server port. Default: `4096`.
- `secure`: enable E2B secure sandbox controller traffic. Default: `true`.
- `network.allowPublicTraffic`: allow unauthenticated access to sandbox service URLs. Default: `false`. When disabled, target requests include E2B's `e2b-traffic-access-token` header.
- `upload.ignore`: path literals or path segments skipped during snapshot upload.
- `upload.includeDotGit`: include the local `.git` directory. Default: `false`.
- `upload.followSymlinks`: follow symlinks during upload. Default: `false`.
- `templateGc`: best-effort cleanup for old managed templates.

`bootstrap.prepareCommands` still runs after upload and before the remote OpenCode server starts. `bootstrap.installCommand` and `bootstrap.startCommand` are accepted for older configs but ignored; the selected base template provides the pinned OpenCode runtime and the local workspace wrapper owns startup through a marker-gated systemd service. Service logs are written to journald and streamed with `journalctl -f` from the template start command.

## Template Cleanup

Managed templates use the `opencode-e2b-` alias prefix. A best-effort cleanup pass runs at plugin load and after workspace removal. Ready templates are deletion candidates when the most recent of `lastSpawnedAt`, `updatedAt`, and `createdAt` is older than the configured TTL.

```json
{
  "templateGc": {
    "enabled": true,
    "ttlMs": 259200000,
    "cooldownMs": 600000
  }
}
```
