# Out-of-the-box feature gaps

What users of modern backend frameworks expect to find on day one, checked
against the feature sets of the three leading alternatives (their plugin
and middleware catalogues, official docs, and production checklists).
This doc names the features, not the frameworks — the point is what Yatta
ships, not whose idea it was.

What Yatta already has (verified in the repo): hardware-aware worker runtime,
SQLite ORM, passkey/TOTP/Argon2id auth, JWT, jobs + cron + DLQ, L1+L2 cache,
storage (local+S3, signed URLs, range/ETag/304 support), mail, SSE/WebSocket
realtime, observe (SLO) + OTel bridge, CORS, security headers, rate limiting,
graceful SIGTERM/SIGINT drain (`src/main.ts`), fail-fast env validation, CLI
(doctor, migrate, backup/restore).

## Must-have (adoption blockers)

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 1 | **OpenAPI/Swagger generation** | Every leading alternative ships auto-generated API docs; users expect `/docs` for free. Its absence is the single most visible gap. | Medium — route metadata exists; needs standard-schema introspection over the userland Zod/Valibot/ArkType validators |
| 2 | **Type-safe client** | The flagship DX moat of the fastest-growing alternative: a client that infers types from the server's route definitions, so the API contract can't drift. Yatta's typed `API` + route params are already typed server-side; a client infers from the same definitions. | Large — type inference machinery, but high strategic value |
| 3 | **Structured logging** | Built-in structured logging is table stakes; Yatta scatters `console.*` across subsystems. | Small–Medium — one facade over the existing observe pipeline |
| 4 | **Testing utilities** | The alternatives make apps testable via the request object out of the box, or ship a dedicated testing module. Yatta's `api.handle(req)` is directly testable, but there is no documented helper, fixtures, or lifecycle sugar. | Small — thin sugar over existing seams |
| 5 | **Canonical health endpoint helper** | Container orchestrators expect `/health` with service indicators; production checklists for every alternative add one. Yatta has `observe` but no blessed health route. | Small |
| 6 | **CSRF middleware** | Cookie/session auth without an origin-check helper is an invitation to misconfigure. | Small |
| 7 | **Request-ID middleware** | Expected in every modern framework; feeds structured logging and tracing. | Tiny |

## Nice-to-have

| # | Feature | Why / effort |
|---|---------|--------------|
| 8 | Static-file serving middleware (serve-static semantics: ETag/304/206, SPA fallback) | Small — `storage.handleRequest` already serves local files; needs a clean API-route wrapper |
| 9 | Response compression (gzip/brotli) | Small — Bun has native compression |
| 10 | Prometheus metrics export | Small–Medium — `observe` already collects; only the export format is missing |
| 11 | Server-Timing | Tiny — standard audit header |
| 12 | ETag / conditional GET for API responses | Small |
| 13 | Body-limit middleware (declarative) | Tiny — Yatta has per-call caps in `ctx.json()` options; a declarative middleware is friendlier |
| 14 | OAuth2/OIDC provider helpers | Medium — pairs with Yatta's auth story |
| 15 | Session middleware | Medium — auth has sessions but no `use(session())` sugar |
| 16 | IP restriction middleware | Tiny |

## Skip (deliberate)

- **Microservices transports (TCP/Redis/Kafka/gRPC)** — a service-mesh story is
  the opposite of Yatta's single-process backend; the cluster runtime already
  covers multi-process. Copying it would dilute the design.
- **A second validation story (class-validator/DTO decorators)** — Yatta is
  intentionally validator-agnostic (Zod/Valibot/ArkType via `Validator`). Don't
  add an opinionated parallel system.
- **GraphQL/tRPC server adapters** — large effort, and they pull Yatta toward
  being an API-toolkit aggregator rather than a backend-as-a-server.
- **JSX renderers, frontend-framework plugins, method-override, trailing-slash,
  powered-by** — frontend-lane or trivia; not differentiators for a backend
  framework.

Nothing on this list is implemented on the `perf/hot-path` branch — this is a
proposal only. Dominic picks what gets built.
