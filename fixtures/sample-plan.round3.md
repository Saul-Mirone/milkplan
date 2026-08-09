# Add rate limiting to the public API

## Context

The `/api/search` endpoint is being hammered by unauthenticated clients, degrading
latency for signed-in users. We will add per-client rate limiting at the gateway
layer with a token-bucket strategy.

## Approach

Use the existing `gateway/middleware` chain. No new service is introduced.

## Implementation steps

1. Add a `RateLimiter` middleware in `gateway/middleware/rate-limit.ts`
   - Token bucket: 60 requests/minute per client key, burst of 10
   - Client key: API key when present, else hashed remote address
2. Store buckets in the existing Redis instance
   - Key schema: `rl:{clientKey}`, TTL 120s
   - Use `EVAL` with a small Lua script for atomic take-or-reject
3. Add config knobs to `gateway/config.ts`

```ts
export interface RateLimitConfig {
  requestsPerMinute: number
  burst: number
  enabled: boolean
}
```

```yaml
rate_limit:
  requests_per_minute: 60
  burst: 10
  enabled: true
```

```jsonc
{
  // Gateway config knobs
  "rateLimit": { "requestsPerMinute": 60, "burst": 10 }
}
```

```zig
// An exotic language exercises the lazy-load path.
pub fn main() void {}
```

## Out of scope

- Per-endpoint differentiated limits (follow-up)
- Dashboard/metrics UI

## Verification

- Unit tests for the token bucket math, including clock skew
- Integration test: 61 rapid requests → last one gets 429 with Retry-After
- Manual: `hey -n 200 -c 20` against staging, confirm p99 for authed users improves
