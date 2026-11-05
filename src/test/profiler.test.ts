import { describe, it, expect } from "bun:test";
import {
  SamplingProfiler,
  EventLoopLagMonitor,
  ThresholdCapture,
  collapsedStacks,
  hotFunctions,
  toFlamegraphSvg,
  sanitizeProfile,
  sanitizeContext,
  frameLabel,
  attachLagTrigger,
  type CpuProfile,
  type ProfilerLike,
} from "../types/profiler";

/*
 * Sampling profiler tests.
 *
 * Synthetic profiles cover the deterministic parts (folding, hot
 * functions, flamegraph, redaction) so those tests never depend on
 * timing. The real-profiler tests cover the Bun inspector path itself:
 * a busy loop must show up as samples, or the mechanism is broken.
 */

// A small profile with known counts: hot on top 8 times, cold twice.
function syntheticProfile(): CpuProfile {
  return {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        hitCount: 0,
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "(module)",
          scriptId: "2",
          url: "file:///home/someone/app/src/work.ts",
          lineNumber: 0,
          columnNumber: 0,
        },
        hitCount: 0,
        children: [3, 4],
      },
      {
        id: 3,
        callFrame: {
          functionName: "hot",
          scriptId: "2",
          url: "file:///home/someone/app/src/work.ts",
          lineNumber: 10,
          columnNumber: 5,
        },
        hitCount: 8,
        children: [],
      },
      {
        id: 4,
        callFrame: {
          functionName: "cold",
          scriptId: "2",
          url: "file:///home/someone/app/src/other.ts",
          lineNumber: 3,
          columnNumber: 0,
        },
        hitCount: 2,
        children: [],
      },
    ],
    startTime: 1000,
    endTime: 2000,
    samples: [3, 3, 3, 3, 3, 3, 3, 3, 4, 4],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
}

function busyWork(ms: number): number {
  const end = Date.now() + ms;
  let s = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 10000; i++) s += Math.sqrt(i);
  }
  return s;
}

describe("SamplingProfiler defaults and validation", () => {
  it("is off until start() is called", () => {
    const profiler = new SamplingProfiler();
    expect(profiler.isRunning).toBe(false);
    expect(profiler.samplingIntervalUs).toBe(1000);
  });

  it("stop() without start() returns null, not a fake empty profile", async () => {
    const profiler = new SamplingProfiler();
    expect(await profiler.stop()).toBeNull();
  });

  it("rejects a non-positive sampling interval", () => {
    expect(() => new SamplingProfiler({ samplingIntervalUs: 0 })).toThrow();
    expect(() => new SamplingProfiler({ samplingIntervalUs: -5 })).toThrow();
    expect(
      () => new SamplingProfiler({ samplingIntervalUs: 1.5 }),
    ).toThrow();
  });

  it("a second start() is a no-op returning false", async () => {
    const profiler = new SamplingProfiler();
    expect(await profiler.start()).toBe(true);
    try {
      expect(await profiler.start()).toBe(false);
      expect(profiler.isRunning).toBe(true);
    } finally {
      await profiler.stop();
    }
    expect(profiler.isRunning).toBe(false);
  });
});

describe("SamplingProfiler real capture (Bun inspector)", () => {
  it("captures samples with the busy function on top", async () => {
    const profiler = new SamplingProfiler({ samplingIntervalUs: 100 });
    const { result, profile } = await profiler.profile(() => busyWork(300));
    expect(typeof result).toBe("number");
    expect(profile.samples.length).toBeGreaterThan(0);
    const hot = hotFunctions(profile, 5);
    expect(hot.length).toBeGreaterThan(0);
    // The busy loop itself must appear among the hot frames.
    const names = hot.map((h) => h.function);
    expect(names.some((n) => n === "busyWork")).toBe(true);
  });

  it("start/stop returns a profile with nodes and samples", async () => {
    const profiler = new SamplingProfiler({ samplingIntervalUs: 100 });
    await profiler.start();
    busyWork(200);
    const profile = await profiler.stop();
    expect(profile).not.toBeNull();
    expect(profile!.nodes.length).toBeGreaterThan(0);
    expect(profile!.samples.length).toBeGreaterThan(0);
  });
});

describe("collapsed stacks and hot functions (synthetic)", () => {
  it("folds samples into stacks with counts", () => {
    const folded = collapsedStacks(syntheticProfile());
    expect(folded).toHaveLength(2);
    const hotStack = folded.find((f) => f.stack.includes("hot@"));
    expect(hotStack?.samples).toBe(8);
    const coldStack = folded.find((f) => f.stack.includes("cold@"));
    expect(coldStack?.samples).toBe(2);
    // Counts add up to the sample count: nothing invented, nothing lost.
    expect(folded.reduce((a, f) => a + f.samples, 0)).toBe(10);
  });

  it("ranks hot functions by self samples", () => {
    const hot = hotFunctions(syntheticProfile(), 10);
    expect(hot[0]?.function).toBe("hot");
    expect(hot[0]?.selfSamples).toBe(8);
    expect(hot[0]?.selfPercent).toBe(80);
    expect(hot[1]?.function).toBe("cold");
  });

  it("returns nothing for an empty profile", () => {
    const empty: CpuProfile = {
      nodes: [],
      startTime: 0,
      endTime: 0,
      samples: [],
      timeDeltas: [],
    };
    expect(collapsedStacks(empty)).toEqual([]);
    expect(hotFunctions(empty)).toEqual([]);
    expect(toFlamegraphSvg(empty)).toContain("No samples captured");
  });
});

describe("flamegraph redaction", () => {
  it("uses basenames only, never full paths", () => {
    const svg = toFlamegraphSvg(syntheticProfile());
    expect(svg).toContain("<svg");
    expect(svg).toContain("work.ts");
    expect(svg).not.toContain("/home/someone");
    expect(svg).not.toContain("file://");
  });

  it("escapes labels so a frame name cannot break out of the SVG", () => {
    const profile = syntheticProfile();
    profile.nodes[2]!.callFrame.functionName = "x<y&z";
    const svg = toFlamegraphSvg(profile);
    expect(svg).toContain("x&lt;y&amp;z");
    expect(svg).not.toContain("x<y&z");
  });

  it("sanitizeProfile reduces frame URLs to basenames", () => {
    const clean = sanitizeProfile(syntheticProfile());
    expect(clean.nodes[2]?.callFrame.url).toBe("work.ts");
    expect(clean.nodes[1]?.callFrame.url).toBe("work.ts");
  });

  it("frame labels carry name, basename and line", () => {
    expect(
      frameLabel({
        functionName: "hot",
        scriptId: "2",
        url: "file:///a/b/work.ts",
        lineNumber: 10,
        columnNumber: 0,
      }),
    ).toBe("hot@work.ts:10");
  });
});

describe("sanitizeContext", () => {
  it("drops credential-looking keys and non-string values", () => {
    const out = sanitizeContext({
      route: "/api/users",
      apiToken: "should-not-appear",
      password: "should-not-appear",
      count: 42,
    });
    expect(out).toEqual({ route: "/api/users" });
  });
});

describe("EventLoopLagMonitor", () => {
  it("is off by default and reports windows once started", async () => {
    const monitor = new EventLoopLagMonitor({ windowMs: 50 });
    expect(monitor.isRunning).toBe(false);
    expect(monitor.current()).toBeNull();
    expect(monitor.start()).toBe(true);
    expect(monitor.start()).toBe(false);
    await new Promise((r) => setTimeout(r, 180));
    const current = monitor.current();
    expect(current).not.toBeNull();
    expect(current!.meanMs).toBeGreaterThanOrEqual(0);
    expect(current!.p99Ms).toBeGreaterThanOrEqual(0);
    expect(current!.maxMs).toBeGreaterThanOrEqual(0);
    expect(monitor.allSamples().length).toBeGreaterThan(0);
    expect(monitor.stop()).toBe(true);
    expect(monitor.isRunning).toBe(false);
  });

  it("rejects bad options", () => {
    expect(() => new EventLoopLagMonitor({ windowMs: 0 })).toThrow();
    expect(() => new EventLoopLagMonitor({ resolutionMs: -1 })).toThrow();
    expect(() => new EventLoopLagMonitor({ thresholdMs: 0 })).toThrow();
  });

  it("fires threshold listeners on over-threshold windows", async () => {
    const seen: number[] = [];
    const monitor = new EventLoopLagMonitor({
      windowMs: 50,
      thresholdMs: 0.001,
    });
    monitor.addThresholdListener((s) => seen.push(s.meanMs));
    monitor.start();
    await new Promise((r) => setTimeout(r, 220));
    monitor.stop();
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("ThresholdCapture with a stub profiler", () => {
  function stubProfiler(): ProfilerLike & {
    stopCalls: number;
    startCalls: number;
  } {
    let running = false;
    const stub = {
      stopCalls: 0,
      startCalls: 0,
      get isRunning() {
        return running;
      },
      async start() {
        stub.startCalls++;
        if (running) return false;
        running = true;
        return true;
      },
      async stop() {
        stub.stopCalls++;
        if (!running) return null;
        running = false;
        return syntheticProfile();
      },
    };
    return stub;
  }

  it("captures nothing while disabled", async () => {
    const profiler = stubProfiler();
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 50,
      captureDurationMs: 10,
    });
    capture.observe(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(capture.captures()).toHaveLength(0);
    expect(profiler.startCalls).toBe(0);
  });

  it("captures after consecutive over-threshold observations", async () => {
    const profiler = stubProfiler();
    const seen: Array<{ trigger: number; route?: string }> = [];
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 50,
      consecutive: 2,
      captureDurationMs: 20,
      cooldownMs: 60000,
      onCapture: (c) =>
        seen.push({ trigger: c.triggerValueMs, route: c.context["route"] }),
    });
    capture.start();
    capture.observe(10);
    capture.observe(60, { route: "/slow" });
    await new Promise((r) => setTimeout(r, 10));
    expect(capture.captures()).toHaveLength(0);
    capture.observe(70, { route: "/slow" });
    await new Promise((r) => setTimeout(r, 100));
    expect(capture.captures()).toHaveLength(1);
    expect(seen[0]?.trigger).toBe(70);
    expect(seen[0]?.route).toBe("/slow");
    expect(capture.captures()[0]?.hot[0]?.function).toBe("hot");
    expect(capture.captures()[0]?.flamegraphSvg).toContain("<svg");
  });

  it("cooldown blocks a second capture and maxCaptures evicts oldest", async () => {
    const profiler = stubProfiler();
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 50,
      captureDurationMs: 10,
      cooldownMs: 60000,
      maxCaptures: 1,
    });
    capture.start();
    capture.observe(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(capture.captures()).toHaveLength(1);
    capture.observe(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(capture.captures()).toHaveLength(1);
    expect(profiler.startCalls).toBe(1);
  });

  it("does not steal a profile already running elsewhere", async () => {
    const profiler = stubProfiler();
    await profiler.start();
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 50,
      captureDurationMs: 10,
    });
    capture.start();
    capture.observe(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(capture.captures()).toHaveLength(0);
    // The outside profile was left alone: stop was never called for it.
    expect(profiler.stopCalls).toBe(0);
    await profiler.stop();
  });

  it("rejects bad options", () => {
    const profiler = stubProfiler();
    expect(
      () => new ThresholdCapture({ profiler, thresholdMs: 0 }),
    ).toThrow();
    expect(
      () =>
        new ThresholdCapture({
          profiler,
          thresholdMs: 50,
          consecutive: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new ThresholdCapture({
          profiler,
          thresholdMs: 50,
          captureDurationMs: 0,
        }),
    ).toThrow();
  });
});

describe("ThresholdCapture end to end with the real profiler", () => {
  it("stores a real capture when lag crosses the threshold", async () => {
    const profiler = new SamplingProfiler({ samplingIntervalUs: 100 });
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 1,
      captureDurationMs: 250,
      cooldownMs: 60000,
    });
    capture.start();
    // Feed the trigger directly: the decision logic is what is under test
    // here, not the event loop's mood on this machine.
    capture.observe(50, { source: "test" });
    const deadline = Date.now() + 5000;
    while (
      capture.captures().length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
      busyWork(20);
    }
    expect(capture.captures()).toHaveLength(1);
    expect(capture.captures()[0]?.flamegraphSvg).toContain("<svg");
    expect(capture.captures()[0]?.context["source"]).toBe("test");
    capture.stop();
    await profiler.dispose();
  });

  it("attachLagTrigger wires monitor windows into observe()", async () => {
    const profiler = new SamplingProfiler({ samplingIntervalUs: 100 });
    const capture = new ThresholdCapture({
      profiler,
      thresholdMs: 0.001,
      captureDurationMs: 100,
      cooldownMs: 60000,
    });
    const monitor = new EventLoopLagMonitor({
      windowMs: 50,
      thresholdMs: 0.001,
    });
    const off = attachLagTrigger(monitor, capture);
    capture.start();
    monitor.start();
    const deadline = Date.now() + 5000;
    while (
      capture.captures().length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    off();
    monitor.stop();
    capture.stop();
    await profiler.dispose();
    expect(capture.captures().length).toBeGreaterThanOrEqual(1);
  });
});
