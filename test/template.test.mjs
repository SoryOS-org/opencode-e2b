import assert from "node:assert/strict"
import test from "node:test"

import { buildManagedTemplateAlias, MANAGED_TEMPLATE_PREFIX } from "../dist/template.js"

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
