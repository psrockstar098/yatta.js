# Cache decorator + edge purge

Short version: the two-tier cache (in-memory L1 + SQLite L2, TTL,
stale-while-revalidate, tag invalidation) is unchanged. This adds two
things on top of it, and nothing else: a decorator/wrapper so a function
can be cached in one line, and edge purge bindings so invalidating a tag
locally also purges it at Cloudflare or Vercel.

## Decorator: cache a function

```ts
import { MemoryCacheEngine } from "yatta.js/cache";
import { wrapCached } from "yatta.js/cache-decorator";

const cache = new MemoryCacheEngine({ maxItems: 10_000 });

const getProfile = wrapCached(
  async (id: string) => db.users.get(id),
  { ttl: "5m", tags: (id: string) => [`user:${id}`] },
  cache,
);

await getProfile("42"); // runs the function
await getProfile("42"); // served from cache, function not run
await cache.invalidateTags("user:42"); // next call runs the function again
```

Everything delegates to `cache.remember`, so TTL, SWR, singleflight and
both tiers behave exactly as they do with the engine directly. There is
no second cache to drift out of sync.

```ts
// TTL is required. There is no "cache forever" default to fall into.
wrapCached(fn, { ttl: "5m" }, cache);

// A string key is a prefix: different arguments still get different entries.
wrapCached(fn, { ttl: "5m", key: "double" }, cache);

// A key function returns the full key and owns uniqueness.
wrapCached(fn, { ttl: "5m", key: (id: string) => `user:${id}` }, cache);

// Stale-while-revalidate: stale value served during the grace period
// while a background refresh runs. Leave it unset for data that must
// never be served stale.
wrapCached(fn, { ttl: "5m", swr: "15m" }, cache);
```

Method form, for class methods (classic decorator shape):

```ts
import { cacheMethod } from "yatta.js/cache-decorator";

class Service {
  // @cacheMethod({ ttl: "5m" }, cache)
  async load(id: string) { /* ... */ }
}
```

The default key is `ClassName.method` plus a hash of the arguments, so
argument values never become stored key text in the L2 database.

## Edge purge: invalidate locally, purge at the edge

```ts
import { EdgeAwareCacheEngine, createEdgePurgeFromEnv } from "yatta.js/cache-edge";

const cache = new EdgeAwareCacheEngine({
  maxItems: 10_000,
  edge: createEdgePurgeFromEnv(), // null when nothing is configured
});

await cache.invalidateTags("users");
// Local entries tagged "users" are gone, and the same tags are purged
// at the configured edge provider. No provider, no network call.
```

One-time setup, then it is automatic. "Automatic" means
automatic-after-one-time-setup, not zero-config: you set the provider
and its credentials once (below), and every later tag invalidation
purges the edge on its own. With no provider configured, behavior is
exactly today's local-only invalidation.

```sh
# Cloudflare: scoped token with the Cache Purge permission + zone id
YATTA_EDGE_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...

# Vercel: API token + project id or name, optional team id
YATTA_EDGE_PROVIDER=vercel
VERCEL_API_TOKEN=...
VERCEL_PROJECT_ID=...
VERCEL_TEAM_ID=...  # optional
```

Cloudflare purges by tag and by URL (`POST /zones/{zone}/purge_cache`).
Vercel purges by tag only (`POST /v1/edge-cache/invalidate-by-tags`):
a URL-only purge is a no-op there, because that endpoint cannot purge
by URL. Existing code with a plain engine can add an edge purge without
swapping engines:

```ts
import { invalidateTagsWithEdge } from "yatta.js/cache-edge";

await invalidateTagsWithEdge(cache, "users", provider);
```

## Zero cost when not used

This feature is opt-in and lazy, end to end:

- The existing cache engine is untouched, so undecorated use runs
  exactly the code it ran before — no wrapper, no extra check.
- Importing the decorator or edge modules creates nothing: no engine,
  no database, no network call. A function costs nothing until it is
  actually wrapped, and only its calls go through the engine.
- Edge modules are never imported by startup code. Nothing in the main
  entrypoint or the cache subsystem imports them; an app loads them
  only when it imports `yatta.js/cache-decorator` or
  `yatta.js/cache-edge`.
- With no provider configured, `invalidateTags` on an edge-aware engine
  does not enter the purge path at all — not even a no-op network
  attempt. The only cost is one null check.

## Gotchas

- **Fail-open, by design.** If the edge provider fails or is slow
  (requests time out after 5 seconds), local invalidation still stands
  and the caller gets the local result, plus a warning. The edge copy
  may lag until the next invalidation or its own TTL. A failed edge
  purge never makes local data look stale when it is not.
- **No purge-everything.** An empty tag/URL list is a no-op, never a
  whole-cache purge. Purging everything stays a dashboard action.
- **A tag purge only matches tagged responses.** Cloudflare purges by
  tag only content whose responses carry a matching `Cache-Tag` header,
  and Vercel likewise only content tagged with `Vercel-Cache-Tag`. If
  the origin never emits those headers, the purge call succeeds and
  removes nothing. Tagging the response is part of the setup, not an
  afterthought.
- **Credentials live in the environment only.** They are never in code,
  never in tests (tests use fake fetches), never in a URL, and never in
  a log line or error message. A provider name with missing credentials
  is treated as unconfigured, with a warning naming the missing
  variable.
- **Never expose invalidation as an unauthenticated endpoint.** This
  module adds no HTTP route. Anyone who can call `invalidateTags` on an
  edge-aware engine can purge the edge cache, so keep that call
  server-side, behind the same auth as the mutation it follows.
- **The default key does not know the caller.** If the result depends
  on the user, tenant, or instance, and the arguments do not carry that
  identity, two callers share one entry. Scope it explicitly:
  `wrapCached(fn, { ttl: "5m", scope: (tenant) => `tenant:${tenant}` },
  cache)`, or pass a `key` function that includes the identity. The
  same applies to instance methods: the default method key includes
  the class and method, not the instance.
- **Keys are hashed, values are not.** Hashing keeps argument values
  out of stored keys, but the cached value itself is still stored in
  L1 and (when configured) L2. Do not cache secrets, and do not set an
  SWR grace period on data that must never be served after its TTL.
- **The edge purge is awaited.** `invalidateTags` on an edge-aware
  engine waits for the edge call (bounded by the timeout) before
  returning, so the purge is not silently dropped when the process
  exits right after invalidation.
