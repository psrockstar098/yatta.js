import { createRuntime, defineSubsystem } from "yatta.js/runtime";
import { loadEnv } from "./func/env";
import crypto from "node:crypto";

// Validate configuration before any subsystem, database, or socket is created.
export const env = loadEnv();

if (env.isEphemeralSecret) {
  console.warn(
    "[env] STORAGE_SECRET not set — using an ephemeral dev secret. " +
      "Signed URLs will not survive a restart.",
  );
}

const routers = (await import("./func/routerHelper")).default;
const { realtime } = await import("./func/realtime");
const { observer, attachSubsystems } = await import("./func/observe");
const { observeDashboard } = await import("./types/observe");

/*
 * The worker module registers handlers; it must not be imported until the runtime
 * is up and the subsystems are attached.
 *
 * It used to be imported here, at module scope, which meant the pool started before
 * `runtime.start()` and long before `attachSubsystems`. A job could therefore be
 * picked up in that window and run against a `db` that was not mounted yet — a
 * failure that looks like a race and is really an ordering mistake. Registration is
 * deferred to `bootstrap()` below, between attaching subsystems and starting.
 */
type WorkerRegistration = () => void | Promise<void>;
let registerWorkers: WorkerRegistration = () => {};

/**
 * Compares two strings without leaking their contents through timing.
 *
 * A `!==` on a secret returns as soon as it finds a difference, so an attacker can
 * measure the prefix one byte at a time. `crypto.timingSafeEqual` needs equal
 * lengths, so a length mismatch is reported as a failure without being compared —
 * the length of a token is not the secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Hash both values first to avoid leaking length via early return.
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const isCluster = typeof process.env.CLUSTER_WORKER_ID !== "undefined";
const clusterId = process.env.CLUSTER_WORKER_ID ?? "0";
const isLeader = !isCluster || clusterId === "0";

export const runtime = createRuntime({
  cpuWorkers: isCluster ? 1 : 2,
  ioWorkers: isCluster ? 1 : 2,
  silent: !isLeader,
  // Fail any task that outlives this, so no promise is pinned in memory forever.
  taskTimeoutMs: 30_000,
});

const subsystems = [
  defineSubsystem({
    name: "auth",
    entrypoint: new URL("./func/auth.ts", import.meta.url),
    workload: "cpu",
  }),
  defineSubsystem({
    name: "jobs",
    entrypoint: new URL("./func/jobs.ts", import.meta.url),
    workload: "cpu",
  }),
  defineSubsystem({
    name: "db",
    entrypoint: new URL("./func/db.ts", import.meta.url),
    workload: "io",
  }),
  defineSubsystem({
    name: "cache",
    entrypoint: new URL("./func/cache.ts", import.meta.url),
    workload: "io",
  }),
  defineSubsystem({
    name: "mail",
    entrypoint: new URL("./func/mail.ts", import.meta.url),
    workload: "io",
  }),
  defineSubsystem({
    name: "storage",
    entrypoint: new URL("./func/storage.ts", import.meta.url),
    workload: "io",
  }),
  defineSubsystem({
    name: "events",
    entrypoint: new URL("./func/events.ts", import.meta.url),
    workload: "io",
  }),
  defineSubsystem({
    name: "cron",
    entrypoint: new URL("./func/cron.ts", import.meta.url),
    workload: "io",
  }),
];

async function bootstrap() {
  // Hand the observer the real subsystems. After this, every database query,
  // auth call and job execution produces a span without a single call site
  // being changed.
  attachSubsystems({
    db: (await import("./func/db")).db,
    auth: (await import("./func/auth")).auth,
    jobs: (await import("./func/jobs")).jobs,
    cache: (await import("./func/cache")).cache,
    storage: (await import("./func/storage")).storage,
    mail: (await import("./func/mail")).mailer,
    realtime,
  });

  observer.start();
  /*
   * Register job handlers only now — after the subsystems above are attached, and
   * before the fleet starts. See the note at the import site.
   */
  ({ registerWorkers } = await import("./func/workers"));
  await registerWorkers();

  await runtime.start();

  for (const sub of subsystems) {
    await runtime.registerSubsystem(sub);
  }

  // ── APM ────────────────────────────────────────────────────────────────
  // Wrapping the router means every request produces a server span, a
  // duration observation and a trace id header, without any per-route work.
  // Declared before Bun.serve so the handler never touches a TDZ binding.
  const instrumented = observer.instrument(
    async (request: Request): Promise<Response> => routers(request, server),
    (request: Request) => {
      const path = new URL(request.url).pathname;
      // Collapse ids to a route pattern so spans aggregate by shape, not by
      // every concrete URL. Anchored to whole segments: unanchored, "/2fa"
      // became "/:nfa" and "/abcdef0123456789xyz" became "/:idxyz".
      return path
        .replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, "/:id")
        .replace(/\/\d+(?=\/|$)/g, "/:n");
    },
  );

  let isShuttingDown = false;

  // From the validated env, not a second raw read.
  const port = env.PORT;
  const server = Bun.serve({
    port,
    reusePort: true,

    /*
     * Both set explicitly, because both defaults are wrong here.
     *
     * `idleTimeout` defaults to about 10s. A realtime connection that sends nothing
     * for longer than that is closed by the server with nothing in the logs, so an
     * SSE client simply stops receiving events and the cause is invisible. 255s is
     * the maximum and is comfortably longer than any heartbeat.
     *
     * `maxRequestBodySize` defaults to a large value. Since the router reads a body
     * fully into memory, an endpoint that accepts an upload turns a large request
     * into an out-of-memory crash instead of a rejected one.
     */
    idleTimeout: env.IDLE_TIMEOUT_SEC ?? 255,
    maxRequestBodySize: env.MAX_REQUEST_BODY_BYTES ?? 10 * 1024 * 1024,

    async fetch(req, server) {
      const url = new URL(req.url);

      // ── Orchestrator health probes ───────────────────────────────────────
      // Liveness: the process is up. Never touches the runtime, so a
      // saturated worker pool cannot cause a restart loop.
      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }

      // Readiness: the worker fleet is mounted and able to serve traffic.
      if (url.pathname === "/readyz") {
        // Live fleet state, not configured topology: the latter is a static
        // number and would report "ready" even with every worker dead.
        const health = runtime.getHealth();
        const ready = health.ready && !isShuttingDown;

        return Response.json(
          {
            status: isShuttingDown
              ? "shutting_down"
              : ready
                ? "ready"
                : "degraded",
            topology: runtime.getTopology(),
            health,
            inFlightTasks: runtime.getActiveTaskCount(),
          },
          {
            status: ready ? 200 : 503,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }

      // ── Observability ────────────────────────────────────────────────────
      // /_yatta/* is claimed by the observer before anything else runs, so
      // health, metrics and the dashboard are reachable without registering a
      // route. Everything else falls through to the app router.
      if (observer.router.matches(url.pathname)) {
        /*
         * Gated.
         *
         * This was reachable by anyone who could reach the port, and it serves
         * traces, spans, metric names, error messages and a dashboard that shows
         * request URLs and query strings. On a public port that is an information
         * disclosure, not a debug convenience: error messages alone tend to name
         * internal hosts and sometimes the shape of a query.
         *
         * `YATTA_OBSERVE_TOKEN` is the way in — a header for probes and a query
         * parameter for a browser you cannot add headers to. In development, and
         * only in development, the gate is open: a token nobody knows yet would
         * make the first run look broken.
         */
        const token = env.YATTA_OBSERVE_TOKEN;

        if (env.NODE_ENV === "production" && !token) {
          return Response.json(
            { error: "Observability is disabled. Set YATTA_OBSERVE_TOKEN to enable it." },
            { status: 404 },
          );
        }

        if (token) {
          const headerToken = req.headers.get("x-yatta-observe-token");
          const queryToken = url.searchParams.get("token");
          const supplied = headerToken ?? queryToken;

          if (queryToken && !headerToken) {
            console.warn(
              "[observe] WARNING: Observe token supplied via URL query parameter. " +
                "This exposes the token in server logs, proxies, and browser history. " +
                "Use the x-yatta-observe-token header instead.",
            );
          }

          // Compared in constant time. A length-independent `!==` leaks the token
          // one byte at a time to anyone willing to measure it.
          if (!timingSafeEqual(supplied ?? "", token)) {
            return Response.json({ error: "Not authorised" }, { status: 401 });
          }
        }
        // matches() implies handle() resolves, but the signature does not, so
        // the fallback is spelled out rather than cast away.
        return (
          (await observer.router.handle(req)) ??
          Response.json({ error: "Unknown observe route" }, { status: 404 })
        );
      }

      return instrumented(req);
    },

    websocket: realtime.websocket,

    development: env.NODE_ENV !== "production",

    error(err) {
      console.error("[server:error]", err);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    },
  });

  if (isCluster) {
    console.log(
      `[Cluster Worker #${clusterId}] Ready at http://localhost:${server.port} (PID: ${process.pid})`,
    );
  } else {
    console.log(
      `✓ Mounted ${subsystems.length} subsystems (${subsystems.map((s) => s.name).join(", ")})`,
    );
    console.log(
      `Yatta server running at http://localhost:${server.port} (PID: ${process.pid})`,
    );
  }

  /*
   * Timings, and why each is longer than the one before it.
   *
   *   preStopMs   the pod stays in the load balancer while it finishes failing
   *               readiness. A pod that stops listening first returns connection
   *               refused to whatever the balancer has not yet noticed.
   *   drainMs     in-flight worker tasks.
   *   hardStopMs  everything above, plus teardown.
   *
   * The hard stop used to be 15s against a 30s drain, so it fired halfway through
   * the drain and exited 1 — killing the long tasks the drain existed to let
   * finish, and reporting a failure for a clean shutdown.
   *
   * An orchestrator must allow more than hardStopMs. Kubernetes defaults
   * `terminationGracePeriodSeconds` to 30, which is less than this, so the SIGKILL
   * arrives first and the ordering below is moot. Raise it.
   */
  const PRE_STOP_MS = 5_000;
  const DRAIN_BUDGET_MS = 30_000;
  const HARD_STOP_MS = DRAIN_BUDGET_MS + PRE_STOP_MS + 5_000;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    /*
     * A second signal means "stop now". Without this, Ctrl-C twice does nothing and
     * the operator is left watching a drain they have already given up on.
     */
    const onSecondSignal = () => {
      console.error(`[shutdown] Second ${signal} — exiting immediately.`);
      process.exit(1);
    };
    process.once(signal, onSecondSignal);

    // Not unref'd: this timer is the thing that has to fire. An unref'd hard stop
    // lets the process exit with pending work whenever nothing else happens to be
    // holding the loop open, which is a silent early exit rather than a hard stop.
    const hardStop = setTimeout(() => {
      console.error(`[shutdown] Hard stop after ${HARD_STOP_MS}ms — exiting.`);
      process.exit(1);
    }, HARD_STOP_MS);

    try {
      /*
       * 1. Fail readiness first, then wait, then stop listening.
       *
       *    Reversed, this returned connection refused to whatever the load balancer
       *    had not yet noticed. It also made the `shutting_down` readiness state
       *    unreachable: the server was no longer accepting requests, so nothing could
       *    read it.
       */
      console.log(`[shutdown] ${signal} received — failing readiness for ${PRE_STOP_MS}ms`);
      await sleep(PRE_STOP_MS);

      void server.stop();
      console.log("[shutdown] Draining in-flight tasks...");

      /*
       * 2. Stop accepting new background work.
       *
       *    Cron and job pickup kept running for the whole drain, so a job could
       *    start after SIGTERM and then be killed mid-task by the shutdown below —
       *    a failure that looks like the drain's fault and is not.
       */
      runtime.pauseWork();

      // 3. Give in-flight tasks time to finish cleanly.
      const drained = await runtime.drain(DRAIN_BUDGET_MS);
      if (!drained) {
        console.warn(
          `[shutdown] Drain timed out with ${runtime.getActiveTaskCount()} task(s) in flight — forcing.`,
        );
      } else {
        console.log("[shutdown] All tasks drained cleanly.");
      }

      // 4. Close whatever is left, then tear down the worker threads.
      await server.stop(true);
      await runtime.shutdown();

      // 5. Stop the observer last, once nothing else will record anything.
      //
      //    Its 3s sampling timer, its SSE subscribers and its unhandledRejection
      //    handlers all outlived the process otherwise, and the last spans of a
      //    deploy were never flushed.
      observer.stop();
      clearTimeout(hardStop);
      console.log("[shutdown] Complete.");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] Failed:", err);
      process.exit(1);
    }
  };

  /*
   * The same graceful path for faults that never reach the signal handlers.
   *
   * An uncaught exception or an unhandled rejection otherwise ends the process with
   * no drain: in-flight tasks abandoned, sockets open, buffered spans lost. Which is
   * the loudest possible failure arriving at the least convenient moment.
   */
  process.on("uncaughtException", (err) => {
    console.error("[fatal] Uncaught exception:", err);
    void shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] Unhandled rejection:", reason);
    void shutdown("unhandledRejection");
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
