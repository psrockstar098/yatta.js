import { describe, it, expect } from "bun:test";
import {
  IncidentAnalyzer,
  ReleaseIntelligence,
  ReleaseTimeline,
  buildSpanTree,
  flattenTree,
  p,
  mean,
  coefficientOfVariation,
  linearTrend,
  MetricsHistory,
  ServiceMapBuilder,
  NPlusOneDetector,
  SloEngine,
  JobIntelligence,
  SafeActions,
  GoldenTraceStore,
  FileSystemTraceToCode,
  normalizeSqlForShape,
  BaselineEngine,
  median,
  type AnalysisSource,
} from "../types/observe_analysis";
import { createObserver } from "../types/observe";
import {
  Observer,
  generateTraceId,
  generateSpanId,
  computeSmartFingerprint,
  type ErrorOccurrence,
} from "../types/observe";

// ── helpers ──────────────────────────────────────────────────────────────────

const span = (over: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  durationMs: number;
  status?: "unset" | "ok" | "error";
  attributes?: Record<string, { string: string; number: number; bool: boolean }>;
}) => ({
  traceId: over.traceId,
  spanId: over.spanId,
  parentSpanId: over.parentSpanId,
  name: over.name,
  kind: "internal",
  startTime: over.startTime,
  endTime: over.startTime + over.durationMs,
  durationMs: over.durationMs,
  status: over.status ?? "ok",
  attributes: over.attributes ?? {},
  events: [],
}) as unknown as import("../types/observe").Span;

const stub = (over: Partial<AnalysisSource>): AnalysisSource =>
  ({
    service: "test",
    environment: "test",
    version: "1.0.0",
    spans: { all: () => [] },
    errors: { issues: new Map() },
    transactions: { all: () => [] },
    slowQueries: { all: () => [] },
    logs: { all: () => [] },
    history: new MetricsHistory(),
    releases: new ReleaseTimeline(),
    ...over,
  }) as AnalysisSource;

const occurrence = (over: {
  fingerprint: string;
  traceId?: string;
  route?: string;
  timestamp?: number;
  message?: string;
}): ErrorOccurrence => ({
  id: crypto.randomUUID(),
  fingerprint: over.fingerprint,
  timestamp: over.timestamp ?? Date.now(),
  traceId: over.traceId,
  message: over.message ?? "boom",
  name: "Error",
  stack: "Error: boom\n    at f (/app/src/a.ts:1:1)",
  parsedFrames: [],
  level: "error",
  request: { route: over.route },
  breadcrumbs: [],
  handled: false,
});

const issue = (fingerprint: string, over: Partial<import("../types/observe").ErrorIssue> = {}) =>
  ({
    fingerprint,
    status: "unresolved",
    firstSeen: Date.now() - 60_000,
    lastSeen: Date.now(),
    count: 1,
    name: "Error",
    message: "boom",
    routes: ["/api/checkout"],
    occurrences: [occurrence({ fingerprint })],
    sparkline: [],
    ...over,
  }) as import("../types/observe").ErrorIssue;

// ── statistics ──────────────────────────────────────────────────────────────

describe("statistics helpers", () => {
  it("computes a percentile from an unsorted sample", () => {
    expect(p([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(p([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(p([], 95)).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    p(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it("reports dispersion so a spiky metric is distinguishable from a steady one", () => {
    const steady = coefficientOfVariation([10, 10, 10, 10]);
    const spiky = coefficientOfVariation([1, 1, 40, 1]);
    expect(steady).toBe(0);
    expect(spiky).toBeGreaterThan(0.5);
    expect(mean([])).toBe(0);
  });
});

// ── span tree ───────────────────────────────────────────────────────────────

describe("buildSpanTree", () => {
  it("nests children under their parent and computes depth", () => {
    const traceId = generateTraceId();
    const root = span({ traceId, spanId: "a", name: "GET /x", startTime: 1000, durationMs: 100 });
    const mid = span({ traceId, spanId: "b", parentSpanId: "a", name: "service", startTime: 1010, durationMs: 60 });
    const leaf = span({ traceId, spanId: "c", parentSpanId: "b", name: "db.query", startTime: 1015, durationMs: 40 });

    const roots = buildSpanTree([leaf, mid, root])!;
    expect(roots).toHaveLength(1);
    const flat = flattenTree(roots);
    expect(flat.map((n) => n.span.spanId)).toEqual(["a", "b", "c"]);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2]);
  });

  it("attributes time not spent in children as the span's own cost", () => {
    const traceId = generateTraceId();
    const root = span({ traceId, spanId: "a", name: "req", startTime: 0, durationMs: 100 });
    const child = span({ traceId, spanId: "b", parentSpanId: "a", name: "db", startTime: 5, durationMs: 20 });

    const flat = flattenTree(buildSpanTree([root, child])!);
    expect(flat[0]!.ownMs).toBe(80);
    expect(flat[1]!.ownMs).toBe(20);
  });

  it("treats an orphan span as a root rather than dropping it", () => {
    const traceId = generateTraceId();
    const orphan = span({ traceId, spanId: "z", name: "orphan", startTime: 0, durationMs: 5 });
    expect(buildSpanTree([orphan])).toHaveLength(1);
  });

  it("returns null for no spans", () => {
    expect(buildSpanTree([])).toBeNull();
  });
});

// ── release timeline ────────────────────────────────────────────────────────

describe("ReleaseTimeline", () => {
  const marker = (release: string, deployedAt: number) => ({
    release,
    version: release,
    environment: "test",
    deployedAt,
    pid: 1,
  });

  it("records deploys in order and resolves the one live at a point in time", () => {
    const tl = new ReleaseTimeline();
    tl.record(marker("1.8.2", 1000));
    tl.record(marker("1.8.3", 2000));
    tl.record(marker("1.8.4", 3000));

    expect(tl.all().map((m) => m.release)).toEqual(["1.8.2", "1.8.3", "1.8.4"]);
    expect(tl.activeAt(2500)?.release).toBe("1.8.3");
    expect(tl.activeAt(500)?.release).toBeUndefined();
    expect(tl.previousOf("1.8.4")?.release).toBe("1.8.3");
  });

  it("does not re-record the same build on restart, preserving deploy time", () => {
    const tl = new ReleaseTimeline();
    tl.record(marker("1.8.4", 3000));
    tl.record(marker("1.8.4", 9999));

    expect(tl.all()).toHaveLength(1);
    // "Live for 2h" must not silently reset on every process restart.
    expect(tl.latest()!.deployedAt).toBe(3000);
  });

  it("caps history", () => {
    const tl = new ReleaseTimeline(3);
    for (let i = 0; i < 10; i++) tl.record(marker(`1.0.${i}`, i * 1000));
    expect(tl.all()).toHaveLength(3);
  });
});

// ── incident correlation ────────────────────────────────────────────────────

describe("IncidentAnalyzer", () => {
  it("returns null for an unknown fingerprint rather than inventing one", () => {
    expect(new IncidentAnalyzer(stub({})).analyze("nope")).toBeNull();
  });

  it("reports an unexplained failure as unknown rather than guessing", () => {
    const fp = "fp1";
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp })] })]]),
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;

    expect(a.suspects).toHaveLength(0);
    expect(a.confidence).toBe(0);
    expect(a.unknowns.join(" ")).toMatch(/No correlated signal/);
  });

  it("always reports at least one unknown, even for a well-formed incident", () => {
    // Traces, a release and enough occurrences: nothing specific is missing, but
    // the correlation is still heuristic and must say so.
    const fp = "fp-standalone";
    const traceId = generateTraceId();
    const source = stub({
      releases: (() => {
        const tl = new ReleaseTimeline();
        tl.record({ release: "1.0.0", version: "1.0.0", environment: "test", deployedAt: Date.now() - 1000, pid: 1 });
        return tl;
      })(),
      errors: {
        issues: new Map([[fp, issue(fp, {
          occurrences: Array.from({ length: 5 }, () => occurrence({ fingerprint: fp, traceId })),
        })]]),
      },
      spans: {
        all: () => [span({ traceId, spanId: "r", name: "GET /api/x", startTime: 0, durationMs: 20,
          attributes: { "http.route": { string: "/api/x", number: 0, bool: false } } })],
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    expect(a.unknowns.length).toBeGreaterThan(0);
    expect(a.unknowns.join(" ")).toMatch(/heuristic/);
  });

  it("always reports unknowns, so a confident answer cannot hide gaps", () => {
    const fp = "fp2";
    const traceId = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp, traceId })] })]]),
      },
      spans: {
        all: () => [
          span({ traceId, spanId: "r", name: "POST /api/checkout", startTime: 1000, durationMs: 50, attributes: { "http.route": { string: "/api/checkout", number: 0, bool: false } } }),
        ],
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    expect(Array.isArray(a.unknowns)).toBe(true);
    expect(a.unknowns.length).toBeGreaterThan(0);
  });

  it("builds an ordered timeline of the failing request", () => {
    const fp = "fp3";
    const traceId = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp, traceId })] })]]),
      },
      spans: {
        all: () => [
          span({ traceId, spanId: "c", parentSpanId: "r", name: "db.query", startTime: 1020, durationMs: 30 }),
          span({ traceId, spanId: "r", name: "POST /api/checkout", startTime: 1000, durationMs: 100 }),
        ],
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    const times = a.timeline.map((t) => t.at);

    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(a.timeline.map((t) => t.label)).toEqual([
      "POST /api/checkout",
      "db.query",
    ]);
    expect(a.timeline[1]!.offsetMs).toBe(20);
  });

  it("names the dominant latency contributor with the share of request time", () => {
    const fp = "fp4";
    const traceId = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp, traceId })] })]]),
      },
      spans: {
        all: () => [
          span({ traceId, spanId: "r", name: "req", startTime: 0, durationMs: 100 }),
          span({ traceId, spanId: "s", parentSpanId: "r", name: "checkout.service", startTime: 1, durationMs: 90 }),
        ],
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    const latency = a.suspects.find((s) => s.kind === "latency")!;

    expect(latency.label).toContain("checkout.service");
    expect(latency.confidence).toBe("likely");
    expect(latency.evidence[0]!.detail).toContain("90%");
    // Even a strong suspect must carry a caveat.
    expect(latency.caveats.length).toBeGreaterThan(0);
  });

  it("marks a minor span as only a possible contributor", () => {
    const fp = "fp5";
    const traceId = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp, traceId })] })]]),
      },
      spans: {
        all: () => [
          span({ traceId, spanId: "r", name: "req", startTime: 0, durationMs: 100 }),
          span({ traceId, spanId: "s", parentSpanId: "r", name: "tiny", startTime: 1, durationMs: 5 }),
        ],
      },
    });

    const latency = new IncidentAnalyzer(source).analyze(fp)!.suspects.find((s) => s.kind === "latency")!;
    expect(latency.confidence).toBe("possible");
    expect(latency.caveats[0]).toMatch(/5%/);
  });

  it("quantifies trace reuse across occurrences", () => {
    const fp = "fp6";
    const shared = generateTraceId();
    const other = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([
          [
            fp,
            issue(fp, {
              count: 4,
              occurrences: [
                occurrence({ fingerprint: fp, traceId: shared }),
                occurrence({ fingerprint: fp, traceId: shared }),
                occurrence({ fingerprint: fp, traceId: shared }),
                occurrence({ fingerprint: fp, traceId: other }),
              ],
            }),
          ],
        ]),
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    expect(a.stats.distinctTraces).toBe(2);
    expect(a.stats.traceReusePct).toBe(75);

    const openTrace = a.suggestedActions.find((x) => x.id === "open-trace")!;
    expect(openTrace.rationale).toContain("75%");
  });

  it("rules out the current release when the issue predates it", () => {
    const fp = "fp7";
    const tl = new ReleaseTimeline();
    const now = Date.now();
    tl.record({ release: "1.8.3", version: "1.8.3", environment: "test", deployedAt: now - 86_400_000, pid: 1 });
    tl.record({ release: "1.8.4", version: "1.8.4", environment: "test", deployedAt: now - 60_000, pid: 1 });

    const source = stub({
      releases: tl,
      errors: {
        issues: new Map([
          [fp, issue(fp, { firstSeen: now - 43_200_000, occurrences: [occurrence({ fingerprint: fp, timestamp: now - 43_200_000 })] })],
        ]),
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    const suspect = a.suspects.find((s) => s.id === "not-current-release")!;

    expect(suspect).toBeDefined();
    expect(suspect.label).toContain("1.8.4");
    // A shared dependency can affect every release, so this is not proof.
    expect(suspect.caveats[0]).toMatch(/shared dependency/);
  });

  it("flags a slow query on a failing trace with an explicit caveat", () => {
    const fp = "fp8";
    const traceId = generateTraceId();
    const source = stub({
      errors: {
        issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp, traceId })] })]]),
      },
      slowQueries: {
        all: () => [
          { id: "q1", sql: "SELECT * FROM orders", durationMs: 840, timestamp: Date.now(), traceId },
        ],
      },
    });

    const suspect = new IncidentAnalyzer(source).analyze(fp)!.suspects.find((s) => s.id === "slow-query")!;
    expect(suspect.label).toContain("840ms");
    expect(suspect.caveats[0]).toMatch(/cannot show whether/);
  });

  it("warns that a single fingerprint across routes may be two bugs", () => {
    const fp = "fp9";
    const source = stub({
      errors: {
        issues: new Map([
          [fp, issue(fp, { routes: ["/a", "/b"], occurrences: [occurrence({ fingerprint: fp })] })],
        ]),
      },
    });

    const a = new IncidentAnalyzer(source).analyze(fp)!;
    expect(a.unknowns.join(" ")).toMatch(/2 routes/);
  });

  it("warns when too few occurrences are retained for a rate", () => {
    const fp = "fp10";
    const source = stub({
      errors: { issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp })] })]]) },
    });
    expect(new IncidentAnalyzer(source).analyze(fp)!.unknowns.join(" ")).toMatch(/Only 1 occurrence/);
  });

  it("always offers a route-scoped action", () => {
    const fp = "fp11";
    const source = stub({
      errors: { issues: new Map([[fp, issue(fp, { occurrences: [occurrence({ fingerprint: fp })] })]]) },
    });
    const a = new IncidentAnalyzer(source).analyze(fp)!;
    expect(a.suggestedActions.some((x) => x.id.startsWith("inspect-route"))).toBe(true);
  });
});

// ── integration with the real observer ──────────────────────────────────────

describe("Observer.analyzeIncident", () => {
  it("correlates a real captured error end to end", () => {
    const observer = new Observer({ service: "incident", release: "1.8.4" });
    observer.start();

    const fp = computeSmartFingerprint(new Error("payment failed"), []);
    const traceId = generateTraceId();

    observer.recordError({
      ...occurrence({ fingerprint: fp, traceId, route: "/api/checkout" }),
      fingerprint: fp,
    });

    const a = observer.analyzeIncident(fp)!;
    expect(a.fingerprint).toBe(fp);
    expect(a.stats.occurrences).toBe(1);
    expect(a.stats.routes).toEqual(["/api/checkout"]);
    expect(a.unknowns.length).toBeGreaterThan(0);

    observer.stop();
  });

  it("analyses every open issue and skips ignored ones", () => {
    const observer = new Observer({ service: "incident-all" });
    const a = observer.analyzeIncident("missing");
    expect(a).toBeNull();

    for (const name of ["one", "two"]) {
      const fp = computeSmartFingerprint(new Error(name), []);
      observer.recordError({ ...occurrence({ fingerprint: fp }), fingerprint: fp });
    }
    expect(observer.analyzeAllIncidents().length).toBe(2);

    const first = observer.analyzeAllIncidents()[0]!.fingerprint;
    observer.errors.applyAction(first, "ignore");
    expect(observer.analyzeAllIncidents().length).toBe(1);
  });

  it("records the running release when started", () => {
    const observer = new Observer({ service: "rel", release: "9.9.9" });
    observer.start();

    expect(observer.releases.latest()?.release).toBe("9.9.9");
    expect(observer.releases.latest()?.pid).toBe(process.pid);

    observer.stop();
  });
});
// ── release intelligence and what-changed ───────────────────────────────────

describe("ReleaseIntelligence", () => {
  const NOW = 1_000_000_000;
  const tx = (
    at: number,
    status: number,
    durationMs: number,
    route = "/api/checkout",
  ) => ({
    id: `t${at}-${status}-${durationMs}`,
    traceId: "tr",
    method: "POST",
    route,
    url: route,
    status,
    durationMs,
    timestamp: at,
    inFlight: false,
  });

  const world = (releases: [string, number][], transactions: any[], issues: any[] = []) => {
    const tl = new ReleaseTimeline();
    for (const [release, at] of releases) {
      tl.record({ release, version: release, environment: "test", deployedAt: at, pid: 1 });
    }
    return stub({
      releases: tl,
      transactions: { all: () => transactions },
      slowQueries: { all: () => [] },
      errors: {
        issues: new Map(issues.map((i) => [i.fingerprint, i])),
      },
    });
  };

  it("returns nothing rather than guessing when no release was recorded", () => {
    const ri = new ReleaseIntelligence(world([], [tx(NOW, 200, 10)]));
    expect(ri.health()).toEqual([]);
    expect(ri.whatChanged()).toBeNull();
  });

  it("groups traffic by the release that was live at the time", () => {
    const ri = new ReleaseIntelligence(
      world(
        [["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]],
        [
          tx(NOW - 90_000, 200, 100),
          tx(NOW - 80_000, 200, 200),
          tx(NOW - 5_000, 500, 900),
          tx(NOW - 4_000, 200, 120),
        ],
      ),
    );

    const [old, cur] = ri.health();
    expect(old!.requests).toBe(2);
    expect(old!.errorRatePct).toBe(0);
    expect(old!.p95Ms).toBeGreaterThan(0);
    expect(cur!.requests).toBe(2);
    expect(cur!.errors).toBe(1);
    expect(cur!.errorRatePct).toBe(50);
    expect(cur!.affectedRoutes).toEqual(["POST /api/checkout"]);
  });

  it("calls the first release unknown rather than healthy", () => {
    const ri = new ReleaseIntelligence(
      world([["1.0.0", NOW - 10_000]], [tx(NOW - 5_000, 500, 50)]),
    );
    // Nothing to compare against: "healthy" would be an assumption.
    expect(ri.health()[0]!.status).toBe("unknown");
  });

  it("stays unknown when either side is too thin to compare", () => {
    const ri = new ReleaseIntelligence(
      world(
        [["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]],
        [tx(NOW - 5_000, 500, 50)],
      ),
    );
    const rows = ri.health();
    expect(rows[0]!.status).toBe("unknown");
    expect(rows[1]!.status).toBe("unknown");
  });

  it("flags a regression when errors climb", () => {
    const before = Array.from({ length: 40 }, (_, i) => tx(NOW - 90_000 + i, 200, 100));
    const after = [
      ...Array.from({ length: 30 }, (_, i) => tx(NOW - 9_000 + i, 200, 100)),
      ...Array.from({ length: 10 }, (_, i) => tx(NOW - 8_000 + i, 500, 400)),
    ];
    const ri = new ReleaseIntelligence(
      world([["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]], [...before, ...after]),
    );
    expect(ri.health()[1]!.status).toBe("regressed");
  });

  it("reports no previous release on a first deploy, and says so", () => {
    const ri = new ReleaseIntelligence(
      world([["1.0.0", NOW - 10_000]], Array.from({ length: 30 }, (_, i) => tx(NOW - 5_000 + i, 200, 100))),
    );

    const wc = ri.whatChanged()!;
    expect(wc.previousRelease).toBeNull();
    expect(wc.deltas).toEqual([]);
    expect(wc.caveats.join(" ")).toMatch(/first recorded/);
  });

  it("produces a signed percentage for each changed metric", () => {
    const before = Array.from({ length: 40 }, (_, i) => tx(NOW - 90_000 + i, 200, 100));
    const after = Array.from({ length: 40 }, (_, i) => tx(NOW - 9_000 + i, 200, 400));
    const ri = new ReleaseIntelligence(
      world([["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]], [...before, ...after]),
    );

    const wc = ri.whatChanged()!;
    expect(wc.previousRelease).toBe("1.8.3");

    const p95 = wc.deltas.find((d) => d.metric === "p95Ms")!;
    expect(p95.before).toBeCloseTo(100, 0);
    expect(p95.after).toBeCloseTo(400, 0);
    expect(p95.changePct).toBeGreaterThan(0);
    expect(p95.worse).toBe(true);
    expect(wc.summary[0]).toContain("1.8.3 → 1.8.4");
  });

  it("reports a zero baseline as null rather than an infinite increase", () => {
    const ri = new ReleaseIntelligence(
      world(
        [["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]],
        [
          ...Array.from({ length: 30 }, (_, i) => tx(NOW - 90_000 + i, 200, 100)),
          ...Array.from({ length: 30 }, (_, i) => tx(NOW - 9_000 + i, 200, 100)),
        ],
      ),
    );
    // Nothing changed, so there should be no deltas at all rather than a 0->0 row.
    expect(ri.whatChanged()!.deltas).toEqual([]);
  });

  it("warns when the sample is too thin to quote percentages", () => {
    const ri = new ReleaseIntelligence(
      world(
        [["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]],
        [tx(NOW - 90_000, 200, 100), tx(NOW - 5_000, 200, 300)],
      ),
    );
    expect(ri.whatChanged()!.caveats.join(" ")).toMatch(/thin/);
  });

  it("separates new errors from ones that stopped occurring", () => {
    // "shared" started before the deploy and is still firing after it, which is
    // the case that must not be reported as fixed.
    const mk = (fp: string, firstSeen: number, lastSeen = firstSeen) =>
      issue(fp, {
        firstSeen,
        lastSeen,
        occurrences: [occurrence({ fingerprint: fp, timestamp: lastSeen })],
      });

    const ri = new ReleaseIntelligence(
      world(
        [["1.8.3", NOW - 100_000], ["1.8.4", NOW - 10_000]],
        Array.from({ length: 40 }, (_, i) => tx(NOW - 90_000 + i, 200, 100)),
        [
          mk("old-only", NOW - 90_000, NOW - 90_000),
          mk("shared", NOW - 90_000, NOW - 5_000),
          mk("brand-new", NOW - 5_000),
        ],
      ),
    );

    const wc = ri.whatChanged()!;
    expect(wc.newErrors).toEqual(["brand-new"]);
    expect(wc.fixedErrors).toEqual(["old-only"]);
    expect(wc.fixedErrors).not.toContain("shared");
    expect(wc.summary.join(" ")).toMatch(/1 new error fingerprint/);
  });
});

// ── time-series history (#6, #12) ──────────────────────────────────────────

describe("MetricsHistory", () => {
  it("retains samples and drops the oldest past its cap", () => {
    const h = new MetricsHistory(3);
    for (let i = 0; i < 5; i++) h.record(i * 1000, { rssMb: i });

    expect(h.size).toBe(3);
    expect(h.all().map((s) => s.at)).toEqual([2000, 3000, 4000]);
  });

  it("drops non-finite values rather than poisoning every statistic", () => {
    const h = new MetricsHistory();
    h.record(1000, { rssMb: 10, cpuPercent: NaN, p95: Infinity });

    const sample = h.all()[0]!;
    expect(sample.metrics.rssMb).toBe(10);
    // NaN in a series silently poisons mean, percentile and regression.
    expect("cpuPercent" in sample.metrics).toBe(false);
    expect("p95" in sample.metrics).toBe(false);
  });

  it("reads a time window and skips gaps instead of treating them as zero", () => {
    const h = new MetricsHistory();
    h.record(1000, { rssMb: 10 });
    h.record(2000, { cpuPercent: 5 });
    h.record(9000, { rssMb: 30 });

    expect(h.values("rssMb", 5000, 9000)).toEqual([30]);
    expect(h.values("rssMb", 20_000, 9000)).toEqual([10, 30]);
  });
});

describe("BaselineEngine", () => {
  const seed = (h: MetricsHistory, values: number[], stepMs = 1000, start = 0) => {
    values.forEach((v, i) => h.record(start + i * stepMs, { dbLatencyMs: v }));
  };

  it("refuses to call anything anomalous before it has enough history", () => {
    const h = new MetricsHistory();
    seed(h, [10, 10, 11, 10]);

    const v = new BaselineEngine(h).evaluate("dbLatencyMs", 5000, 120_000, 40_000);
    // Four samples: almost any value is "anomalous" depending which four were
    // kept, so the honest answer is that we do not know yet.
    expect(v.anomalous).toBe(false);
    expect(v.confidence).toBe("unknown");
    expect(v.caveats[0]).toMatch(/needs 20/);
  });

  it("flags a genuine outlier once the baseline is established", () => {
    const h = new MetricsHistory();
    // Realistic jitter: a constant series has MAD 0, and the engine declines to
    // score against a noise scale it has never actually observed.
    seed(h, Array.from({ length: 60 }, (_, i) => 20 + (i % 5) - 2));

    const v = new BaselineEngine(h).evaluate("dbLatencyMs", 180, 120_000, 60_000);
    expect(v.anomalous).toBe(true);
    expect(v.confidence).toBe("likely");
    expect(v.ratio).toBe(9);
    expect(Math.abs(v.z!)).toBeGreaterThan(3);
  });

  it("does not flag ordinary variation", () => {
    const h = new MetricsHistory();
    seed(h, Array.from({ length: 60 }, (_, i) => 20 + (i % 3)));

    const v = new BaselineEngine(h).evaluate("dbLatencyMs", 22, 120_000, 60_000);
    expect(v.anomalous).toBe(false);
  });

  it("is not dragged upward by a single spike, unlike a mean", () => {
    const h = new MetricsHistory();
    // One 10,000ms stall in sixty samples.
    seed(h, Array.from({ length: 60 }, (_, i) => (i === 30 ? 10_000 : 20)));

    const base = new BaselineEngine(h).baseline("dbLatencyMs", 120_000, 60_000);
    expect(base.median).toBe(20);
    expect(mean([...Array.from({ length: 59 }, () => 20), 10_000])).toBeGreaterThan(180);
  });

  it("declines to score a metric with zero variance instead of dividing by zero", () => {
    const h = new MetricsHistory();
    seed(h, Array.from({ length: 40 }, () => 7));

    const v = new BaselineEngine(h).evaluate("dbLatencyMs", 9, 120_000, 40_000);
    expect(v.z).toBeNull();
    expect(v.anomalous).toBe(false);
    expect(v.caveats.join(" ")).toMatch(/near-zero variance/);
  });

  it("reports a null ratio for a zero baseline rather than infinity", () => {
    const h = new MetricsHistory();
    seed(h, Array.from({ length: 40 }, () => 0));

    expect(new BaselineEngine(h).evaluate("dbLatencyMs", 5, 120_000, 40_000).ratio).toBeNull();
  });

  it("orders anomalous metrics first", () => {
    const h = new MetricsHistory();
    for (let i = 0; i < 60; i++) {
      h.record(i * 1000, {
        cpuPercent: 20 + (i % 3),
        queueDepth: 3 + (i % 2),
      });
    }

    const all = new BaselineEngine(h).evaluateAll(
      { cpuPercent: 21, queueDepth: 900 },
      120_000,
      60_000,
    );
    expect(all[0]!.metric).toBe("queueDepth");
  });
});

describe("adaptiveThreshold", () => {
  it("returns null while the baseline is immature", () => {
    const observer = new Observer({ service: "thr" });
    expect(observer.adaptiveThreshold("dbLatencyMs")).toBeNull();
  });

  it("never sits below the metric's own p95", () => {
    const observer = new Observer({ service: "thr2" });
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      observer.history.record(t0 + i * 1000, { flat: 10 });
    }

    const threshold = observer.adaptiveThreshold("flat")!;
    // A perfectly flat metric has MAD 0, so median + 3*MAD would fall *below*
    // the normal value and flag every ordinary reading.
    expect(threshold).toBeGreaterThanOrEqual(10);
  });
});

describe("slowQueryMode", () => {
  it("fixed mode applies the absolute budget", () => {
    const observer = new Observer({ service: "sq-fixed", slowQueryThresholdMs: 50 });
    observer.recordSlowQuery({ id: "a", sql: "SELECT 1", durationMs: 60, timestamp: Date.now(), table: "users" });
    observer.recordSlowQuery({ id: "b", sql: "SELECT 2", durationMs: 10, timestamp: Date.now(), table: "users" });

    expect(observer.slowQueries.all()).toHaveLength(1);
  });

  it("adaptive mode uses a per-query baseline and ignores a fast budget", () => {
    const observer = new Observer({
      service: "sq-adaptive",
      slowQueryThresholdMs: 2, // multiplier
      slowQueryMode: "adaptive",
    });

    // Baseline: this table normally takes ~300ms.
    for (let i = 0; i < 60; i++) {
      observer.recordSlowQuery({
        id: `w${i}`, sql: "SELECT 1", durationMs: 300, timestamp: Date.now(), table: "orders",
      });
    }
    expect(observer.slowQueries.all()).toHaveLength(0);

    // 900ms is slow for `orders`; under a flat 50ms budget it is 18x over.
    observer.recordSlowQuery({ id: "slow", sql: "SELECT 1", durationMs: 900, timestamp: Date.now(), table: "orders" });
    expect(observer.slowQueries.all()).toHaveLength(1);
  });

  it("flags a slow query on a normally-fast table", () => {
    const observer = new Observer({
      service: "sq-adaptive2",
      slowQueryThresholdMs: 3,
      slowQueryMode: "adaptive",
    });
    for (let i = 0; i < 60; i++) {
      observer.recordSlowQuery({ id: `f${i}`, sql: "SELECT 1", durationMs: 8, timestamp: Date.now(), table: "flags" });
    }
    observer.recordSlowQuery({ id: "spike", sql: "SELECT 1", durationMs: 200, timestamp: Date.now(), table: "flags" });

    expect(observer.slowQueries.all()).toHaveLength(1);
  });

  it("leaves queries unclassified while the baseline warms up", () => {
    const observer = new Observer({
      service: "sq-cold",
      slowQueryThresholdMs: 40,
      slowQueryMode: "adaptive",
    });
    observer.recordSlowQuery({ id: "c1", sql: "SELECT 1", durationMs: 80, timestamp: Date.now(), table: "cold" });

    // 40 is a multiplier in adaptive mode, not a 40ms budget. Treating it as one
    // flagged essentially everything during warm-up, so nothing is claimed
    // until there is a real reference to compare against.
    expect(observer.slowQueries.all()).toHaveLength(0);
    // The duration is still retained, which is what makes the baseline possible.
    expect(observer.history.values("slowQuery:cold", 900_000).length).toBe(1);
  });

  it("keeps absolute-budget behaviour in fixed mode during warm-up", () => {
    const observer = new Observer({ service: "sq-cold-fixed", slowQueryThresholdMs: 40 });
    observer.recordSlowQuery({ id: "c1", sql: "SELECT 1", durationMs: 80, timestamp: Date.now(), table: "cold" });
    expect(observer.slowQueries.all()).toHaveLength(1);
  });

  it("rejects an unknown mode", () => {
    expect(() => new Observer({ service: "bad", slowQueryMode: "clever" } as never)).toThrow(
      /slowQueryMode|slow/,
    );
  });
});

describe("linearTrend", () => {
  it("recovers a known slope", () => {
    const points = Array.from({ length: 60 }, (_, i) => ({
      at: i * 60_000,
      value: 100 + i * 2,
    }));
    const { slopePerMs, rSquared } = linearTrend(points);
    expect(slopePerMs * 3_600_000).toBeCloseTo(120, 0);
    expect(rSquared).toBeCloseTo(1, 2);
  });

  it("returns no slope for fewer than two points", () => {
    expect(linearTrend([{ at: 0, value: 1 }]).slopePerMs).toBe(0);
    expect(linearTrend([]).slopePerMs).toBe(0);
  });
});

describe("memoryTrend", () => {
  it("refuses to claim growth on a short window", () => {
    const observer = new Observer({ service: "mem1" });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) observer.history.record(t0 + i * 1000, { rssMb: 400 + i });

    const t = observer.memoryTrend("rssMb");
    expect(t.verdict).toBe("insufficient-data");
    expect(t.caveats[0]).toMatch(/needs 30/);
  });

  it("reports steady growth with its fit quality", () => {
    const observer = new Observer({ service: "mem2" });
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) {
      observer.history.record(t0 + i * 5000, { rssMb: 400 + i * 0.5 });
    }

    const t = observer.memoryTrend("rssMb");
    expect(t.verdict).toBe("growing");
    expect(t.growthMbPerHour).toBeGreaterThan(0);
    expect(t.rSquared).toBeGreaterThan(0.9);
    // Growth is consistent with a leak, never proof of one.
    expect(t.caveats.join(" ")).toMatch(/does not prove/);
  });

  it("calls a noisy flat series stable rather than a leak", () => {
    const observer = new Observer({ service: "mem3" });
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) {
      observer.history.record(t0 + i * 5000, { rssMb: 400 + ((i * 7919) % 37) });
    }

    const t = observer.memoryTrend("rssMb");
    expect(t.verdict).toBe("stable");
    expect(t.caveats.join(" ")).toMatch(/weak|noise/);
  });

  it("reports a flat series as stable with a clean fit", () => {
    const observer = new Observer({ service: "mem4" });
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) observer.history.record(t0 + i * 5000, { rssMb: 400 });

    expect(observer.memoryTrend("rssMb").verdict).toBe("stable");
  });
});

// ── service map (#4) ────────────────────────────────────────────────────────

describe("ServiceMapBuilder", () => {
  const clientSpan = (over: {
    traceId: string; spanId: string; parentSpanId?: string; name: string;
    startTime: number; durationMs: number; status?: "unset" | "ok" | "error";
    attrs?: Record<string, { string: string }>;
  }) => ({
    traceId: over.traceId, spanId: over.spanId, parentSpanId: over.parentSpanId,
    name: over.name, kind: over.name.startsWith("db.") ? "client" : "internal",
    startTime: over.startTime, endTime: over.startTime + over.durationMs,
    durationMs: over.durationMs, status: over.status ?? "ok",
    attributes: over.attrs ?? {}, events: [],
  }) as unknown as import("../types/observe").Span;

  it("returns an honest empty graph with no spans", () => {
    const map = new ServiceMapBuilder(stub({})).build();
    expect(map.nodes).toEqual([]);
    expect(map.limitations.length).toBeGreaterThan(0);
  });

  it("draws an edge from a server span to the database it queried", () => {
    const traceId = generateTraceId();
    const map = new ServiceMapBuilder(
      stub({
        spans: {
          all: () => [
            clientSpan({ traceId, spanId: "r", name: "POST /api/checkout", startTime: 0, durationMs: 100 }),
            clientSpan({ traceId, spanId: "q", parentSpanId: "r", name: "db.query", startTime: 5, durationMs: 40, attrs: { "db.statement": { string: "SELECT ?" } } }),
          ],
        },
      }),
    ).build();

    expect(map.nodes.map((n) => n.id).sort()).toEqual(["api", "database"]);
    const edge = map.edges.find((e) => e.from === "api" && e.to === "database")!;
    expect(edge.spans).toBe(1);
  });

  it("never draws self-edges, which would bury the graph", () => {
    const traceId = generateTraceId();
    const map = new ServiceMapBuilder(
      stub({
        spans: {
          all: () => [
            clientSpan({ traceId, spanId: "r", name: "req", startTime: 0, durationMs: 100 }),
            clientSpan({ traceId, spanId: "a", parentSpanId: "r", name: "req.child", startTime: 1, durationMs: 10 }),
          ],
        },
      }),
    ).build();

    expect(map.edges.filter((e) => e.from === e.to)).toHaveLength(0);
  });

  it("treats an orphan span as a root rather than dropping it", () => {
    const traceId = generateTraceId();
    const map = new ServiceMapBuilder(
      stub({ spans: { all: () => [clientSpan({ traceId, spanId: "x", name: "orphan", startTime: 0, durationMs: 5 })] } }),
    ).build();
    expect(map.nodes.length).toBeGreaterThan(0);
  });

  it("flags its own limits instead of implying full coverage", () => {
    const traceId = generateTraceId();
    const map = new ServiceMapBuilder(
      stub({ spans: { all: () => [clientSpan({ traceId, spanId: "r", name: "req", startTime: 0, durationMs: 5 })] } }),
    ).build();

    const text = map.limitations.join(" ");
    expect(text).toMatch(/inferred from span names/);
    expect(text).toMatch(/[Nn]o outbound HTTP client spans were recorded/);
  });
});

// ── N+1 detection (#13) ─────────────────────────────────────────────────────

describe("NPlusOneDetector", () => {
  const q = (over: {
    traceId: string; spanId: string; parentSpanId: string; durationMs: number; sql: string;
  }) => ({
    traceId: over.traceId, spanId: over.spanId, parentSpanId: over.parentSpanId,
    name: "db.query", kind: "client", startTime: 0, endTime: over.durationMs,
    durationMs: over.durationMs, status: "ok",
    attributes: { "db.statement": { string: over.sql } }, events: [],
  }) as unknown as import("../types/observe").Span;

  const parent = (traceId: string, spanId: string) => ({
    traceId, spanId, name: "GET /users", kind: "server", startTime: 0,
    endTime: 500, durationMs: 500, status: "ok", attributes: {}, events: [],
  }) as unknown as import("../types/observe").Span;

  it("finds a repeated identical query under one parent", () => {
    const traceId = generateTraceId();
    const spans = [parent(traceId, "r")];
    for (let i = 0; i < 20; i++) {
      spans.push(q({ traceId, spanId: `q${i}`, parentSpanId: "r", durationMs: 20, sql: "SELECT * FROM orders WHERE id = ?" }));
    }

    const found = new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect();
    expect(found).toHaveLength(1);
    expect(found[0]!.calls).toBe(20);
    expect(found[0]!.eachMs).toBe(20);
    // 19 avoidable repetitions; the first call is necessary.
    expect(found[0]!.avoidableMs).toBe(380);
    expect(found[0]!.severity).toBe("medium");
  });

  it("ignores repetition spread across separate parents", () => {
    const traceId = generateTraceId();
    const spans: import("../types/observe").Span[] = [];
    for (let r = 0; r < 20; r++) {
      spans.push(parent(traceId, `r${r}`));
      spans.push(q({ traceId, spanId: `q${r}`, parentSpanId: `r${r}`, durationMs: 5, sql: "SELECT ?" }));
    }

    // The same statement once per request is traffic, not an N+1.
    expect(new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect()).toEqual([]);
  });

  it("distinguishes different query shapes under one parent", () => {
    const traceId = generateTraceId();
    const spans = [parent(traceId, "r")];
    for (let i = 0; i < 6; i++) {
      spans.push(q({ traceId, spanId: `a${i}`, parentSpanId: "r", durationMs: 5, sql: "SELECT * FROM a WHERE id = ?" }));
      spans.push(q({ traceId, spanId: `b${i}`, parentSpanId: "r", durationMs: 5, sql: "SELECT * FROM b WHERE id = ?" }));
    }

    const found = new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect();
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.calls === 6)).toBe(true);
  });

  it("stays quiet below the repetition floor", () => {
    const traceId = generateTraceId();
    const spans = [parent(traceId, "r")];
    for (let i = 0; i < 3; i++) {
      spans.push(q({ traceId, spanId: `q${i}`, parentSpanId: "r", durationMs: 5, sql: "SELECT ?" }));
    }

    expect(new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect()).toEqual([]);
    expect(new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect(2)).toHaveLength(1);
  });

  it("always carries a caveat rather than asserting a loop", () => {
    const traceId = generateTraceId();
    const spans = [parent(traceId, "r")];
    for (let i = 0; i < 8; i++) {
      spans.push(q({ traceId, spanId: `q${i}`, parentSpanId: "r", durationMs: 10, sql: "SELECT ?" }));
    }

    const found = new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect();
    expect(found[0]!.caveats.join(" ")).toMatch(/does not prove a loop/);
  });

  it("escalates severity with avoidable cost", () => {
    const traceId = generateTraceId();
    const build = (each: number) => {
      const spans = [parent(traceId, "r")];
      for (let i = 0; i < 12; i++) {
        spans.push(q({ traceId, spanId: `q${i}`, parentSpanId: "r", durationMs: each, sql: "SELECT ?" }));
      }
      return new NPlusOneDetector(stub({ spans: { all: () => spans } })).detect()[0]!;
    };
    expect(build(1).severity).toBe("low");
    expect(build(100).severity).toBe("high");
  });
});

describe("normalizeSqlForShape", () => {
  it("collapses literals so structurally identical statements compare equal", () => {
    const a = normalizeSqlForShape("SELECT * FROM t WHERE id = 42 AND name = 'bob'");
    const b = normalizeSqlForShape("SELECT * FROM t WHERE id = 7 AND name = 'alice'");
    expect(a).toBe(b);
  });

  it("keeps genuinely different statements apart", () => {
    expect(normalizeSqlForShape("SELECT a FROM t")).not.toBe(normalizeSqlForShape("SELECT b FROM t"));
  });
});

// ── SLO (#7) ────────────────────────────────────────────────────────────────

describe("SloEngine", () => {
  const NOW = 10_000_000;
  const tx = (status: number, at: number, route = "/checkout", method = "POST") => ({
    id: `${status}-${at}`, traceId: "t", method, route, url: route,
    status, durationMs: 10, timestamp: at, inFlight: false,
  });

  const engine = (transactions: any[]) =>
    new SloEngine(stub({ transactions: { all: () => transactions } }));

  it("reports no-data rather than a flattering 100% with no traffic", () => {
    const r = engine([]).evaluate({ name: "Checkout", target: 99.9, windowMs: 86_400_000 }, NOW);
    expect(r.status).toBe("no-data");
    expect(r.achieved).toBeNull();
    expect(r.errorBudgetRemaining).toBeNull();
  });

  it("measures availability from 5xx only", () => {
    const txs = [
      ...Array.from({ length: 95 }, (_, i) => tx(200, NOW - 86_000_000 + i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => tx(500, NOW - 86_000_000 + i * 1000)),
      // A 404 is a served answer, not an outage.
      ...Array.from({ length: 20 }, (_, i) => tx(404, NOW - 86_000_000 + i * 1000)),
    ];
    const r = engine(txs).evaluate({ name: "Checkout", target: 99.9, windowMs: 86_400_000 }, NOW);
    expect(r.achieved).toBe(95.833);
    expect(r.status).toBe("breached");
  });

  it("computes remaining budget as a share of the allowance", () => {
    const txs = Array.from({ length: 100 }, (_, i) =>
      tx(i < 99 ? 200 : 500, NOW - 86_000_000 + i * 800_000),
    );
    const r = engine(txs).evaluate({ name: "Checkout", target: 99, windowMs: 86_400_000 }, NOW);
    expect(r.achieved).toBe(99);
    // 99% target leaves 1% budget; 1% was consumed, so nothing remains.
    expect(r.errorBudgetRemaining).toBe(0);
  });

  it("filters by route and method", () => {
    const txs = [
      ...Array.from({ length: 30 }, (_, i) => tx(200, NOW - 1000 + i, "/checkout", "POST")),
      ...Array.from({ length: 30 }, (_, i) => tx(500, NOW - 1000 + i, "/other", "GET")),
    ];
    const r = engine(txs).evaluate(
      { name: "Checkout", target: 99.9, windowMs: 86_400_000, query: { route: "/checkout", method: "POST" } },
      NOW,
    );
    expect(r.requests).toBe(30);
    expect(r.status).not.toBe("breached");
  });

  it("warns that a partial window skews burn rate", () => {
    const txs = Array.from({ length: 30 }, (_, i) => tx(200, NOW - i * 1000));
    const r = engine(txs).evaluate({ name: "Checkout", target: 99.9, windowMs: 86_400_000 }, NOW);
    expect(r.caveats.join(" ")).toMatch(/partial window/);
  });

  it("always states that retained traffic undercounts", () => {
    const txs = Array.from({ length: 30 }, (_, i) => tx(200, NOW - i * 1000));
    const r = engine(txs).evaluate({ name: "Checkout", target: 99.9, windowMs: 86_400_000 }, NOW);
    expect(r.caveats.join(" ")).toMatch(/undercount/);
  });
});

describe("SLO configuration", () => {
  it("evaluates configured objectives", () => {
    const observer = new Observer({
      service: "slo",
      slos: [{ name: "Availability", target: 99.9, windowMs: 86_400_000 }],
    });
    const results = observer.evaluateSlos();
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Availability");
  });

  it("is empty when none are configured", () => {
    expect(new Observer({ service: "slo-none" }).evaluateSlos()).toEqual([]);
  });

  it("rejects a malformed objective at construction", () => {
    expect(() => new Observer({ service: "bad", slos: [{ name: "", target: 99, windowMs: 1000 }] })).toThrow(/name/);
    expect(() => new Observer({ service: "bad", slos: [{ name: "x", target: 900, windowMs: 1000 }] })).toThrow(/target/);
    expect(() => new Observer({ service: "bad", slos: [{ name: "x", target: 99, windowMs: 0 }] })).toThrow(/windowMs/);
  });
});

// ── job intelligence (#14) ──────────────────────────────────────────────────

describe("JobIntelligence", () => {
  const source = (snapshot: Record<string, number> | undefined, history = new MetricsHistory()) =>
    stub({ history, jobSnapshot: snapshot ? () => snapshot : undefined });

  it("says so plainly when jobs are not attached", () => {
    const h = new JobIntelligence(source(undefined)).health();
    expect(h.backlog).toBe("unknown");
    expect(h.caveats.join(" ")).toMatch(/not attached/);
  });

  it("derives success rate from terminal outcomes", () => {
    const h = new JobIntelligence(source({ total: 200, queued: 5, completed: 90, failed: 8, dead: 2 })).health();
    expect(h.successRate).toBe(90);
  });

  it("claims no success rate before any job finishes", () => {
    const h = new JobIntelligence(source({ total: 4, queued: 4 })).health();
    expect(h.successRate).toBeNull();
    expect(h.caveats.join(" ")).toMatch(/No job has reached a terminal state/);
  });

  it("flags dead-lettered jobs as needing attention", () => {
    const h = new JobIntelligence(source({ total: 10, completed: 9, dead: 1 })).health();
    expect(h.caveats.join(" ")).toMatch(/dead-lettered/);
  });

  it("reports an unknown backlog until there is enough history", () => {
    const h = new JobIntelligence(source({ total: 10, queued: 5 })).health();
    expect(h.backlog).toBe("unknown");
    expect(h.caveats.join(" ")).toMatch(/needs 20/);
  });

  it("detects a growing and then draining backlog", () => {
    const t0 = Date.now();
    const rising = new MetricsHistory();
    for (let i = 0; i < 30; i++) rising.record(t0 + i * 1000, { queueDepth: 10 + i });
    expect(new JobIntelligence(source({ total: 100, queued: 60 }, rising)).health().backlog).toBe("increasing");

    const falling = new MetricsHistory();
    for (let i = 0; i < 30; i++) falling.record(t0 + i * 1000, { queueDepth: 100 - i });
    expect(new JobIntelligence(source({ total: 100, queued: 5 }, falling)).health().backlog).toBe("draining");
  });

  it("calls a small drift against a large queue stable", () => {
    const t0 = Date.now();
    const hist = new MetricsHistory();
    for (let i = 0; i < 30; i++) hist.record(t0 + i * 1000, { queueDepth: 10_000 + i });

    // +1/s at 10k queued is noise, not an incident.
    expect(new JobIntelligence(source({ total: 20_000, queued: 10_000 }, hist)).health().backlog).toBe("stable");
  });
});

// ── safe actions (#8) ───────────────────────────────────────────────────────

describe("SafeActions", () => {
  const actions = () => new SafeActions(stub({}));

  it("returns null for an unknown action rather than guessing", () => {
    expect(actions().preview({ kind: "rm-rf" })).toBeNull();
  });

  it("describes an action without performing it", async () => {
    let ran = false;
    const preview = actions().preview({ kind: "clear-cache" });
    await actions().execute({ kind: "clear-cache", idempotencyKey: "pv" }, () => { ran = true; }, { confirmed: true });

    expect(preview?.risk).toBe("destructive");
    expect(ran).toBe(true);
  });

  it("runs a read-only action without demanding confirmation", async () => {
    let ran = false;
    const outcome = await actions().execute(
      { kind: "open-trace", payload: { traceId: "abc123def456" } },
      () => { ran = true; return "trace"; },
    );

    // Reading a trace cannot change anything, so gating it behind a prompt
    // would just train operators to confirm without reading.
    expect(ran).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it("refuses a state-changing action without an idempotency key", async () => {
    let ran = false;
    const outcome = await actions().execute(
      { kind: "clear-cache" },
      () => { ran = true; },
      { confirmed: true },
    );

    expect(ran).toBe(false);
    expect(outcome.error).toMatch(/idempotency key/);
  });

  it("runs a confirmed, keyed action once and deduplicates a retry", async () => {
    let calls = 0;
    const exec = () => { calls++; return { purged: 3 }; };
    // One instance: the ledger is per-action-registry, as it is on the observer.
    const shared = actions();

    const first = await shared.execute(
      { kind: "purge-dead-jobs", idempotencyKey: "k1" }, exec, { confirmed: true },
    );
    // A double-clicked button sends the same key again.
    const retry = await shared.execute(
      { kind: "purge-dead-jobs", idempotencyKey: "k1" }, exec, { confirmed: true },
    );

    expect(calls).toBe(1);
    expect(first.ok).toBe(true);
    expect(retry.deduplicated).toBe(true);
  });

  it("requires confirmation before anything that changes state", async () => {
    const outcome = await actions().execute(
      { kind: "replay-dead-job", idempotencyKey: "k2" }, () => "done",
    );
    expect(outcome.error).toMatch(/Confirmation required/);
  });

  it("states the consequence of a destructive action", () => {
    const preview = actions().preview({ kind: "purge-dead-jobs" })!;
    expect(preview.risk).toBe("destructive");
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.reason).toMatch(/cannot be replayed/);
  });

  it("blocks an action for an unknown fingerprint", () => {
    const preview = actions().preview({ kind: "resolve-issue", payload: { fingerprint: "nope" } })!;
    expect(preview.blocked).toMatch(/No such fingerprint/);
  });

  it("reports an executor failure instead of throwing", async () => {
    const outcome = await actions().execute(
      { kind: "clear-cache", idempotencyKey: "k3" },
      () => { throw new Error("cache unavailable"); },
      { confirmed: true },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("cache unavailable");
  });

  it("audits blocked attempts too", async () => {
    const outcome = await await actions().execute({ kind: "clear-cache" }, () => "x", { confirmed: true });
    // "Someone tried to clear the cache at 3am" is itself the record worth keeping.
    expect(outcome.audit.action).toMatch(/missing-idempotency-key/);
  });
});

describe("Observer.performAction", () => {
  it("deduplicates a retried destructive action across separate calls", async () => {
    const observer = new Observer({ service: "idem" });
    let calls = 0;
    const exec = () => { calls++; return "purged"; };
    const req = { kind: "purge-dead-jobs", idempotencyKey: "double-click" };

    await observer.performAction(req, exec, { confirmed: true });
    const retry = await observer.performAction(req, exec, { confirmed: true });

    // Two HTTP requests carrying the same key must perform one action.
    expect(calls).toBe(1);
    expect(retry.deduplicated).toBe(true);
  });

  it("writes an audit entry for the action", async () => {
    const observer = new Observer({ service: "audit" });
    await observer.performAction(
      { kind: "open-trace", payload: { traceId: "abc" } },
      () => "ok",
      { confirmed: true, actor: "tester" },
    );

    const entry = observer.auditLogs.all().find((a) => a.action.startsWith("action:"))!;
    expect(entry).toBeDefined();
    expect(entry.actor).toBe("tester");
  });
});

// ── incident report for AI consumption (#5) ────────────────────────────────

describe("incidentReport", () => {
  it("returns null for an unknown fingerprint", () => {
    expect(new Observer({ service: "rep" }).incidentReport("nope")).toBeNull();
  });

  it("carries evidence and caveats together on every claim", () => {
    const observer = new Observer({ service: "rep2", release: "2.0.0" });
    const traceId = generateTraceId();
    const fp = computeSmartFingerprint(new Error("db timeout"), []);
    observer.start();
    observer.recordError({
      ...occurrence({ fingerprint: fp, traceId, route: "/api/orders" }),
      fingerprint: fp,
    });

    const report = observer.incidentReport(fp)!;

    expect(report.schemaVersion).toBe(1);
    expect(report.service.release).toBe("2.0.0");
    expect(report.summary.affectedRoutes).toEqual(["/api/orders"]);
    expect(report.knownUnknowns.length).toBeGreaterThan(0);
    expect(report.collectionGaps.length).toBeGreaterThan(0);

    // A reader must not be able to see a conclusion without its weaknesses.
    for (const cause of report.likelyCauses) {
      expect(cause.reasonsItCouldBeWrong.length).toBeGreaterThan(0);
      expect(cause.confidence).toMatch(/likely|possible|unknown/);
    }
    observer.stop();
  });

  it("states what the collector cannot see", () => {
    const observer = new Observer({ service: "rep3" });
    const fp = computeSmartFingerprint(new Error("x"), []);
    observer.recordError({ ...occurrence({ fingerprint: fp }), fingerprint: fp });

    const gaps = observer.incidentReport(fp)!.collectionGaps.join(" ");
    expect(gaps).toMatch(/since this process started/);
  });

  it("never omits unknowns or caveats, even when nothing specific is missing", () => {
    const observer = new Observer({ service: "rep5" });
    const traceId = generateTraceId();
    const fp = computeSmartFingerprint(new Error("plain"), []);
    observer.start();
    observer.recordError({
      ...occurrence({ fingerprint: fp, traceId }),
      fingerprint: fp,
    });

    const report = observer.incidentReport(fp)!;
    expect(report.knownUnknowns.length).toBeGreaterThan(0);
    observer.stop();
  });

  it("is JSON-serialisable, so it can cross a process boundary", () => {
    const observer = new Observer({ service: "rep4" });
    const fp = computeSmartFingerprint(new Error("y"), []);
    observer.recordError({ ...occurrence({ fingerprint: fp }), fingerprint: fp });

    expect(() => JSON.parse(JSON.stringify(observer.incidentReport(fp)))).not.toThrow();
  });
});

// ── golden traces (#11) ─────────────────────────────────────────────────────

describe("GoldenTraceStore", () => {
  const traceSpans = (
    traceId: string,
    timings: Array<[string, string | undefined, number]>,
  ): import("../types/observe").Span[] => {
    // Distinct, increasing start times: buildSpanTree orders by start time, and
    // identical timestamps made the ordering arbitrary.
    let cursor = 0;
    return timings.map(([spanId, parentSpanId, durationMs]) => {
      const node = {
        traceId,
        spanId,
        parentSpanId,
        name: spanId,
        kind: parentSpanId === undefined ? "server" : "internal",
        startTime: cursor,
        endTime: cursor + durationMs,
        durationMs,
        status: "ok",
        attributes: {},
        events: [],
      } as unknown as import("../types/observe").Span;
      cursor += durationMs;
      return node;
    });
  };

  const golden = (over: Partial<import("../types/observe_analysis").GoldenTrace> = {}) => ({
    name: "Cart",
    traceId: "golden-trace",
    savedAt: 0,
    steps: ["root", "db", "pay", "cache"],
    stepTimings: [
      { name: "root", ms: 300 },
      { name: "db", ms: 40 },
      { name: "pay", ms: 100 },
      { name: "cache", ms: 5 },
    ],
    totalMs: 300,
    ...over,
  });

  it("replaces a baseline of the same name instead of piling up duplicates", () => {
    const store = new GoldenTraceStore();
    store.save(golden({ totalMs: 300 }));
    store.save(golden({ totalMs: 400 }));

    expect(store.all()).toHaveLength(1);
    expect(store.find("Cart")!.totalMs).toBe(400);
  });

  it("reports a new step as a structural difference", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden());
    const live = traceSpans("golden-trace", [["root", undefined, 400], ["db", "root", 40], ["pay", "root", 200], ["cache", "root", 5], ["newStep", "root", 30]]);

    const cmp = store.compare(g, live)!;
    expect(cmp.verdict).toBe("different-shape");
    expect(cmp.differences.some((d) => d.kind === "extra" && d.step === "newStep")).toBe(true);
  });

  it("reports a step that vanished", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden());
    const live = traceSpans("golden-trace", [["root", undefined, 200], ["db", "root", 40], ["pay", "root", 100]]);

    const cmp = store.compare(g, live)!;
    const missing = cmp.differences.find((d) => d.kind === "missing")!;
    expect(missing.step).toBe("cache");
    // A removed step can be an improvement, so the note must not assume a bug.
    expect(missing.note).toMatch(/improvement or a removed step/);
  });

  it("flags a step that became dramatically slower", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden());
    const live = traceSpans("golden-trace", [["root", undefined, 2000], ["db", "root", 40], ["pay", "root", 1500], ["cache", "root", 5]]);

    const cmp = store.compare(g, live)!;
    expect(cmp.verdict).toBe("slower");

    // Both the root and the payment step blew past 2x; differences are ordered
    // by absolute delta, so the largest leads.
    const slower = cmp.differences.filter((d) => d.kind === "slower");
    expect(slower.map((d) => d.step).sort()).toEqual(["pay", "root"]);
    expect(slower.find((d) => d.step === "pay")!.ratio).toBeGreaterThan(2);
  });

  it("ignores ordinary drift below the threshold", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden());
    const live = traceSpans("golden-trace", [["root", undefined, 320], ["db", "root", 41], ["pay", "root", 105], ["cache", "root", 5]]);

    const cmp = store.compare(g, live)!;
    expect(cmp.verdict).toBe("same-shape");
    expect(cmp.caveats.join(" ")).toMatch(/No step deviated/);
  });

  it("compares shape only when the baseline recorded no timings", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden({ steps: ["root", "db", "pay", "cache"], stepTimings: [], totalMs: 0 }));
    const live = traceSpans("golden-trace", [["root", undefined, 5000], ["db", "root", 40], ["pay", "root", 100], ["cache", "root", 5]]);

    const cmp = store.compare(g, live)!;
    // No timings means no slowdown can be detected, and saying so beats a
    // confident "no difference".
    expect(cmp.verdict).toBe("same-shape");
    expect(cmp.caveats.join(" ")).toMatch(/only the call shape/);
  });

  it("refuses to compare against a baseline with too little shape", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden({ steps: ["root"], stepTimings: [{ name: "root", ms: 100 }], totalMs: 100 }));
    const live = traceSpans("golden-trace", [["root", undefined, 100], ["db", "root", 40]]);

    expect(store.compare(g, live)!.verdict).toBe("unknown");
  });

  it("returns null when the trace has no recorded spans", () => {
    const store = new GoldenTraceStore();
    const g = store.save(golden());
    expect(store.compare(g, [])).toBeNull();
  });
});

describe("Observer.saveGoldenTrace", () => {
  it("captures the span shape and route of a live trace", () => {
    const observer = new Observer({ service: "golden" });
    const traceId = generateTraceId();
    const span = new (require("../types/observe").Span)({
      traceId, spanId: "a", name: "GET /cart", kind: "server", startTime: Date.now(),
    });
    span.setAttribute("http.route", "/cart");
    span.end();
    observer.recordSpan(span);

    const saved = observer.saveGoldenTrace("Cart", traceId)!;
    expect(saved.steps).toEqual(["GET /cart"]);
    expect(saved.route).toBe("/cart");
  });

  it("returns null for an unknown trace", () => {
    expect(new Observer({ service: "golden2" }).saveGoldenTrace("x", "nope")).toBeNull();
  });
});

// ── trace-to-code (#10) ─────────────────────────────────────────────────────

describe("FileSystemTraceToCode", () => {
  const FILES: Record<string, string> = {
    "/app/src/checkout.ts": ["const a = 1;", "const b = 2;", "customer.id;", "const c = 3;", "const d = 4;", "const e = 5;"].join("\n"),
  };
  const resolver = (root?: string) =>
    new FileSystemTraceToCode((p) => FILES[p] ?? null, root);

  it("returns the target line marked, with surrounding context", () => {
    const snippet = resolver().resolve({ filePath: "/app/src/checkout.ts", line: 3, column: 5 });
    expect(snippet.missing).toBeUndefined();
    const target = snippet.lines.find((l) => l.isTarget)!;
    expect(target.number).toBe(3);
    expect(target.text).toBe("customer.id;");
    expect(snippet.lines.length).toBe(6);
  });

  it("says so plainly when the file is unavailable", () => {
    const snippet = resolver().resolve({ filePath: "/app/src/bundle.js", line: 1, column: 1 });
    expect(snippet.missing).toBe(true);
    expect(snippet.reason).toMatch(/not available/);
    // A production build has no sources; that must be visible, not blank.
    expect(snippet.caveats.join(" ")).toMatch(/does not ship its sources/);
  });

  it("refuses to read outside the project root", () => {
    // A stack frame can carry any path an attacker chose, so an unguarded read
    // would turn a crafted trace into arbitrary file disclosure.
    const snippet = resolver("/app").resolve({ filePath: "/etc/passwd", line: 1, column: 1 });
    expect(snippet.missing).toBe(true);
    expect(snippet.reason).toMatch(/outside the project root/);
  });

  it("reports a line outside the file rather than returning nothing", () => {
    const snippet = resolver().resolve({ filePath: "/app/src/checkout.ts", line: 900, column: 1 });
    expect(snippet.missing).toBe(true);
    expect(snippet.caveats.join(" ")).toMatch(/Line numbers can drift/);
  });

  it("caches reads rather than hitting the filesystem per frame", () => {
    let reads = 0;
    const r = new FileSystemTraceToCode((p) => { reads++; return FILES[p] ?? null; });
    r.resolve({ filePath: "/app/src/checkout.ts", line: 3, column: 1 });
    r.resolve({ filePath: "/app/src/checkout.ts", line: 4, column: 1 });
    expect(reads).toBe(1);
  });
});

describe("Observer.sourceFor", () => {
  it("reports no resolver rather than silently returning nothing", () => {
    const observer = new Observer({ service: "src" });
    const snippet = observer.sourceFor({ filePath: "/a.ts", line: 1, column: 1 });
    expect(snippet.missing).toBe(true);
    expect(snippet.reason).toMatch(/No source resolver/);
  });

  it("uses an installed resolver", () => {
    const observer = new Observer({ service: "src2" });
    observer.sourceResolver = new FileSystemTraceToCode(
      () => ["one", "two", "boom"].join("\n"),
    );
    const snippet = observer.sourceFor({ filePath: "/x.ts", line: 3, column: 2 });
    expect(snippet.lines.find((l) => l.isTarget)!.text).toBe("boom");
  });
});

describe("AI span data", () => {
  it("is reachable through the public API, not just the constructor", () => {
    const observer = new Observer({ service: "ai" });

    const span = observer.tracer.startSpan("llm.chat", {
      kind: "client",
      ai: {
        operation: "chat",
        provider: "anthropic",
        model: "claude-sonnet-4",
        inputTokens: 1_200,
        outputTokens: 340,
        costUsd: 0.0123,
      },
    });
    span.end();
    observer.recordSpan(span);

    const stored = observer.spans.all().find((s) => s.name === "llm.chat")!;
    // AiSpanData was serialised but had no way in — startSpan dropped it.
    expect(stored.toJSON().ai?.model).toBe("claude-sonnet-4");
    expect(stored.toJSON().ai?.costUsd).toBe(0.0123);
  });

  it("flows through withSpan", async () => {
    const observer = new Observer({ service: "ai2" });

    await observer.tracer.withSpan(
      "llm.tool",
      { kind: "client", ai: { operation: "tool", model: "claude-sonnet-4", costUsd: 0.5 } },
      async () => "done",
    );

    const stored = observer.spans.all().find((s) => s.name === "llm.tool")!;
    expect(stored.toJSON().ai?.operation).toBe("tool");
  });

  it("is absent when no AI data was supplied", () => {
    const observer = new Observer({ service: "ai3" });
    const span = observer.tracer.startSpan("plain");
    span.end();
    expect(span.toJSON().ai).toBeUndefined();
  });
});

describe("Observer — audit records", () => {
  it("keeps structured detail so an entry can be acted on", () => {
    const obs = createObserver({ service: "audit-test", environment: "test", dashboard: false });

    obs.recordAudit({
      action: "member.updated",
      target: "user_123",
      actor: "admin_1",
      meta: { role: "admin", previousRole: "member" },
    });

    const entry = obs.auditLogs.all()[0]!;
    expect(entry.action).toBe("member.updated");
    expect(entry.target).toBe("user_123");
    // Without meta, the record says only that *something* changed, which cannot
    // answer the question an audit log is consulted for.
    expect(entry.meta).toEqual({ role: "admin", previousRole: "member" });
    obs.stop();
  });

  it("allows an entry with no detail rather than forcing one", () => {
    const obs = createObserver({ service: "audit-test-2", environment: "test", dashboard: false });
    obs.recordAudit({ action: "cache.flushed", actor: "operator" });
    expect(obs.auditLogs.all()[0]!.meta).toBeUndefined();
    obs.stop();
  });
});

describe("createObserver — one observer per call", () => {
  it("constructs a distinct instance rather than returning a cached one", () => {
    const a = createObserver({ service: "svc-a", environment: "test", dashboard: false });
    const b = createObserver({ service: "svc-b", environment: "test", dashboard: false });

    // It used to return the cached instance here, so `b` was `a` — the second
    // config was discarded and both names reported svc-a.
    expect(b).not.toBe(a);
    expect(b.service).toBe("svc-b");
    expect(a.service).toBe("svc-a");

    a.stop();
    b.stop();
  });

  it("validates the config on every call, not only the first", () => {
    createObserver({ service: "warmup", environment: "test", dashboard: false });

    // The second call used to skip validation entirely, so an invalid config
    // here threw nothing and was then ignored.
    expect(() =>
      createObserver({ service: "bad-slo", environment: "test", dashboard: false,
        slos: [{ name: "x", target: 500, windowMs: 1000 }] } as never),
    ).toThrow(/target/);
  });

  it("gives each instance its own counters", () => {
    const a = createObserver({ service: "counters-a", environment: "test", dashboard: false });
    const b = createObserver({ service: "counters-b", environment: "test", dashboard: false });

    // Metrics live on the registry, reached via .metrics.
    a.metrics.counter("requests").add(5, { route: "/x" });

    const aNames = a.metrics.snapshot().counters.map((c: any) => c.name);
    const bNames = b.metrics.snapshot().counters.map((c: any) => c.name);

    expect(aNames).toContain("requests");
    // A shared instance would show the other one's metric here.
    expect(bNames).not.toContain("requests");

    a.stop();
    b.stop();
  });
});

describe("MetricsRegistry.snapshot", () => {
  it("reads counters, gauges and histograms back", () => {
    const obs = createObserver({ service: "metrics-snap", environment: "test", dashboard: false });

    obs.metrics.counter("requests").add(3, { route: "/a" });
    obs.metrics.counter("requests").add(2, { route: "/b" });
    obs.metrics.gauge("queueDepth").set(7, { queue: "default" });
    obs.metrics.histogram("latency").observe(12);
    obs.metrics.histogram("latency").observe(40);

    const snap = obs.metrics.snapshot();

    const requests = snap.counters.find((c) => c.name === "requests")!;
    // Label keys are encodeURIComponent'd and sorted, so a value containing the
    // separator cannot forge a second label.
    expect(requests.values).toEqual({ "route=%2Fa": 3, "route=%2Fb": 2 });

    const depth = snap.gauges.find((g) => g.name === "queueDepth")!;
    expect(depth.values).toEqual({ "queue=default": 7 });

    const latency = snap.histograms.find((h) => h.name === "latency")!;
    expect(latency.values).toHaveLength(1);
    expect(latency.values[0]!.count).toBe(2);
    expect(latency.values[0]!.min).toBe(12);
    expect(latency.values[0]!.max).toBe(40);
    // Buckets are [5, 10, 25, 50, ...] at indices 0, 1, 2, 3 — so 12 lands in
    // the <=25 bucket at index 2 and 40 in the <=50 bucket at index 3.
    expect(latency.values[0]!.bucketCounts[2]).toBe(1);
    expect(latency.values[0]!.bucketCounts[3]).toBe(1);
    expect(latency.values[0]!.bucketCounts[0]).toBe(0);
    // The overflow slot catches anything above the largest bound.
    expect(latency.values[0]!.bucketCounts[latency.values[0]!.buckets.length]).toBe(0);

    obs.stop();
  });

  it("does not hand out the live bucket arrays", () => {
    const obs = createObserver({ service: "metrics-copy", environment: "test", dashboard: false });
    obs.metrics.histogram("h").observe(5);

    const snap = obs.metrics.snapshot();
    snap.histograms[0]!.values[0]!.bucketCounts[0] = 9999;
    snap.histograms[0]!.values[0]!.buckets[0] = -1;

    const again = obs.metrics.snapshot();
    expect(again.histograms[0]!.values[0]!.bucketCounts[0]).toBe(1);
    expect(again.histograms[0]!.values[0]!.buckets[0]).toBe(5);

    obs.stop();
  });
});

describe("Observer — trace sampling", () => {
  function observerWith(rate: number | undefined) {
    return createObserver({
      service: "sampling-test",
      environment: "test",
      ...(rate === undefined ? {} : { tracesSampleRate: rate }),
    });
  }

  it("records every span by default", () => {
    const obs = observerWith(undefined);

    const sampled = Array.from({ length: 50 }, (_, i) =>
      obs.tracer.startSpan(`s${i}`).sampled,
    );

    expect(sampled.every(Boolean)).toBe(true);
  });

  it("records none at a rate of 0", () => {
    const obs = observerWith(0);

    const sampled = Array.from({ length: 50 }, (_, i) =>
      obs.tracer.startSpan(`s${i}`).sampled,
    );

    expect(sampled.some(Boolean)).toBe(false);
  });

  it("records about the stated share at an intermediate rate", () => {
    const obs = observerWith(0.1);

    const sampled = Array.from({ length: 1000 }, (_, i) =>
      obs.tracer.startSpan(`s${i}`).sampled,
    ).filter(Boolean).length;

    // This option used to be read by nothing, so every span was recorded and this
    // count was always 1000.
    expect(sampled).toBeGreaterThan(50);
    expect(sampled).toBeLessThan(150);
  });

  it("makes the same load produce the same traces", () => {
    const first = observerWith(0.25);
    const second = observerWith(0.25);

    const a = Array.from({ length: 40 }, (_, i) => first.tracer.startSpan(`s${i}`).sampled);
    const b = Array.from({ length: 40 }, (_, i) => second.tracer.startSpan(`s${i}`).sampled);

    // Deterministic rather than random: a sample you cannot choose is not a
    // sample, because you cannot go and read it.
    expect(a).toEqual(b);
  });

  it("gives every span of one request the same decision", () => {
    const obs = observerWith(0.5);

    // 40 roots, each with a child. Every child must agree with its own root,
    // whichever the root's decision happened to be.
    let checked = 0;

    for (let i = 0; i < 40; i++) {
      const root = obs.tracer.startSpan(`root${i}`);
      const child = obs.tracer.startSpan(`child${i}`, { parent: root });

      // The rate is a share of requests. If each span rolled separately, a
      // sampled request could still come out with no recorded spans inside it.
      expect(child.sampled).toBe(root.sampled);
      expect(child.traceId).toBe(root.traceId);

      if (root.sampled) checked++;
    }

    // Some were sampled and some were not, so the check above was not vacuous.
    expect(checked).toBeGreaterThan(5);
    expect(checked).toBeLessThan(35);
  });

  it("respects an upstream decision over the local rate", () => {
    const obs = observerWith(0);

    // Rate 0 would record nothing, but an upstream caller that asked for a trace
    // should not silently lose it.
    const traced = obs.tracer.startSpan("t", {
      parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1, sampled: true },
    });

    expect(traced.sampled).toBe(true);
  });

  it("refuses a rate outside 0 to 1", () => {
    expect(() => observerWith(1.5)).toThrow(/tracesSampleRate/);
    expect(() => observerWith(-0.1)).toThrow(/tracesSampleRate/);
    expect(() => observerWith(Number.NaN)).toThrow(/tracesSampleRate/);
  });
});
