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
- ensures the uploaded project has a git repository and writes `.git/opencode`;
- writes per-workspace OpenCode env values to `/tmp/.opencode-e2b.env`;
- releases the managed workspace template's marker-gated systemd `opencode serve` service;
- waits for `/global/health` before returning the remote workspace target.

OpenCode persists `configure()` before `create()`, so the plugin does not store E2B sandbox IDs in the OpenCode workspace row. Instead it writes workspace metadata to E2B and later finds sandboxes with `Sandbox.list`.

## Compatibility

- Minimum supported OpenCode runtime: `1.14.32`.
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
