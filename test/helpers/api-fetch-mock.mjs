// Test helper for intercepting the E2B API client's HTTP calls.
//
// The e2b SDK resolves its API `fetch` lazily and caches the result
// process-wide on the first API call (see `createApiFetch` in the SDK). Under
// Bun the resolved fetcher is simply the value of `globalThis.fetch` captured
// at that moment. That means a test which reassigns `globalThis.fetch` *after*
// the first API call has already run is silently ignored, and the captured
// fetcher from whichever test ran first leaks into every later test.
//
// To stay compatible with that caching, we install a single stable
// `globalThis.fetch` shim once, before any API call, and route per-test
// behavior through a mutable handler. The SDK captures the shim by value, and
// the shim always delegates to whatever handler the current test installed.
let handler = null
let installed = false
let realFetch = null

export function installApiFetchShim() {
  if (installed) return
  installed = true
  realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (handler) return handler(input, init)
    return realFetch(input, init)
  }
}

export function setApiFetchHandler(fn) {
  handler = fn
}

export function clearApiFetchHandler() {
  handler = null
}
