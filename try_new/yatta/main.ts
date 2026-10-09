// yatta/main.ts — the server entrypoint.
//
// Every file in yatta/func/ is mounted as an isolated subsystem, so a slow
// handler in one can never block the event loop of another.
import { createRuntime, defineSubsystem } from "yatta.js/runtime";
import routers from "./func/routerHelper";
import api from "./backend/routes";
import { realtime, sseResponse } from "./func/realtime";
import { observer } from "./func/observe";
import { rememberPeerAddress } from "./func/peer";

const port = Number(process.env.PORT) || 4000;

const runtime = createRuntime({ taskTimeoutMs: 30_000 });
await runtime.start();

// Heavy, CPU-bound work goes to the cpu pool; everything else to the io pool.
const subsystems = [
  defineSubsystem({ name: "auth",    entrypoint: new URL("./func/auth.ts", import.meta.url),    workload: "cpu" }),
  defineSubsystem({ name: "jobs",    entrypoint: new URL("./func/jobs.ts", import.meta.url),    workload: "cpu" }),
  defineSubsystem({ name: "db",      entrypoint: new URL("./func/db.ts", import.meta.url),      workload: "io" }),
  defineSubsystem({ name: "cache",   entrypoint: new URL("./func/cache.ts", import.meta.url),   workload: "io" }),
  defineSubsystem({ name: "mail",    entrypoint: new URL("./func/mail.ts", import.meta.url),    workload: "io" }),
  defineSubsystem({ name: "storage", entrypoint: new URL("./func/storage.ts", import.meta.url), workload: "io" }),
  defineSubsystem({ name: "events",  entrypoint: new URL("./func/events.ts", import.meta.url),  workload: "io" }),
  defineSubsystem({ name: "cron",    entrypoint: new URL("./func/cron.ts", import.meta.url),    workload: "io" }),
];

for (const subsystem of subsystems) {
  await runtime.registerSubsystem(subsystem);
}

// Hand the observer the subsystems. After this, every database query, login and
// job execution produces a span without a single call site changing.
observer.attach("db", (await import("./func/db")).db);
observer.attach("auth", (await import("./func/auth")).auth);
observer.attach("jobs", (await import("./func/jobs")).jobs);
observer.attach("cache", (await import("./func/cache")).cache);
observer.attach("storage", (await import("./func/storage")).storage);
observer.attach("mail", (await import("./func/mail")).mailer);
observer.attach("realtime", realtime);

// Install the global handlers and the periodic exporter flush. Without this the
// observer never reports ready and nothing is shipped off-box.
observer.start();

// Wrapping the dispatcher means every request produces a server span, a
// duration observation and a trace id header — without any per-route work.
// Bun.serve hands the server to fetch(), but the wrapper is built before the
// server exists, so it reads it through this holder.
let serverRef: unknown;

const instrumented = observer.instrument(
  async (request: Request): Promise<Response> => dispatch(request, serverRef),
  // Collapse ids to a route pattern so spans aggregate by shape rather than
  // producing one series per concrete URL. Built with RegExp so the escaping
  // survives being embedded in this template literal.
  (request: Request) =>
    new URL(request.url).pathname
      .replace(new RegExp("\\/[0-9a-f-]{16,}", "gi"), "/:id")
      .replace(new RegExp("\\/\\d+", "g"), "/:n"),
);

const server = Bun.serve({
  port,
  reusePort: true,

  fetch(req, srv) {
    serverRef = srv;

    // The peer address exists only here, and auth's per-IP rate limits need it.
    // Recorded before anything else touches the request.
    rememberPeerAddress(req, srv.requestIP(req)?.address);

    return instrumented(req);
  },

  websocket: realtime.websocket,

  development: process.env.NODE_ENV !== "production",

  error(err) {
    console.error("[server:error]", err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  },
});

/**
 * The real request path, wrapped by the observer so every call is traced.
 *
 * Kept out of fetch() so instrumentation covers the observer's own routes and
 * the runtime's liveness endpoints consistently.
 */
async function dispatch(req: Request, srv: unknown): Promise<Response> {
  const url = new URL(req.url);

  // SSE for the realtime engine. The WebSocket side is attached below via
  // Bun.serve's websocket option; SSE is a plain HTTP response, so without
  // this route a scaffolded app had no working event stream at all.
  if (url.pathname === "/realtime/sse") {
    return sseResponse(req);
  }

  // The observer owns everything under /_yatta/ — health, telemetry, the issue
  // queue and the dashboard — so those endpoints work without registering a route.
  if (observer.router.matches(url.pathname)) {
    return (await observer.router.handle(req)) ??
      Response.json({ error: "Not found" }, { status: 404 });
  }

  // Liveness: never touches the runtime, so a busy pool cannot cause a
  // restart loop.
  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok" });
  }

  // Readiness: the fleet is mounted and able to serve.
  if (url.pathname === "/readyz") {
    const topology = runtime.getTopology();
    const ready = topology.totalWorkers > 0;
    return Response.json(
      { status: ready ? "ready" : "degraded", topology, inFlightTasks: runtime.getActiveTaskCount() },
      { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Everything under /api comes from yatta/backend/routes.ts, where every
  // feature router is mounted in one place.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return api.handle(req, {});
  }

  // Everything else is file-based: backend/index.ts serves the root path and
  // backend/health.ts serves /health, and so on.
  return routers(req, srv as never);
}

console.log(`✓ Yatta listening on http://localhost:${server.port}`);
console.log(`  routes:  yatta/backend/`);
console.log(`  modules: yatta/func/`);
console.log(`  observe:  http://localhost:${server.port}/_yatta/dashboard`);

// Graceful shutdown: stop accepting connections, drain in-flight work, then
// terminate the worker threads.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  server.stop(true);
  console.log("[shutdown] draining in-flight tasks...");

  const drained = await runtime.drain(10_000);
  if (!drained) {
    console.warn(
      `[shutdown] drain timed out with ${runtime.getActiveTaskCount()} task(s) in flight — forcing.`,
    );
  }

  await runtime.shutdown();
  console.log("[shutdown] complete.");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
