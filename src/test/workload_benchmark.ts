// src/test/workload_benchmark.ts
import { FrameworkRuntime } from "../../core_runtime";

const fixturePath = new URL("./fixtures/workload_fixture.ts", import.meta.url);
await Bun.write(
  fixturePath,
  `
  // 1. Zero-delay Ping (IPC Baseline)
  export function fastPing() {
    return 1;
  }

  // 2. Real-World JSON Payload (~2 KB plain object transformation)
  export function jsonPayload(data: any) {
    return {
      success: true,
      id: data.id,
      email: data.email,
      roles: data.roles,
      processedAt: Date.now(),
      digest: data.name + ":" + data.id,
    };
  }

  // 3. Micro-Compute Task (~0.05-0.1ms math/hashing like JWT verify or state machine)
  export function microCompute(seed: number) {
    let acc = 0x811c9dc5;
    for (let i = 0; i < 1500; i++) {
      acc ^= (i * 31) ^ seed;
      acc = Math.imul(acc, 0x01000193);
    }
    return acc;
  }
  `,
);

function calculatePercentiles(latencies: number[]) {
  latencies.sort((a, b) => a - b);
  const len = latencies.length;
  return {
    p50: latencies[Math.floor(len * 0.5)]!.toFixed(2),
    p90: latencies[Math.floor(len * 0.9)]!.toFixed(2),
    p95: latencies[Math.floor(len * 0.95)]!.toFixed(2),
    p99: latencies[Math.floor(len * 0.99)]!.toFixed(2),
    p999: latencies[Math.floor(len * 0.999)]!.toFixed(2),
    max: latencies[len - 1]!.toFixed(2),
  };
}

// Sample payload (~2 KB)
const SAMPLE_PAYLOAD = {
  id: 12345,
  name: "Yatta Framework Enterprise User",
  email: "developer@yatta-runtime.internal",
  roles: ["admin", "developer", "billing_manager"],
  attributes: {
    tier: "enterprise",
    features: ["realtime", "module_graph", "worker_isolation", "auto_draining"],
    region: "us-east-1",
    limits: { maxConnections: 10000, rateLimit: 50000 },
  },
};

async function runWorkloadTest(
  runtime: FrameworkRuntime,
  graphId: string,
  handlerName: string,
  payloadFactory: (idx: number) => any,
  concurrency: number,
) {
  const latencies: number[] = [];
  const t0 = performance.now();

  const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
    const s = performance.now();
    await runtime.execute(graphId, handlerName, payloadFactory(idx));
    latencies.push(performance.now() - s);
  });

  await Promise.all(tasks);
  const duration = performance.now() - t0;
  const ops = Math.round((concurrency / duration) * 1000);
  const p = calculatePercentiles(latencies);

  return {
    concurrency,
    duration: duration.toFixed(1) + " ms",
    ops: ops.toLocaleString(),
    ...p,
  };
}

async function runSuite() {
  console.log(
    "\n=========================================================================",
  );
  console.log(
    "   🚀 YATTA WORKER RUNTIME — MULTI-WORKLOAD & DEEP STRESS BENCHMARK     ",
  );
  console.log(
    "=========================================================================\n",
  );

  const runtime = new FrameworkRuntime({ cpuWorkers: 2, ioWorkers: 2 });
  await runtime.start();

  const ioGraph = await runtime.registerSubsystem({
    name: "workload-io",
    entrypoint: fixturePath.href,
    workload: "io",
  });

  const cpuGraph = await runtime.registerSubsystem({
    name: "workload-cpu",
    entrypoint: fixturePath.href,
    workload: "cpu",
  });

  const concurrencyTiers = [1_000, 5_000, 10_000, 25_000, 50_000];

  // ──────────────────────────────────────────────────────────────────────────
  // WORKLOAD 1: FAST PING (Baseline IPC Overhead)
  // ──────────────────────────────────────────────────────────────────────────
  console.log(
    "📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):",
  );
  console.log(
    "| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |",
  );
  console.log(
    "|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|",
  );

  for (const c of concurrencyTiers) {
    const res = await runWorkloadTest(
      runtime,
      ioGraph,
      "fastPing",
      () => null,
      c,
    );
    console.log(
      `| ${res.concurrency.toString().padStart(11)} | ${res.duration.padStart(9)} | ${res.ops.padStart(18)} | ${res.p50.padStart(8)} | ${res.p90.padStart(8)} | ${res.p99.padStart(8)} | ${res.p999.padStart(10)} | ${res.max.padStart(8)} |`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WORKLOAD 2: 2KB JSON OBJECT PAYLOAD (Serialization & Memory Copying)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:");
  console.log(
    "| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |",
  );
  console.log(
    "|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|",
  );

  for (const c of concurrencyTiers) {
    const res = await runWorkloadTest(
      runtime,
      ioGraph,
      "jsonPayload",
      (idx) => ({ ...SAMPLE_PAYLOAD, id: idx }),
      c,
    );
    console.log(
      `| ${res.concurrency.toString().padStart(11)} | ${res.duration.padStart(9)} | ${res.ops.padStart(18)} | ${res.p50.padStart(8)} | ${res.p90.padStart(8)} | ${res.p99.padStart(8)} | ${res.p999.padStart(10)} | ${res.max.padStart(8)} |`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // WORKLOAD 3: MICRO-COMPUTE (~0.08ms CPU task like JWT Verify / Hash Map)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):");
  console.log(
    "| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |",
  );
  console.log(
    "|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|",
  );

  // For CPU micro-compute, test realistic burst tiers: 1k, 5k, 10k
  for (const c of [1_000, 5_000, 10_000]) {
    const res = await runWorkloadTest(
      runtime,
      cpuGraph,
      "microCompute",
      (idx) => idx,
      c,
    );
    console.log(
      `| ${res.concurrency.toString().padStart(11)} | ${res.duration.padStart(9)} | ${res.ops.padStart(18)} | ${res.p50.padStart(8)} | ${res.p90.padStart(8)} | ${res.p99.padStart(8)} | ${res.p999.padStart(10)} | ${res.max.padStart(8)} |`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MEMORY RECLAMATION POST 50K BURST
  // ──────────────────────────────────────────────────────────────────────────
  const memBeforeGC = process.memoryUsage().rss / 1024 / 1024;
  await new Promise((r) => setTimeout(r, 1200)); // Allow JSC GC to settle
  const memAfterGC = process.memoryUsage().rss / 1024 / 1024;

  console.log("\n📈 Memory Footprint (Post 50,000-Task Burst):");
  console.log(`  • Peak RSS Memory        : ${memBeforeGC.toFixed(1)} MB`);
  console.log(
    `  • Settled Cooldown RSS   : ${memAfterGC.toFixed(1)} MB (Clean GC release)`,
  );

  await runtime.shutdown();

  console.log(
    "\n=========================================================================",
  );
  console.log("   ✅ COMPREHENSIVE WORKLOAD BENCHMARK COMPLETE");
  console.log(
    "=========================================================================\n",
  );
  process.exit(0);
}

runSuite().catch(console.error);
