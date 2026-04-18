# OpenCode E2B Workspace Plugin

This repository contains a small TypeScript plugin package for OpenCode's experimental workspace API. The current implementation is intentionally open ended: it establishes the module boundaries and lifecycle we want, while keeping the internal pieces easy to expand later.

## Current shape

- `src/index.ts`: plugin entrypoint and workspace adaptor registration.
- `src/config.ts`: option normalization and persisted workspace config.
- `src/e2b.ts`: sandbox creation, lookup, targeting, and teardown.
- `src/upload.ts`: local project snapshot collection and upload pipeline.
- `src/bootstrap.ts`: repository preparation and OpenCode server bootstrap.
- `src/types.ts`: shared option and config types.

## What the first scaffold does

- Registers an `e2b` workspace type.
- Creates an E2B sandbox for the workspace.
- Uploads the current local project snapshot into the sandbox.
- Prepares a repository in the sandbox if needed.
- Writes the temporary `.git/opencode` project marker required by the current OpenCode workspace flow.
- Starts `opencode serve` inside the sandbox.
- Resolves the workspace target to the sandbox host URL.
- Locates existing sandboxes by metadata rather than persisting the E2B sandbox ID in the OpenCode workspace row.

## Important constraint

OpenCode persists the result of `configure()` before it calls `create()`. That means the adaptor cannot create an E2B sandbox and then save the generated `sandboxId` into the workspace row afterward.

The current workaround is metadata-based discovery:

- `opencodeWorkspaceId`
- `opencodeProjectId`
- `opencodeWorkspaceType`

The plugin writes those values into E2B sandbox metadata at creation time and looks sandboxes up with `Sandbox.list({ query: { metadata } })` later.

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
        "template": "base",
        "sandboxTimeoutMs": 3600000,
        "bootstrap": {
          "installCommand": "npm install -g opencode-ai",
          "startCommand": "opencode serve --hostname 0.0.0.0 --port 4096"
        }
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

- The scaffold defaults to public sandbox traffic for the remote workspace URL.
- The bootstrap commands are configurable because the right installation path may differ by E2B template.
- The uploader intentionally uses a simple recursive snapshot model today. It excludes common heavy directories but is designed to be replaced with git-aware or tar-stream uploads later.

## Extension points

- Replace the simple snapshot upload with git-aware manifests or incremental sync.
- Add support for cloning from a git remote instead of uploading the working tree.
- Swap runtime bootstrap for a custom prebuilt E2B template.
- Persist richer workspace metadata in `extra`.
- Add support for secured traffic and OpenCode target headers.
- Add health probes tailored to the OpenCode server once the runtime command is finalized.
