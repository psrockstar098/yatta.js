# Fast stateless HS256 JWT verifier

> Draft for review. Not published to the docs site.

A minimal, opt-in HS256 verifier for hot request paths, exported as
`yatta.js/jwt`. It verifies exactly the token shape the entry-style
`verifyAuth` accepts — a `Bearer` token whose header declares
`alg: "HS256"` and whose payload carries a numeric-string `sub`, a
string `username`, and a future `exp` — and returns
`{ userId, username }` on success. Nothing is cached: every call
re-verifies the signature from scratch, so a rotated secret takes
effect on the very next request.

```ts
import { createJwtVerifier } from "yatta.js/jwt";

const jwt = createJwtVerifier(process.env.JWT_SECRET!);

api.post("/posts/:id/like", (ctx) => {
  const auth = jwt.verifyRequest(ctx.req);
  if (!auth.ok) return API.json({ error: auth.error }, { status: 401 });
  // auth.userId, auth.username
});
```

## API

`createJwtVerifier(secret)` returns a verifier with three methods,
all returning `JwtVerifyResult`
(`{ ok: true; userId: number; username: string }` or
`{ ok: false; error: string }`):

- `verifyToken(token)` — a raw `header.payload.signature` token.
- `verifyAuthorizationHeader(header)` — an `Authorization` header
  value; missing / non-`Bearer` values fail with
  `"missing bearer token"`.
- `verifyRequest(req)` — the `Authorization` header of a `Request`.

Error strings match the reference verifier exactly:
`"missing bearer token"`, `"invalid or expired token"`,
`"invalid token payload"`. Only HS256 is accepted; `alg: "none"`,
HS384/HS512, RS256, and every other algorithm fail.

The factory throws `TypeError` on an empty or non-string secret
(construction time only — verification itself never throws).

## Why it is faster

HMAC-SHA256 goes through `Bun.CryptoHasher` (constructor key form),
which measured ~2x faster than `node:crypto` `createHmac` on the
perf-3 VM (729 ns/op vs 1,423 ns/op, 20,000 iters, Bun 1.4.4). The
signature is decoded with `Buffer.from(sig, "base64url")`: there is
no `Bun.base64URLDecode` in Bun 1.4.4 (checked against
bun.sh/docs/api/hashing and at runtime), and the lenient `Buffer.from`
decode is also what the reference verifier uses, so non-canonical
base64url spellings behave identically.

The verifier also checks the signature *before* parsing the payload
JSON, so a forged token never pays for a payload parse. The order
change is provably equivalent — every failure before the
payload-shape check reports the same string
(`"invalid or expired token"`), and `"invalid token payload"` is
reachable only after the signature has passed and the payload has
parsed as an object, which is the same gate in both orders. A
differential test (`src/test/jwt-fast.test.ts`) runs the same corpus
through both implementations and asserts identical outcomes.

One subtlety is load-bearing: the signature comparison is over
decoded bytes (`timingSafeEqual` on the 32-byte digests, length
checked first), never over the base64url strings. Two base64url
spellings can decode to the same bytes (non-canonical trailing
bits, padding variants); the reference accepts those, so a string
comparison here would wrongly reject them.

## Measured effect (perf round 3, 20,000 iters, median of 5 runs)

- Valid token: reference `verifyAuth` ~5.5µs/op, helper
  `verifyRequest` ~4.7–5.0µs/op — **~10–15% faster
  (~0.5–0.8µs saved)**. The helper won the stage in all four
  benchmark runs (deltas 5.7%, 23.4%, 9.5%, 14.9% — the VM is
  noisy, the direction is not).
- Forged signature: **~19–36% faster (~1.0–1.4µs saved)** — the
  payload parse is skipped entirely.
- Full `POST /posts/1/like` handle with the helper wired in:
  **~3–4% faster (~0.6µs of ~17µs)** in the interleaved,
  full-copy run. Earlier runs showed larger like-path deltas
  (9–12%) that did not reproduce — treated as VM noise in the
  reference arm, not claimed.

## Scope — what this is NOT

This is not the auth subsystem (`src/types/auth.ts`): it issues no
tokens, manages no sessions, and knows nothing about users, roles,
or refresh flows. It verifies one token shape, fast. It is a new,
additive, opt-in export; the existing auth subsystem is untouched,
and the main entry point does not re-export it (matching `yatta.js/api`
and `yatta.js/db`, which are standalone package exports too).
