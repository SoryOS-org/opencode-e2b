import assert from "node:assert/strict"
import { test } from "bun:test"
import { isProvider, placeholderEnv, providerNetwork, secretName } from "../dist/v2/providers.js"
import { mergeNetwork } from "../dist/v2/sandbox/create.js"

test("a provider key reaches the box only as an egress rule", () => {
  assert.deepEqual(providerNetwork(["anthropic", "openai"]), {
    rules: {
      "api.anthropic.com": [
        { transform: { headers: { "x-api-key": "${e2b.secrets.opencode-e2b-anthropic}" } } },
      ],
      "api.openai.com": [
        { transform: { headers: { Authorization: "Bearer ${e2b.secrets.opencode-e2b-openai}" } } },
      ],
    },
  })
  assert.equal(providerNetwork([]), undefined)
})

test("the box environment holds placeholders, not keys", () => {
  const env = placeholderEnv(["anthropic"])
  assert.deepEqual(Object.keys(env), ["ANTHROPIC_API_KEY"])
  assert.doesNotMatch(env.ANTHROPIC_API_KEY, /^sk-/)
})

test("provider names", () => {
  assert.equal(isProvider("anthropic"), true)
  assert.equal(isProvider("toString"), false)
  assert.equal(secretName("openrouter"), "opencode-e2b-openrouter")
})

test("network configs merge: lists add up, the second config's rule wins for a host", () => {
  const rule = (header: string) => [{ transform: { headers: { [header]: "x" } } }]
  assert.deepEqual(
    mergeNetwork(
      { allowOut: ["github.com"], rules: { "api.anthropic.com": rule("a"), "api.github.com": rule("b") } },
      { allowOut: ["github.com", "api.anthropic.com"], rules: { "api.anthropic.com": rule("c") } },
    ),
    {
      allowOut: ["github.com", "api.anthropic.com"],
      denyOut: undefined,
      rules: { "api.anthropic.com": rule("c"), "api.github.com": rule("b") },
    },
  )
  assert.equal(mergeNetwork(undefined, undefined), undefined)
})
