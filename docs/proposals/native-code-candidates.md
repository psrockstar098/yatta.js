# Native-code candidates for Yatta JS — measured analysis

**Verdict up front: no FFI seam in Yatta's hot paths justifies native code today.**
Every genuinely expensive operation Yatta performs is already native. The remaining
pure-JS costs are small, and FFI call overhead alone eats most of what could be saved.
This document is the evidence, not a guess. No native code was written for this analysis —
the framework's native layers, if ever added, are written separately.

Measurements: Bun 1.4.2, this VM (2 CPU, shared/noisy), micro-benchmarks with warmup.
Absolute numbers vary run to run on this VM; the *ratios* and *orders of magnitude* are stable.

## What the request path actually costs

- `api.handle()` for `GET /json` (framework only, no HTTP): **~9–12 µs/op**.
- Under real HTTP (repo's `comparison_benchmark.ts`, 20k requests @ 100 concurrent):
  **≈108 µs/request wall** on this VM (9,281 req/s median) — so the framework is
  roughly **~10% of request cost**; Bun.serve + the load generator own the rest.

Framework-internal costs, measured:

| Operation | Cost | Implementation |
|---|---|---|
| `new URL()` | 0.66 µs | native (Bun URL) — duplicated in `handle()`+`Context` ctor; **deduped on this branch** |
| Route match, param route (`matchSegments`) | ~2–3 µs delta vs static | JS string ops — pre-split on this branch |
| `Context.query()` | ~5.7 µs | `URLSearchParams` (native), key copy in JS; only when handler calls it |
| `Context.cookies()` | ~4.9 µs | JS string split/scan; only when handler calls it |
| `API.json()` + body read | ~3.4 µs | JSON.stringify native + Response construction native |
| Security headers (file-router path) | ~3.2 µs per 5 sets | Headers are native; rebuild hoisted on this branch |

## The functions people usually nominate for native — already native

| Function (file) | Measured | Verdict |
|---|---|---|
| `createHash("sha256")` hex, auth/db/mail/observe | ~4.8 µs/op | node:crypto = OpenSSL/BoringSSL C++. FFI reimplementation cannot beat it. |
| `createHmac("sha256")` base64url, `auth.ts` (JWT sign/verify), `storage.ts` (signed URLs) | ~5.8 µs/op | Same. |
| `timingSafeEqual`, `auth.ts` | 0.14 µs/op | Native. |
| base64url encode/decode (Buffer), auth/db | ~1.3 µs/op | Native. |
| `JSON.parse`/`JSON.stringify`, everywhere | ~0.5–3.1 µs/op (payload-size dependent) | Native (JSC). |
| `Bun.password` Argon2id verify, auth | **~332 ms/op** | Native, and slow *by design* — it is the cost function. FFI changes nothing except risk. |
| `bun:sqlite` row fetch (ORM base) | 10.2 ms / 10k rows (~1.0 µs/row) | Native C++ (`bun:sqlite`). |

## The one non-trivial JS fraction — and why FFI still can't fix it

ORM `findMany` on 10k rows: **15.9 ms** vs **10.2 ms** raw `bun:sqlite` — the ORM's
JS-side mapping/normalization adds **~0.58 µs/row (~36%)**. This is the only measured
place where JS consumes a real share of a hot path. But the work is *constructing JS
objects with the right shape* — a C-ABI FFI function cannot create or mutate JS objects
(Bun FFI exposes scalars/buffers only; no JSC embedding API). The seam does not exist.
The available fix is JS-level (cheaper row mapping), not native.

## Why FFI loses on the small stuff

Measured floor: one trivial FFI call (`strlen` via `bun:ffi` into libc) costs
**~0.25 µs** before any argument marshalling; a plain JS property read costs 0.06 µs.
Every remaining JS hotspot (`matchSegments` ~0.3–1 µs, cookie scan ~4.9 µs per request
that uses it, header pairs) is at or near that floor, and marshalling strings/buffers
across the boundary costs more than the JS work saves. Beyond speed, FFI would force the
npm package to ship per-platform prebuilt binaries (or a native toolchain at install
time) — Yatta is currently pure TypeScript on Bun, installable anywhere Bun runs.

## If Dominic wants a native experiment anyway

The only seam shape that could ever pay is **batched** string processing (one FFI call
amortized over many items), e.g. parsing cookies/query strings for N requests at once in
the cluster runtime — expected gain < 5 µs/request *only on requests that use those
features*, i.e. < 5% of framework overhead, < 0.5% of wall-clock request cost. Not
recommended. Better use of the same hours: JS-level row-mapping optimization in the ORM
(measured ~36% overhead on bulk reads) and the OpenAPI/client gaps in
`feature-gaps.md`.
