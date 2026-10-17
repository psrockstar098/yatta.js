// yatta/backend/health.ts
//
// Liveness, readiness and the framework's own health endpoint.
//
//   GET /healthz    liveness  — the process is up. Touches nothing, so a busy
//                              runtime cannot trigger a restart loop.
//   GET /readyz     readiness — subsystems are mounted and able to serve.
//   GET /health     composite — the observer's view of this process, including
//                              traces, errors and exporter state.
//
// /healthz and /readyz are handled by the framework before any route runs.
// /health is proxied to the observer, so it is always available.

import { createAPI } from "yatta.js/api";
import { db } from "../func/db";
import { jobs } from "../func/jobs";
import { observer } from "../func/observe";

const route = createAPI("/health");

/** Liveness. Must never touch a subsystem. */
route.get("/z", () => Response.json({ status: "ok" }));

/**
 * Readiness.
 *
 * 200 only when the database answers and the job store is initialised;
 * 503 otherwise, so an orchestrator stops routing traffic here.
 */
route.get("/ready", async () => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const started = Date.now();
    await db.run("select 1", [], "get");
    checks.db = { ok: true, detail: `${Date.now() - started}ms` };
  } catch (err) {
    checks.db = { ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }

  try {
    const metrics = await jobs.metrics();
    checks.jobs = {
      ok: true,
      // `queued` and `dead` are the field names. `pending` and `failed` do not
      // exist on QueueMetrics, so this line read 0 and 0 forever — reported while
      // looking authoritative.
      detail: `${metrics.queued} queued, ${metrics.dead} dead`,
    };
  } catch (err) {
    checks.jobs = { ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }

  const ready = Object.values(checks).every((c) => c.ok);

  return Response.json(
    { status: ready ? "ready" : "degraded", checks },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
});

/**
 * Composite health, straight from the observer.
 *
 * Proxied through the router rather than reimplemented, so the numbers here
 * are exactly the ones the dashboard shows.
 */
route.get("/", async (ctx) => {
  const response = await observer.router.handle(
    new Request(new URL("/_yatta/api/telemetry", ctx.req.url)),
  );

  return response ?? Response.json({ status: "unknown" }, { status: 503 });
});

export default route;
