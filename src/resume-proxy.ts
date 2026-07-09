import type { PluginLogger } from "./types.js"

/** Where the proxy should forward to right now (the live sandbox host + auth headers). */
export type UpstreamTarget = {
  baseUrl: URL
  headers?: Record<string, string>
}

/**
 * Resolve the current upstream. `revive: true` means the previous attempt failed
 * (sandbox likely paused / serve down) — resume the sandbox and only return once it is
 * reachable, or throw if it cannot.
 */
export type ResolveUpstream = (revive: boolean) => Promise<UpstreamTarget>

export type ResumeProxyHandle = {
  /** URL the plugin returns from `target()` — a stable local address. */
  url: URL
  port: number
  stop: () => void
}

const SSE_CONTENT_TYPE = "text/event-stream"

/**
 * A local reverse proxy fronting a remote E2B sandbox. `target()` hands OpenCode this
 * proxy's URL instead of the raw sandbox host, so the plugin owns the connection and can
 * resume a paused/dropped sandbox on demand.
 *
 * Key behavior: when the sandbox's event stream drops (pause / blip), the proxy closes
 * OpenCode's stream *gracefully* rather than holding it open and reconnecting underneath.
 * A clean end puts OpenCode's `syncWorkspaceLoop` on its `disconnected` path, so it
 * reconnects AND re-runs its own `syncHistory` backfill — which is what keeps event
 * sequences from diverging over long sessions. The proxy only owns sandbox liveness
 * (resume-on-reconnect); sync correctness stays with OpenCode.
 */
export function startResumeProxy(deps: {
  resolveUpstream: ResolveUpstream
  logger?: PluginLogger
  hostname?: string
}): ResumeProxyHandle {
  const { resolveUpstream, logger } = deps

  const server = Bun.serve({
    hostname: deps.hostname ?? "127.0.0.1",
    port: 0,
    idleTimeout: 255, // SSE streams are long-lived
    fetch(req) {
      const url = new URL(req.url)
      const accept = req.headers.get("accept") ?? ""
      return accept.includes(SSE_CONTENT_TYPE)
        ? handleEventStream(req, url, resolveUpstream, logger)
        : handleRequest(req, url, resolveUpstream, logger)
    },
  })

  const port = server.port ?? 0
  return {
    url: new URL(`http://${server.hostname}:${port}`),
    port,
    stop: () => server.stop(true),
  }
}

function upstreamUrl(url: URL, target: UpstreamTarget): URL {
  return new URL(url.pathname + url.search, target.baseUrl)
}

function forwardHeaders(reqHeaders: Headers, target: UpstreamTarget): Headers {
  const headers = new Headers(reqHeaders)
  headers.delete("host")
  headers.delete("connection")
  // We buffer the body and let fetch set framing; forwarding the client's original
  // content-length/transfer-encoding leaves conflicting framing the E2B edge rejects.
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  for (const [key, value] of Object.entries(target.headers ?? {})) headers.set(key, value)
  return headers
}

/** fetch auto-decompresses; strip stale framing so the client doesn't try to decode again. */
function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  headers.delete("connection")
  return headers
}

/** Plain request/response passthrough. First attempt uses the cached upstream; on a
 *  connection failure, revive the sandbox once and retry. */
async function handleRequest(
  req: Request,
  url: URL,
  resolveUpstream: ResolveUpstream,
  logger?: PluginLogger,
): Promise<Response> {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revive = attempt > 0
    let target: UpstreamTarget
    try {
      target = await resolveUpstream(revive)
    } catch (error) {
      await logger?.warn("resume-proxy: could not resolve upstream", { revive, error: `${error}` })
      return new Response("workspace unavailable", { status: 503 })
    }

    try {
      const response = await fetch(upstreamUrl(url, target), {
        method: req.method,
        headers: forwardHeaders(req.headers, target),
        body,
        redirect: "manual",
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers),
      })
    } catch (error) {
      await logger?.warn("resume-proxy: forward failed", { attempt, error: `${error}` })
      if (revive) return new Response("workspace unavailable", { status: 502 })
      // fall through to attempt 1, which forces a revive
    }
  }

  return new Response("workspace unavailable", { status: 502 })
}

/** SSE passthrough. Connects (reviving the sandbox if paused) and pipes the event stream.
 *  On drop, closes the client stream gracefully so OpenCode reconnects + backfills. */
function handleEventStream(
  req: Request,
  url: URL,
  resolveUpstream: ResolveUpstream,
  logger?: PluginLogger,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let upstream: Response | undefined
      for (let attempt = 0; attempt < 2 && !req.signal.aborted; attempt += 1) {
        let target: UpstreamTarget
        try {
          target = await resolveUpstream(attempt > 0)
        } catch (error) {
          await logger?.warn("resume-proxy: sse resolve failed", { error: `${error}` })
          break
        }
        try {
          const response = await fetch(upstreamUrl(url, target), {
            headers: forwardHeaders(req.headers, target),
            signal: req.signal,
          })
          if (response.ok && response.body) {
            upstream = response
            await logger?.info("resume-proxy: sse upstream connected", {
              url: upstreamUrl(url, target).toString(),
            })
            break
          }
        } catch (error) {
          await logger?.warn("resume-proxy: sse connect failed; will revive", { attempt, error: `${error}` })
        }
      }

      if (upstream?.body) {
        try {
          const reader = upstream.body.getReader()
          while (!req.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) controller.enqueue(value)
          }
        } catch (error) {
          // Absorb the abrupt drop; we still close cleanly below so OpenCode treats it as
          // a graceful disconnect (→ reconnect + syncHistory backfill), not a fatal error.
          await logger?.warn("resume-proxy: sse upstream dropped", { error: `${error}` })
        }
      }

      try {
        controller.close()
      } catch {
        // already closed
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}
