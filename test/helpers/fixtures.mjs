// Shared, non-secret test fixtures.

// Dummy E2B API key for tests. This is NOT a real credential: it is the literal
// `e2b_` prefix followed by 40 hex zeros — the placeholder the e2b SDK itself
// documents, and the minimal value that satisfies the SDK's key-format check
// (/^e2b_[0-9a-f]+$/). Every test that sets it also mocks the E2B client, so
// this value never authenticates against the E2B API.
export const FAKE_E2B_API_KEY = "e2b_0000000000000000000000000000000000000000"
