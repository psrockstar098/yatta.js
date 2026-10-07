/**
 * Throughput comparison against Hono, Elysia, Express, Fastify and Koa.
 *
 * Every server serves the same `GET /json` returning the same payload, and every one
 * is warmed before it is measured.
 *
 * ## Why each framework runs in its own process
 *
 * The previous version started all six servers in sequence inside one process and
 * reported a single number each. That cannot answer the question it appears to answer.
 * Three runs of the same benchmark on the same machine gave:
 *
 *   Yatta    11,907 / 13,233 / 11,455
 *   Hono     15,125 / 13,211 / 13,768
 *   Elysia   16,703 / 13,803 / 13,079
 *
 * so "Hono is 1.27x faster" in one run and "Hono is 0.99x" in the next. Measuring raw
 * `Bun.serve` with a static Response — no framework at all — gave 15,884, 17,352 and
 * 16,920 req/s across variants *within a single run*, and Hono came out slower than
 * Yatta when the order was changed.
 *
 * The cause is shared state: every server inherits the previous one's garbage, the
 * load generator competes with the servers for the same cores, and the JIT state
 * depends on what ran before. A fixed order therefore measures the order.
 *
 * So each framework is started in a separate process, the runs are repeated, and the
 * median is reported with the observed spread. If the spread overlaps another
 * framework, the honest answer is that they are the same, and this now says so instead
 * of printing whichever number came out first.
 *
 * Usage:
 *   bun run src/test/comparison_benchmark.ts              # full comparison
 *   bun run src/test/comparison_benchmark.ts --only hono  # one framework, one process
 */

import { spawnSync } from "node:child_process";

type Server = { name: string; url: string; close: () => Promise<void> | void };
type Result = {
  name: string;
  rps: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number[];
  median: number;
  spread: number;
};

const PAYLOAD = { hello: "world", n: 42, ok: true };
const TOTAL = 20_000;
const WARMUP = 3_000;
const CONCURRENCY = 100;
const REPEATS = 3;

// ── Servers ────────────────────────────────────────────────────────────────

async function startYatta(port: number): Promise<Server> {
  const { createAPI, API } = await import("yatta.js/api");
  const api = createAPI();
  api.get("/json", () => API.json(PAYLOAD));
  const server = Bun.serve({ port, fetch: (req) => api.handle(req, {}) });
  return { name: "Yatta", url: `http://127.0.0.1:${port}/json`, close: () => server.stop(true) };
}

async function startExpress(port: number): Promise<Server> {
  const { default: express } = await import("express");
  const app = express();
  app.get("/json", (_req: any, res: any) => res.json(PAYLOAD));
  const server = app.listen(port);
  await new Promise((r) => server.once("listening", r));
  return {
    name: "Express",
    url: `http://127.0.0.1:${port}/json`,
    close: () => new Promise((r, j) => server.close((e: any) => (e ? j(e) : r()))),
  };
}

async function startFastify(port: number): Promise<Server> {
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  app.get("/json", async () => PAYLOAD);
  await app.listen({ port, host: "127.0.0.1" });
  return { name: "Fastify", url: `http://127.0.0.1:${port}/json`, close: () => app.close() };
}

async function startHono(port: number): Promise<Server> {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.get("/json", (c) => c.json(PAYLOAD));
  const server = Bun.serve({ port, fetch: app.fetch });
  return { name: "Hono", url: `http://127.0.0.1:${port}/json`, close: () => server.stop(true) };
}

async function startElysia(port: number): Promise<Server> {
  const { Elysia } = await import("elysia");
  const app = new Elysia().get("/json", () => PAYLOAD);
  app.listen(port);
  return { name: "Elysia", url: `http://127.0.0.1:${port}/json`, close: () => { void app.stop(); } };
}

async function startKoa(port: number): Promise<Server> {
  const { default: Koa } = await import("koa");
  const { default: Router } = await import("@koa/router");
  const app = new Koa();
  const router = new Router();
  router.get("/json", (ctx: any) => { ctx.body = PAYLOAD; });
  app.use(router.routes()).use(router.allowedMethods());
  const server = app.listen(port);
  await new Promise((r) => server.once("listening", r));
  return {
    name: "Koa",
    url: `http://127.0.0.1:${port}/json`,
    close: () => new Promise((r, j) => server.close((e: any) => (e ? j(e) : r()))),
  };
}

/** Raw Bun, no framework. The ceiling any of the above is measured against. */
async function startRawBun(port: number): Promise<Server> {
  const server = Bun.serve({ port, fetch: () => Response.json(PAYLOAD) });
  return { name: "Raw Bun", url: `http://127.0.0.1:${port}/json`, close: () => server.stop(true) };
}

const STARTERS: Record<string, (port: number) => Promise<Server>> = {
  yatta: startYatta,
  raw: startRawBun,
  hono: startHono,
  elysia: startElysia,
  express: startExpress,
  fastify: startFastify,
  koa: startKoa,
};

// ── Load ───────────────────────────────────────────────────────────────────

async function measure(
  url: string,
  total: number,
): Promise<{ rps: number; latencies: number[] }> {
  const latencies: number[] = [];
  let completed = 0;
  const start = performance.now();

  async function worker(): Promise<void> {
    for (;;) {
      const i = completed++;
      if (i >= total) break;

      const t0 = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return { rps: total / ((performance.now() - start) / 1000), latencies };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

// ── One framework, one process ─────────────────────────────────────────────

async function benchOne(key: string, repeats: number): Promise<Result> {
  const start = STARTERS[key]!;
  const server = await start(4111);

  const samples: number[] = [];
  let last: Result | null = null;

  for (let i = 0; i < repeats; i++) {
    await measure(server.url, WARMUP);
    const { rps, latencies } = await measure(server.url, TOTAL);
    samples.push(rps);
    latencies.sort((a, b) => a - b);
    last = {
      name: server.name,
      rps,
      avg: latencies.reduce((s, v) => s + v, 0) / latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      samples,
      median: 0,
      spread: 0,
    };
  }

  await server.close();

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const spread = median === 0 ? 0 : ((sorted.at(-1)! - sorted[0]!) / median) * 100;

  return { ...(last as Result), rps: median, median, spread };
}

// ── Entry ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--only")) {
  const key = args[args.indexOf("--only") + 1]!;
  const repeats = args.includes("--repeats") ? Number(args[args.indexOf("--repeats") + 1]) : REPEATS;

  const result = await benchOne(key, repeats);

  // Machine-readable, so the driver does not have to parse a table.
  process.stdout.write(`\n__YATTA_BENCH__${JSON.stringify(result)}\n`);
  process.exit(0);
}

/**
 * Driver: one child process per framework, per repetition.
 *
 * The order is rotated between repetitions so no framework is always measured on a
 * freshly started process or always last.
 */
const keys = ["yatta", "raw", "hono", "elysia", "express", "fastify", "koa"];
const collected = new Map<string, Result[]>();

for (let rep = 0; rep < REPEATS; rep++) {
  const rotated = rep % 2 === 0 ? keys : [...keys].reverse();

  for (const key of rotated) {
    const child = spawnSync(
      process.execPath,
      [import.meta.path, "--only", key, "--repeats", "1"],
      { encoding: "utf8", env: process.env },
    );

    const line = child.stdout?.split("\n").find((l) => l.startsWith("__YATTA_BENCH__"));

    if (!line) {
      console.error(`  (${key} produced no result — skipping)`);
      continue;
    }

    const parsed = JSON.parse(line.slice("__YATTA_BENCH__".length)) as Result;
    const bucket = collected.get(key) ?? [];
    bucket.push(parsed);
    collected.set(key, bucket);
  }
}

const results: Result[] = [];

for (const key of keys) {
  const runs = collected.get(key);
  if (!runs?.length) continue;

  const samples = runs.flatMap((r) => r.samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  results.push({
    name: runs[0]!.name,
    rps: median,
    median,
    spread: median === 0 ? 0 : ((sorted.at(-1)! - sorted[0]!) / median) * 100,
    avg: runs[0]!.avg,
    p50: runs[0]!.p50,
    p95: runs[0]!.p95,
    p99: runs[0]!.p99,
    samples,
  });
}

const yatta = results.find((r) => r.name === "Yatta");

console.log("\n=======================================================");
console.log("   YATTA vs EXPRESS vs FASTIFY vs HONO vs ELYSIA vs KOA");
console.log("=======================================================\n");
console.log("Route:  GET /json");
console.log(
  `Load:   ${TOTAL.toLocaleString()} requests, ${CONCURRENCY} concurrent, keep-alive\n` +
    `Method: one process per framework, ${REPEATS} repetitions each, median reported\n`,
);
console.log("| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |");
console.log("|-----------|-------------:|---------:|-------:|----:|----:|----:|");

for (const r of results) {
  const ratio = yatta && yatta.median ? r.median / yatta.median : 0;
  console.log(
    `| ${r.name.padEnd(9)} | ${Math.round(r.median).toLocaleString().padStart(11)} ` +
      `| ${ratio.toFixed(2).padStart(8)}x | ${r.spread.toFixed(0).padStart(5)}% ` +
      `| ${r.p50.toFixed(2)}ms | ${r.p95.toFixed(2)}ms | ${r.p99.toFixed(2)}ms |`,
  );
}

const raw = results.find((r) => r.name === "Raw Bun");
if (raw && yatta) {
  const overhead = (1 / yatta.median - 1 / raw.median) * 1_000_000;
  console.log(
    `\n  Yatta dispatch adds about ${overhead.toFixed(1)}µs per request over a\n` +
      `  handler that returns a static Response. That is the whole cost of routing.`,
  );
}

if (yatta && yatta.spread > 15) {
  console.log(
    `\n  Note: Yatta's own spread is ${yatta.spread.toFixed(0)}%, so differences smaller\n` +
      `  than that are not resolved by this benchmark. Read the spread column.`,
  );
}

/*
 * The shape here is load-bearing.
 *
 * `render-benchmarks.sh` assigns this file straight into `benchmarks.json` under a
 * `comparison` key, and the website reads it. So this must be the object itself — not
 * wrapped in another `comparison` — and each framework must carry `latency_ms` as a
 * nested object. Wrapping it double-nests and the page reads `undefined`.
 */
const jsonOut = process.env.BENCH_JSON_OUT ?? "/tmp/bench/comparison.json";

await Bun.write(
  jsonOut,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      route: "GET /json",
      method: `one process per framework, ${REPEATS} repetitions, median of ${REPEATS * 1} samples`,
      load: { requests: TOTAL, concurrency: CONCURRENCY, keep_alive: true },
      frameworks: results.map((r) => ({
        name: r.name,
        requests_per_sec: Math.round(r.median),
        vs_yatta: yatta ? Number((r.median / yatta.median).toFixed(2)) : null,
        // How far apart this framework's own runs were. A difference smaller than this
        // is not a difference.
        spread_pct: Number(r.spread.toFixed(1)),
        samples: r.samples.map((v) => Math.round(v)),
        latency_ms: {
          avg: Number(r.avg.toFixed(2)),
          p50: Number(r.p50.toFixed(2)),
          p95: Number(r.p95.toFixed(2)),
          p99: Number(r.p99.toFixed(2)),
        },
      })),
    },
    null,
    2,
  ),
).catch(() => {});

console.log(`\n  Wrote ${jsonOut}`);
console.log("\n=======================================================\n");