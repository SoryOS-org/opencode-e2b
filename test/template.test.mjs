import assert from "node:assert/strict"
import test from "node:test"

import { Template } from "e2b"

import {
  buildManagedTemplateAlias,
  buildOpenCodeInstallCommand,
  buildPrebuiltOpenCodeTemplateName,
  ensureManagedWorkspaceTemplate,
  MANAGED_TEMPLATE_PREFIX,
} from "../dist/template.js"

const baseInputs = {
  nodeVariant: "22-slim",
  runtimeVersion: "1.14.30",
  projectPath: "/home/user/project",
  serverPort: 4096,
  pluginPackageVersion: "0.1.0",
}

test("buildManagedTemplateAlias is stable for identical inputs", () => {
  assert.equal(buildManagedTemplateAlias(baseInputs), buildManagedTemplateAlias(baseInputs))
})

test("buildManagedTemplateAlias changes when identity inputs change", () => {
  const baseAlias = buildManagedTemplateAlias(baseInputs)
  const changedAlias = buildManagedTemplateAlias({
    ...baseInputs,
    runtimeVersion: "1.14.31",
  })

  assert.notEqual(changedAlias, baseAlias)
})

test("buildManagedTemplateAlias includes a normalized readable node segment", () => {
  const alias = buildManagedTemplateAlias({
    ...baseInputs,
    nodeVariant: "Node 22 Slim!",
  })

  assert.match(alias, new RegExp(`^${MANAGED_TEMPLATE_PREFIX}node-22-slim-[a-f0-9]{12}$`))
})

test("buildOpenCodeInstallCommand skips optional binary dependencies", () => {
  assert.equal(buildOpenCodeInstallCommand("1.14.39"), "npm install -g --omit=optional opencode-ai@1.14.39")
})

test("buildPrebuiltOpenCodeTemplateName targets the runtime-specific published template", () => {
  assert.equal(buildPrebuiltOpenCodeTemplateName("1.14.39"), "opencode:1.14.39")
})

test("ensureManagedWorkspaceTemplate reuses a matching prebuilt template", async () => {
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []

  Template.getTags = async (name) => {
    calls.push(["getTags", name])
    return [{ tag: "9.8.7" }]
  }
  Template.build = async () => {
    throw new Error("managed template build should not run")
  }

  try {
    const template = await ensureManagedWorkspaceTemplate({
      ...baseInputs,
      runtimeVersion: "9.8.7",
      pluginPackageVersion: "prebuilt-test",
    })

    assert.equal(template, "opencode:9.8.7")
    assert.deepEqual(calls, [["getTags", "opencode"]])
  } finally {
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})

test("ensureManagedWorkspaceTemplate falls back to managed templates when prebuilt is absent", async () => {
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
    if (name === "opencode") {
      return [{ tag: "9.8.5" }]
    }
    return []
  }
  Template.build = async (_template, name) => {
    calls.push(["build", name])
  }

  try {
    const template = await ensureManagedWorkspaceTemplate(inputs)
    const alias = buildManagedTemplateAlias(inputs)

    assert.equal(template, alias)
    assert.deepEqual(calls, [
      ["getTags", "opencode"],
      ["getTags", alias],
      ["build", alias],
    ])
  } finally {
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
})
