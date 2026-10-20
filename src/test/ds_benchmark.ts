/**
 * Micro-benchmarks for the `yatta.js/ds` primitives against the engine
 * natives they parallel. Read the results in `ds.ts`'s header: these exist
 * to prove the "honest performance notes" either way, not to crown a winner.
 *
 * Usage: bun run src/test/ds_benchmark.ts
 */
import {
  createStringMap,
  createColumnStore,
  createTaskGroup,
  createBatch,
} from "../types/ds";

function measure(name: string, fn: () => void, iters: number) {
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  console.log(
    `${name}: ${(ms / iters).toFixed(3)} ms/op total (${ms.toFixed(0)} ms for ${iters})`,
  );
}

async function measureAsync(name: string, fn: () => Promise<void>, iters: number) {
  for (let i = 0; i < 2; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await fn();
  const ms = performance.now() - t0;
  console.log(
    `${name}: ${(ms / iters).toFixed(3)} ms/op total (${ms.toFixed(0)} ms for ${iters})`,
  );
}

const N = 100_000;

// ── StringMap vs Map: 100k puts + 100k gets ────────────────────────────
{
  const keys = Array.from({ length: N }, (_, i) => `user:${i}:session`);
  measure("Map            100k put + 100k get", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < N; i++) m.set(keys[i]!, i);
    let s = 0;
    for (let i = 0; i < N; i++) s += m.get(keys[i]!)!;
    if (s === -1) console.log("impossible");
  }, 5);
  measure("StringMap      100k put + 100k get", () => {
    const m = createStringMap<number>({ capacity: N * 2 });
    for (let i = 0; i < N; i++) m.put(keys[i]!, i);
    let s = 0;
    for (let i = 0; i < N; i++) s += m.get(keys[i]!)!;
    if (s === -1) console.log("impossible");
  }, 5);
}

// ── ColumnStore vs array-of-objects: field scan over 1M rows ───────────
{
  const M = 1_000_000;
  const col = createColumnStore({ id: "u32", score: "f64" } as const, M);
  for (let i = 0; i < M; i++) col.append({ id: i, score: (i % 100) * 0.5 });
  const arr: Array<{ id: number; score: number }> = new Array(M);
  for (let i = 0; i < M; i++) arr[i] = { id: i, score: (i % 100) * 0.5 };
  measure("array-of-objects field scan (sum 1M)", () => {
    let s = 0;
    for (let i = 0; i < M; i++) s += arr[i]!.score;
    if (s === -1) console.log("impossible");
  }, 5);
  measure("ColumnStore    field scan (sum 1M)", () => {
    const scores = col.field("score") as unknown as Float64Array;
    let s = 0;
    for (let i = 0; i < scores.length; i++) s += scores[i]!;
    if (s === -1) console.log("impossible");
  }, 5);
  measure("array-of-objects full-row random access (100k)", () => {
    let s = 0;
    for (let i = 0; i < 100_000; i++) {
      const r = arr[(i * 7919) % M]!;
      s += r.id + r.score;
    }
    if (s === -1) console.log("impossible");
  }, 5);
  measure("ColumnStore    full-row random access (100k)", () => {
    let s = 0;
    for (let i = 0; i < 100_000; i++) {
      const r = col.get((i * 7919) % M);
      s += r.id + r.score;
    }
    if (s === -1) console.log("impossible");
  }, 5);
}

// ── TaskGroup vs Promise.all: 200 concurrent sleeps ───────────────────
{
  const K = 200;
  const sleep = (i: number) => new Promise<number>((r) => setTimeout(() => r(i), 2));
  await measureAsync("Promise.all    200 tasks", async () => {
    await Promise.all(Array.from({ length: K }, (_, i) => sleep(i)));
  }, 10);
  await measureAsync("TaskGroup      200 tasks", async () => {
    const g = createTaskGroup();
    for (let i = 0; i < K; i++) g.spawn(() => sleep(i));
    await g.waitAll();
  }, 10);
}

// ── Batch: 50 file writes+reads vs sequential vs Promise.all ──────────
{
  const dir = `/tmp/yatta-ds-bench-${process.pid}`;
  const { mkdirSync, rmSync } = await import("node:fs");
  const files = Array.from({ length: 50 }, (_, i) => `${dir}/f${i}.txt`);
  mkdirSync(dir, { recursive: true });

  await measureAsync("sequential     50 write+read", async () => {
    for (const f of files) {
      await Bun.write(f, "x".repeat(100));
      await Bun.file(f).text();
    }
  }, 3);
  await measureAsync("Promise.all    50 write+read", async () => {
    await Promise.all(
      files.map(async (f) => {
        await Bun.write(f, "x".repeat(100));
        await Bun.file(f).text();
      }),
    );
  }, 3);
  await measureAsync("Batch          50 write+read", async () => {
    const b = createBatch();
    for (const f of files) b.write(f, "x".repeat(100));
    await b.run();
    const b2 = createBatch();
    for (const f of files) b2.read(f);
    await b2.run();
  }, 3);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nDone. Numbers are relative on this machine — compare within a run.");
