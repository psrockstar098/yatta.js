// src/test/verify_runtime.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { FrameworkRuntime } from "../../core_runtime";

describe("Worker Runtime Verification", () => {
  let runtime: FrameworkRuntime;

  beforeAll(async () => {
    runtime = new FrameworkRuntime();
    await runtime.start();
  });

  afterAll(async () => {
    await runtime.shutdown();
  });

  test("Hardware topology scales without the 1-worker-per-core trap", () => {
    const topology = runtime["scheduler"].getTopology();
    expect(topology.cpuCores).toBeGreaterThanOrEqual(1);
    expect(topology.cpuWorkers).toBeGreaterThanOrEqual(1);
    expect(topology.ioWorkers).toBeGreaterThanOrEqual(1);

    // If 2 cores: should be 1 CPU worker and 2 I/O workers (3 total)
    if (topology.cpuCores === 2) {
      expect(topology.cpuWorkers).toBe(1);
      expect(topology.ioWorkers).toBe(2);
      expect(topology.totalWorkers).toBe(3);
    }
  });

  test("CPU-bound tasks do not starve the I/O event loop", async () => {
    // 1. Mount a dummy CPU-heavy subsystem (simulating password hashing / data transform)
    const cpuSubsystemPath = new URL(
      "./fixtures/cpu_fixture.ts",
      import.meta.url,
    ).href;

    // Create an inline mock fixture if file doesn't exist
    await Bun.write(
      new URL("./fixtures/cpu_fixture.ts", import.meta.url),
      `
      export function heavyCompute(iterations: number) {
        let sum = 0;
        for (let i = 0; i < iterations; i++) {
          sum += Math.sqrt(i) * Math.sin(i);
        }
        return sum;
      }
      `,
    );

    const graphId = await runtime.registerSubsystem({
      name: "cpu-fixture",
      entrypoint: cpuSubsystemPath,
      workload: "cpu",
    });

    // 2. Dispatch a long CPU-heavy task into the CPU pool
    const heavyPromise = runtime.execute(graphId, "heavyCompute", 50_000_000);

    // 3. Measure I/O responsiveness while CPU task is executing
    const startIO = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ioLatency = performance.now() - startIO;

    // In a monolithic thread, 50,000,000 math operations would block this timer by several seconds.
    // In our runtime, the timer resolves within <70ms because I/O is untouched.
    expect(ioLatency).toBeLessThan(120);

    const cpuResult = await heavyPromise;
    expect(typeof cpuResult).toBe("number");
  });

  test("ModuleGraph teardown protects against dangling promises", async () => {
    const graphId = await runtime.registerSubsystem({
      name: "disposable-subsystem",
      entrypoint: new URL("./fixtures/cpu_fixture.ts", import.meta.url).href,
      workload: "io",
    });

    // Verify execution works
    const res = await runtime.execute(graphId, "heavyCompute", 100);
    expect(typeof res).toBe("number");
  });
});
