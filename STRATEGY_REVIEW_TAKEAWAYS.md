# Yatta Strategy Takeaways — from external reviews (2026-10-06/07)

Two ChatGPT reviews of the compare page and the yatta.js repo. Saved 2026-10-07 per Dominic.

## Positioning (both reviews agree)

- **Don't chase the speed leaderboard.** Yatta doesn't need to beat Elysia on raw req/s.
- Headline should be: **"The backend you don't have to assemble"** — not "fastest framework."
- Frame it as: *"An application runtime for building self-contained backends"* / *"Don't assemble a backend. Run your backend."*
- The honest 1.18× claim (vs Hono+Drizzle) is MORE credible than a 7× claim. Keep it.

## Competitive story

- Raw speed: Elysia/Hono lead, Yatta close behind — and that's fine.
- Backend completeness: Yatta is far ahead of Elysia/Hono/Fastify here. That's the actual battlefield.
- The universal API (one route table → server direct-call + HTTP + typed browser client) may be the best feature. It collapses the type-duplication chain.

## Biggest open technical questions

1. **SQLite multi-node story.** Single machine + WAL + cluster mode is coherent. But what happens at 3 machines / 12 processes? Where is the authoritative DB? Positioning needs to be explicit: "optimized for single-node deployments, with a defined scale-out path" — or define the real multi-node story.
2. **Security audit.** Auth surface is huge (Argon2id, JWT rotation, TOTP, WebAuthn, RBAC...). Feature completeness ≠ security maturity. Needs implementation review + attack testing before production claims.
3. **Production evidence.** Repo is ~1 day old, 0 stars, 0 releases. Architecture is ahead of evidence. This is the biggest risk, not code quality.

## Recommended next milestone: prove the core, stop adding features

1. Database torture tests (1M–100M rows, concurrent R/W, WAL contention, crash recovery, disk-full)
2. Auth audit (automated security tests, session attacks, refresh replay, CSRF, RBAC bypass)
3. Runtime torture tests (worker crashes, 100k queued jobs, memory pressure, cascading failure, shutdown under load)
4. Cluster tests (1/4/8 processes, multi-machine — throughput, latency, consistency, recovery)
5. Independent benchmark reproduction by the community

## Architecture notes to preserve

- Keep `src/types/*` engines independently usable (escape hatch if someone doesn't want the whole platform).
- Middleware belongs to the app, not the transport — prevents direct-invocation bypass. Keep this invariant.
- Observability: in-memory only — position as "embedded runtime diagnostics," not a Datadog replacement.
- The honest worker-runtime note ("Bun's raw workers edge out Yatta") is a credibility signal. Keep that tone everywhere.

## Coupling risk (flagged)

Adopting all of yatta/* makes Yatta the application platform, not just a framework. That's fine if the project succeeds — but it's the biggest architectural risk to name honestly.
