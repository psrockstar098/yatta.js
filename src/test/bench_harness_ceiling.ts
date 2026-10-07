/**
 * What is the harness ceiling?
 *
 * `comparison_benchmark.ts` puts Yatta at ~11.9k req/s and Hono at ~15.1k, which reads
 * as Yatta losing by 27%. Before optimising anything, this measures the same client
 * against `Bun.serve` with a handler that returns a static Response — no framework, no
 * router, no dispatch.
 *
 * If raw Bun lands near Hono, the gap is framework overhead and worth chasing. If raw
 * Bun lands near Yatta, the client is the ceiling and the whole comparison is
 * measuring the harness.
 *
 *   bun run src/test/bench_harness_ceiling.ts
 */
import { Hono } from "hono";
import { createAPI, API } from "yatta.js/api";

const PAYLOAD = { hello: "world", n: 42, ok: true };
const TOTAL = 20_000;
const CONCURRENCY = 100;

async function measure(url: string): Promise<{ rps: number; avg: number }> {
  let completed = 0;
  const latencies: number[] = [];
  const start = performance.now();

  async function worker(): Promise<void> {
    for (;;) {
      const i = completed++;
      if (i >= TOTAL) break;

      const t0 = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);

  return {
    rps: TOTAL / elapsed,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
  };
}

// The routers under test, wired exactly as comparison_benchmark.ts wires them.
const yattaApi = createAPI();
yattaApi.get("/json", () => API.json(PAYLOAD));

const honoApp = new Hono();
honoApp.get("/json", (c) => c.json(PAYLOAD));

const variants: Array<[string, (req: Request) => Response | Promise<Response>]> = [
  ["static Response (no framework)", () => Response.json(PAYLOAD)],
  ["Hono", (req) => honoApp.fetch(req)],
  ["Yatta api.handle", (req) => yattaApi.handle(req, {})],
  ["Response.json built per request", () => Response.json({ hello: "world", n: 42, ok: true })],
  ["new URL(req.url) then static", (req) => {
    const url = new URL(req.url);
    return url.pathname === "/json" ? Response.json(PAYLOAD) : new Response(null, { status: 404 });
  }],
  ["async handler, static body", async () => Response.json(PAYLOAD)],
];

console.log(`client: ${TOTAL.toLocaleString()} requests, concurrency ${CONCURRENCY}\n`);

for (const [label, fetch_] of variants) {
  const server = Bun.serve({ port: 0, fetch: fetch_ });
  const url = `http://127.0.0.1:${server.port}/json`;

  // Best of two: the first run pays for connection setup and JIT.
  let best = { rps: 0, avg: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const r = await measure(url);
    if (r.rps > best.rps) best = r;
  }

  server.stop(true);

  console.log(
    `  ${label.padEnd(34)} ${Math.round(best.rps).toLocaleString().padStart(7)} req/s   avg ${best.avg.toFixed(2)}ms`,
  );
}