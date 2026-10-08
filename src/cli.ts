#!/usr/bin/env bun
// src/cli.ts — the `yatta` command.
//
// Zero dependencies, runs on Bun (or Node 22+ via --experimental-strip-types).
// Every command is a thin wrapper around something you can also run by hand,
// so nothing here becomes a thing you have to learn.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cmdDoctor } from "./cli_doctor";
import { cmdMigrate, cmdMigrateMake, cmdMigrateStatus } from "./cli_migrate";
import { cmdDbBackup, cmdDbRestore } from "./cli_backup";

const VERSION = "1.0.0";

const C: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

// Colours are noise in CI logs and in piped output.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_t, key: string) => (useColor ? C[key] ?? "" : ""),
  },
);

const log = (msg = "") => console.log(msg);
const ok = (msg: string) => log(`${c.green}✓${c.reset} ${msg}`);
const warn = (msg: string) => log(`${c.yellow}!${c.reset} ${msg}`);
const fail = (msg: string) => log(`${c.red}✗${c.reset} ${msg}`);
const step = (msg: string) => log(`${c.cyan}›${c.reset} ${msg}`);

/** Runs a command, streaming output. Returns the exit code. */
function run(cmd: string, args: string[], cwd?: string): number {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: false });
  if (res.error) {
    fail(`Could not run \`${cmd}\`: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/** Locates the framework root (where package.json lives), from this file. */
function frameworkRoot(): string {
  return resolve(import.meta.dir, "..");
}

function pkg(): Record<string, any> {
  return JSON.parse(readFileSync(join(frameworkRoot(), "package.json"), "utf8"));
}

/**
 * The name this package installs under.
 *
 * Read from package.json rather than written out by hand, because the instructions used
 * to say `bun link yatta` while the package is called `yatta.js`. That created
 * node_modules/yatta while every scaffolded file imports `yatta.js/*`, so following the
 * documented steps exactly produced a project that could not typecheck — 20+ errors on
 * a fresh `yatta new`.
 */
function pkgName(): string {
  return pkg().name ?? "yatta.js";
}

/**
 * Reloads a `Bun.FileSystemRouter`, at most once per `intervalMs`.
 *
 * The original intent — pick up a newly added route file without restarting — was
 * implemented as `router.reload()` on *every request*. That costs a directory scan per
 * request, and it is also incorrect under concurrency: `reload()` mutates the route
 * table while `match()` reads it, and the interleaving produced intermittent 500s.
 * Measured on a fresh scaffold: 40 of 100 concurrent requests to a file-routed path
 * failed, while the same handler reached through `/api` was 75/75 clean.
 *
 * State is per-router rather than module-level, and a reload already in flight is not
 * started again, so two concurrent requests cannot race.
 *
 * 500ms is far below the gap a person notices when adding a file, and far above the
 * cost of the scan it replaces.
 */
const reloadState = new WeakMap<object, { last: number; running: boolean }>();

export function throttledReload(router: object, intervalMs = 500): void {
  const reload = (router as { reload?: () => void }).reload;
  if (typeof reload !== "function") return;

  let state = reloadState.get(router);
  if (!state) {
    state = { last: 0, running: false };
    reloadState.set(router, state);
  }

  const now = Date.now();
  if (state.running || now - state.last < intervalMs) return;

  state.running = true;
  state.last = now;
  try {
    reload.call(router);
  } finally {
    state.running = false;
  }
}


// ── Commands ──────────────────────────────────────────────────────────────

/**
 * yatta/main.ts — the entrypoint. Mounts every subsystem found in
 * yatta/func/, then serves file-based routes from yatta/backend/.
 */
export const TEMPLATE_MAIN = `// yatta/main.ts — the server entrypoint.
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
      .replace(new RegExp("\\\\/[0-9a-f-]{16,}", "gi"), "/:id")
      .replace(new RegExp("\\\\/\\\\d+", "g"), "/:n"),
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

console.log(\`✓ Yatta listening on http://localhost:\${server.port}\`);
console.log(\`  routes:  yatta/backend/\`);
console.log(\`  modules: yatta/func/\`);
console.log(\`  observe:  http://localhost:\${server.port}/_yatta/dashboard\`);

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
      \`[shutdown] drain timed out with \${runtime.getActiveTaskCount()} task(s) in flight — forcing.\`,
    );
  }

  await runtime.shutdown();
  console.log("[shutdown] complete.");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
`;

/** yatta/backend/index.ts — serves GET / */
const TEMPLATE_BACKEND_INDEX = `// yatta/backend/index.ts — this file serves GET /
import { API, createAPI } from "yatta.js/api";

const api = createAPI();

api.get(async () => {
  return API.json({
    ok: true,
    message: "Edit yatta/backend/ to add your routes.",
  });
});

export default api;
`;

/** yatta/backend/index.ts router entry — dispatches to backend files. */
const TEMPLATE_ROUTER = `// yatta/backend/_router.ts
//
// Maps request paths to the files in this folder, Next.js style:
//   yatta/backend/index.ts        -> GET /
//   yatta/backend/user/index.ts   -> /user
//   yatta/backend/posts/[id].ts   -> /posts/:id
//
// You rarely need to edit this — add a file and it is picked up.

import path from "node:path";
import { API, throttledReload } from "yatta.js/api";

const fileRouter = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: import.meta.dir,
});

/**
 * Pulls the API instance out of a route module.
 * Supports \`export default api\`, \`export const api\`, and CJS interop.
 */
function resolveApi(module: Record<string, unknown>): any {
  const candidate: any = module.default ?? module.api ?? module;
  if (!candidate) return undefined;
  if (candidate instanceof API) return candidate;
  if (candidate.default instanceof API) return candidate.default;
  if (typeof candidate.handle === "function") return candidate;
  if (candidate.default && typeof candidate.default.handle === "function") {
    return candidate.default;
  }
  return undefined;
}

export async function routers(req: Request, server: any): Promise<Response> {
  if (process.env.NODE_ENV !== "production") throttledReload(fileRouter);

  let match = fileRouter.match(req);
  let basePath: string | undefined;

  // Try the trailing-slash variant.
  if (!match) {
    const url = new URL(req.url);
    const alt = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = fileRouter.match(alt);
  }

  // Walk up to a parent directory, e.g. /user/profile -> /user.
  if (!match) {
    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    while (segments.length > 0) {
      const parentPath = "/" + segments.join("/");
      const candidate = fileRouter.match(parentPath);
      if (candidate) {
        match = candidate;
        basePath = parentPath;
        break;
      }
      segments.pop();
    }
  }

  if (!match) return new Response("Not Found", { status: 404 });

  let module: Record<string, unknown>;
  try {
    module = await import(match.filePath);
  } catch (err) {
    console.error(\`Failed to load route \${match.filePath}:\`, err);
    return new Response("Internal Server Error", { status: 500 });
  }

  const api = resolveApi(module);
  if (!api) {
    console.error(
      \`Route "\${match.filePath}" must export an API instance:\` +
        \`\\n\\n  import { API, createAPI } from "yatta.js/api";\\n\` +
        \`  const api = createAPI();\\n\` +
        \`  api.get(async () => API.json({ ok: true }));\\n\` +
        \`  export default api;\\n\`,
    );
    return new Response("Route handler not found", { status: 500 });
  }

  const res = await api.handle(req, match.params, basePath);

  // Standard hardening headers.
  const isHttps =
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isHttps) {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return res;
}
`;

const TEMPLATE_PKG = (name: string) =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "bun --watch yatta/main.ts",
        start: "bun yatta/main.ts",
        check: "bunx tsc --noEmit",
      },
      devDependencies: { "@types/bun": "latest" },
    },
    null,
    2,
  ) + "\n";

// ── Subsystem templates ───────────────────────────────────────────────────
// These mirror the framework's own src/func/* so a developer starts with
// the same wiring: schema, auth store, workers, cron, events.

const TEMPLATE_FUNC_DB = `// yatta/func/db.ts
//
// The ORM. Edit the schema to match your app; the table types are inferred.
import { col, createDatabase, connect } from "yatta.js/db";

export const schema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    passwordHash: col.text().nullable(),
    roles: col.json<string[]>().default(["user"]),
    emailVerified: col.boolean().default(false),
    twoFactorEnabled: col.boolean().default(false),
    encryptedTwoFactorSecret: col.text().nullable(),
    twoFactorRecoveryCodes: col.json<string[]>().nullable(),
    credentialVersion: col.integer().default(1),
    metadata: col.json<Record<string, unknown>>().nullable(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
  sessions: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    sessionTokenHash: col.text().unique(),
    refreshTokenHash: col.text().nullable(),
    expiresAt: col.date(),
    refreshVersion: col.integer().default(0),
    userAgent: col.text().nullable(),
    ip: col.text().nullable(),
    lastSeenAt: col.createdAt(),
    lastAuthenticatedAt: col.createdAt(),
    createdAt: col.createdAt(),
  },
  identities: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    provider: col.text(),
    providerAccountId: col.text(),
    email: col.text().nullable(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
  verificationTokens: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    tokenHash: col.text().unique(),
    type: col.text(),
    expiresAt: col.date(),
  },
  passkeys: {
    id: col.text().primaryKey(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    name: col.text().default("Passkey"),
    publicKey: col.text(),
    counter: col.integer().default(0),
    transports: col.json<string[]>().nullable(),
    createdAt: col.createdAt(),
    lastUsedAt: col.date().nullable(),
  },
  apiKeys: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    name: col.text(),
    keyHash: col.text().unique(),
    prefix: col.text(),
    scopes: col.json<string[]>().default(["*"]),
    expiresAt: col.date().nullable(),
    lastUsedAt: col.date().nullable(),
    createdAt: col.createdAt(),
  },
};

// This makes db.users, db.sessions, … fully typed.
declare module "yatta.js/db" {
  interface Register {
    schema: typeof schema;
  }
}

export const db = createDatabase({
  // WAL + busy_timeout are applied on open, so cluster mode is safe.
  path: process.env.DATABASE_URL || "Database/app.db",
  schema,
});

export { connect };
`;

const TEMPLATE_FUNC_CACHE = `// yatta/func/cache.ts
//
// Two-tier cache: L1 in-process LRU, L2 persisted to SQLite.
import { createCache, SQLiteL2CacheStore } from "yatta.js/cache";

export const cache = createCache({
  maxItems: 20_000,
  defaultTtl: "1h",
  l2Storage: new SQLiteL2CacheStore("Database/cache.db"),
});
`;

const TEMPLATE_FUNC_MAIL = `// yatta/func/mail.ts
//
// Terminal output in development; "smtp" in production.
import { createMailer } from "yatta.js/mail";

export interface AppTemplates {
  welcome: { name: string; verifyUrl: string };
}

declare module "yatta.js/mail" {
  interface MailRegister {
    templates: AppTemplates;
  }
}

export const mailer = createMailer({
  defaultFrom: process.env.MAIL_FROM || "Yatta App <hello@localhost>",
  mode: process.env.NODE_ENV === "production" ? "smtp" : "terminal",
});

mailer.registerLayout(
  "default",
  \`<!DOCTYPE html>
  <html>
    <body style="font-family:sans-serif;background:#fafafa;padding:20px;">
      <div style="background:#fff;padding:24px;border-radius:8px;max-width:600px;margin:auto;">
        {{{content}}}
      </div>
    </body>
  </html>\`,
);

mailer.registerTemplate<AppTemplates["welcome"]>("welcome", {
  subject: "Welcome to Yatta, {{name}}!",
  layout: "default",
  html: \`
    <h2>Welcome, {{name}}</h2>
    <p>Please confirm your email address:</p>
    <a href="{{{verifyUrl}}}">Verify Email</a>
  \`,
});
`;

const TEMPLATE_FUNC_STORAGE = `// yatta/func/storage.ts
//
// Local disk by default. Point \`s3\` at R2/S3 for object-scale deployments;
// local disk does not sync across machines.
import { createStorage } from "yatta.js/storage";

declare module "yatta.js/storage" {
  interface StorageRegister {
    disks: "local" | "s3";
  }
}

export const storage = createStorage({
  default: "local",
  disks: {
    local: {
      driver: "local",
      baseDir: "./storage/uploads",
      publicUrl: "/storage/files",
    },
    s3: {
      driver: "s3",
      bucket: process.env.S3_BUCKET || "my-bucket",
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
});
`;

const TEMPLATE_FUNC_JOBS = `// yatta/func/jobs.ts
//
// Durable queue backed by SQLite (WAL). Add your job names to AppJobs to get
// full autocompletion on .job() and .handle().
import { createJobs, SQLiteJobStore } from "yatta.js/jobs";

export interface AppJobs {
  "send-email": { to: string; subject: string; body: string };
  "cleanup-stale-tokens": { maxAgeDays?: number };
}

declare module "yatta.js/jobs" {
  interface JobRegister extends AppJobs {}
}

export const jobs = createJobs({
  store: new SQLiteJobStore("Database/jobs.db"),
});
`;

const TEMPLATE_FUNC_EVENTS = `// yatta/func/events.ts
//
// Typed event bus wired to the queue, so an event can pipe straight into a
// background job.
import { createEvents } from "yatta.js/jobs";
import { jobs } from "./jobs";

export interface AppEvents {
  "user.registered": { userId: string; email: string };
}

declare module "yatta.js/jobs" {
  interface EventRegister extends AppEvents {}
}

export const events = createEvents(jobs);

// 1. Direct listener
events.on("user.registered", (data) => {
  console.log(\`[event] New user registered: \${data.email}\`);
});

// 2. Pipe the event into a background job.
// The 4th argument maps the event payload into the job payload.
events.pipe(
  "user.registered",
  "send-email",
  undefined,
  (data) => ({
    to: data.email,
    subject: "Welcome to Yatta!",
    body: "Thank you for creating an account.",
  }),
);
`;

const TEMPLATE_FUNC_CRON = `// yatta/func/cron.ts
//
// Cron expressions use standard 5-field Vixie syntax.
import { createCron } from "yatta.js/jobs";
import { jobs } from "./jobs";

export const cron = createCron();

// Every night at midnight UTC.
cron.schedule("nightly-cleanup", "0 0 * * *", async () => {
  await jobs.enqueue("cleanup-stale-tokens", {});
});

// Shorthand for simple intervals.
cron.every("10m", () => {
  console.log("[cron] heartbeat");
});
`;

const TEMPLATE_FUNC_OBSERVE = `// yatta/func/observe.ts
//
// Built-in observability: distributed tracing, metrics, structured logs,
// error monitoring, user feedback, and a dashboard.
//
// This is the single observer instance. Import it anywhere you need to record
// something; do not create a second one.

import { createObserver } from "yatta.js/observe";

export const observer = createObserver({
  service: "app",
  release: process.env.GIT_SHA,
  // Logical OR, not nullish coalescing: an empty NODE_ENV is common in
  // Docker and CI, and a nullish coalesce treats "" as set. That made a
  // production container read as development and serve the dashboard.
  environment: process.env.NODE_ENV || "development",

  // Keep 2k spans in memory for the dashboard. Lower this on a small box.
  bufferSize: 2000,

  // Sample a fraction of traces in production to bound cost.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1,

  // Everything below this level is dropped before it is masked, buffered,
  // breadcrumbed or broadcast. "silent" turns logging off entirely.
  logLevel: process.env.NODE_ENV === "production" ? "warn" : "info",

  // Serve the dashboard. Off by default so it cannot leak in production.
  dashboard: process.env.NODE_ENV !== "production",

  // Process memory, CPU and event-loop delay. Sampled on a timer, so it is on
  // while developing and off in production unless you turn it on.
  runtimeMetrics: process.env.NODE_ENV !== "production",
  runtimeSampleMs: 10_000,

  // Only queries slower than this are kept in the slow-query list.
  slowQueryThresholdMs: 250,
});

// ── Convenience wrappers ────────────────────────────────────────────────────
//
// The point of these is that a caller cannot forget to report something.

/** Report an error with the current request attached, if there is one. */
export function report(error: unknown, request?: Request): void {
  observer.errors.capture(error, request ? { request } : {});
}

/**
 * Run work inside a span.
 *
 * Always ends the span, and a throw is recorded and re-thrown — this observes,
 * it never swallows.
 */
export function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return observer.tracer.withSpan(name, {}, fn);
}

export const observeLog = observer.log;
`;

const TEMPLATE_BACKEND_HEALTH = `// yatta/backend/health.ts
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
    checks.db = { ok: true, detail: \`\${Date.now() - started}ms\` };
  } catch (err) {
    checks.db = { ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }

  try {
    const metrics = await jobs.metrics();
    checks.jobs = {
      ok: true,
      // \`queued\` and \`dead\` are the field names. \`pending\` and \`failed\` do not
      // exist on QueueMetrics, so this line read 0 and 0 forever — reported while
      // looking authoritative.
      detail: \`\${metrics.queued} queued, \${metrics.dead} dead\`,
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
`;

export const TEMPLATE_BACKEND_AUTH = `// yatta/backend/auth.ts
//
// Signup, signin, signout and "who am I".
//
// Auth is mounted in routes.ts, so these are live on a fresh project:
//
//   POST /api/auth/signup    { email, password }
//   POST /api/auth/signin    { email, password }
//   POST /api/auth/signout
//   GET  /api/auth/me
//
// Add password reset, passkeys, MFA or API keys here as you need them — they
// are methods on the same \`auth\` handle.

import { createAPI, HttpError } from "yatta.js/api";
import { auth } from "../func/auth";

const api = createAPI();

/**
 * signUp and signIn return a union: either a complete session, or a demand to
 * verify the address first. Both branches have to be handled, or a user is
 * silently left unable to sign in.
 */
function isVerificationRequired(
  result: unknown,
): result is { user: unknown; emailVerificationRequired: true } {
  return typeof result === "object" && result !== null && "emailVerificationRequired" in result;
}

/** Apply a token pair to a response. */
function sessionResponse(result: { tokens: unknown; cookies: string[] }, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);

  return new Response(
    JSON.stringify({ tokens: result.tokens }),
    { status, headers },
  );
}

/**
 * Whether a sign-in stopped at the second factor.
 *
 * Every sign-in route returns this instead of a session when the account has 2FA on,
 * and the returned value is a ticket, not a user id: a bare id gives an app's own
 * second step nothing to verify.
 */
function isMfaChallenge(
  result: unknown,
): result is { mfaRequired: true; ticket: string; expiresInSec: number } {
  return typeof result === "object" && result !== null && "mfaRequired" in result;
}

/** POST /api/auth/signup */
api.post("/signup", async (ctx) => {
  const { email, password } = (await ctx.req.json()) as {
    email: string;
    password: string;
  };

  const result = await auth.signUp({ email, password, req: ctx.req });

  if (isVerificationRequired(result)) {
    return Response.json(
      { user: result.user, emailVerificationRequired: true },
      { status: 202 },
    );
  }

  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ user: result.user }), { status: 201, headers });
});

/** POST /api/auth/signin */
api.post("/signin", async (ctx) => {
  const { email, password } = (await ctx.req.json()) as {
    email: string;
    password: string;
  };

  const result = await auth.signIn({ email, password, req: ctx.req });

  if (isVerificationRequired(result)) {
    return Response.json({ emailVerificationRequired: true }, { status: 202 });
  }

  // With 2FA on there is no session yet. Answering sessionResponse() here would read
  // cookies off an object that has none, so a 2FA user got a 500 from a fresh project.
  if (isMfaChallenge(result)) {
    return Response.json(result, { status: 202 });
  }

  return sessionResponse(result);
});

/** POST /api/auth/mfa — the second half of a sign-in that stopped at 2FA. */
api.post("/mfa", async (ctx) => {
  const { ticket, code, recoveryCode } = (await ctx.req.json()) as {
    ticket: string;
    code?: string;
    recoveryCode?: string;
  };

  // The ticket is single use, so a retry needs a new signIn.
  const result = await auth.completeMfa({ ticket, code, recoveryCode, req: ctx.req });

  return sessionResponse(result);
});

/** POST /api/auth/signout */
api.post("/signout", async (ctx) => {
  const result = await auth.signOut(ctx.req);
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(result), { status: 200, headers });
});

/** GET /api/auth/me — null when signed out. */
api.get("/me", async (ctx) => {
  const user = await auth.getUser(ctx.req);
  if (!user) throw new HttpError(401, "Not authenticated");
  return Response.json({ user });
});

/**
 * GET /api/auth/require-me — throws when signed out.
 *
 * requireUser raises the auth subsystem's own UnauthorizedError, which carries
 * status 401. routes.ts reads that status structurally, so the response is a
 * 401 rather than a 500.
 */
api.get("/require-me", async (ctx) => {
  const user = await auth.requireUser(ctx.req);
  return Response.json({ user });
});

export default api;
`;

const TEMPLATE_BACKEND_ROUTES = `// yatta/backend/routes.ts
//
// The API entry point.
//
// Everything under /api is served from here. Each feature is a file that
// exports an API instance; mount it below and it keeps its own middleware,
// validation and error handling.
//
//   yatta/backend/health.ts   ->  /api/health
//   yatta/backend/users.ts    ->  /api/users, /api/users/:id

import { createAPI } from "yatta.js/api";
import { observer } from "../func/observe";
import auth from "./auth";
import health from "./health";

const api = createAPI("/api");

// CORS first, so a preflight never reaches a handler.
api.cors({
  origin: (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(","),
  credentials: true,
});

// Mount a feature router. Add a line per feature file.
api.mount("/health", health);

// Auth ships mounted so signup and signin work on a fresh project.
api.mount("/auth", auth);

// Add your own routes here, or create yatta/backend/users.ts and mount it.
// api.mount("/users", users);

/*
 * Telemetry aliases.
 *
 * The observer answers /_yatta/** itself, ahead of this router. These proxy
 * through it so a client that only knows /api can still read telemetry, and so
 * the numbers match the dashboard exactly rather than being recomputed here.
 */
api.get("/telemetry", async (ctx) => {
  const res = await observer.router.handle(
    new Request(new URL("/_yatta/api/telemetry", ctx.req.url)),
  );
  return res ?? Response.json({ error: "unavailable" }, { status: 503 });
});

api.get("/issues", async (ctx) => {
  const res = await observer.router.handle(
    new Request(new URL("/_yatta/api/errors", ctx.req.url)),
  );
  return res ?? Response.json({ error: "unavailable" }, { status: 503 });
});

/**
 * Every throw lands in one place, in one shape, and is captured by the
 * observer with the request and trace attached.
 *
 * The status is read structurally rather than with \`instanceof HttpError\`,
 * because auth, db and jobs each define their own error base class — an
 * UnauthorizedError carrying status 401 would otherwise come back as a 500.
 */
api.onError((error, ctx) => {
  observer.errors.capture(error, { request: ctx.req });

  const carried = (error as { status?: unknown }).status;
  const status =
    typeof carried === "number" &&
    Number.isInteger(carried) &&
    carried >= 400 &&
    carried <= 599
      ? carried
      : 500;

  return Response.json(
    {
      error:
        status === 500 && process.env.NODE_ENV === "production"
          ? "Internal Server Error"
          : (error as Error).message,
    },
    { status },
  );
});

export default api;
`;

const TEMPLATE_FUNC_WORKERS = `// yatta/func/workers.ts
//
// Handlers registered here run in a worker pool, isolated from the HTTP loop.
import { jobs } from "./jobs";
import { mailer } from "./mail";

jobs.handle("send-email", async ({ data }) => {
  await mailer.send({
    to: data.to,
    subject: data.subject,
    text: data.body,
  });
});

jobs.handle("cleanup-stale-tokens", async ({ log }) => {
  log("Cleaning up expired verification tokens and sessions...");
});

// Queue name, then the concurrency and polling config.
export const defaultWorker = jobs.worker("default", {
  concurrency: 5,
  pollInterval: "1s",
  lockDuration: "60s",
});
`;

const TEMPLATE_FUNC_PEER = `// yatta/func/peer.ts
//
// The client's real address, captured at the edge.
//
// Bun does not put the peer address on Request — it lives on the server, as
// server.requestIP(req). Anything downstream that needs it (auth's per-IP rate
// limits, most obviously) has only the Request, and a Request does not carry it.
//
// So the address is recorded here on the way in, keyed by the Request itself. A
// WeakMap, so an entry disappears with the request rather than accumulating for
// the life of the process, and no header is injected and no Request is cloned —
// either of those would cost something on every single request to solve a
// problem only auth has.

const addresses = new WeakMap<Request, string>();

/**
 * Records the peer address for one request. Called from fetch(), which is the
 * only place the server is available.
 */
export function rememberPeerAddress(req: Request, address: string | undefined): void {
  if (address) addresses.set(req, address);
}

/**
 * The peer address of a request, or undefined when it was not recorded.
 *
 * Undefined is a real possibility and not a bug: a request that never passed
 * through fetch() — a test calling a handler directly, or a route invoked in
 * process — has no peer. Callers must treat it as "unknown", never as "local".
 */
export function peerAddress(req: Request): string | undefined {
  return addresses.get(req);
}
`;

const TEMPLATE_FUNC_AUTH = `// yatta/func/auth.ts
//
// Auth persisted through your own SQLite database. Handles Argon2id
// passwords, rotating JWTs, TOTP 2FA, WebAuthn passkeys, and API keys.
import {
  createAuth,
  type AuthStore,
  type AuthUser,
  type AuthSession,
  type AuthIdentity,
  type AuthVerificationToken,
  type AuthPasskeyCredential,
  type AuthApiKey,
} from "yatta.js/auth";
import { db } from "./db";
import { mailer } from "./mail";
import { peerAddress } from "./peer";

export class SQLiteAuthStore implements AuthStore {
  async findUserById(id: string): Promise<AuthUser | null> {
    const u = db.users.findById(id);
    return u ? this.toUser(u) : null;
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const u = db.users.findFirst({ where: { email: email.toLowerCase().trim() } });
    return u ? this.toUser(u) : null;
  }

  async createUser(
    data: Omit<AuthUser, "createdAt" | "updatedAt">,
  ): Promise<AuthUser> {
    const row = db.users.insert({
      ...data,
      email: data.email.toLowerCase().trim(),
    } as any);
    return this.toUser(row);
  }

  async updateUser(id: string, updates: Partial<AuthUser>): Promise<AuthUser> {
    const row = db.users.updateById(id, updates as any);
    if (!row) throw new Error("User not found");
    return this.toUser(row);
  }

  async deleteUser(id: string): Promise<void> {
    db.users.deleteById(id);
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    return this.toSession(db.sessions.insert(session as any));
  }

  async findSessionById(id: string): Promise<AuthSession | null> {
    const s = db.sessions.findById(id);
    if (!s || new Date(s.expiresAt) < new Date()) return null;
    return this.toSession(s);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const s = db.sessions.findFirst({ where: { sessionTokenHash: tokenHash } });
    if (!s || new Date(s.expiresAt) < new Date()) return null;
    return this.toSession(s);
  }

  async listSessionsByUserId(userId: string): Promise<AuthSession[]> {
    const now = new Date();
    return db.sessions
      .findMany({ where: { userId } })
      .filter((r) => new Date(r.expiresAt) > now)
      .map((r) => this.toSession(r));
  }

  async updateSession(id: string, updates: Partial<AuthSession>): Promise<AuthSession> {
    const row = db.sessions.updateById(id, updates as any);
    if (!row) throw new Error("Session not found");
    return this.toSession(row);
  }

  async deleteSession(id: string): Promise<void> {
    db.sessions.deleteById(id);
  }

  async deleteSessionsByUserId(userId: string): Promise<void> {
    db.sessions.delete({ where: { userId } });
  }

  async findIdentity(provider: string, providerAccountId: string): Promise<AuthIdentity | null> {
    const i = db.identities.findFirst({ where: { provider, providerAccountId } });
    return i ? this.toIdentity(i) : null;
  }

  async listIdentitiesByUserId(userId: string): Promise<AuthIdentity[]> {
    return db.identities.findMany({ where: { userId } }).map((r) => this.toIdentity(r));
  }

  async createIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    return this.toIdentity(db.identities.insert(identity as any));
  }

  async deleteIdentity(id: string): Promise<void> {
    db.identities.deleteById(id);
  }

  async createToken(token: AuthVerificationToken): Promise<AuthVerificationToken> {
    return this.toToken(db.verificationTokens.insert(token as any));
  }

  async findTokenByHash(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null> {
    const t = db.verificationTokens.findFirst({ where: { tokenHash, type } });
    if (!t || new Date(t.expiresAt) < new Date()) return null;
    return this.toToken(t);
  }

  async consumeToken(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null> {
    /*
     * Read and delete, in one place.
     *
     * AuthStore requires this, and the template did not implement it, so the
     * scaffolded project did not typecheck. It matters beyond the type: verification
     * links and magic links are redeemed through here, and a store that returns the
     * row without removing it lets one link be used twice.
     */
    const t = db.verificationTokens.findFirst({ where: { tokenHash, type } });
    if (!t || new Date(t.expiresAt) < new Date()) return null;

    db.verificationTokens.deleteById(t.id);
    return this.toToken(t);
  }

  async deleteToken(id: string): Promise<void> {
    db.verificationTokens.deleteById(id);
  }

  async deleteTokensByUserId(
    userId: string,
    type?: AuthVerificationToken["type"],
  ): Promise<void> {
    if (type) db.verificationTokens.delete({ where: { userId, type } });
    else db.verificationTokens.delete({ where: { userId } });
  }

  async savePasskey(cred: AuthPasskeyCredential): Promise<void> {
    db.passkeys.upsert({
      where: { id: cred.id },
      create: {
        id: cred.id,
        userId: cred.userId,
        name: cred.name ?? "Passkey",
        publicKey: Buffer.from(cred.publicKey).toString("base64"),
        counter: cred.counter,
        transports: cred.transports as any,
        createdAt: cred.createdAt.toISOString(),
      },
      update: {
        counter: cred.counter,
        lastUsedAt: cred.lastUsedAt?.toISOString(),
      },
    });
  }

  async findPasskeyById(id: string): Promise<AuthPasskeyCredential | null> {
    const p = db.passkeys.findById(id);
    return p ? this.toPasskey(p) : null;
  }

  async listPasskeysByUserId(userId: string): Promise<AuthPasskeyCredential[]> {
    return db.passkeys.findMany({ where: { userId } }).map((p) => this.toPasskey(p));
  }

  async updatePasskey(id: string, updates: Partial<AuthPasskeyCredential>): Promise<void> {
    const patch: any = { ...updates };
    if (updates.publicKey) patch.publicKey = Buffer.from(updates.publicKey).toString("base64");
    if (updates.lastUsedAt) patch.lastUsedAt = updates.lastUsedAt.toISOString();
    db.passkeys.updateById(id, patch);
  }

  async deletePasskey(id: string): Promise<void> {
    db.passkeys.deleteById(id);
  }

  async createApiKey(key: AuthApiKey): Promise<AuthApiKey> {
    return this.toApiKey(db.apiKeys.insert(key as any));
  }

  async findApiKeyByHash(keyHash: string): Promise<AuthApiKey | null> {
    const k = db.apiKeys.findFirst({ where: { keyHash } });
    return k ? this.toApiKey(k) : null;
  }

  async listApiKeysByUserId(userId: string): Promise<AuthApiKey[]> {
    return db.apiKeys.findMany({ where: { userId } }).map((k) => this.toApiKey(k));
  }

  async updateApiKey(id: string, updates: Partial<AuthApiKey>): Promise<void> {
    db.apiKeys.updateById(id, updates as any);
  }

  async deleteApiKey(id: string): Promise<void> {
    db.apiKeys.deleteById(id);
  }

  // ── Mappers ───────────────────────────────────────────────────────────

  private toUser(row: any): AuthUser {
    return {
      ...row,
      emailVerified: Boolean(row.emailVerified),
      twoFactorEnabled: Boolean(row.twoFactorEnabled),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private toSession(row: any): AuthSession {
    return {
      ...row,
      expiresAt: new Date(row.expiresAt),
      lastSeenAt: new Date(row.lastSeenAt),
      lastAuthenticatedAt: new Date(row.lastAuthenticatedAt),
      createdAt: new Date(row.createdAt),
    };
  }

  private toIdentity(row: any): AuthIdentity {
    return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
  }

  private toToken(row: any): AuthVerificationToken {
    return { ...row, expiresAt: new Date(row.expiresAt) };
  }

  private toPasskey(row: any): AuthPasskeyCredential {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name ?? undefined,
      publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64")),
      counter: row.counter ?? 0,
      transports: row.transports ?? undefined,
      createdAt: new Date(row.createdAt),
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : undefined,
    };
  }

  private toApiKey(row: any): AuthApiKey {
    return {
      ...row,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : undefined,
      createdAt: new Date(row.createdAt),
    };
  }
}

export const auth = createAuth({
  secret: process.env.AUTH_SECRET || "change-me-to-a-real-32-char-secret",
  store: new SQLiteAuthStore(),
  email: {
    mailer,
    appUrl: process.env.APP_URL || "http://localhost:4000",
  },
  passkeys: {
    rpName: "Yatta App",
    rpID: process.env.RP_ID || "localhost",
    origin: process.env.APP_URL || "http://localhost:4000",
  },
  security: {
    // Off in production, on everywhere else. Without this a fresh project can
    // sign a user up but can never sign them in: signUp returns
    // emailVerificationRequired, no session is issued, and the verification
    // email goes nowhere because the mailer has no real transport. Turn it on
    // in production once you have a working mailer.
    allowUnverifiedSession: process.env.NODE_ENV === "production" ? false : true,

    /*
     * Without this every request is seen as 127.0.0.1 and the per-IP rate limits
     * become one global limit — so one attacker guessing passwords locks out every
     * legitimate user at once. The framework warns at boot when it is missing, but a
     * warning is not a default, and this file is what a new project ships with.
     *
     * The address is captured in main.ts at the edge, because that is the only place
     * Bun exposes it. See func/peer.ts.
     */
    getClientIp: (req) => peerAddress(req),
  },
});
`;

const TEMPLATE_FUNC_REALTIME = `// yatta/func/realtime.ts
//
// WebSocket + SSE.
//
// The WebSocket upgrade handler is wired in main.ts. SSE is not: it is an HTTP
// response, so main.ts needs a route that returns it — \`sseResponse()\` below
// provides one and main.ts calls it for GET /realtime/sse.
import { createRealtime, sse } from "yatta.js/realtime";

export const realtime = createRealtime({
  handlers: {
    open(client) {
      console.log(\`[realtime] connected: \${client.id}\`);
    },
    message(client, event, data) {
      // Echo straight back for now.
      client.send(event, data);
    },
    close(client) {
      console.log(\`[realtime] disconnected: \${client.id}\`);
    },
  },
});

/**
 * GET /realtime/sse — a Server-Sent Events stream.
 *
 * Returns a live event source. Publish to a topic from anywhere and connected
 * browsers receive it:
 *
 *   realtime.publish("task.created", { taskId });
 *
 * The abort signal fires when the client disconnects, so anything started per
 * connection must be torn down there.
 */
export function sseResponse(req: Request): Response {
  return sse(req, (client) => {
    client.send("connected", { clientId: client.id });

    client.signal.addEventListener("abort", () => {
      console.log(\`[realtime] sse disconnected: \${client.id}\`);
    });
  });
}
`;

const TEMPLATE_FUNC_ROUTER = `// yatta/func/routerHelper.ts
//
// Dispatches requests to yatta/backend/** using Bun's file router,
// Next.js style:
//
//   yatta/backend/index.ts        -> GET /
//   yatta/backend/user/index.ts   -> /user
//   yatta/backend/posts/[id].ts   -> /posts/:id
//
// You rarely need to edit this.
import type { Server } from "bun";
import path from "node:path";
import { API, throttledReload } from "yatta.js/api";
import { realtime } from "./realtime";
import { storage } from "./storage";

// Resolved from this file, so it works regardless of cwd.
const backendDir = path.resolve(import.meta.dir, "../backend");

export const router = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: backendDir,
});

/** Pulls the API instance out of a route module (handles default/api/CJS). */
function resolveApi(module: Record<string, unknown>): API | undefined {
  const candidate: any = module.default ?? module.api ?? module;
  if (!candidate) return undefined;
  if (candidate instanceof API) return candidate;
  if (candidate.default instanceof API) return candidate.default;
  if (typeof candidate.handle === "function") return candidate;
  if (candidate.default && typeof candidate.default.handle === "function") {
    return candidate.default;
  }
  return undefined;
}

export default async function routers(
  req: Request,
  server: Server<unknown>,
): Promise<Response> {
  const url = new URL(req.url);
  const isHttps =
    url.protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";

  // 1. Realtime: WebSocket upgrade or SSE, detected automatically.
  if (url.pathname === "/realtime") {
    const res = await realtime.connect(req, server);
    if (res instanceof Response) return applyHeaders(res, isHttps);
    return undefined as any; // upgrade handled by Bun
  }

  // 2. Storage explorer, downloads, and RFC 9110 file streaming.
  if (url.pathname.startsWith("/storage")) {
    const res = await storage.handleRequest(req, "/storage");
    return applyHeaders(res, isHttps);
  }

  // 3. Pick up new route files without a restart during development.
  //
  // A *new* file is picked up; an *edited* one is not, because import() caches the
  // module. Use "bun run dev" (bun --watch) for edits — the two are not
  // interchangeable, and the distinction is not otherwise visible.
  if (process.env.NODE_ENV !== "production") throttledReload(router);

  // 4. Match the route.
  let match = router.match(req);
  let basePath: string | undefined;

  if (!match) {
    const alt = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = router.match(alt);
  }

  if (!match) {
    const segments = url.pathname.split("/").filter(Boolean);
    while (segments.length > 0) {
      const parentPath = "/" + segments.join("/");
      const candidate = router.match(parentPath);
      if (candidate) {
        match = candidate;
        basePath = parentPath;
        break;
      }
      segments.pop();
    }
  }

  if (!match) return applyHeaders(new Response("Not Found", { status: 404 }), isHttps);

  let module: Record<string, unknown>;
  try {
    module = await import(match.filePath);
  } catch (err) {
    console.error(\`Failed to load route module \${match.filePath}:\`, err);
    return applyHeaders(new Response("Internal Server Error", { status: 500 }), isHttps);
  }

  const api = resolveApi(module);
  if (!api) {
    console.error(
      \`Route "\${match.filePath}" must export an API instance:\\n\\n\` +
        \`  import { API, createAPI } from "yatta.js/api";\\n\` +
        \`  const api = createAPI();\\n\` +
        \`  api.get(async () => API.json({ ok: true }));\\n\` +
        \`  export default api;\\n\`,
    );
    return applyHeaders(new Response("Route handler not found", { status: 500 }), isHttps);
  }

  const res = await api.handle(req, match.params, basePath);
  return applyHeaders(res, isHttps);
}

/** Standard hardening headers. HSTS only over real HTTPS. */
function applyHeaders(res: Response, isHttps: boolean): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isHttps) {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return res;
}
`;

/** File list + one-line blurbs shown after init. */
const FUNC_FILES = [
  "db.ts",
  "auth.ts",
  "cache.ts",
  "mail.ts",
  "storage.ts",
  "jobs.ts",
  "events.ts",
  "cron.ts",
  "workers.ts",
  "realtime.ts",
  "observe.ts",
  "routerHelper.ts",
] as const;

const FUNC_BLURBS: Record<string, string> = {
  "db.ts": "ORM + schema",
  "auth.ts": "auth, passkeys, 2FA",
  "cache.ts": "L1 LRU + SQLite L2",
  "mail.ts": "templates + transports",
  "storage.ts": "local + S3 disks",
  "jobs.ts": "durable queue",
  "events.ts": "typed event bus",
  "cron.ts": "scheduled tasks",
  "workers.ts": "job handlers + pool",
  "realtime.ts": "WebSocket + SSE",
  "observe.ts": "traces, metrics, errors",
  "routerHelper.ts": "route dispatch",
};

const TEMPLATE_TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["bun"],
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    // A linked (symlinked) Yatta checkout resolves its own node_modules,
    // which yields two copies of undici-types and a pile of phantom
    // FormData/HeadersInit errors. Pin it to this project's copy.
    "paths": {
      "undici-types": ["./node_modules/undici-types"]
    }
  }
}
`;

/**
 * Where a project's entrypoint is, in the order they are looked for.
 *
 * `yatta/main.ts` first, because that is what `yatta new` and `yatta init` both
 * write and what the generated package.json points its scripts at.
 *
 * `src/main.ts` second, and not because it is preferred: it is what the framework's
 * own checkout uses, and what a project scaffolded before the layout was unified used.
 * Leaving it out means `yatta dev` fails inside the framework checkout, and leaving
 * it first means a new project cannot start.
 *
 * The two run commands used to hardcode `src/main.ts`, so `yatta new app && cd app &&
 * yatta dev` reported "No src/main.ts found" — in a project that was sitting right
 * there, correctly scaffolded, with a package.json whose own `dev` script would have
 * worked. `bun run dev` worked and `yatta dev` did not, which is the worst version of
 * that bug: the two ways of starting the server disagreeing about where the server is.
 */
const ENTRYPOINTS = ["yatta/main.ts", "src/main.ts"] as const;

/** The entrypoint in `dir`, or `null`. */
function findEntrypoint(dir: string): string | null {
  for (const candidate of ENTRYPOINTS) {
    if (existsSync(join(dir, candidate))) return candidate;
  }

  return null;
}

/**
 * Guards `dev`/`start`/`cluster` against being run outside a project.
 *
 * Without this, Bun resolves the entrypoint relative to the framework checkout,
 * silently boots the framework itself on port 4000, and reports a confusing
 * EADDRINUSE instead of "you are in the wrong directory".
 *
 * Returns the path to run rather than a boolean, so the caller cannot go on to
 * hardcode a different one — the whole bug was two places each naming a path.
 */
function requireProject(command: string): string | null {
  const cwd = process.cwd();
  const entry = findEntrypoint(cwd);

  if (entry) return join(cwd, entry);

  fail(`No ${ENTRYPOINTS.join(" or ")} found in ${cwd}`);
  log("");
  log(`  \`yatta ${command}\` must run from inside your project, not the`);
  log(`  framework checkout.`);
  log("");
  log(`  If you just created a project, enter it first:`);
  log("");
  const nested = join(cwd, "app");
  if (findEntrypoint(nested)) {
    log(`${c.dim}    cd app${c.reset}`);
    log("");
  }
  log(`  Or start a new one:`);
  log("");
  log(`${c.dim}    yatta new my-project${c.reset}`);
  log("");
  return null;
}

function cmdNew(name?: string): number {
  if (!name) {
    fail("Usage: yatta new <project-name>");
    log(`${c.dim}  e.g. yatta new my-app${c.reset}`);
    return 1;
  }

  const dir = resolve(process.cwd(), name);

  if (existsSync(dir)) {
    // "." and "./" mean "here" — a reasonable intent worth explaining
    // rather than rejecting outright.
    if (name === "." || name === "./") {
      if (existsSync(join(dir, "src", "main.ts"))) {
        fail("This directory already has a src/main.ts — nothing to scaffold.");
        log(`${c.dim}  Run \`yatta dev\` to start it.${c.reset}`);
        return 1;
      }
      if (existsSync(join(dir, "src"))) {
        fail("This directory already has a src/ folder.");
        log(`${c.dim}  Scaffold into a subfolder instead: yatta new app${c.reset}`);
        return 1;
      }
      warn(`Scaffolding into the current directory (${dir})`);
      scaffoldInto(dir);
      printNextSteps(".");
      return 0;
    }

    fail(`"${name}" already exists. Pick another name or delete it first.`);
    return 1;
  }

  scaffoldInto(dir);
  printNextSteps(name);
  return 0;
}

function printNextSteps(name: string): void {
  log("");
  log("Next steps:");
  if (name !== ".") log(`  cd ${name}`);
  log("  bun install");
  log(`  bun link ${pkgName()}      ${c.dim}# connect to this checkout${c.reset}`);
  log("  bun run dev");
  log("");
  log(`${c.dim}Reconnect after changing the framework: bun link ${pkgName()}${c.reset}`);
}

/**
 * Writes the whole `yatta/` folder.
 *
 * One definition, because `yatta new` and `yatta init` were writing different
 * things from the same templates: `new` put the entrypoint in `src/` and handed it a
 * package.json whose scripts ran `yatta/main.ts`, and it never wrote the eleven
 * subsystem files that entrypoint imports. A fresh `yatta new` project had thirteen
 * unresolved imports and could not typecheck or start.
 *
 * The templates all name `yatta/` in their own headers, so this is the layout they
 * were written for.
 */
export function writeYattaFolder(yattaDir: string): void {
  mkdirSync(join(yattaDir, "backend"), { recursive: true });
  mkdirSync(join(yattaDir, "func"), { recursive: true });

  writeFileSync(join(yattaDir, "main.ts"), TEMPLATE_MAIN);
  writeFileSync(join(yattaDir, "backend", "_router.ts"), TEMPLATE_ROUTER);
  writeFileSync(join(yattaDir, "backend", "index.ts"), TEMPLATE_BACKEND_INDEX);

  // The full subsystem set, wired exactly like the framework's own src/func.
  writeFileSync(join(yattaDir, "func", "db.ts"), TEMPLATE_FUNC_DB);
  writeFileSync(join(yattaDir, "func", "cache.ts"), TEMPLATE_FUNC_CACHE);
  writeFileSync(join(yattaDir, "func", "mail.ts"), TEMPLATE_FUNC_MAIL);
  writeFileSync(join(yattaDir, "func", "storage.ts"), TEMPLATE_FUNC_STORAGE);
  writeFileSync(join(yattaDir, "func", "jobs.ts"), TEMPLATE_FUNC_JOBS);
  writeFileSync(join(yattaDir, "func", "events.ts"), TEMPLATE_FUNC_EVENTS);
  writeFileSync(join(yattaDir, "func", "cron.ts"), TEMPLATE_FUNC_CRON);
  writeFileSync(join(yattaDir, "func", "workers.ts"), TEMPLATE_FUNC_WORKERS);
  writeFileSync(join(yattaDir, "func", "auth.ts"), TEMPLATE_FUNC_AUTH);
  writeFileSync(join(yattaDir, "func", "peer.ts"), TEMPLATE_FUNC_PEER);
  writeFileSync(join(yattaDir, "func", "realtime.ts"), TEMPLATE_FUNC_REALTIME);
  writeFileSync(join(yattaDir, "func", "observe.ts"), TEMPLATE_FUNC_OBSERVE);
  writeFileSync(join(yattaDir, "func", "routerHelper.ts"), TEMPLATE_FUNC_ROUTER);
  writeFileSync(join(yattaDir, "backend", "health.ts"), TEMPLATE_BACKEND_HEALTH);
  writeFileSync(join(yattaDir, "backend", "auth.ts"), TEMPLATE_BACKEND_AUTH);
  writeFileSync(join(yattaDir, "backend", "routes.ts"), TEMPLATE_BACKEND_ROUTES);
}

/** The two root files `yatta new` writes, alongside the folder itself. */
export function scaffoldInto(dir: string): void {
  writeYattaFolder(join(dir, "yatta"));
  writeFileSync(join(dir, "package.json"), TEMPLATE_PKG(basename(dir)));
  writeFileSync(join(dir, "tsconfig.json"), TEMPLATE_TSCONFIG);
  ok(`Scaffolded ${dir}/`);
}



/**
 * `yatta init` — sets up the `yatta/` folder in the *current* project.
 *
 * Creates the same file set the framework itself uses in `src/func/`,
 * wired the same way, so a developer can start an ORM, auth, jobs, cache,
 * mail, storage and realtime without writing any of it by hand:
 *
 *   yatta/main.ts          server entrypoint (mounts every subsystem)
 *   yatta/backend/         file-based routes
 *   yatta/func/            one file per subsystem, exactly like the framework
 *
 * package.json and tsconfig.json stay at the project root; they belong to
 * the project, not to Yatta.
 */
function cmdInit(): number {
  const root = resolve(process.cwd());
  const yattaDir = join(root, "yatta");

  // Refuse to overwrite an existing setup rather than silently clobbering
  // someone's handlers.
  if (existsSync(join(yattaDir, "main.ts"))) {
    fail("A yatta/ folder already exists with a main.ts.");
    log(
      `${c.dim}  Nothing was changed. Delete it first if you want to start over.${c.reset}`,
    );
    return 1;
  }

  step("Creating yatta/…");

  writeYattaFolder(yattaDir);

  ok("Created:");
  log("");
  log(`${c.dim}    yatta/main.ts${c.reset}`);
  log(`${c.dim}    yatta/func/${c.reset}`);
  for (const f of FUNC_FILES) {
    log(`${c.dim}      ${f.padEnd(16)}${c.reset} ${c.dim}${FUNC_BLURBS[f] ?? ""}${c.reset}`);
  }
  log(`${c.dim}    yatta/backend/${c.reset}`);
  log(`${c.dim}      ${"routes.ts".padEnd(16)}${c.reset} ${c.dim}API entry + CORS${c.reset}`);
  log(`${c.dim}      ${"health.ts".padEnd(16)}${c.reset} ${c.dim}liveness, readiness, observe${c.reset}`);
  log(`${c.dim}      ${"auth.ts".padEnd(16)}${c.reset} ${c.dim}signup, signin, mfa, me${c.reset}`);
  log(`${c.dim}      ${"index.ts".padEnd(16)}${c.reset} ${c.dim}file-based routes${c.reset}`);
  log("");
  log(`${c.dim}    Observability is live:${c.reset}`);
  log(`${c.dim}      /_yatta/            dashboard + health${c.reset}`);
  log(`${c.dim}      /_yatta/api/telemetry   traces, errors, runtime${c.reset}`);
  log(`${c.dim}      /_yatta/api/errors      issue queue${c.reset}`);
  log(`${c.dim}      /_yatta/api/stream       live event stream${c.reset}`);
  log("");

  // Wire the existing project up: scripts, entrypoint, and the dependency.
  // Nothing here should require the developer to edit anything by hand.
  const pkgResult = wireUpProjectPackage(root);

  if (pkgResult.created) ok("Created package.json");
  if (pkgResult.devUpdated) ok('"dev" script → bun --watch yatta/main.ts');
  if (pkgResult.startUpdated) ok('"start" script → bun yatta/main.ts');
  if (pkgResult.dependencyAdded) ok('Added "yatta.js" to dependencies');
  if (pkgResult.moduleUpdated) ok('"module" → yatta/main.ts');

  if (!pkgResult.devUpdated) {
    warn('Kept your existing "dev" script — add Yatta alongside it:');
    log(`${c.dim}    "yatta": "bun --watch yatta/main.ts"${c.reset}`);
  }

  if (ensureTsconfigCompatible(root)) {
    ok("Patched tsconfig.json (added DOM lib + undici-types alias)");
  }

  // Install and connect the dependency. Leaving this to the developer meant a
  // bare `yatta init && bun run dev` failed with "Cannot find module
  // 'yatta/runtime'", because the dependency was declared but never installed.
  step("Installing dependencies…");
  const installed = runQuiet("bun", ["install"], root) === 0;
  if (installed) ok("Dependencies installed");
  else warn("`bun install` failed — run it manually before starting.");

  // Prefer a locally linked checkout over the published package, so edits to
  // the framework show up here immediately.
  if (isGloballyLinked()) {
    if (runQuiet("bun", ["link", "yatta"], root) === 0) {
      ok("Connected to your local Yatta checkout");
    } else {
      warn("Could not link the local checkout — using the installed package.");
    }
  }

  /*
   * Verify the framework actually resolves.
   *
   * `bun install` and `bun link` both exited 0 while leaving the project unable
   * to import anything, so `bun dev` died on "Cannot find module
   * 'yatta/runtime'". Probing the real import is the only check that catches
   * this — every earlier signal was just an exit code.
   */
  if (!frameworkResolves(root)) {
    fail("The framework did not resolve, so `bun run dev` will fail.");
    log("");
    log(`  ${c.dim}cd ${root}${c.reset}`);
    log(`  ${c.dim}bun install && bun link ${pkgName()}${c.reset}`);
    log("");
    log(`${c.dim}  If that still fails, node_modules/yatta is missing or points`);
    log(`  somewhere that does not contain the framework.${c.reset}`);
    log("");
    return 1;
  }

  ok("Done.");
  log("");
  log("Next:");
  log("  bun run dev");
  log("");
  return 0;
}

/**
 * True when a scaffolded project can actually import the framework.
 *
 * Imports the subpath the generated entrypoint depends on rather than checking
 * that node_modules/yatta exists — the directory can be present and still
 * resolve to nothing.
 */
function frameworkResolves(root: string): boolean {
  const probe = join(root, ".yatta-resolve-check.ts");
  try {
    writeFileSync(
      probe,
      'import { createRuntime } from "yatta.js/runtime";\n' +
        "if (typeof createRuntime !== \"function\") process.exit(1);\n" +
        "process.exit(0);\n",
    );
    return runQuiet("bun", ["run", probe], root) === 0;
  } catch {
    return false;
  } finally {
    // Always clean up: a stray probe file in someone's project is worse than
    // the failure it was checking for.
    try {
      unlinkSync(probe);
    } catch {}
  }
}

/** True when this checkout is registered in Bun's global link registry. */
function isGloballyLinked(): boolean {
  const home = process.env.HOME ?? "";
  if (!home) return false;

  const globalDir = join(home, ".bun", "install", "global", "node_modules");
  return existsSync(join(globalDir, pkg().name));
}

/** Runs a command quietly, returning its exit code. */
function runQuiet(cmd: string, args: string[], cwd?: string): number {
  const res = spawnSync(cmd, args, { cwd, shell: false, stdio: "ignore" });
  if (res.error) return 1;
  return res.status ?? 1;
}

/**
 * Makes an existing tsconfig compatible with a linked Yatta checkout.
 *
 * Two things are required for `bunx tsc --noEmit` to pass in a project that
 * consumes Yatta via `bun link`:
 *
 * 1. `"DOM"` in `lib`. Bun's global types and `undici-types` disagree about
 *    `FormData`/`HeadersInit` without the DOM lib, producing phantom errors.
 * 2. `paths` pinning `undici-types` to the project's copy. A symlinked
 *    checkout resolves its own node_modules, so the type is otherwise
 *    loaded twice and the two definitions conflict.
 *
 * Additive only: existing options are preserved, and the file is rewritten
 * solely when something actually changes. If it cannot be parsed
 * confidently, it is left untouched.
 *
 * @returns `true` if the tsconfig was patched.
 */
function ensureTsconfigCompatible(root: string): boolean {
  const tsPath = join(root, "tsconfig.json");

  if (!existsSync(tsPath)) return false;

  try {
    // Tolerate JSONC (bun init writes comments and trailing commas).
    const raw = readFileSync(tsPath, "utf8");
    const json = JSON.parse(
      raw
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    );

    const compilerOptions = json.compilerOptions ?? (json.compilerOptions = {});
    let changed = false;

    // 1. Ensure DOM is in lib.
    if (!Array.isArray(compilerOptions.lib)) {
      compilerOptions.lib = ["ESNext", "DOM"];
      changed = true;
    } else if (!compilerOptions.lib.includes("DOM")) {
      compilerOptions.lib = [...compilerOptions.lib, "DOM"];
      changed = true;
    }

    // 2. Pin undici-types to this project's copy.
    if (compilerOptions.paths?.["undici-types"] !== undefined) {
      // already configured by the developer
    } else {
      compilerOptions.paths = {
        ...(compilerOptions.paths ?? {}),
        "undici-types": ["./node_modules/undici-types"],
      };
      changed = true;
    }

    if (!changed) return false;

    writeFileSync(tsPath, `${JSON.stringify(json, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Points the host project at `yatta/main.ts`.
 *
 * Handles both cases a developer actually hits:
 *   - Fresh project: `bun init` writes no scripts at all, only `"module"`.
 *   - Existing project: has its own scripts, which must not be clobbered.
 *
 * Scripts are only rewritten when they are absent or still point at a
 * stock entrypoint (`index.ts`, `src/main.ts`). A hand-written `dev` script
 * is left alone and reported instead.
 *
 * Also ensures `yatta` is listed as a dependency so `npm install yatta`
 * followed by `yatta init` is all that is required.
 */
function wireUpProjectPackage(root: string): {
  created: boolean;
  devUpdated: boolean;
  startUpdated: boolean;
  dependencyAdded: boolean;
  moduleUpdated: boolean;
} {
  const result = {
    created: false,
    devUpdated: false,
    startUpdated: false,
    dependencyAdded: false,
    moduleUpdated: false,
  };

  const pkgPath = join(root, "package.json");
  let json: Record<string, any>;

  if (existsSync(pkgPath)) {
    try {
      json = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return result;
    }
  } else {
    // `yatta init` in an empty directory still yields a runnable project.
    json = { name: basename(root), private: true, type: "module" };
    result.created = true;
  }

  const scripts: Record<string, string> = json.scripts ?? {};

  // Stock entrypoints we are willing to take over.
  const STOCK = /^(bun|npm|pnpm|yarn)?\s*(run\s+)?(index|src\/main|main)\.ts$/;

  const devIsStock = scripts.dev === undefined || STOCK.test(scripts.dev.trim());

  if (devIsStock) {
    scripts.dev = "bun --watch yatta/main.ts";
    result.devUpdated = true;
  }

  const startIsStock =
    scripts.start === undefined || STOCK.test(scripts.start.trim());

  if (startIsStock) {
    scripts.start = "bun yatta/main.ts";
    result.startUpdated = true;
  }

  json.scripts = scripts;

  // "module" is what Bun/TS treat as the entrypoint.
  if (
    json.module === undefined ||
    json.module === "index.ts" ||
    json.module === "src/main.ts"
  ) {
    json.module = "yatta/main.ts";
    result.moduleUpdated = true;
  }

  const deps = { ...(json.dependencies ?? {}) };
  if (!deps["yatta.js"]) {
    // Left as a normal range: `bun add yatta.js` / `npm i yatta.js` fills in the
    // version, and this keeps the file valid in the meantime.
    deps["yatta.js"] = "*";
    json.dependencies = deps;
    result.dependencyAdded = true;
  }

  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
  return result;
}

function cmdLink(): number {
  const root = frameworkRoot();

  step("Registering this checkout as a linkable package…");
  if (run("bun", ["link"], root) !== 0) return 1;

  ok("Registered in Bun's global link registry.");
  log("");
  log(`${c.bold}In any project that should use it:${c.reset}`);
  log("");
  log(`${c.dim}    cd your-project${c.reset}`);
  log(`${c.dim}    bun link ${pkgName()}${c.reset}`);
  log("");
  log(`${c.dim}Then import it like a normal dependency:${c.reset}`);
  log(`${c.dim}    import { createDatabase } from "yatta.js/db";${c.reset}`);
  log(`${c.dim}    import { createRuntime } from "yatta.js/runtime";${c.reset}`);
  log("");
  log(`${c.dim}    registered at: ${root}${c.reset}`);
  return 0;
}

function cmdUnlink(): number {
  const root = frameworkRoot();
  step("Removing this checkout from the global link registry…");
  return run("bun", ["unlink"], root);
}

/** Prints the commands a consumer project should use. */
function cmdUsage(): number {
  const root = frameworkRoot();

  log("");
  log(`  ${c.bold}yatta${c.reset} v${VERSION}`);
  log(`  ${c.dim}Production-grade backend framework for Bun${c.reset}`);
  log("");
  log(`${c.bold}Commands${c.reset}`);
  log(`  ${c.cyan}yatta init${c.reset}         Create yatta/ in the current project`);
  log(`  ${c.cyan}yatta new <name>${c.reset}   Scaffold a brand-new project`);
  log(`  ${c.cyan}yatta link${c.reset}         Make this checkout installable locally`);
  log(`  ${c.cyan}yatta unlink${c.reset}       Remove it from the link registry`);
  log(`  ${c.cyan}yatta dev${c.reset}          Run the server in watch mode`);
  log(`  ${c.cyan}yatta start${c.reset}        Run the server`);
  log(`  ${c.cyan}yatta cluster${c.reset}      Run one process per core`);
  log(`  ${c.cyan}yatta check${c.reset}        Typecheck and run tests`);
  log(`  ${c.cyan}yatta info${c.reset}         Show paths and versions`);
  log(`  ${c.cyan}yatta doctor${c.reset}       Diagnose project health and configuration`);
  log(`  ${c.cyan}yatta version${c.reset}      Print the version`);
  log(`  ${c.cyan}yatta help${c.reset}         Show this`);
  log("");
  log(`${c.bold}Database${c.reset}`);
  log(`  ${c.cyan}yatta migrate${c.reset}      Run pending migrations`);
  log(`  ${c.cyan}yatta migrate:make <name>${c.reset}  Create a new migration file`);
  log(`  ${c.cyan}yatta migrate:status${c.reset}  Show migration status`);
  log(`  ${c.cyan}yatta db:backup${c.reset}    Backup the SQLite database`);
  log(`  ${c.cyan}yatta db:restore <file>${c.reset}  Restore from backup`);
  log("");
  log(`${c.bold}Using it in your own project${c.reset}`);
  log(`  ${c.dim}1.${c.reset} yatta link                 ${c.dim}register this checkout${c.reset}`);
  log(`  ${c.dim}2.${c.reset} cd your-project`);
  log(`  ${c.dim}3.${c.reset} bun link ${pkgName()}            ${c.dim}connect it${c.reset}`);
  log(`  ${c.dim}4.${c.reset} yatta init                  ${c.dim}create yatta/main.ts, backend/, func/${c.reset}`);
  log(`  ${c.dim}5.${c.reset} bun run dev`);
  log("");
  log(`${c.bold}Layout${c.reset}`);
  log(`  ${c.dim}your-project/${c.reset}`);
  log(`  ${c.dim}├── package.json        ${c.dim}yours${c.reset}`);
  log(`  ${c.dim}└── yatta/${c.reset}`);
  log(`  ${c.dim}    ├── main.ts          ${c.dim}server entrypoint${c.reset}`);
  log(`  ${c.dim}    ├── backend/         ${c.dim}file-based routes${c.reset}`);
  log(`  ${c.dim}    └── func/            ${c.dim}isolated subsystems${c.reset}`);
  log("");
  log(`${c.dim}Framework root: ${root}${c.reset}`);
  log("");
  return 0;
}

function cmdInfo(): number {
  const root = frameworkRoot();
  const p = pkg();
  const bunVersion = runCapture("bun", ["--version"]);

  log("");
  log(`  ${c.bold}yatta${c.reset}          ${p.version}`);
  log(`  bun             ${bunVersion ?? "not found"}`);
  log(`  node            ${runCapture("node", ["--version"]) ?? "not found"}`);
  log("");
  log(`  root            ${root}`);
  log(`  runtime entry   ${join(root, "core_runtime", "index.ts")}`);
  log("");
  log(`${c.bold}Engines${c.reset}`);
  log(`  ${p.engines?.bun ?? "any"}`);
  log("");
  log(`${c.bold}Entrypoints${c.reset}`);
  for (const key of Object.keys(p.exports ?? {})) {
    const specifier =
      key === "." || key === "./package.json"
        ? "yatta"
        : `yatta/${key.replace(/^\.\//, "")}`;
    log(`  ${c.dim}import … from "${specifier}"${c.reset}`);
  }
  log("");
  return 0;
}

function runCapture(cmd: string, args: string[]): string | null {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return res.status === 0 ? (res.stdout ?? "").trim() : null;
}

// ── Entry ─────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  /*
   * A flag is not an argument.
   *
   * `yatta new --help` used to take "--help" as the project name and scaffold a
   * directory called --help, because the subcommand took rest[0] verbatim. Any command
   * that takes a path or a name would do the same, and the result is a stray directory
   * rather than a message.
   *
   * -h/--help after a command prints that command's usage; anything else starting with
   * "-" is refused with the usage, because no command in this CLI takes a flag.
   */
  const firstArg = rest[0];
  if (firstArg === "-h" || firstArg === "--help") {
    return cmdUsage();
  }
  if (firstArg !== undefined && firstArg.startsWith("-")) {
    fail(`Unknown option "${firstArg}".`);
    return cmdUsage();
  }

  switch (command) {
    case "new":
      return cmdNew(rest[0]);
    case "init":
      return cmdInit();
    case "link":
      return cmdLink();
    case "unlink":
      return cmdUnlink();
    case "dev": {
      const entry = requireProject("dev");
      return entry ? run("bun", ["--watch", entry]) : 1;
    }
    case "start": {
      const entry = requireProject("start");
      return entry ? run("bun", ["run", entry]) : 1;
    }
    case "cluster": {
      const entry = requireProject("cluster");
      return entry ? run("bun", ["run", join(dirname(entry), "..", "core_runtime", "cluster.ts")]) : 1;
    }
    case "check":
      return run("bunx", ["tsc", "--noEmit"]) || run("bun", ["test"]);
    case "info":
      return cmdInfo();
    case "doctor":
      return cmdDoctor();
    case "migrate":
      return await cmdMigrate();
    case "migrate:make":
      return cmdMigrateMake(rest[0] ?? "");
    case "migrate:status":
      return await cmdMigrateStatus();
    case "db:backup":
      return cmdDbBackup();
    case "db:restore":
      return cmdDbRestore(rest[0] ?? "");
    case "version":
    case "--version":
    case "-v":
      log(VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return cmdUsage();
    default:
      fail(`Unknown command "${command}". Run \`yatta help\` to see what is available.`);
      return 1;
  }
}

/*
 * Run only when executed, not when imported.
 *
 * The tests below load this module to check what `yatta new` writes. An unconditional
 * `process.exit` at module scope meant they could not — so the one file that decides
 * what every new project contains was the one file nothing could check.
 */
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
