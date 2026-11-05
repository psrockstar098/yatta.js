# Rate limiting

> Draft for review. Not published to the docs site.

A general rate-limit middleware for the onion pipeline. It is separate
from auth's own attempt limits (login, signup, magic link, passkey),
which stay exactly as they are. Use this one for ordinary routes and
for endpoints that had no limiter, like `/oauth/token`.

```ts
import { createAPI } from "yatta.js/api";
import { createRateLimit, oauthTokenRateLimit } from "yatta.js/ratelimit";

const api = createAPI();

// 100 requests per minute, per IP, per route.
api.use(createRateLimit({ limit: 100, windowSec: 60 }));

api.get("/hello", () => new Response("hi"));
```

## Per-route overrides

The route is part of every key, so one route's budget never affects
another's. An override replaces the default rule for that route only.

```ts
api.use(
  createRateLimit({
    limit: 100,
    windowSec: 60,
    routes: {
      "/sensitive": { limit: 5, windowSec: 60 },
    },
  }),
);
```

## Per-user limits

Add `"user"` to `dimensions` and the middleware checks a second bucket
for the authenticated user, across IPs. A request must pass every
bucket that applies to it, and a refused request consumes none of the
buckets that passed.

```ts
api.use(authMiddleware); // puts the user on ctx.state.user first
api.use(createRateLimit({ limit: 100, windowSec: 60, dimensions: ["ip", "user"] }));
```

| Option | Default | What it does |
| --- | --- | --- |
| `limit` | `100` | Requests allowed per window, per bucket |
| `windowSec` | `60` | Window length, in seconds |
| `routes` | — | Per-route overrides, keyed by path |
| `dimensions` | `["ip"]` | Buckets to check: `"ip"`, `"user"` |
| `store` | In-memory | Counter store (see below) |
| `maxKeys` | `100000` | Distinct keys before new keys share one fallback bucket |
| `trustProxy` | `false` | Read forwarded headers for the client IP |
| `trustedProxyCount` | `1` | Proxies trusted to append to `x-forwarded-for` |
| `getClientIp` | — | Peer address resolver (see below) |
| `escalation` | 3 violations per level, max level 2 | Penalty tuning |

## The penalty policy

No flat block, no lockout. A violation is one window in which a key
went over its limit; further over-limit requests in that same window
do not add more violations, so one burst cannot jump a key to the
harshest treatment.

- 0–2 violations: the normal limit and window.
- 3–5 violations: the limit is halved (never below 1) and the window
  is doubled.
- 6 or more violations: the limit is 1 per window and the window is
  four times the base window.
- A full window with no violation removes one violation, so good
  behaviour restores normal treatment. A degraded key is slowed,
  never silenced outright, and no account is ever locked out by this
  middleware.

Refused requests answer `429` with a `Retry-After` header and a
generic body. Successful responses carry `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers, and the
same numbers are on `ctx.state.rateLimit` for handlers.

## The OAuth token endpoint

The OAuth module flags `/oauth/token` as having no rate limiting.
This preset covers it: 5 token requests per minute per IP.

```ts
import { oauthTokenRateLimit } from "yatta.js/ratelimit";

const oauthApi = createAPI();
oauthApi.use(oauthTokenRateLimit());
oauthApi.post("/token", (ctx) => oauth.handleToken(ctx.req));
```

It changes nothing about OAuth itself — it only refuses the 6th
request. Pass options to tighten or loosen it for a deployment.

## Wiring the real client IP

Bun does not put the peer address on `Request`. Under `Bun.serve`
it comes from `server.requestIP(req)`, which is the second argument
to the `fetch` handler and returns `{ address, port }`, or `null`
for a closed request or a Unix socket. Wire it like this:

```ts
const server = Bun.serve({
  fetch(req, server) {
    return api.handle(req, {});
  },
});

// Wherever the limiter is created:
createRateLimit({
  getClientIp: (req) => server.requestIP(req)?.address,
});
```

Without `getClientIp`, and without a peer address recorded at the
edge, the middleware uses an `"unknown"` bucket — every unidentified
client shares it. In production, always supply `getClientIp`.

## Cluster-wide limiting

Counters live behind a `RateLimitStore` — `get`, `set` with a TTL in
seconds, `delete` — the same shape as the auth attempt store. The
default is in-memory and single-process. For more than one process,
supply a store backed by storage every process can see, following
the same pattern as a custom auth or OAuth store; the middleware
itself does not change.

```ts
const store = {
  async get(key) { /* ... */ },
  async set(key, data, ttlSec) { /* ... */ },
  async delete(key) { /* ... */ },
};
api.use(createRateLimit({ store }));
```

## Gotchas

- **Forwarded headers are ignored by default.** Only set
  `trustProxy` when a proxy you control sets those headers and
  strips any incoming copy. Otherwise a client forges a fresh
  `x-forwarded-for` per request and mints a fresh bucket each time.
  When trusted, the client IP is counted back from the right-hand
  end of `x-forwarded-for` past `trustedProxyCount` entries — the
  leftmost entry is the one the client wrote, so it is never used.
- **Put the limiter on the router that owns the route.** A parent
  router's middleware does not run for mounted child routers, so a
  limiter on the parent does not cover a mounted `/oauth` router.
  Apply it on the child router itself.
- **Per-user limiting needs auth first.** The user comes from
  `ctx.state.user` (a string id, or an object with an `id`), so the
  auth middleware must run before this one. A request with no user
  simply has no per-user bucket; it is never put in a shared
  "anonymous" bucket.
- **Shared IPs share a bucket.** Clients behind one NAT address or
  one egress proxy count together on the per-IP bucket. The per-user
  bucket is the fix for authenticated routes; for anonymous routes
  this is inherent to per-IP limiting, and the minimum limit of 1
  keeps a shared address from being silenced outright.
- **IPv4-mapped IPv6 is folded.** A client seen as `::ffff:1.2.3.4`
  (an IPv4 peer on a dual-stack socket, which is what
  `server.requestIP` returns) is bucketed as `1.2.3.4`, so one
  client cannot hold two buckets by address spelling. Genuine IPv6
  addresses are left as they are.
- **Check-then-increment is not atomic.** Through a shared store,
  heavy concurrent load can admit a few requests past the limit. A
  store with an atomic increment avoids that; the in-memory default
  is exact for one process.
- **This is not the auth limiter.** Auth attempt limits, with their
  lockouts, are unchanged and untouched by this middleware. Do not
  use this middleware to replace them on login or signup routes.
