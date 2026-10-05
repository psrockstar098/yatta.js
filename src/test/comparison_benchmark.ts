// src/test/comparison_benchmark.ts
//
// Head-to-head HTTP throughput: Yatta vs the frameworks people usually reach
// for. Each server exposes one GET /json route returning the same small
// payload; the harness hammers it with concurrent keep-alive requests and
// reports requests/second.
//
// Run: bun run src/test/comparison_benchmark.ts
import { createAPI, API } from "yatta.js/api";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";

const PAYLOAD = { id: "1", name: "Ada", active: true };
const WARMUP = 2_000;
const TOTAL = 20_000;
const CONCURRENCY = 100;

type Server = { name: string; url: string; close: () => Promise<void> | void };

async function startYatta(port: number): Promise<Server> {
  const api = createAPI();
  api.get("/json", () => API.json(PAYLOAD));
  const server = Bun.serve({ port, fetch: (req) => api.handle(req, {}) });
  return { name: "Yatta", url: `http://127.0.0.1:${port}/json`, close: () => server.stop(true) };
}

async function startExpress(port: number): Promise<Server> {
  const app = express();
  app.get("/json", (_req: any, res: any) => res.json(PAYLOAD));
  const server = app.listen(port);
  await new Promise<void>((r) => server.on("listening", r));
  return { name: "Express", url: `http://127.0.0.1:${port}/json`, close: () => new Promise((r, j) => server.close((e: any) => (e ? j(e) : r()))) };
}

async function startFastify(port: number): Promise<Server> {
  const fastify = Fastify();
  fastify.get("/json", async () => PAYLOAD);
  await fastify.listen({ port, host: "127.0.0.1" });
  return { name: "Fastify", url: `http://127.0.0.1:${port}/json`, close: () => fastify.close() };
}

async function startHono(port: number): Promise<Server> {
  const app = new Hono();
  app.get("/json", (c) => c.json(PAYLOAD));
  const server = Bun.serve({ port, fetch: app.fetch });
  return { name: "Hono", url: `http://127.0.0.1:${port}/json`, close: () => server.stop(true) };
}

async function hammer(url: string, total: number, concurrency: number): Promise<number> {
  let completed = 0;
  const start = performance.now();
  async function worker() {
    for (;;) {
      const i = completed++;
      if (i >= total) break;
      const res = await fetch(url);
      await res.arrayBuffer();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedSec = (performance.now() - start) / 1000;
  return total / elapsedSec;
}

async function bench(server: Server): Promise<number> {
  await hammer(server.url, WARMUP, CONCURRENCY);
  const rps = await hammer(server.url, TOTAL, CONCURRENCY);
  await hammer(server.url, WARMUP, CONCURRENCY);
  return rps;
}

console.log("\n=======================================================");
console.log("   YATTA vs EXPRESS vs FASTIFY vs HONO — HTTP THROUGHPUT");
console.log("=======================================================\n");
console.log("Route: GET /json");
console.log(`Load: ${TOTAL.toLocaleString()} requests, ${CONCURRENCY} concurrent, keep-alive\n`);

const starters = [startYatta, startExpress, startFastify, startHono];
const results: { name: string; rps: number }[] = [];

for (let i = 0; i < starters.length; i++) {
  const server = await starters[i]!(4101 + i);
  const rps = await bench(server);
  await server.close();
  results.push({ name: server.name, rps });
  console.log(`  * ${server.name}: ${Math.round(rps).toLocaleString()} req/s`);
  await Bun.sleep(500);
}

const yatta = results.find((r) => r.name === "Yatta")!.rps;
console.log("\n| Framework | Requests/sec | vs Yatta |");
console.log("|-----------|-------------:|---------:|");
for (const r of results) {
  const ratio = r.rps / yatta;
  console.log(`| ${r.name.padEnd(9)} | ${Math.round(r.rps).toLocaleString().padStart(11)} | ${ratio.toFixed(2)}x |`);
}

console.log("\n   COMPARISON BENCHMARK COMPLETE");
console.log("=======================================================\n");
