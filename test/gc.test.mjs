import assert from "node:assert/strict"
import { test } from "bun:test"

import { MANAGED_TEMPLATE_PREFIX } from "../dist/template.js"
import { runTemplateGC, selectStaleManagedTemplates } from "../dist/gc.js"

const now = Date.parse("2026-05-01T12:00:00.000Z")
const ttlMs = 60 * 60 * 1000

test("runTemplateGC skips when E2B_API_KEY is missing", async () => {
  const originalApiKey = process.env.E2B_API_KEY
  const calls = []
  const logger = {
    debug: (message) => calls.push(["debug", message]),
    info: (message) => calls.push(["info", message]),
    warn: (message) => calls.push(["warn", message]),
    error: (message) => calls.push(["error", message]),
  }

  delete process.env.E2B_API_KEY

  try {
    await runTemplateGC(
      {
        enabled: true,
        ttlMs,
        cooldownMs: 0,
      },
      logger,
    )

    assert.deepEqual(calls, [
      ["info", "template gc start"],
      ["debug", "template gc skipped; E2B_API_KEY is not set"],
    ])
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.E2B_API_KEY
    } else {
      process.env.E2B_API_KEY = originalApiKey
    }
  }
})

test("selectStaleManagedTemplates returns ready managed templates older than ttl", () => {
  const stale = selectStaleManagedTemplates(
    [
      {
        templateID: "template-stale",
        names: [`team/${MANAGED_TEMPLATE_PREFIX}node-abc123`],
        buildStatus: "ready",
        updatedAt: "2026-05-01T10:00:00.000Z",
      },
      {
        templateID: "template-fresh",
        names: [`${MANAGED_TEMPLATE_PREFIX}node-fresh`],
        buildStatus: "ready",
        updatedAt: "2026-05-01T11:30:00.000Z",
      },
      {
        templateID: "template-other",
        names: ["other-template"],
        buildStatus: "ready",
        updatedAt: "2026-05-01T09:00:00.000Z",
      },
      {
        templateID: "template-building",
        names: [`${MANAGED_TEMPLATE_PREFIX}node-building`],
        buildStatus: "building",
        updatedAt: "2026-05-01T09:00:00.000Z",
      },
    ],
    now,
    ttlMs,
  )

  assert.deepEqual(
    stale.map((candidate) => ({
      templateID: candidate.entry.templateID,
      alias: candidate.alias,
      ageMs: candidate.ageMs,
    })),
    [
      {
        templateID: "template-stale",
        alias: `${MANAGED_TEMPLATE_PREFIX}node-abc123`,
        ageMs: 2 * 60 * 60 * 1000,
      },
    ],
  )
})

test("selectStaleManagedTemplates falls back to aliases when names are absent", () => {
  const stale = selectStaleManagedTemplates(
    [
      {
        templateID: "template-stale",
        aliases: [`${MANAGED_TEMPLATE_PREFIX}node-legacy`],
        buildStatus: "ready",
        createdAt: "2026-05-01T09:30:00.000Z",
      },
    ],
    now,
    ttlMs,
  )

  assert.equal(stale[0].alias, `${MANAGED_TEMPLATE_PREFIX}node-legacy`)
})

test("selectStaleManagedTemplates checks aliases when names are present", () => {
  const stale = selectStaleManagedTemplates(
    [
      {
        templateID: "template-stale",
        names: ["team/other-template"],
        aliases: [`${MANAGED_TEMPLATE_PREFIX}node-alias`],
        buildStatus: "ready",
        createdAt: "2026-05-01T09:30:00.000Z",
      },
    ],
    now,
    ttlMs,
  )

  assert.equal(stale[0].alias, `${MANAGED_TEMPLATE_PREFIX}node-alias`)
})
