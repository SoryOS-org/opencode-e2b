import assert from "node:assert/strict"
import { test } from "bun:test"

import { startResumeProxy } from "../dist/resume-proxy.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A controllable fake "sandbox": echoes requests, returns a gzipped body, and streams SSE
// that ends after a couple events (each new connection is a new "generation").
function startFakeSandbox() {
  let eventGen = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/echo") {
        return Response.json({ method: req.method, token: req.headers.get("x-token") })
      }
      if (url.pathname === "/gzipped") {
        // Real gzip body + content-encoding header — the proxy's fetch decompresses it,
        // so the proxy must NOT forward content-encoding/-length.
        const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ ok: true, from: "sandbox" })))
        return new Response(gz, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(gz.length),
          },
        })
      }
      if (url.pathname === "/global/event") {
        const gen = ++eventGen
        const body = new ReadableStream({
          async start(c) {
            const enc = new TextEncoder()
            c.enqueue(enc.encode(`data: gen${gen}:a\n\n`))
            await sleep(20)
            c.enqueue(enc.encode(`data: gen${gen}:b\n\n`))
            await sleep(20)
            c.close() // simulate the stream ending (sandbox paused / dropped)
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: new URL(`http://127.0.0.1:${server.port}`),
    stop: () => server.stop(true),
  }
}

// A proxy whose cached upstream is dead (sandbox "paused") until a revive flips it live.
function pausedSandboxProxy(fake) {
  const deadUrl = new URL("http://127.0.0.1:1") // guaranteed connection refused
  const reviveCalls = []
  const state = { down: true }
  const proxy = startResumeProxy({
    resolveUpstream: async (revive) => {
      reviveCalls.push(revive)
      if (state.down && !revive) return { baseUrl: deadUrl }
      state.down = false // "resume" on revive
      return { baseUrl: fake.url }
    },
  })
  return { proxy, reviveCalls }
}

// Read one SSE connection to completion, collecting `gen<N>:<x>` events.
async function readSseToEnd(url) {
  const res = await fetch(url, { headers: { accept: "text/event-stream" } })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ""
  let endedCleanly = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        endedCleanly = true
        break
      }
      buffer += dec.decode(value, { stream: true })
    }
  } catch {
    endedCleanly = false
  }
  const events = [...buffer.matchAll(/data: (gen\d+:[ab])/g)].map((m) => m[1])
  return { contentType: res.headers.get("content-type"), events, endedCleanly }
}

test("resume-proxy forwards a plain GET and injects upstream auth headers", async () => {
  const fake = startFakeSandbox()
  const proxy = startResumeProxy({
    resolveUpstream: async () => ({ baseUrl: fake.url, headers: { "x-token": "secret" } }),
  })
  try {
    const res = await fetch(new URL("/echo", proxy.url))
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.method, "GET")
    assert.equal(body.token, "secret") // injected by the proxy, not sent by the client
  } finally {
    proxy.stop()
    fake.stop()
  }
})

test("resume-proxy delivers gzipped upstream responses without a decode mismatch", async () => {
  const fake = startFakeSandbox()
  const proxy = startResumeProxy({ resolveUpstream: async () => ({ baseUrl: fake.url }) })
  try {
    const res = await fetch(new URL("/gzipped", proxy.url))
    assert.equal(res.headers.get("content-encoding"), null) // stripped
    assert.deepEqual(await res.json(), { ok: true, from: "sandbox" })
  } finally {
    proxy.stop()
    fake.stop()
  }
})

test("resume-proxy revives the paused sandbox and retries when the first forward fails", async () => {
  const fake = startFakeSandbox()
  const { proxy, reviveCalls } = pausedSandboxProxy(fake)
  try {
    const res = await fetch(new URL("/echo", proxy.url))
    assert.equal(res.status, 200)
    assert.deepEqual(reviveCalls, [false, true]) // tried cached, failed, then revived
  } finally {
    proxy.stop()
    fake.stop()
  }
})

test("resume-proxy closes the client SSE gracefully when upstream ends (so OpenCode reconnects)", async () => {
  const fake = startFakeSandbox()
  const proxy = startResumeProxy({ resolveUpstream: async () => ({ baseUrl: fake.url }) })
  try {
    const first = await readSseToEnd(new URL("/global/event", proxy.url))
    assert.equal(first.contentType, "text/event-stream")
    assert.deepEqual(first.events, ["gen1:a", "gen1:b"])
    assert.ok(first.endedCleanly, "client SSE should end gracefully, not error")

    // A fresh connect (OpenCode's reconnect) gets the next upstream generation.
    const second = await readSseToEnd(new URL("/global/event", proxy.url))
    assert.deepEqual(second.events, ["gen2:a", "gen2:b"])
  } finally {
    proxy.stop()
    fake.stop()
  }
})

test("resume-proxy revives the paused sandbox on an SSE connect failure", async () => {
  const fake = startFakeSandbox()
  const { proxy, reviveCalls } = pausedSandboxProxy(fake)
  try {
    const result = await readSseToEnd(new URL("/global/event", proxy.url))
    assert.deepEqual(result.events, ["gen1:a", "gen1:b"], "connected after reviving")
    assert.deepEqual(reviveCalls, [false, true], "tried cached, failed, then revived")
  } finally {
    proxy.stop()
    fake.stop()
  }
})
