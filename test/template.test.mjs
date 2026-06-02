import assert from "node:assert/strict"
import { test } from "bun:test"

import { Template } from "e2b"

import {
  BOOTSTRAP_READY_MARKER,
  buildManagedBaseTemplateAlias,
  buildManagedTemplateAlias,
  buildManagedWorkspaceTemplateAlias,
  buildOpenCodeInstallCommand,
  buildPrebuiltOpenCodeTemplateName,
  buildSystemdServiceInstallCommand,
  buildSystemdStartCommand,
  buildSystemdStartScript,
  buildSystemdUnitContent,
  ensureManagedWorkspaceTemplate,
  MANAGED_TEMPLATE_PREFIX,
  resolveOpenCodeBaseTemplate,
  RUNTIME_ENV_FILE,
} from "../dist/template.js"

const baseInputs = {
  nodeVariant: "22-slim",
  runtimeVersion: "1.14.30",
  baseTemplate: "e2b/opencode:v1.14.30",
  projectPath: "/home/user/project",
  serverPort: 4096,
  pluginPackageVersion: "0.1.0",
}

const baseTemplateInputs = {
  nodeVariant: baseInputs.nodeVariant,
  runtimeVersion: baseInputs.runtimeVersion,
  pluginPackageVersion: baseInputs.pluginPackageVersion,
}

test("buildManagedTemplateAlias is stable for identical inputs", () => {
  assert.equal(buildManagedTemplateAlias(baseInputs), buildManagedTemplateAlias(baseInputs))
})

test("buildManagedBaseTemplateAlias is stable for identical inputs", () => {
  assert.equal(
    buildManagedBaseTemplateAlias(baseTemplateInputs),
    buildManagedBaseTemplateAlias(baseTemplateInputs),
  )
})

test("buildManagedTemplateAlias changes when identity inputs change", () => {
  const baseAlias = buildManagedTemplateAlias(baseInputs)
  const changedAlias = buildManagedTemplateAlias({
    ...baseInputs,
    runtimeVersion: "1.14.31",
  })

  assert.notEqual(changedAlias, baseAlias)
})

test("buildManagedWorkspaceTemplateAlias includes a normalized readable node segment", () => {
  const alias = buildManagedTemplateAlias({
    ...baseInputs,
    nodeVariant: "Node 22 Slim!",
  })

  assert.match(alias, new RegExp(`^${MANAGED_TEMPLATE_PREFIX}workspace-node-22-slim-[a-f0-9]{12}$`))
})

test("buildManagedBaseTemplateAlias includes a normalized readable node segment", () => {
  const alias = buildManagedBaseTemplateAlias({
    ...baseTemplateInputs,
    nodeVariant: "Node 22 Slim!",
  })

  assert.match(alias, new RegExp(`^${MANAGED_TEMPLATE_PREFIX}base-node-22-slim-[a-f0-9]{12}$`))
})

test("buildOpenCodeInstallCommand skips optional binary dependencies", () => {
  assert.equal(buildOpenCodeInstallCommand("1.14.39"), "npm install -g --omit=optional opencode-ai@1.14.39")
})

test("buildPrebuiltOpenCodeTemplateName targets the runtime-specific published template", () => {
  assert.equal(buildPrebuiltOpenCodeTemplateName("1.14.39"), "e2b/opencode:v1.14.39")
})

test("buildSystemdUnitContent points systemd at the opencode start script", () => {
  const unit = buildSystemdUnitContent()

  assert.match(unit, /\[Service\]/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /StandardOutput=journal/)
  assert.match(unit, /StandardError=journal/)
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/opencode-e2b-start/)
})

test("buildSystemdStartScript gates opencode serve on the bootstrap marker", () => {
  const script = buildSystemdStartScript("/home/user/project", 4096)

  assert.match(script, /^#!\/bin\/sh/)
  assert.match(script, /waiting for \/tmp\/\.opencode-e2b-bootstrap-ready/)
  assert.match(script, new RegExp(escapeRegExp(BOOTSTRAP_READY_MARKER)))
  assert.match(script, new RegExp(escapeRegExp(RUNTIME_ENV_FILE)))
  assert.match(script, /cd '\/home\/user\/project'/)
  assert.match(script, /exec \/usr\/local\/bin\/opencode serve --hostname 0\.0\.0\.0 --port 4096/)
})

test("buildSystemdServiceInstallCommand writes the opencode service unit and start script", () => {
  const command = buildSystemdServiceInstallCommand("/home/user/project", 4096)

  assert.match(command, /cat >\/usr\/local\/bin\/opencode-e2b-start <<'EOF'/)
  assert.match(command, /chmod \+x \/usr\/local\/bin\/opencode-e2b-start/)
  assert.match(command, /cat >\/etc\/systemd\/system\/opencode-e2b\.service <<'EOF'/)
  assert.match(command, new RegExp(escapeRegExp(BOOTSTRAP_READY_MARKER)))
  assert.match(command, /Description=OpenCode E2B workspace server/)
  assert.match(command, /EOF$/)
})

test("buildSystemdStartCommand starts the service and streams opencode logs", () => {
  const command = buildSystemdStartCommand()

  assert.match(command, /sudo systemctl daemon-reload/)
  assert.match(command, /sudo systemctl restart opencode-e2b\.service/)
  assert.match(command, /sudo journalctl -fu opencode-e2b\.service -o cat/)
})

test("resolveOpenCodeBaseTemplate uses published opencode templates when present", async () => {
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []

  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return name === "e2b/opencode:v1.14.30" ? [{ tag: "default" }] : []
  }
  Template.build = async () => {
    throw new Error("published base should not build a managed base template")
  }

  try {
    const template = await resolveOpenCodeBaseTemplate(baseTemplateInputs)

    assert.equal(template, "e2b/opencode:v1.14.30")
    assert.deepEqual(calls, [["getTags", "e2b/opencode:v1.14.30"]])
  } finally {
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("resolveOpenCodeBaseTemplate builds a managed base when published template is missing", async () => {
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const inputs = {
    ...baseTemplateInputs,
    runtimeVersion: "9.8.7",
    pluginPackageVersion: "managed-base-test",
  }
  const alias = buildManagedBaseTemplateAlias(inputs)

  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    if (name === "e2b/opencode:v9.8.7") throw new Error("404: tag does not exist")
    return []
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }

  try {
    const template = await resolveOpenCodeBaseTemplate(inputs)

    assert.equal(template, alias)
    assert.deepEqual(calls, [
      ["getTags", "e2b/opencode:v9.8.7"],
      ["getTags", alias],
      ["build", alias],
    ])
  } finally {
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("ensureManagedWorkspaceTemplate builds managed templates", async () => {
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const inputs = {
    ...baseInputs,
    runtimeVersion: "9.8.6",
    pluginPackageVersion: "fallback-test",
  }

  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return []
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }

  try {
    const template = await ensureManagedWorkspaceTemplate(inputs)
    const alias = buildManagedWorkspaceTemplateAlias(inputs)

    assert.equal(template, alias)
    assert.deepEqual(calls, [
      ["getTags", alias],
      ["build", alias],
    ])
  } finally {
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("ensureManagedWorkspaceTemplate deletes errored managed templates before rebuilding", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const originalFetch = globalThis.fetch
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const inputs = {
    ...baseInputs,
    runtimeVersion: "9.8.4",
    pluginPackageVersion: "failed-template-test",
  }
  const alias = buildManagedTemplateAlias(inputs)

  process.env.E2B_API_KEY = "e2b_test"
  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return name === alias ? [{ tag: "default" }] : []
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? input.method ?? "GET"
    calls.push(["fetch", method])
    if (method === "DELETE") {
      return jsonResponse({})
    }
    return jsonResponse([
      {
        templateID: "template-failed",
        names: [alias],
        aliases: [],
        buildStatus: "error",
      },
    ])
  }

  try {
    const template = await ensureManagedWorkspaceTemplate(inputs)

    assert.equal(template, alias)
    assert.deepEqual(calls, [
      ["getTags", alias],
      ["fetch", "GET"],
      ["fetch", "DELETE"],
      ["build", alias],
    ])
  } finally {
    restoreTestEnv(originalApiKey)
    globalThis.fetch = originalFetch
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("ensureManagedWorkspaceTemplate waits for in-progress managed templates", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const originalFetch = globalThis.fetch
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []
  const inputs = {
    ...baseInputs,
    runtimeVersion: "9.8.3",
    pluginPackageVersion: "pending-template-test",
  }
  const alias = buildManagedTemplateAlias(inputs)
  const statuses = ["building", "ready"]

  process.env.E2B_API_KEY = "e2b_test"
  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return name === alias ? [{ tag: "default" }] : []
  }
  Template.build = async () => {
    throw new Error("managed template build should not run while another build is pending")
  }
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? input.method ?? "GET"
    const buildStatus = statuses.shift() ?? "ready"
    calls.push(["fetch", method, buildStatus])
    return jsonResponse([
      {
        templateID: "template-pending",
        names: [alias],
        aliases: [],
        buildStatus,
      },
    ])
  }

  try {
    const template = await ensureManagedWorkspaceTemplate(inputs)

    assert.equal(template, alias)
    assert.deepEqual(calls, [
      ["getTags", alias],
      ["fetch", "GET", "building"],
      ["fetch", "GET", "ready"],
    ])
  } finally {
    restoreTestEnv(originalApiKey)
    globalThis.fetch = originalFetch
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

function restoreTestEnv(originalApiKey) {
  if (originalApiKey === undefined) {
    delete process.env.E2B_API_KEY
  } else {
    process.env.E2B_API_KEY = originalApiKey
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
