# Yatta JS — Adversarial Security Pass, 2026-10-25

**Scope:** local-only pass on Dominic's own code. No live site, deployment, or
external target was probed. Repo `psrockstar098/yatta.js`, branch
`security-pass-2026-10-25` (from main `b395c43`). Nothing pushed to GitHub.
Method: static review (framework + 4 delegated slices) + dynamic probes against
a locally booted server (`bun src/main.ts`, port 4599) and unit-level probes.
Skills used: `ethical-hacking-methodology` plus yaklang playbooks for
web/API/auth/injection/file-access/SSRF/CORS/JWT/upload surfaces.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | SQL injection via unescaped index names in `syncSchema` | High | **Fixed + tested** |
| F2 | DDL interpolations (`type`, `ON DELETE`) had no runtime check | Medium | **Fixed + tested** |
| F3 | One WebSocket handshake killed the server (DoS) | High | **Fixed + tested** |
| F4 | SSE subscriptions bypassed `authorize.join` entirely | High | **Fixed + tested** |
| F5 | Single-disk storage form could not set `authorize`/`security` | Medium | **Fixed + tested** |
| F6 | `parseDuration` silently turned invalid strings into 1h tokens | Low | **Fixed + tested** |
| F7 | Failures during a lockout extended the lockout indefinitely | Low | **Fixed + tested** |
| F8 | Realtime with no auth config was silent about being open | Low | **Warning added** |
| F9 | `AuthCrypto` accepted any secret, incl. empty/weak | Low | **Warning added** |

No remote SQL injection through the normal typed query path, no storage path
traversal, no signed-URL forgery, no JWT alg confusion, and no CORS
credential reflection were found in live code (details below).

## Verified findings with proof

### F1 — SQL injection via unescaped index names (High, FIXED)

`src/types/db.ts` built index names as `"idx_<table>_<col>"` with **no**
escaping, while the table/column in the same statement were escaped.
Proof (local `:memory:` DB, before fix):

```ts
createDatabase({ path: ":memory:", schema: {
  t: { id: col.integer().primaryKey(),
       'x" ON "t" ("id"); CREATE TABLE pwned(x); --': col.text().index() } } });
// → sqlite_master contained a table named "pwned"
```

bun:sqlite executes the trailing statement, so this was real execution, not
just malformed SQL. Reachability: schema names are normally static code, so
this needs a dynamic-schema author or an app that builds schema from
untrusted input — but the breakout itself was unconditional.
**Fix:** all three index-name sites (`idx_` ×2, `uniq_` ×1) now escape `"`
exactly like every other identifier. Re-ran the payload: `pwned` no longer
created. Regression test: `src/test/db_ddl_escape.test.ts`.

### F2 — DDL interpolations with no runtime whitelist (Medium, FIXED)

`buildColumnDefFragment` interpolated `def.type` and `ON DELETE <action>`
verbatim. TypeScript types restrict them, but a JS caller, an `as any` cast,
or a dynamically loaded schema could inject DDL.
**Fix:** runtime whitelist — types `INTEGER|TEXT|REAL|BLOB`, actions
`CASCADE|SET NULL|RESTRICT`; anything else throws `YattaError`.
Regression tests in `src/test/db_ddl_escape.test.ts`.

### F3 — One WebSocket handshake killed the server (High, FIXED)

`Observer.instrument()` (`src/types/observe.ts`) read `res.status`
unconditionally, but the router returns `undefined` for WebSocket upgrades
(Bun upgrades the socket in place). The throw escaped the fetch handler as an
unhandled rejection, and `main.ts` treats that as a fatal shutdown.
Proof (live local server): healthy before, one unauthenticated WS open to
`/realtime`, log showed
`TypeError: undefined is not an object (evaluating 'res.status')` at
`observe.ts:2898`, then graceful shutdown and process exit; health check
afterwards refused connections. Any remote client that could reach the port
could kill the process with a single handshake — no auth needed.
**Fix:** `instrument()` returns upgrade (undefined) responses as-is.
Re-verified live: WS connects/disconnects normally, server healthy 12s+
later, zero unhandled rejections.
Regression test: `src/test/observe_instrument_upgrade.test.ts`.

### F4 — SSE subscriptions bypassed `authorize.join` (High, FIXED)

The WS message path ran `authorize.join` before subscribing, but the SSE
branch of `connect()` (`src/types/realtime.ts`) subscribed the client to
whatever `?topic=` was requested with no join check at all. An app with a
correct WS guard was still fully open over SSE, including `Last-Event-ID`
replay of up to 100 past events on the channel.
**Fix:** the SSE branch now runs the same `authorize.join` guard before
subscribing (403 on deny; a throwing guard denies, fail-closed). SSE join
guards receive a data-only client (`id` + `data`); they must only read
`client.data`.
Regression test: `src/test/realtime_sse_join_guard.test.ts` (deny → 403,
allow → 200).

### F5 — Single-disk storage form could not set auth/security (Medium, FIXED)

Only the multi-disk form read `config.authorize`/`config.security`. A
developer using the documented `createStorage({ driver, baseDir })` form had
no config path to enable an authorizer or signed-URL-only mode, and silently
got world-readable files.
**Fix:** new `SingleDiskStorageConfig` type (driver config + `authorize`,
`security`, `secret`, `publicReads`); the constructor's single-disk branch
now passes them through. No behavior change for existing configs.
Regression tests in `src/test/security_pass_fixes.test.ts`.

### F6 — `parseDuration` silently defaulted invalid strings to 3600s (Low, FIXED)

`parseDuration("-1h")`, `"1hh"`, `"banana"` all returned 3600 instead of
failing, so a typo issued a valid 1-hour signed URL. (The number form
already threw; only strings were silent.) Note: this was found while
investigating a suspected expired-token bypass — that suspicion was
**wrong**: expiry enforcement itself works (hand-crafted past-expiry and
wrong-secret URLs both 403).
**Fix:** defined-but-unparseable strings now throw `StorageError`; only
`undefined` takes the 3600 default.
Regression test in `src/test/security_pass_fixes.test.ts`.

### F7 — Failures during a lockout extended the lockout indefinitely (Low, FIXED)

`GranularRateLimiter.recordFailure` re-set `lockoutUntil = now + lockoutSec`
on every failure, including failures that arrived while already locked out,
so an attacker who kept failing could hold a victim account/IP locked out
forever (availability, not a bypass).
**Fix:** an active lockout is never extended; it lasts exactly `lockoutSec`
from the failure that triggered it. Hits are still recorded.
Regression test in `src/test/security_pass_fixes.test.ts`.

### F8 — Realtime with no auth config was silent about being open (Low, WARNING)

With neither `authenticate` nor `authorize.join` configured, any client can
connect and subscribe to any topic (the stock app configures none of them),
and nothing logged that fact — unlike storage, which warns about its
open-by-default reads.
**Fix:** `RealtimeEngine` now logs a warning at construction when neither
is configured, mirroring storage's warning. Behavior unchanged.
Realtime suite still 44/44.

### F9 — `AuthCrypto` accepted any secret, incl. empty/weak (Low, WARNING)

No length/entropy check: the HKDF salt and info strings are public
(open-source code), so a guessable secret lets an attacker derive every key
offline and forge any HS256 token without touching the server. (Production
already requires `AUTH_SECRET` to be set; strength was unchecked.)
**Fix:** a once-only warning for secrets shorter than 32 characters.
Existing tests use a 50+ char secret, so no test spam. No throw, so
dev/test setups keep working.

## Checked and found safe (with evidence)

- **ORM query path:** every where-clause value is a bound `?` parameter;
  identifiers use `""` doubling; `contains`/`startsWith`/`endsWith` escape
  LIKE wildcards; unknown operators/columns throw. No `groupBy`/`having`/
  JOIN/JSON-operator builder exists. (Static, full-file review.)
- **Storage traversal:** all direct-key operations go through `sanitizeKey`
  + lexical containment. Dynamic probes: `../`, `%2e%2e%2f`, backslash,
  double-encoding, absolute paths, null bytes — all 403/404, no file
  outside `baseDir` served. HTML/SVG uploads forced to download
  (`Content-Disposition: attachment`); explorer UI uses `textContent`,
  no filename XSS found.
- **Signed URLs:** HMAC-SHA256 over `method:key:exp[:ct]`; verification
  rejects past/non-finite expiry, re-sanitizes the key, timing-safe compare.
  Dynamic: path swap, expiry push, signature flip, GET↔PUT swap, past-expiry
  (hand-crafted), wrong-secret — all 403. Valid URL → 200.
- **CORS (live code):** fail-closed. Credentials + no origin → no ACAO/ACAC
  headers; credentials + explicit origin → that origin only, never the
  request origin. (An older reflecting implementation exists only inside a
  commented-out block at `api.ts:971` — dead code, not fixed, not live.)
- **JWT:** header must be exactly `alg: HS256, typ: JWT`; HMAC compared
  timing-safe; `exp` enforced, future `iat` >60s rejected. Consumers enforce
  token type (`access`/`mfa`/`refresh`), session lookup + revocation, and
  refresh-token hash binding. Sessions are server-generated, hashed at rest;
  password reset/change kills sessions; recovery codes are HMAC-hashed;
  TOTP replay handled; signup/login normalize email (trim + lowercase)
  before rate limiting, closing the case/whitespace bucket bypass.
- **Cookies/CSRF:** HttpOnly default, Secure in production, SameSite Lax
  default; cookie-authenticated mutations require the CSRF cookie/header
  pair (timing-safe compare); prototype-safe cookie/query parsing.
- **Errors:** unknown errors return generic 500, no stack/message leak
  (dynamic: thrown `Error("DB password hunter2…")` → `{"error":"Internal
  Server Error"}`); security headers present on routed responses
  (nosniff, DENY, Referrer-Policy); no method override; 404s are bare.
- **Jobs:** handlers resolve by name from an app-registered map only; no
  `eval`/`Function`/spawn on job payloads.
- **Mail:** CRLF header-injection sanitization present; URL allow-listing
  for links.
- **SSRF:** no user-supplied-URL fetch exists in framework core. OAuth
  `tokenUrl`/`userInfoUrl` are app-configured provider URLs; OAuth state is
  HMAC-signed and PKCE is supported.
- **1.0.5 protocol features (WebDAV, gRPC-Web, DoH, WebFinger, OpenID
  Connect, OAuth 2.0 server):** not implemented in this codebase — nothing
  to test there. The OAuth *client* in `auth.ts` was reviewed (see above).

## Not fixed — design notes / Dominic decisions (do not change unilaterally)

These are documented behaviors or app-responsibility items, not code bugs
fixed here. Changing any of them changes framework behavior and needs
Dominic's call:

1. **Storage reads are world-readable by default** (no `authorize` →
   reads allowed; only list/write/delete/sign are 403). The shipped
   default instance sets no authorizer. Any stored file is downloadable by
   anyone who guesses its key, and the explorer UI is open. The code warns
   about this at boot; the fix direction is fail-closed reads or
   `signedUrls: true` in the stock app — a behavior change.
2. **Listing cannot be scoped per user:** `/api/files` calls the
   authorizer with no key and returns the first 1000 files. An app that
   grants `list` at all grants full enumeration.
3. **Signed URLs are bearer tokens:** no nonce, revocation, or max
   lifetime; a leaked URL replays until expiry. Signed PUT defaults to
   overwrite (`replace`), so a PUT token for a new key can overwrite an
   existing file until expiry.
4. **Realtime defaults stay opt-in:** no default rate limit, no
   connection cap, per-connection (not per-IP/user) buckets, SSE never
   rate-limited, origin check opt-in and skipped when `Origin` is absent.
   The F8 warning is the mitigation applied here.
5. **Observe router enforces nothing by itself:** the `main.ts` gate
   (production + `YATTA_OBSERVE_TOKEN`, constant-time check) is the only
   stock protection; an app mounting `observeDashboard()` directly exposes
   telemetry, traces, errors (with stacks), logs, and destructive actions
   (purge dead jobs, replay dead jobs, clear cache — gated only by
   `?confirmed=true`). Also: `?token=` query acceptance leaks tokens into
   logs/proxies/history, and audit actors are self-declared
   (`x-observe-actor`). Fix direction: fail-closed router or header-only
   tokens — behavior changes.
6. **`like` is a pattern operator, not a literal:** `like: "%"` matches
   every non-null row (bound parameter, so not SQLi — wildcard abuse only
   if app code passes user input straight to `like`). `contains` and
   friends already escape. Recommend documenting `like` as pattern-only.
7. **Raw SQL escape hatches are by design:** `rawAll`/`rawGet`/`rawRun`/
   `raw`/`exec` and `get sqlite()` pass strings straight through. Any app
   code interpolating user input there is the injection boundary.
8. **Mass-assignment is an app pattern:** insert/update/select keys are
   quote-doubled but not schema-validated, so `insert(req.body)` can set
   privileged columns that exist (e.g. `isAdmin`). Endpoints must
   allow-list fields.
9. **Router semantics to know:** file-based routes serve sub-paths via the
   directory fallback (`/user/profile` → `/user` module); a root catch-all
   handler shadows sub-routes for that method; OPTIONS preflights bypass
   `api.use()` middleware; the 10 MB body cap lives in `ctx.json()`/
   `ctx.formData()` helpers and in Bun.serve `maxRequestBodySize`, not in
   `handle()` itself — a handler reading `req` directly has no cap.
   Route params are percent-decoded with no sanitization, so a handler
   joining a param into a filesystem path must sanitize it itself.
10. **Symlink confinement is lexical only:** no `realpath` check anywhere
    in storage; a symlink planted inside `baseDir` by something outside the
    storage API would be followed. No storage route plants symlinks, so
    this is latent hardening, not a live exploit.
11. **CORS function-origin callbacks are developer-controlled:** a callback
    returning `true` (or the request origin) with `credentials: true`
    reflects any origin with credentials. Safe by default; dangerous only
    if the app writes it that way.
12. **JWT `sign()` accepts any `expInSec`** (no max-TTL cap) — only
    reachable by code holding the signing key.

## Fixes made (branch `security-pass-2026-10-25`, NOT pushed)

| File | Change |
|---|---|
| `src/types/db.ts` | Escape `idx_`/`uniq_` index names; whitelist column types + `ON DELETE` actions in `buildColumnDefFragment` |
| `src/types/observe.ts` | `instrument()` returns upgrade (undefined) responses as-is |
| `src/types/realtime.ts` | SSE branch runs `authorize.join`; constructor warns when no `authenticate`/`authorize.join` |
| `src/types/storage.ts` | `SingleDiskStorageConfig` (authorize/security/secret/publicReads on single-disk form); `parseDuration` throws on unparseable strings |
| `src/types/auth.ts` | Short-secret once-warning in `AuthCrypto`; lockout never extended while active |
| `src/test/db_ddl_escape.test.ts` | New: 3 regression tests (F1, F2) |
| `src/test/observe_instrument_upgrade.test.ts` | New: 2 regression tests (F3) |
| `src/test/realtime_sse_join_guard.test.ts` | New: 2 regression tests (F4) |
| `src/test/security_pass_fixes.test.ts` | New: 4 regression tests (F5, F6, F7) |

Test-only note: `createDatabase` reuses a path-keyed global registry, so
tests sharing `":memory:"` must pass `forceNew: true` or later schemas
never sync — that artifact initially masked the F2 tests, and is itself a
gotcha for future test authors.

## Test results

- New regression tests: 3 + 2 + 2 + 4 = **11 pass, 0 fail**.
- Affected suites (db ×4, storage ×2, realtime, auth ×2, observe, api ×2,
  mfa, security_regressions): **317 pass, 0 fail**.
- Typecheck (`tsc --noEmit`): **clean**.
- Full suite (`bun test`): **979 pass, 0 fail across 47 files** (109.6s).
  The previously known 1-test harness failure (bun:sqlite `/tmp/opencode`
  dir) did not reproduce in this run.
- Live verification: local server boot + WS upgrade crash before fix,
  healthy after fix; storage traversal/signed-URL/CORS/error probes as
  listed above. All test servers stopped; repo tree holds only the branch
  work above.

## Surfaces covered vs not covered

- **Covered dynamically:** storage HTTP surface + signed URLs, CORS,
  error leakage, security headers, observe gate in dev, realtime WS/SSE
  connect + subscribe, full-server WS-upgrade crash.
- **Covered statically (full-file or scoped):** `db.ts` (full), `storage.ts`
  (full), `realtime.ts` (full), `observe.ts` router surface, `api.ts`
  (full), `auth.ts` (full: core + consumers verified for type/sid/
  revocation/normalization), `routerHelper.ts`, `main.ts` gates, `env.ts`
  secrets, `mail.ts` injection guards, `job.ts` handler resolution.
- **Not covered:** 1.0.5 protocol features (not implemented); live
  deployments (out of scope by order); S3/R2 driver paths (local driver
  only tested dynamically); cluster mode; performance/DoS beyond the WS
  crash (no load testing); the `/_yatta/*` destructive actions were read,
  not executed (they need the gate token + would mutate state).
