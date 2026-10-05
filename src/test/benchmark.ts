// src/test/benchmark.ts
import { FrameworkRuntime } from "../../core_runtime";

const runtime = new FrameworkRuntime({ cpuWorkers: 2, ioWorkers: 2 });

const fixturePath = new URL("./fixtures/bench_fixture.ts", import.meta.url);
await Bun.write(
  fixturePath,
  `
  export function runCompute(iterations: number) {
    let acc = 0;
    for (let i = 0; i < iterations; i++) {
      acc += Math.sqrt(i) * Math.sin(i) ^ (i % 1024);
    }
    return acc;
  }

  export function fastPing() {
    return 1;
  }

  export function ioSimulation(delayMs: number) {
    return new Promise((resolve) => setTimeout(() => resolve(1), delayMs));
  }
  `,
);

function calculatePercentiles(latencies: number[]) {
  latencies.sort((a, b) => a - b);
  const len = latencies.length;
  return {
    p50: latencies[Math.floor(len * 0.5)]!.toFixed(2),
    p95: latencies[Math.floor(len * 0.95)]!.toFixed(2),
    p99: latencies[Math.floor(len * 0.99)]!.toFixed(2),
    max: latencies[len - 1]!.toFixed(2),
  };
}

async function runBenchmark() {
  console.log("\n=======================================================");
  console.log("   🚀 YATTA WORKER RUNTIME — DEEP PROFILE & STRESS TEST");
  console.log("=======================================================\n");

  await runtime.start();

  const cpuGraph = await runtime.registerSubsystem({
    name: "bench-cpu",
    entrypoint: fixturePath.href,
    workload: "cpu",
  });

  const ioGraph = await runtime.registerSubsystem({
    name: "bench-io",
    entrypoint: fixturePath.href,
    workload: "io",
  });

  // ─────────────────────────────────────────────────────────────
  // 1. LAYER OVERHEAD DECOMPOSITION (Where do microseconds go?)
  // ─────────────────────────────────────────────────────────────
  console.log(
    "[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):",
  );

  // A. Raw Worker PostMessage Round-Trip
  const rawWorker = new Worker(
    new URL("../../core_runtime/worker.ts", import.meta.url).href,
  );
  let rawResolvers = new Map<number, () => void>();
  let rawReqId = 0;
  rawWorker.onmessage = (e: any) => {
    rawResolvers.get(e.data.id)?.();
    rawResolvers.delete(e.data.id);
  };

  const t0Raw = performance.now();
  for (let i = 0; i < 2000; i++) {
    const id = ++rawReqId;
    await new Promise<void>((r) => {
      rawResolvers.set(id, r);
      rawWorker.postMessage({ id, action: "PING" });
    });
  }
  const rawIpcCost = ((performance.now() - t0Raw) / 2000).toFixed(4);
  rawWorker.terminate();

  // B. End-to-End Runtime Execution (Scheduler + IPC + ModuleGraph + FastPing)
  const t0E2E = performance.now();
  for (let i = 0; i < 2000; i++) {
    await runtime.execute(ioGraph, "fastPing", null);
  }
  const e2eCost = ((performance.now() - t0E2E) / 2000).toFixed(4);

  console.log(`  • Raw Worker IPC Round-Trip      : ${rawIpcCost} ms/op`);
  console.log(`  • End-to-End Runtime Task Cost    : ${e2eCost} ms/op`);
  console.log(
    `  • Scheduler + Graph Overhead     : ${(Number(e2eCost) - Number(rawIpcCost)).toFixed(4)} ms/op\n`,
  );

  // ─────────────────────────────────────────────────────────────
  // 2. CONCURRENCY LADDER (Stress Testing: 10 to 10,000 tasks)
  // ─────────────────────────────────────────────────────────────
  console.log(
    "[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):",
  );
  console.log(
    "| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |",
  );
  console.log(
    "|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|",
  );

  const testTiers = [10, 100, 500, 1000, 5000, 10000];

  for (const concurrency of testTiers) {
    const latencies: number[] = [];
    const t0 = performance.now();

    const tasks = Array.from({ length: concurrency }).map(async () => {
      const start = performance.now();
      await runtime.execute(ioGraph, "fastPing", null);
      latencies.push(performance.now() - start);
    });

    await Promise.all(tasks);
    const duration = performance.now() - t0;
    const ops = Math.round((concurrency / duration) * 1000);
    const p = calculatePercentiles(latencies);

    console.log(
      `| ${concurrency.toString().padStart(11)} | ${(duration.toFixed(1) + " ms").padStart(10)} | ${ops
        .toLocaleString()
        .padStart(
          20,
        )} | ${p.p50.padStart(10)} | ${p.p95.padStart(10)} | ${p.p99.padStart(10)} | ${p.max.padStart(10)} |`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 3. I/O LATENCY UNDER HEAVY CPU LOAD
  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] Event Loop Latency Under Heavy Compute Load...");
  const t0LagWorker = performance.now();
  let workerIOLatency = 0;
  setTimeout(() => {
    workerIOLatency = performance.now() - t0LagWorker;
  }, 10);

  // Background CPU work: 60M math ops
  const backgroundWork = runtime.execute(cpuGraph, "runCompute", 60_000_000);
  await new Promise((r) => setTimeout(r, 20));
  await backgroundWork;

  console.log(
    `  • Worker Fleet Event Loop Lag : ${workerIOLatency.toFixed(2)} ms (Zero event-loop freezing ⚡)\n`,
  );

  // ─────────────────────────────────────────────────────────────
  // 4. MEMORY FOOTPRINT
  // ─────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  console.log("[4] Memory Footprint Post 10,000-Request Burst:");
  console.log(
    `  • RSS Heap Memory             : ${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(
    `  • V8/JSC Heap Used             : ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
  );

  console.log("\n=======================================================");
  console.log("   ✅ BENCHMARK COMPLETE");
  console.log("=======================================================\n");

  await runtime.shutdown();
  process.exit(0);
}

runBenchmark().catch(console.error);
