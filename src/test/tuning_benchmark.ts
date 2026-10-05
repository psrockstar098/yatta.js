import { FrameworkRuntime } from "../../core_runtime";

const fixturePath = new URL("./fixtures/bench_fixture.ts", import.meta.url);

function calculatePercentiles(latencies: number[]) {
  latencies.sort((a, b) => a - b);
  const len = latencies.length;
  return {
    p50: latencies[Math.floor(len * 0.5)]!.toFixed(2),
    p95: latencies[Math.floor(len * 0.95)]!.toFixed(2),
    p99: latencies[Math.floor(len * 0.99)]!.toFixed(2),
    p999: latencies[Math.floor(len * 0.999)]!.toFixed(2),
    max: latencies[len - 1]!.toFixed(2),
  };
}

async function testTopology(
  cpuWorkers: number,
  ioWorkers: number,
  taskCount: number,
) {
  const runtime = new FrameworkRuntime({ cpuWorkers, ioWorkers });
  await runtime.start();

  const ioGraph = await runtime.registerSubsystem({
    name: `tune-${cpuWorkers}-${ioWorkers}`,
    entrypoint: fixturePath.href,
    workload: "io",
  });

  const latencies: number[] = [];
  const t0 = performance.now();

  const tasks = Array.from({ length: taskCount }).map(async () => {
    const s = performance.now();
    await runtime.execute(ioGraph, "fastPing", null);
    latencies.push(performance.now() - s);
  });

  await Promise.all(tasks);
  const duration = performance.now() - t0;
  const ops = Math.round((taskCount / duration) * 1000);
  const p = calculatePercentiles(latencies);

  await runtime.shutdown();

  return {
    config: `${cpuWorkers} CPU + ${ioWorkers} IO`,
    threads: cpuWorkers + ioWorkers,
    duration: duration.toFixed(1) + " ms",
    ops: ops.toLocaleString(),
    ...p,
  };
}

async function runTuningSuite() {
  console.log("\n=======================================================");
  console.log("   🧪 YATTA WORKER RUNTIME — TOPOLOGY & TAIL TUNING    ");
  console.log("=======================================================\n");

  // 1. TOPOLOGY MATRIX (10,000 Tasks)
  console.log(
    "[1] Hardware Topology Matrix Sweep (10,000 tasks on 2 physical cores):",
  );
  console.log(
    "| Configuration | Threads | Duration  | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |",
  );
  console.log(
    "|:--------------|:-------:|:---------:|:------------------:|:--------:|:--------:|:--------:|:--------:|",
  );

  const configs = [
    { cpu: 1, io: 1 },
    { cpu: 1, io: 2 },
    { cpu: 2, io: 1 },
    { cpu: 2, io: 2 },
  ];

  for (const c of configs) {
    const res = await testTopology(c.cpu, c.io, 10_000);
    console.log(
      `| ${res.config.padEnd(13)} | ${res.threads.toString().padStart(7)} | ${res.duration.padStart(9)} | ${res.ops.padStart(18)} | ${res.p50.padStart(8)} | ${res.p95.padStart(8)} | ${res.p99.padStart(8)} | ${res.max.padStart(8)} |`,
    );
  }

  // 2. 25,000 TASK DEEP TAIL STRESS TEST
  console.log("\n[2] High-Stress Deep Tail Test (25,000 Tasks):");
  const memBefore = process.memoryUsage().rss / 1024 / 1024;

  const runtime = new FrameworkRuntime({ cpuWorkers: 2, ioWorkers: 2 });
  await runtime.start();
  const ioGraph = await runtime.registerSubsystem({
    name: "stress-25k",
    entrypoint: fixturePath.href,
    workload: "io",
  });

  const latencies: number[] = [];
  const t0 = performance.now();

  const burst25k = Array.from({ length: 25_000 }).map(async () => {
    const s = performance.now();
    await runtime.execute(ioGraph, "fastPing", null);
    latencies.push(performance.now() - s);
  });

  await Promise.all(burst25k);
  const duration = performance.now() - t0;
  const p = calculatePercentiles(latencies);
  const memAfterBurst = process.memoryUsage().rss / 1024 / 1024;

  // Let GC settle for 1 second
  await new Promise((r) => setTimeout(r, 1000));
  const memSettled = process.memoryUsage().rss / 1024 / 1024;

  console.log(`  • 25,000 Tasks Completed in  : ${duration.toFixed(1)} ms`);
  console.log(
    `  • Peak Throughput Rate       : ${Math.round((25000 / duration) * 1000).toLocaleString()} ops/sec`,
  );
  console.log(
    `  • Latency Distribution       : p50: ${p.p50}ms | p90: ${p.p95}ms | p99: ${p.p99}ms | p99.9: ${p.p999}ms | Max: ${p.max}ms`,
  );
  console.log(
    `  • Memory (RSS)               : Baseline: ${memBefore.toFixed(1)} MB | Peak: ${memAfterBurst.toFixed(1)} MB | Cooldown: ${memSettled.toFixed(1)} MB`,
  );

  await runtime.shutdown();

  console.log("\n=======================================================");
  console.log("   ✅ TUNING BENCHMARK COMPLETE");
  console.log("=======================================================\n");
  process.exit(0);
}

runTuningSuite().catch(console.error);
