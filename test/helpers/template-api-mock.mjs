import { Template } from "e2b"

import { clearApiFetchHandler, setApiFetchHandler } from "./api-fetch-mock.mjs"
import { FAKE_E2B_API_KEY } from "./fixtures.mjs"

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

/**
 * Run `fn(calls)` with the E2B template API fully mocked: fake API key,
 * `Template.getTags` forbidden, `Template.build` and the API fetch recorded
 * into `calls` — everything restored afterwards no matter how `fn` exits.
 *
 * Override points (each receives `calls` and returns the stub):
 * - `options.fetch(calls)` — replaces the default empty-list fetch handler.
 * - `options.build(calls)` — replaces the default recording build stub.
 */
export async function withTemplateApiMocks(fn, options = {}) {
  const originalApiKey = process.env.E2B_API_KEY
  const originalGetTags = Template.getTags
  const originalBuild = Template.build
  const calls = []

  process.env.E2B_API_KEY = FAKE_E2B_API_KEY
  Template.getTags = async () => {
    throw new Error("managed template lookup should not call getTags")
  }
  Template.build =
    options.build?.(calls) ??
    (async (_template, name) => {
      calls.push(["build", name])
    })
  setApiFetchHandler(
    options.fetch?.(calls) ??
      (async (input, init) => {
        const method = init?.method ?? input.method ?? "GET"
        calls.push(["fetch", method])
        return jsonResponse([])
      }),
  )

  try {
    return await fn(calls)
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.E2B_API_KEY
    } else {
      process.env.E2B_API_KEY = originalApiKey
    }
    clearApiFetchHandler()
    Template.getTags = originalGetTags
    Template.build = originalBuild
  }
}
