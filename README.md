# OpenCode E2B Workspace Plugin

This repository contains a small TypeScript plugin package for OpenCode's experimental workspace API. The current implementation is intentionally open ended: it establishes the module boundaries and lifecycle we want, while keeping the internal pieces easy to expand later.

## Current shape

- `src/index.ts`: plugin entrypoint and workspace adaptor registration.
- `src/config.ts`: option normalization and persisted workspace config.
- `src/e2b.ts`: sandbox creation, lookup, targeting, and teardown.
- `src/upload.ts`: local project snapshot collection and upload pipeline.
- `src/bootstrap.ts`: repository preparation and bootstrap-ready signaling.
- `src/template.ts`: managed E2B template built from a Node base image with the pinned OpenCode runtime baked in.
- `src/types.ts`: shared option and config types.

## What the current scaffold does

- Registers an `e2b` workspace type.
- Builds (once per `(nodeVariant, runtimeVersion, projectPath, serverPort, pluginPackageVersion)`) a managed E2B template that starts from a Node image, installs the pinned OpenCode controller at build time, and launches it from a marker-gated init command.
- Creates an E2B sandbox from that managed template.
- Uploads the current local project snapshot into the sandbox.
- Prepares a repository in the sandbox if needed.
- Writes the temporary `.git/opencode` project marker required by the current OpenCode workspace flow.
- Writes a bootstrap-ready marker (`/tmp/.opencode-e2b-bootstrap-ready`) that the template's baked start command polls for; on detection it `exec`s the pinned `opencode serve`.
- Polls `/global/health` until the server responds.
- Resolves the workspace target to the sandbox host URL.
- Locates existing sandboxes by metadata rather than persisting the E2B sandbox ID in the OpenCode workspace row.

## Important constraint

OpenCode persists the result of `configure()` before it calls `create()`. That means the adaptor cannot create an E2B sandbox and then save the generated `sandboxId` into the workspace row afterward.

The current workaround is metadata-based discovery plus a small persisted workspace compatibility record. The plugin stores that compatibility data in both `WorkspaceInfo.extra` and E2B sandbox metadata:

- `opencodeWorkspaceId`
- `opencodeProjectId`
- `opencodeWorkspaceApiVersion`
- `opencodeRuntimeVersion`
- `opencodeFlags`

The plugin writes those values into E2B sandbox metadata at creation time and looks sandboxes up with `Sandbox.list({ query: { metadata } })` later.

`opencodeFlags` is a serialized list of namespaced provenance markers. Today the scaffold derives flags such as:

- `sync:local-snapshot-upload`
- `repo:git-init`
- `bootstrap:prepare-commands`
- `install:node-base`

Missing flags should be treated as `unknown`, not `false`, so older sandboxes can still be reconciled safely.

## Version handling

- **Minimum supported OpenCode version: `1.14.20`.** Both the local controller and any reused sandbox's baked runtime must meet this floor. The plugin refuses to register against an older local controller, and refuses to attach to a pre-floor sandbox (which is then replaced on next create).
- The local OpenCode runtime version is probed at plugin load via `GET /global/health` against `PluginInput.serverUrl`, which is the running local controller. The probe also gates the floor check, so a missing or too-old controller fails fast at registration time.
- The local version is baked into the managed template at build time via `npm install -g opencode-ai@<version>`, so every sandbox spawned fresh from the template ships a floor-compliant controller by construction.
- The plugin's own package version is also mixed into the managed-template alias hash. That gives plugin releases a simple escape hatch to force a rebuild even when the pinned OpenCode runtime version stays the same.
- The remote sandbox version is probed from `GET /global/health` on the remote OpenCode server. There is no CLI fallback; any sandbox reaching `target()` has already cleared the same health endpoint during `create()`'s readiness wait.
- Above the floor, sandbox reuse still requires the local controller version, the persisted workspace runtime version, and the sandbox metadata runtime version to match. `workspaceApiVersion` remains the real breaking-change gate for broader protocol changes.
- The plugin refuses to attach to a sandbox when:
  - `opencodeWorkspaceApiVersion` does not match the current workspace compatibility version
  - the probed remote OpenCode version is below `1.14.20` (or unparseable)
  - the workspace or sandbox metadata advertises a different OpenCode runtime version than the local controller

Bumping the floor requires a new plugin release; the value lives as a single constant in `src/runtime.ts`.

## Usage

1. Install dependencies:

```bash
npm install
```

2. Build the plugin:

```bash
npm run build
```

3. Register it in your OpenCode config:

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

4. Start OpenCode with experimental workspaces enabled:

```bash
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

## Notes on defaults

- The scaffold defaults to the Node Docker image variant `22-slim`.
- Managed templates are built from `Template().fromNodeImage(nodeVariant)`. Custom base images are not currently supported; that is intentionally deferred to a follow-up.
- The managed template installs the pinned version via `npm install -g opencode-ai@<runtimeVersion>` at build time.
- The template's start command waits for the plugin to create `/tmp/.opencode-e2b-bootstrap-ready`, sources the per-sandbox env file at `/tmp/.opencode-e2b.env`, then `exec`s `/usr/local/bin/opencode serve`. Combined stdout/stderr land in `/tmp/opencode-serve.log` so the plugin can tail them on readiness timeout.
- Per-workspace envs OpenCode delivers via `adaptor.create(config, env)` — `OPENCODE_WORKSPACE_ID`, `OPENCODE_EXPERIMENTAL_WORKSPACES`, `OPENCODE_AUTH_CONTENT`, `OTEL_EXPORTER_OTLP_*` — are written to `/tmp/.opencode-e2b.env` in POSIX-sh `export KEY='value'` form before the bootstrap-ready marker is touched. The baked start command sources that file so the envs reach `opencode serve`. The on-disk env file is required because E2B's `Sandbox.create({envs})` only applies to subsequent `sandbox.commands.run` calls, not to the template's init command.
- The managed template alias is keyed by `nodeVariant`, pinned runtime version, project path, server port, and this plugin's own package version. Changing any of those produces a new alias and triggers a fresh template build on next use.
- The scaffold defaults to public sandbox traffic for the remote workspace URL.
- `bootstrap.installCommand` and `bootstrap.startCommand` are deprecated and ignored. The fields are still accepted by the config schema so old configs load, but the plugin logs a warning and ignores their values. `bootstrap.prepareCommands` still runs after upload and before the bootstrap-ready marker is written.
- The uploader intentionally uses a simple recursive snapshot model today. It excludes common heavy directories but is designed to be replaced with git-aware or tar-stream uploads later.

## Extension points

- Replace the simple snapshot upload with git-aware manifests or incremental sync.
- Add support for cloning from a git remote instead of uploading the working tree.
- Revisit the `.git/opencode` project marker (forced `git init` today) once OpenCode exposes a non-git project-root signal.
- Persist richer workspace metadata in `extra`.
- Add support for secured traffic and OpenCode target headers.
- Add health probes tailored to the OpenCode server once the runtime command is finalized.
