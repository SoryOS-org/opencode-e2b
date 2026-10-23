import assert from "node:assert/strict"
import { test } from "bun:test"
import { describeNetwork, networkFor, parseOptions } from "../dist/v2/options.js"

test("defaults leave the network untouched", () => {
  const opts = parseOptions(undefined)
  assert.equal(opts.template, "opencode")
  assert.equal(opts.git, "auto")
  assert.equal(networkFor(opts), undefined)
  assert.equal(describeNetwork(opts), "all egress allowed, no secrets")
})

test("a secret becomes a header rule with a placeholder, never the value", () => {
  const net = networkFor(parseOptions({ secrets: { "api.github.com": "github-token" } }))
  assert.deepEqual(net, {
    rules: {
      "api.github.com": [{ transform: { headers: { Authorization: "Bearer ${e2b.secrets.github-token}" } } }],
    },
  })
})

test("a custom header and prefix are kept", () => {
  const net = networkFor(
    parseOptions({ secrets: { "registry.example.com": { secret: "npm", header: "X-Token", prefix: "" } } }),
  )
  assert.deepEqual(net?.rules, {
    "registry.example.com": [{ transform: { headers: { "X-Token": "${e2b.secrets.npm}" } } }],
  })
})

test("with restricted egress, secret hosts are added to the allow list", () => {
  const net = networkFor(
    parseOptions({ network: { denyOut: ["0.0.0.0/0"] }, secrets: { "api.github.com": "github-token" } }),
  )
  assert.deepEqual(net?.allowOut, ["api.github.com"])
  assert.deepEqual(net?.denyOut, ["0.0.0.0/0"])
  const merged = networkFor(
    parseOptions({
      network: { allowOut: ["registry.npmjs.org", "api.github.com"] },
      secrets: { "api.github.com": "gh" },
    }),
  )
  assert.deepEqual(merged?.allowOut, ["registry.npmjs.org", "api.github.com"])
})

test("bad options fail loudly", () => {
  assert.throws(() => parseOptions({ secrets: { "api.github.com": 42 } }), /secrets\["api.github.com"\]/)
  assert.throws(() => parseOptions({ network: { allowOut: "npmjs.org" } }), /network.allowOut/)
  assert.throws(() => parseOptions({ idleMinutes: 0 }), /idleMinutes/)
  assert.throws(() => parseOptions({ domain: "" }), /domain/)
  assert.throws(() => parseOptions({ git: "yes" }), /git/)
})
