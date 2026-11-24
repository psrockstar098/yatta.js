import { createRuntime, defineSubsystem } from "yatta.js/runtime";
import { loadEnv } from "./func/env";
import { rememberPeerAddress } from "./func/peer";
import crypto from "node:crypto";

// Validate configuration before any subsystem, database, or socket is created.
export const env = loadEnv();

if (env.isEphemeralSecret) {
  console.warn(
    "[env] STORAGE_SECRET not set — using an ephemeral dev secret. " +
      "Signed URLs will not survive a restart.",
  );
}

const [
  { default: routers },
  { realtime },
  { observer, attachSubsystems },
] = await Promise.all([
  import("./func/routerHelper"),
  import("./func/realtime"),
  import("./func/observe"),
]);

/**
 * Compares a supplied token against a precomputed SHA-256 digest in constant time.
 *
 * Hashing the supplied input to a fixed 32-byte digest before `crypto.timingSafeEqual`
 * avoids leaking either the expected token's bytes or its length via early returns.
 */
function timingSafeEqualHash(input: string, expectedDigest: Buffer): boolean {
  const inputDigest = crypto.createHash("sha256").update(input).digest();
  return crypto.timingSafeEqual(inputDigest, expectedDigest);
}

const observeToken = env.YATTA_OBSERVE_TOKEN;
const observeTokenHash = observeToken
  ? crypto.createHash("sha256").update(observeToken).digest()
  : null;

const rawClusterId = process.env.CLUSTER_WORKER_ID;
const isCluster = rawClusterId !== undefined && rawClusterId !== "";
const clusterId = isCluster ? rawClusterId : "0";
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

  let isShuttingDown = false;
  let hadFatalFault = false;
  let observerStarted = false;
  let runtimeStarted = false;
  let server: ReturnType<typeof Bun.serve> | undefined;

  const shutdown = async (signal: string) => {
    const isFatal =
      signal === "uncaughtException" || signal === "unhandledRejection";
    if (isFatal) hadFatalFault = true;

    if (isShuttingDown) return;
    isShuttingDown = true;

    // Not unref'd: this timer is the thing that has to fire. An unref'd hard stop
    // lets the process exit with pending work whenever nothing else happens to be
    // holding the loop open, which is a silent early exit rather than a hard stop.
    const hardStop = setTimeout(() => {
      console.error(`[shutdown] Hard stop after ${HARD_STOP_MS}ms — exiting.`);
      process.exit(1);
    }, HARD_STOP_MS);

    try {
      // On a fatal fault, stop accepting new work immediately: the process is
      // already broken and there is no pre-stop window to protect. On a graceful
      // signal the pause stays after the pre-stop wait, before the drain (below):
      // pauseWork refuses every new scheduler dispatch, including request-handler
      // calls, so pausing before the pre-stop window would fail live HTTP
      // requests still arriving from the load balancer with WorkPausedError.
      if (isFatal && runtimeStarted) {
        runtime.pauseWork();
      }

      /*
       * 1. On graceful signals, fail readiness first, then wait, then stop listening.
       *
       *    On fatal faults, skip the pre-stop window and stop accepting new
       *    connections immediately.
       */
      if (server && !isFatal) {
        console.log(
          `[shutdown] ${signal} received — failing readiness for ${PRE_STOP_MS}ms`,
        );
        await sleep(PRE_STOP_MS);
      } else if (isFatal) {
        console.error(
          `[shutdown] Fatal fault (${signal}) — stopping immediately without pre-stop delay.`,
        );
      }

      const httpDrained = server
        ? server.stop().catch((err) => {
            console.error("[shutdown] server.stop() error:", err);
          })
        : Promise.resolve();

      console.log("[shutdown] Draining in-flight tasks...");

      // Stop accepting new background work before the drain, so no cron tick or
      // queued job starts after the signal and gets killed mid-task by the
      // teardown below. This is its original position — after the pre-stop wait
      // and after server.stop() — for the reason above: pausing earlier would
      // refuse live requests. A job that starts during the 5s pre-stop window
      // is bounded by the drain budget. (No-op on the fatal path: already paused.)
      if (runtimeStarted) {
        runtime.pauseWork();
      }

      // 2. Give in-flight tasks and HTTP requests time to finish cleanly.
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const drainTimeout = new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, DRAIN_BUDGET_MS);
      });

      const [drained] = await Promise.all([
        runtimeStarted ? runtime.drain(DRAIN_BUDGET_MS) : Promise.resolve(true),
        Promise.race([httpDrained, drainTimeout]).finally(() => {
          if (drainTimer) clearTimeout(drainTimer);
        }),
      ]);

      if (!drained) {
        console.warn(
          `[shutdown] Drain timed out with ${runtime.getActiveTaskCount()} task(s) in flight — forcing.`,
        );
      } else {
        console.log("[shutdown] All tasks drained cleanly.");
      }

      // 3. Close whatever is left, then tear down the worker threads.
      if (server) {
        await server.stop(true);
      }
      if (runtimeStarted) {
        await runtime.shutdown();
      }

      // 4. Stop the observer last, once nothing else will record anything.
      //
      //    Its 3s sampling timer, its SSE subscribers and its unhandledRejection
      //    handlers all outlived the process otherwise, and the last spans of a
      //    deploy were never flushed.
      if (observerStarted) {
        observer.stop();
      }
      clearTimeout(hardStop);
      console.log("[shutdown] Complete.");
      process.exit(hadFatalFault ? 1 : 0);
    } catch (err) {
      console.error("[shutdown] Failed:", err);
      process.exit(1);
    }
  };

  /*
   * Register signal and fatal handlers before starting subsystems so early
   * termination or faults during startup still tear down initialized state.
   */
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (isShuttingDown) {
      console.error(`[shutdown] Second signal (${signal}) — exiting immediately.`);
      process.exit(1);
    }
    void shutdown(signal);
  };

  process.on("uncaughtException", (err) => {
    console.error("[fatal] Uncaught exception:", err);
    hadFatalFault = true;
    if (isShuttingDown) {
      console.error("[shutdown] Uncaught exception during shutdown — exiting immediately.");
      process.exit(1);
    }
    void shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] Unhandled rejection:", reason);
    hadFatalFault = true;
    if (!isShuttingDown) {
      void shutdown("unhandledRejection");
    }
  });

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    // Hand the observer the real subsystems. After this, every database query,
    // auth call and job execution produces a span without a single call site
    // being changed.
    const [
      { db },
      { auth },
      { jobs },
      { cache },
      { storage },
      { mailer },
    ] = await Promise.all([
      import("./func/db"),
      import("./func/auth"),
      import("./func/jobs"),
      import("./func/cache"),
      import("./func/storage"),
      import("./func/mail"),
    ]);

    attachSubsystems({
      db,
      auth,
      jobs,
      cache,
      storage,
      mail: mailer,
      realtime,
    });

    observer.start();
    observerStarted = true;

    /*
     * The worker module registers handlers; it must not be imported until the
     * subsystems above are attached, and before the fleet starts.
     */
    const { registerWorkers } = await import("./func/workers");
    await registerWorkers();

    await runtime.start();
    runtimeStarted = true;

    for (const sub of subsystems) {
      await runtime.registerSubsystem(sub);
    }

    const HEALTHZ_BODY = '{"status":"ok"}';
    const HEALTHZ_HEADERS = { "Content-Type": "application/json;charset=utf-8" };
    const requestPathCache = new WeakMap<Request, string>();

    // ── APM ────────────────────────────────────────────────────────────────
    // Wrapping the router means every request produces a server span, a
    // duration observation and a trace id header, without any per-route work.
    // Declared before Bun.serve so the handler never touches a TDZ binding.
    const instrumented = observer.instrument(
      async (request: Request): Promise<Response> => routers(request, activeServer),
      (request: Request) => {
        const path =
          requestPathCache.get(request) ?? new URL(request.url).pathname;
        // Collapse ids to a route pattern so spans aggregate by shape, not by
        // every concrete URL. Anchored to whole segments: unanchored, "/2fa"
        // became "/:nfa" and "/abcdef0123456789xyz" became "/:idxyz".
        return path
          .replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, "/:id")
          .replace(/\/\d+(?=\/|$)/g, "/:n");
      },
    );

    // From the validated env, not a second raw read.
    const port = env.PORT;
    const activeServer = Bun.serve({
      port,
      reusePort: isCluster,

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

      async fetch(req, srv) {
        // Bun guarantees req.url parses: raw-TCP probes with malformed targets
        // (%zz, http://[::1/, user:pass@:80, //evil.com/x) were all rejected
        // with 505 or normalised before fetch() ran, so no try/catch here —
        // it would be dead code.
        const url = new URL(req.url);

        // ── Orchestrator health probes ───────────────────────────────────────
        // Liveness: the process is up. Never touches the runtime, so a
        // saturated worker pool cannot cause a restart loop.
        if (url.pathname === "/healthz") {
          return new Response(HEALTHZ_BODY, { headers: HEALTHZ_HEADERS });
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

        /*
         * The peer address exists only here, and auth's per-IP rate limits need it.
         * Recorded before anything else touches non-probe requests.
         */
        rememberPeerAddress(req, srv.requestIP(req)?.address);

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
          if (env.NODE_ENV !== "development" && !observeToken) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }

          if (observeTokenHash) {
            const headerToken = req.headers.get("x-yatta-observe-token");
            const queryToken = url.searchParams.get("token");
            const supplied = headerToken ?? queryToken;

            // Compared in constant time against the precomputed SHA-256 digest.
            if (!supplied || !timingSafeEqualHash(supplied, observeTokenHash)) {
              return Response.json({ error: "Not authorised" }, { status: 401 });
            }

            if (queryToken && !headerToken) {
              console.warn(
                "[observe] WARNING: Observe token supplied via URL query parameter. " +
                  "This exposes the token in server logs, proxies, and browser history. " +
                  "Use the x-yatta-observe-token header instead.",
              );
            }
          }
          // matches() implies handle() resolves, but the signature does not, so
          // the fallback is spelled out rather than cast away.
          return (
            (await observer.router.handle(req)) ??
            Response.json({ error: "Unknown observe route" }, { status: 404 })
          );
        }

        requestPathCache.set(req, url.pathname);
        return instrumented(req);
      },

      websocket: realtime.websocket,

      development: env.NODE_ENV === "development",

      error(err) {
        console.error("[server:error]", err);
        return Response.json({ error: "Internal Server Error" }, { status: 500 });
      },
    });
    server = activeServer;

    if (isCluster) {
      console.log(
        `[Cluster Worker #${clusterId}] Ready at http://localhost:${activeServer.port} (PID: ${process.pid})`,
      );
    } else {
      console.log(
        `✓ Mounted ${subsystems.length} subsystems (${subsystems.map((s) => s.name).join(", ")})`,
      );
      console.log(
        `Yatta server running at http://localhost:${activeServer.port} (PID: ${process.pid})`,
      );
    }
  } catch (err) {
    if (server) {
      try {
        await server.stop(true);
      } catch {}
    }
    if (runtimeStarted) {
      try {
        await runtime.shutdown();
      } catch {}
    }
    if (observerStarted) {
      try {
        observer.stop();
      } catch {}
    }
    throw err;
  }
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
