<p align="center">
  
  <img src="./logo.png" alt="Yatta" width="640" />
</p>

# Yatta

**Production-grade backend framework for [Bun](https://bun.com).**

Zero-config routing, a type-safe SQLite ORM, auth, background jobs, caching,
object storage, transactional mail, and realtime — plus a hardware-aware
worker runtime that keeps CPU work off your I/O event loop.
[![CI](https://github.com/psrockstar098/yatta.js/actions/workflows/ci.yml/badge.svg)](https://github.com/psrockstar098/yatta.js/actions/workflows/ci.yml)
[![Benchmarks](https://img.shields.io/badge/benchmarks-view_results-blue)](./BENCHMARKS.md)
[![npm](https://img.shields.io/npm/v/yatta.js)](https://www.npmjs.com/package/yatta.js)

```bash
bun install
bun run dev
```


---

## Why Bun

Yatta leans on Bun's native primitives rather than wrapping them: `bun:sqlite`,
`Bun.serve`, WebSockets, `Bun.Worker`, and `Bun.password` (Argon2id). There is
no build step for application code — TypeScript runs directly.

## Table of contents

- [Architecture](#architecture)
- [The worker runtime](#the-worker-runtime)
- [Benchmarks](#benchmarks)
- [Feature engines](#feature-engines)
- [Write a route once](#write-a-route-once)
- [Observability](#observability)
- [Routing](#routing)
- [Environment variables](#environment-variables)
- [Health probes](#health-probes)
- [Cluster mode](#cluster-mode)
- [Reliability guarantees](#reliability-guarantees)
- [Verifying a change](#verifying-a-change)
- [Deployment](#deployment)
- [Scripts](#scripts)
- [License](#license)

---

## Architecture

```
core_runtime/   hardware-aware worker scheduler + module isolation
src/types/      8 standalone framework engines
src/func/       app wiring — instantiates the engines
src/backend/    file-based HTTP routes (Next.js convention)
```

The two layers are independent. `core_runtime/` is a general compute
scheduler; `src/types/` are self-contained engines you can adopt individually.

## The worker runtime

The runtime avoids the "one worker per core" trap. It sizes two pools from
`navigator.hardwareConcurrency`:

| Pool | Sizing | Concurrency per worker | For |
|------|--------|------------------------|-----|
| `cpu-pool` | `cores * 0.35` | `1` | Password hashing, crypto, transforms |
| `io-pool` | `min(16, cores * 0.8)` | `500` | DB queries, network, mail |

```ts
import { createRuntime, defineSubsystem } from "yatta.js/runtime";

const runtime = createRuntime({ taskTimeoutMs: 30_000 });
await runtime.start();

const graphId = await runtime.registerSubsystem(
  defineSubsystem({
    name: "billing",
    entrypoint: new URL("./func/billing.ts", import.meta.url),
    workload: "cpu",
  }),
);

const receipt = await runtime.execute(graphId, "computeReceipt", payload);
```

Subsystems mount as isolated module graphs. On ≤2 cores, I/O workers start with
Bun's `smol` heap. Queued tasks are micro-batched — up to 32 per IPC message
(64 under heavy backlog) — to cut thread-hop overhead.

## Benchmarks

<!-- BENCHMARKS:START -->
| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      65,894 |     1.00x |    10% | 1.25ms | 2.83ms | 3.80ms |
| Raw Bun   |      51,845 |     0.79x |     4% | 1.62ms | 3.40ms | 3.46ms |
| Hono      |      59,750 |     0.91x |     7% | 1.54ms | 3.19ms | 3.37ms |
| Elysia    |      55,136 |     0.84x |     9% | 1.46ms | 3.16ms | 3.31ms |
| Express   |      43,366 |     0.66x |     2% | 2.24ms | 3.57ms | 4.86ms |
| Fastify   |      56,636 |     0.86x |    14% | 1.75ms | 2.61ms | 4.04ms |
| Koa       |      47,332 |     0.72x |     6% | 1.80ms | 3.62ms | 5.23ms |
<!-- BENCHMARKS:END -->

`GET /json` head-to-head, 20,000 requests at 100 concurrent connections.
Full results, throughput ladders and workload profiles: [BENCHMARKS.md](BENCHMARKS.md).

## Feature engines

Each engine lives in `src/types/`, has its own error class, ships in-memory and
persistent stores, and supports TypeScript module augmentation for typed keys.

| Module | What it does |
|--------|--------------|
| `yatta/api` | Unified API: router with onion middleware, typed params, schema validation (Zod/Valibot/ArkType), CORS, cookies, streaming, typed client, universal routes (define once, call directly or over HTTP), path utilities, DataLoader batching |
| `yatta/db` | `bun:sqlite` ORM — column builder, relations, transactions with savepoints, pagination, cursor pagination, schema sync, backup/restore |
| `yatta/auth` | Argon2id, rotating access/refresh JWTs, AES-256-GCM sessions, TOTP 2FA, WebAuthn passkeys, hashed API keys, RBAC, rate-limit lockouts |
| `yatta/jobs` | Job queue, worker pools, cron (Vixie semantics, tz-aware), event bus, atomic leases, DLQ, backoff + jitter |
| `yatta/cache` | L1 LRU + SQLite L2, singleflight, stale-while-revalidate, tag invalidation; plus an O(1) priority queue |
| `yatta/storage` | Local + S3 drivers, RFC 9110 range streaming, magic-byte inspection, HMAC signed URLs |
| `yatta/mail` | SMTP/Resend/Postmark/SendGrid/SES/Gmail, layouts, pipe templating, md→html, RFC 8058 unsubscribe |
| `yatta/realtime` | Unified SSE + WebSocket, topic pub/sub, AI token streaming, job tracking, backpressure |
| `yatta/observe` | Tracing, metrics, logs, issue grouping, incident correlation, adaptive baselines, SLOs, N+1 detection, golden traces |
| `yatta/otel` | OpenTelemetry bridge — Yatta spans flow to any OTel backend (Jaeger, Tempo, Datadog) |

### Typed keys

Augment the register interfaces for autocompletion and compile-time payloads:

```ts
declare module "yatta.js/jobs" {
  interface JobRegister {
    "send-email": { to: string; subject: string; body: string };
  }
}
```

## Routing

One router, and it is the only one. A route is a path and a function; `ctx` carries
everything the request has.

```ts
import { createAPI, API, HttpError } from "yatta.js/api";

const api = createAPI("/api");

api.get("/users/:id", async (ctx) => {
  const user = await db.users.findById(ctx.params.id);
  if (!user) throw new HttpError(404, "No such user");
  return API.json(user);
});

api.post("/users", async (ctx) => {
  // Validated on the way in. A transformer applies, so the handler sees the
  // coerced value rather than the raw body.
  const body = await ctx.json(z.object({ email: z.string().email(), age: z.coerce.number() }));
  return API.json(await db.users.create(body), { status: 201 });
});

export default api;
```

Mount it and serve:

```ts
import api from "./backend/routes";

Bun.serve({ port: 4000, fetch: (req) => api.handle(req, {}) });
```

**Middleware runs before the handler and can deny it.** Throw to refuse; return nothing
to let the request through. Returning a value answers the request instead, which is how
a cache short-circuits.

```ts
api.use((ctx, next) => {
  if (!ctx.req.headers.get("cookie")) throw new HttpError(401, "Not signed in");
  return next();
});
```

**Static routes beat dynamic ones.** `/users/new` resolves to the static route, not to
the user whose id is the literal string `new` — specificity decides, not declaration
order.

Handy context members: `ctx.params`, `ctx.query()`, `ctx.json(schema?)`,
`ctx.formData()`, `ctx.cookies()`, `ctx.req.signal`, and `ctx.state` for handoff.

> This replaces an earlier second routing layer — `defineRoute` / `createApp` /
> `mount` / `createClient`, with its own path parser, batching and schema modules. Two
> routers over one codebase is two things to learn and two places for a signature to
> drift, and the second had no users outside its own tests. It was removed rather than
> kept as an alternative.

## Observability

`yatta/observe` is built in. One `Observer` records spans, metrics, logs and
issues, and derives analysis from them. Nothing leaves the process.

```ts
import { observer } from "../func/observe";

observer.start();

const incident = observer.analyzeIncident(fingerprint);
```

The dashboard lives at `/_yatta` and answers `/_yatta/api/*`.

### It tells you what it does not know

An analysis that reports a confident answer when it is guessing is worse than no
analysis, because it gets trusted. So every conclusion carries the evidence
behind it and the reasons it might be wrong, and gaps are reported rather than
smoothed over:

```ts
const a = observer.analyzeIncident(fp)!;

a.suspects[0]?.label;      // "Latency concentrated in db.query"
a.suspects[0]?.confidence; // "likely" | "possible" | "unknown"
a.suspects[0]?.evidence;   // what supports it
a.suspects[0]?.caveats;    // why it could still be wrong
a.unknowns;                // never empty — see below
```

`unknowns` always carries a standing disclosure that the correlation is
heuristic and based only on in-memory telemetry. A well-formed incident with
plenty of data still gets that line, so a consumer cannot render "Likely cause"
with nothing beside it.

Where the data cannot support a claim, the engine declines rather than guessing:

| Situation | Result |
|-----------|--------|
| Fewer than 20 samples for a baseline | `confidence: "unknown"`, no anomaly claimed |
| Metric with zero observed variance | `z: null`, explains it cannot be scored |
| Zero baseline for a ratio | `changePct: null`, not `Infinity` |
| SLO with fewer than 20 requests | `status: "no-data"`, no compliance claimed |
| First release with nothing to compare | `status: "unknown"`, not "healthy" |
| Memory trend with a weak fit | `verdict: "stable"`, reports the R² |

### What it derives

| Call | Returns |
|------|---------|
| `analyzeIncident(fp)` | Timeline, suspects with evidence, suggested actions |
| `releaseHealth()` | Per-release errors, p50/p95/p99, slow queries, new errors |
| `whatChanged()` | The running release against the previous one |
| `serviceMap()` | Dependency graph inferred from spans, with its own limitations |
| `detectNPlusOne()` | Repeated identical queries under one parent |
| `detectAnomalies()` | Current values against their own history |
| `memoryTrend()` | Least-squares growth with fit quality |
| `evaluateSlos()` | Availability, error budget, burn rate |
| `jobHealth()` | Queue depth, success rate, backlog direction |
| `incidentReport(fp)` | Self-contained JSON for a model or a colleague |
| `compareToGolden(name, traceId)` | Drift against a known-good baseline |

### Adaptive thresholds

A fixed 50ms budget is wrong for every table that does not normally take 50ms.
Set the mode and the configured value becomes a multiplier of that query's own
rolling p95:

```ts
createObserver({
  slowQueryThresholdMs: 3,
  slowQueryMode: "adaptive",
});
```

During warm-up queries are recorded but left unclassified. Using the multiplier
as if it were a millisecond budget flagged almost everything in the first few
dozen calls, which is worse than saying "not enough data yet".

### SLOs

```ts
createObserver({
  slos: [
    { name: "Checkout availability", target: 99.9, windowMs: 30 * 86_400_000 },
  ],
});
```

Measured against retained in-memory traffic, and always says so. A 5xx counts
against availability; a 4xx does not, because it is a served answer.

### Guarded actions

Destructive operations are previewed before they run, require confirmation, and
require an idempotency key so a double-click cannot purge twice:

```ts
const preview = observer.previewAction({ kind: "purge-dead-jobs" });
// preview.risk → "destructive", preview.reason explains the consequence

observer.performAction(
  { kind: "purge-dead-jobs", idempotencyKey: req.id },
  execute,
  { confirmed: true },
);
```

Blocked attempts are audited too — "someone tried to purge the queue at 3am" is
itself the record worth keeping.

### Analysis endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /_yatta/api/analysis/state` | Every analysis in one call |
| `GET /_yatta/api/analysis/incident/:fp` | One incident analysis |
| `GET /_yatta/api/analysis/report/:fp` | Full incident report for export |
| `GET/POST /_yatta/api/analysis/goldens/:name` | List or save a golden trace |
| `GET /_yatta/api/analysis/compare/:name?trace=` | Compare against a baseline |
| `POST /_yatta/api/analysis/action/:kind` | Guarded action |

The dashboard's command palette (⌘K / Ctrl+K) drives all of it.

### What it cannot see

Stated by the features themselves rather than left to be discovered:

- **History is in-memory only.** A restart loses it. Retention is bounded
  precisely so the observer cannot become the leak it is meant to diagnose.
- **No outbound HTTP instrumentation.** `serviceMap()` reports this as a
  limitation; external dependencies appear only if a call site was wrapped.
- **Source navigation needs a resolver.** Production bundles ship no sources,
  and the resolver refuses any path outside the project root.

## Routing

Routes are files. `src/backend/user/index.ts` serves `/user`:

```ts
import { API, createAPI } from "yatta.js/api";

const api = createAPI();

api.get(async (ctx) => API.json({ query: ctx.query() }));

export default api;
```

Handy context members: `ctx.params`, `ctx.query()`, `ctx.json(schema?)`,
`ctx.formData()`, `ctx.cookies()`, and `ctx.state` for middleware handoff.

## Environment variables

Validated at boot — the server refuses to start on malformed configuration.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `4000` | Must be 1–65535 |
| `NODE_ENV` | `development` | `production` \| `development` \| `test` |
| `STORAGE_SECRET` | *ephemeral* | **Required in production** |
| `DATABASE_URL` | `Database/app.db` | Shared volume / managed SQLite file |

Outside production a missing `STORAGE_SECRET` falls back to an ephemeral
dev secret and logs a warning — signed URLs then stop verifying after a restart.

## Health probes

| Endpoint | Meaning | Status |
|----------|---------|--------|
| `/healthz` | Liveness. Never touches the worker pool. | `200 {"status":"ok"}` |
| `/readyz` | Readiness: fleet mounted and serving. | `200` ready / `503` degraded |

Liveness is deliberately decoupled from runtime health: a saturated pool must
not trigger a restart loop.

## Cluster mode

```bash
bun run cluster
```

Spawns one process per core behind `SO_REUSEPORT`. SQLite is opened in WAL mode
with a 5s busy timeout and `synchronous = NORMAL`, so concurrent processes share
one file safely. For multi-*node* deployments, point `storage` at the S3 driver —
local disk does not sync across machines.

## Reliability guarantees

## Verifying a change

A local `bun run check` says nothing about what GitHub Actions did with your push, and
that gap has already cost five red pushes in a row that were reported as done. So the
last step is a command, not a habit:

```bash
bun run check          # typecheck + tests
git push
bun run verify:ci      # blocks until CI finishes; exits non-zero if any run failed
```

`verify:ci` resolves the current commit, waits for every workflow to reach a conclusion,
prints one line per workflow with its URL, and fails loudly on a red one. It needs the
`gh` CLI authenticated. The docs site has its own:

```bash
cd ../yatta-docs && bun run check && git push && bun run verify:ci
```

In the docs repo `bun run check` is `lint && build`, and the build matters: `check:api`
only compares the generated `api-surface.json`, so it passes on a page that does not
compile, and `tsc --noEmit` cannot run on a fresh checkout because Next's global types
come from the gitignored `next-env.d.ts` that a build generates. There is no quick
command that replaces it.

Two smaller rules that follow from the same episode:

- **A bug fix needs a test that fails without it.** Several of these were found by
  probing an untested surface, and each fix was reverted briefly to confirm the new test
  actually goes red. A test that passes before and after proves nothing.
- **A guard written as `x > 0 ? apply : skip` fails open on `NaN`.** Four of them did —
  a size cap, a cache TTL, and a rate limiter each ended up with no limit at all, all
  reachable from `Number(process.env.SOMETHING)` with the variable unset. Validate at
  the boundary rather than trusting a downstream comparison.


- **Supervision.** A worker that dies has its in-flight and queued tasks rejected
  with `WorkerCrashError`; a replacement is spawned and remounts its graphs.
  Recovery survives cascading crashes.
- **Deadlines.** Every task carries an execution deadline (30s default,
  per-subsystem override). A hung task rejects with `TaskTimeoutError` instead
  of pinning a promise forever. `timeoutMs: 0` opts out.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` stops accepting connections, drains
  in-flight work, then terminates threads and stops the observer. The drain
  budget is 30s — deliberately longer than the default task deadline, so a
  legitimately long task is not reported as a failed drain.

> Note: JavaScript cannot preempt a blocking loop inside a worker. A deadline
> frees the host-side promise and scheduler bookkeeping, but the wedged thread
> needs a restart. Long-running work should yield or run in a disposable worker.

## Deployment

```bash
docker build -t yatta .
docker run -p 4000:4000 \
  -e NODE_ENV=production \
  -e STORAGE_SECRET="$(openssl rand -hex 32)" \
  yatta
```

The image runs non-root and ships a `HEALTHCHECK` wired to `/healthz`. Mount
`Database/` and `storage/uploads` as volumes to persist data.

`YATTA_CLUSTER_MODE=false` runs a single process instead of one per core.

Security headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`) are applied to all responses; HSTS is sent only over HTTPS.

## Scripts

| Command | Does |
|---------|------|
| `bun run dev` | Watch mode |
| `bun run start` | Production server |
| `bun run cluster` | Multi-process mode |
| `bun test` | Full suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run check` | Typecheck + tests |
| `bun run benchmark` | Scheduler/IPC microbenchmarks |

### CLI

| Command | Does |
|---------|------|
| `yatta doctor` | Diagnose project health |
| `yatta migrate` | Run pending migrations |
| `yatta migrate:make <name>` | Create migration file |
| `yatta migrate:status` | Show migration status |
| `yatta db:backup` | Backup SQLite database |
| `yatta db:restore <file>` | Restore from backup |

## Contributing

```bash
bun install
bun run check
```

CI runs the full suite and typecheck across Bun 1.4.2 and latest, verifies the
publish payload excludes tests, and smoke-tests the Docker image.

### Changing the docs

This README and the docs site are separate, and the site is what people read.
Anything changed here that a reader could notice needs a matching change in
`../yatta-docs`: new exports, new modules, bug fixes users would notice, and any
change to a claim the site makes. The AGENTS.md file at the repo root has the
mapping, and yatta-docs fails its build if the generated API reference has drifted
from this source.

## License

MIT
