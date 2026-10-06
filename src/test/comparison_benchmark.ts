// src/test/comparison_benchmark.ts
//
// Head-to-head HTTP benchmark: Yatta vs popular frameworks.
// Each server exposes one GET /json route returning the same small payload.
// The harness measures throughput (req/sec) and latency (avg, p50, p95, p99).
//
// Run: bun run src/test/comparison_benchmark.ts
import { createAPI, API } from "yatta.js/api";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { Elysia } from "elysia";
import Koa from "koa";
import Router from "@koa/router";

const PAYLOAD = { id: "1", name: "Ada", active: true };
const WARMUP = 2_000;
const TOTAL = 20_000;
const CONCURRENCY = 100;

type Server = { name: string; url: string; close: () => Promise<void> | void };
type Result = { name: string; rps: number; avg: number; p50: number; p95: number; p99: number };

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

async function startElysia(port: number): Promise<Server> {
  const app = new Elysia().get("/json", () => PAYLOAD);
  app.listen(port);
  await Bun.sleep(300);
  return { name: "Elysia", url: `http://127.0.0.1:${port}/json`, close: () => { void app.stop(); } };
}

async function startKoa(port: number): Promise<Server> {
  const app = new Koa();
  const router = new Router();
  router.get("/json", (ctx: any) => { ctx.body = PAYLOAD; });
  app.use(router.routes());
  const server = app.listen(port);
  await new Promise<void>((r) => server.on("listening", r));
  return { name: "Koa", url: `http://127.0.0.1:${port}/json`, close: () => new Promise((r, j) => server.close((e: any) => (e ? j(e) : r()))) };
}

async function measure(url: string, total: number, concurrency: number): Promise<{ rps: number; latencies: number[] }> {
  const latencies: number[] = [];
  let completed = 0;
  const start = performance.now();
  async function worker() {
    for (;;) {
      const i = completed++;
      if (i >= total) break;
      const t0 = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      latencies.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedSec = (performance.now() - start) / 1000;
  return { rps: total / elapsedSec, latencies };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function bench(server: Server): Promise<Result> {
  await measure(server.url, WARMUP, CONCURRENCY);
  const { rps, latencies } = await measure(server.url, TOTAL, CONCURRENCY);
  await measure(server.url, WARMUP, CONCURRENCY);
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  return {
    name: server.name,
    rps,
    avg,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

console.log("\n=======================================================");
console.log("   YATTA vs EXPRESS vs FASTIFY vs HONO vs ELYSIA vs KOA");
console.log("=======================================================\n");
console.log("Route: GET /json");
console.log(`Load: ${TOTAL.toLocaleString()} requests, ${CONCURRENCY} concurrent, keep-alive\n`);

const starters = [startYatta, startExpress, startFastify, startHono, startElysia, startKoa];
const results: Result[] = [];

for (let i = 0; i < starters.length; i++) {
  const server = await starters[i]!(4101 + i);
  const r = await bench(server);
  await server.close();
  results.push(r);
  console.log(`  * ${r.name.padEnd(8)}: ${Math.round(r.rps).toLocaleString().padStart(7)} req/s | avg ${r.avg.toFixed(2)}ms | p99 ${r.p99.toFixed(2)}ms`);
  await Bun.sleep(500);
}

const yatta = results.find((r) => r.name === "Yatta")!;
console.log("\n| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |");
console.log("|-----------|-------------:|---------:|------------:|----:|----:|----:|");
for (const r of results) {
  const ratio = r.rps / yatta.rps;
  console.log(
    `| ${r.name.padEnd(9)} | ${Math.round(r.rps).toLocaleString().padStart(11)} | ${ratio.toFixed(2)}x | ${r.avg.toFixed(2).padStart(9)}ms | ${r.p50.toFixed(2)}ms | ${r.p95.toFixed(2)}ms | ${r.p99.toFixed(2)}ms |`,
  );
}
console.log("\n   COMPARISON BENCHMARK COMPLETE");
console.log("=======================================================\n");
