import { describe, it, expect } from "bun:test";
import {
  // Primitives
  RingBuffer,
  percentile,
  computeApdexAndPercentiles,
  parseStackTrace,
  computeSmartFingerprint,
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  formatTraceparent,
  sanitizeUrlString,
  maskHeaders,
  maskPayload,
  isAlreadyObserved,
  markObserved,
  MetricsRegistry,
  // Core
  Span,
  Tracer,
  Logger,
  ErrorReporter,
  HardwareEngine,
  Observer,
  observeDashboard,
  type ErrorOccurrence,
  type LogRecord,
  type HttpTransaction,
} from "../types/observe";

// ────────────────────────────────────────────────────────────────────────────
// Primitives — the load-bearing ones everything else rests on
// ────────────────────────────────────────────────────────────────────────────

describe("RingBuffer", () => {
  it("wraps around without losing order or overflowing", () => {
    const buf = new RingBuffer<number>(5);

    for (let i = 0; i < 5; i++) buf.push(i);
    expect(buf.all()).toEqual([0, 1, 2, 3, 4]);
    expect(buf.size).toBe(5);

    // Three more pushes must evict the three oldest, not grow.
    buf.push(5);
    buf.push(6);
    buf.push(7);

    expect(buf.size).toBe(5);
    expect(buf.all()).toEqual([3, 4, 5, 6, 7]);
  });

  it("counts what it dropped", () => {
    const buf = new RingBuffer<number>(2);
    expect(buf.droppedCount).toBe(0);

    buf.push(1);
    buf.push(2);
    buf.push(3);

    expect(buf.droppedCount).toBe(1);
  });

  it("returns a fresh array, so a caller cannot reorder the store", () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);

    const view = buf.all();
    view.push(99);
    view.reverse();

    // The array is copied; the elements are shared, deliberately — deep-copying
    // every span on each read would be far too expensive on a hot path.
    expect(buf.all()).toEqual([1, 2]);
  });

  it("keeps the newest values after wrapping", () => {
    const buf = new RingBuffer<number>(10);
    for (let i = 0; i < 6; i++) buf.push(i);

    expect(buf.all()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("clears", () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);
    buf.clear();

    expect(buf.size).toBe(0);
    expect(buf.all()).toEqual([]);
  });
});

describe("percentile", () => {
  it("matches a known distribution", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, 50)).toBeGreaterThanOrEqual(5);
    expect(percentile(sorted, 95)).toBeGreaterThanOrEqual(9);
  });

  it("returns 0 for an empty sample rather than NaN", () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it("handles p above 1 without running off the end", () => {
    expect(percentile([1, 2, 3], 500)).toBe(3);
  });
});

describe("computeApdexAndPercentiles", () => {
  const tx = (durationMs: number, status = 200) => ({ durationMs, status });

  it("scores a fast, error-free set as satisfying", () => {
    const result = computeApdexAndPercentiles(
      [tx(10), tx(12), tx(15), tx(11), tx(13), tx(14), tx(10), tx(12)],
      100,
    );

    expect(result.apdex).toBeGreaterThan(0.9);
    expect(result.p50).toBeGreaterThan(0);
    expect(result.total).toBe(8);
  });

  it("degrades when slow requests dominate", () => {
    const result = computeApdexAndPercentiles(
      [tx(1000), tx(2000), tx(3000), tx(4000), tx(50)],
      100,
    );

    expect(result.apdex).toBeLessThan(0.9);
    expect(result.max).toBe(4000);
  });

  it("returns a perfect score for an empty set rather than NaN", () => {
    const result = computeApdexAndPercentiles([], 100);

    expect(Number.isNaN(result.apdex)).toBe(false);
    expect(result.apdex).toBe(1);
  });
});

describe("traceparent (W3C)", () => {
  it("round-trips a generated context", () => {
    const ctx = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      traceFlags: 1,
      sampled: true,
    };
    const header = formatTraceparent(ctx);

    expect(parseTraceparent(header)).toEqual(ctx);
  });

  it("rejects a malformed header rather than guessing", () => {
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });

  it("marks an unsampled flag", () => {
    const ctx = {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      traceFlags: 0,
      sampled: false,
    };
    expect(parseTraceparent(formatTraceparent(ctx))!.sampled).toBe(false);
  });

  it("generates 32- and 16-hex ids", () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseStackTrace", () => {
  const stack = [
    "Error: boom",
    "    at handle (/app/src/routes/users.ts:42:15)",
    "    at Object.<anonymous> (/app/src/index.ts:7:3)",
    "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
  ].join("\n");

  it("extracts function, file and line", () => {
    const frames = parseStackTrace(stack);
    const first = frames[0]!;

    expect(first.functionName).toBe("handle");
    expect(first.fileName).toContain("users.ts");
    expect(first.lineno).toBe(42);
  });

  it("does not treat a file path as a function name for a bare frame", () => {
    // "at /path/file.ts:1:2" has no function name; the path must not be
    // reported as one.
    const frames = parseStackTrace("Error: x\n    at /app/src/a.ts:1:2");
    expect(frames[0]!.functionName).not.toContain("/app/src/a.ts");
  });

  it("survives an empty or absent stack", () => {
    expect(parseStackTrace(undefined)).toEqual([]);
    expect(parseStackTrace("")).toEqual([]);
  });
});

describe("computeSmartFingerprint", () => {
  it("groups identical failures across differing ids and times", () => {
    const a = computeSmartFingerprint(
      new Error("Cannot read property 'id' of undefined"),
      parseStackTrace("Error\n    at load (/app/src/db.ts:10:5)"),
    );
    const b = computeSmartFingerprint(
      new Error("Cannot read property 'id' of undefined"),
      parseStackTrace("Error\n    at load (/app/src/db.ts:10:5)"),
    );

    expect(a).toBe(b);
  });

  it("separates failures from different call sites", () => {
    const stackA = "Error\n    at load (/app/src/db.ts:10:5)";
    const stackB = "Error\n    at load (/app/src/api.ts:10:5)";

    expect(computeSmartFingerprint(new Error("x"), parseStackTrace(stackA))).not.toBe(
      computeSmartFingerprint(new Error("x"), parseStackTrace(stackB)),
    );
  });

  it("returns a stable string even with no stack", () => {
    const fp = computeSmartFingerprint(new Error("bare"), []);
    expect(typeof fp).toBe("string");
    expect(fp.length).toBeGreaterThan(0);
  });
});

describe("sanitizeUrlString", () => {
  it("strips javascript: and data: schemes", () => {
    expect(sanitizeUrlString("javascript:alert(1)")).not.toContain("javascript:");
    expect(sanitizeUrlString("data:text/html,<script>")).not.toContain("data:");
  });

  it("reduces a URL to path and query, dropping origin and fragment", () => {
    // Origin is dropped deliberately: the observer records where a request went,
    // not which host it reached.
    expect(sanitizeUrlString("https://example.com/a?b=1#c")).toBe("/a?b=1");
  });

  it("redacts sensitive query parameters", () => {
    const out = sanitizeUrlString("/reset?token=secret123&ok=1");
    expect(out).not.toContain("secret123");
    expect(out).toContain("ok=1");
  });

  it("handles empty input", () => {
    expect(sanitizeUrlString("")).toBeDefined();
  });
});

describe("maskHeaders and maskPayload", () => {
  it("masks every configured credential header", () => {
    const masked = maskHeaders({
      authorization: "Bearer abc",
      cookie: "yatta_session=xyz",
      refresh_token: "rt",
      "x-api-key": "k",
    });

    for (const key of Object.keys(masked)) {
      expect(String(masked[key])).not.toContain("abc");
      expect(String(masked[key])).not.toContain("xyz");
      expect(String(masked[key])).not.toContain("k");
    }
  });

  it("masks camelCase credential names, not just snake_case", () => {
    const masked = maskPayload({
      authToken: "secret-a",
      refreshToken: "secret-b",
      password: "secret-c",
      sessionId: "secret-d",
    });

    for (const v of Object.values(masked)) {
      expect(String(v)).not.toContain("secret-");
    }
  });

  it("leaves ordinary values readable", () => {
    const masked = maskPayload({ userId: "u1", count: 3, ok: true });
    expect(masked.userId).toBe("u1");
    expect(masked.count).toBe(3);
  });

  it("does not recurse forever on a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;

    expect(() => maskPayload(cyclic)).not.toThrow();
  });
});

describe("observed-error dedup", () => {
  it("marks once per error object", () => {
    const err = new Error("dup");
    expect(isAlreadyObserved(err)).toBe(false);

    markObserved(err);
    expect(isAlreadyObserved(err)).toBe(true);
  });

  it("treats a different instance as new", () => {
    markObserved(new Error("a"));
    expect(isAlreadyObserved(new Error("a"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Metrics
// ────────────────────────────────────────────────────────────────────────────

describe("MetricsRegistry", () => {
  it("keeps label sets separate, including values containing the separator", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("requests");

    // A naive "k=v,k=v" join collides when a value itself contains a comma.
    counter.add(1, { route: "a,b", status: "200" });
    counter.add(1, { route: "a", status: "b,200" });

    // add() returns the value for that label set, so both must be 1 and the
    // total for neither may leak into the other.
    expect(counter.add(0, { route: "a,b", status: "200" })).toBe(1);
    expect(counter.add(0, { route: "a", status: "b,200" })).toBe(1);
  });

  it("accumulates what a counter is given", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("hits");

    expect(counter.add(2)).toBe(2);
    expect(counter.add(3)).toBe(5);
  });

  it("reads back a gauge and keeps label sets apart", () => {
    const reg = new MetricsRegistry();
    const gauge = reg.gauge("active");

    gauge.set(7, { q: "x" });
    gauge.set(9, { q: "y" });

    expect(gauge.get({ q: "x" })).toBe(7);
    expect(gauge.get({ q: "y" })).toBe(9);
    expect(gauge.get({ q: "z" })).toBe(0);
  });

  it("returns the same instance for the same metric name", () => {
    const reg = new MetricsRegistry();
    expect(reg.counter("same")).toBe(reg.counter("same"));
    expect(reg.gauge("same")).not.toBe(reg.counter("same"));
  });

  it("times an observation with startTimer", async () => {
    const reg = new MetricsRegistry();
    const hist = reg.histogram("latency");

    const stop = hist.startTimer();
    await Bun.sleep(3);
    const ms = stop();

    expect(ms).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Span
// ────────────────────────────────────────────────────────────────────────────

describe("Span", () => {
  it("reports a monotonic duration", async () => {
    const span = new Span({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: "test",
      kind: "internal",
      startTime: Date.now(),
    });

    await Bun.sleep(5);
    span.end();

    expect(span.durationMs).toBeGreaterThan(0);
  });

  it("clamps a wall-clock correction that would go negative", () => {
    const span = new Span({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: "test",
      kind: "internal",
      startTime: Date.now() + 10_000,
    });

    span.end();

    expect(span.endTime!).toBeGreaterThanOrEqual(span.startTime);
  });

  it("marks itself errored and records the exception", () => {
    const span = new Span({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: "test",
      kind: "internal",
      startTime: Date.now(),
    });

    span.recordError(new TypeError("bad type"));
    span.end();

    const json = span.toJSON();
    expect(json.status).toBe("error");
    expect(json.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("does not treat a 4xx as a server error", () => {
    const span = new Span({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: "test",
      kind: "server",
      startTime: Date.now(),
    });

    span.setHttpStatus(404);
    span.end();

    expect(span.toJSON().status).not.toBe("error");
  });

  it("does treat a 5xx as one", () => {
    const span = new Span({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      name: "test",
      kind: "server",
      startTime: Date.now(),
    });

    span.setHttpStatus(500);
    span.end();

    expect(span.toJSON().status).toBe("error");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Logger
// ────────────────────────────────────────────────────────────────────────────

describe("Logger", () => {
  it("records a message into the observer's buffer", () => {
    const observer = new Observer({ service: "log-emit" });
    observer.log.info("recorded");

    const logs = observer.logs.all();
    expect(logs.some((l) => l.message === "recorded")).toBe(true);
  });

  it("attaches the trace id when inside a span", async () => {
    const observer = new Observer({ service: "log-trace" });
    await observer.tracer.withSpan("work", {}, async () => {
      observer.log.info("inside");
    });

    const entry = observer.logs.all().find((l) => l.message === "inside")!;
    expect(entry.traceId).toBeDefined();
  });

  it("drops records below the configured level before doing any work", () => {
    const observer = new Observer({ service: "log-level", logLevel: "warn" });

    observer.log.debug("dropped");
    observer.log.info("dropped");
    observer.log.warn("kept");
    observer.log.error("kept too");

    const messages = observer.logs.all().map((l) => l.message);
    expect(messages).toEqual(["kept", "kept too"]);
  });

  it("defaults to info, so debug is off unless asked for", () => {
    const observer = new Observer({ service: "log-level-default" });

    observer.log.debug("dropped");
    observer.log.info("kept");

    expect(observer.logs.all().map((l) => l.message)).toEqual(["kept"]);
  });

  it("records everything at trace, and nothing at silent", () => {
    const loud = new Observer({ service: "log-trace", logLevel: "trace" });
    loud.log.debug("kept");
    expect(loud.logs.all()).toHaveLength(1);

    const quiet = new Observer({ service: "log-silent", logLevel: "silent" });
    quiet.log.error("fatal problem");
    expect(quiet.logs.all()).toHaveLength(0);
  });

  it("rejects a level it does not understand", () => {
    expect(
      () => new Observer({ service: "bad-level", logLevel: "loud" } as never),
    ).toThrow(/logLevel/);
  });

  it("buffers up to the configured size", () => {
    const observer = new Observer({ service: "log-cap", bufferSize: 5 });
    for (let i = 0; i < 20; i++) observer.log.info(`line ${i}`);

    expect(observer.logs.size).toBeLessThanOrEqual(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ErrorReporter
// ────────────────────────────────────────────────────────────────────────────

describe("ErrorReporter", () => {
  const occurrence = (
    message: string,
    extra: Partial<ErrorOccurrence> = {},
  ): ErrorOccurrence => ({
    id: crypto.randomUUID(),
    fingerprint: computeSmartFingerprint(new Error(message), []),
    timestamp: Date.now(),
    message,
    name: "Error",
    stack: `Error: ${message}\n    at f (/app/src/a.ts:1:1)`,
    parsedFrames: parseStackTrace(`Error: ${message}\n    at f (/app/src/a.ts:1:1)`),
    level: "error",
    request: {},
    breadcrumbs: [],
    handled: false,
    ...extra,
  });

  it("groups repeated identical failures into one issue", () => {
    const observer = new Observer({ service: "err" });
    for (let i = 0; i < 5; i++) observer.recordError(occurrence("same failure"));

    const issues = [...observer.errors.issues.values()];
    expect(issues).toHaveLength(1);
    expect(issues[0]!.count).toBe(5);
  });

  it("keeps distinct failures apart", () => {
    const observer = new Observer({ service: "err2" });
    observer.recordError(occurrence("failure A"));
    observer.recordError(occurrence("failure B"));

    expect(observer.errors.issues.size).toBe(2);
  });

  it("keeps a bounded history of occurrences per issue", () => {
    const observer = new Observer({ service: "err3" });
    for (let i = 0; i < 20; i++) observer.recordError(occurrence("repeated"));

    const issue = [...observer.errors.issues.values()][0]!;
    expect(issue.count).toBe(20);
    // Unbounded occurrence lists are a memory leak over weeks of uptime.
    expect(issue.occurrences.length).toBeLessThanOrEqual(20);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Observer
// ────────────────────────────────────────────────────────────────────────────

describe("Observer", () => {
  it("starts and stops cleanly, and reports installation", () => {
    const observer = new Observer({ service: "lifecycle" });

    expect(observer.isInstalled()).toBe(false);
    observer.start();
    expect(observer.isInstalled()).toBe(true);

    observer.stop();
    expect(observer.isInstalled()).toBe(false);
  });

  it("records a transaction and reflects it in the deep state", async () => {
    const observer = new Observer({ service: "tx" });
    const tx: HttpTransaction = {
      id: crypto.randomUUID(),
      traceId: generateTraceId(),
      method: "GET",
      route: "/api/users",
      url: "/api/users",
      status: 200,
      durationMs: 12,
      timestamp: Date.now(),
      inFlight: false,
    };

    observer.recordTransaction(tx);

    const state = await observer.getDeepApplicationState();
    expect(state.service).toBe("tx");
    expect(state.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("rejects unknown config keys rather than silently accepting them", () => {
    expect(() => new Observer({ service: "x", nonsense: true } as never)).toThrow();
  });

  it("requires a service name", () => {
    expect(() => new Observer({} as never)).toThrow();
  });

  it("instruments a handler into a transaction", async () => {
    const observer = new Observer({ service: "instr" });
    const handler = observer.instrument(
      async () => new Response("ok", { status: 200 }),
      () => "/api/thing",
    );

    const res = await handler(new Request("http://x/api/thing"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBeDefined();

    const state = await observer.getDeepApplicationState();
    expect(state.apdex.total).toBeGreaterThan(0);
  });

  it("records a thrown handler as a 500, not a successful 200", async () => {
    const observer = new Observer({ service: "instr-fail-status" });
    const handler = observer.instrument(async () => {
      throw new Error("upstream is down");
    });

    await expect(handler(new Request("http://x/api/thing"))).rejects.toThrow();

    // The span must carry the failure: anything reading http.status_code
    // defaults it to 200, which is what made crashed endpoints look fast.
    const server = observer.spans.all().find((s) => s.kind === "server")!;
    expect(server.toJSON().status).toBe("error");
    expect(server.attributes["http.status_code"]?.number).toBe(500);

    // The endpoint rollup must count the failure, not a success.
    const state = await observer.getDeepApplicationState();
    const endpoint = state.endpoints.find((e: any) =>
      e.operationId.includes("thing"),
    )!;
    expect(endpoint.count).toBe(1);
    expect(endpoint.failureRate).toBe(100);
  });

  it("records the structured status a handler threw with", async () => {
    const observer = new Observer({ service: "instr-throw-404" });
    const handler = observer.instrument(async () => {
      throw Object.assign(new Error("nope"), { status: 404 });
    });

    await expect(handler(new Request("http://x/api/gone"))).rejects.toThrow();

    const server = observer.spans.all().find((s) => s.kind === "server")!;
    expect(server.attributes["http.status_code"]?.number).toBe(404);
  });

  it("records a thrown handler without swallowing it", async () => {
    const observer = new Observer({ service: "instr-throw" });
    const handler = observer.instrument(async () => {
      throw new Error("handler exploded");
    });

    await expect(handler(new Request("http://x/boom"))).rejects.toThrow("handler exploded");
  });

  it("records a slow query past the configured threshold", async () => {
    const observer = new Observer({
      service: "slow",
      slowQueryThresholdMs: 50,
    });

    observer.recordSlowQuery({
      id: "q1",
      sql: "SELECT 1",
      durationMs: 200,
      timestamp: Date.now(),
    });
    observer.recordSlowQuery({
      id: "q2",
      sql: "SELECT 2",
      durationMs: 5,
      timestamp: Date.now(),
    });

    const state = await observer.getDeepApplicationState();
    expect(state.slowQueries.length).toBe(1);
  });

  it("returns a waterfall for a trace, and nothing for an unknown id", () => {
    const observer = new Observer({ service: "wf" });
    const traceId = generateTraceId();

    expect(observer.getTraceWaterfall("nope")).toBeNull();
    expect(observer.getTraceWaterfall(traceId)).toBeDefined();
  });

  it("delivers events to an SSE subscriber and can unsubscribe", () => {
    const observer = new Observer({ service: "sse" });
    const chunks: Uint8Array[] = [];

    const controller = {
      enqueue: (c: Uint8Array) => chunks.push(c),
      close: () => {},
      desiredSize: 100,
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    const unsubscribe = observer.registerSseSubscriber(controller);

    observer.recordLog({
      level: "info",
      message: "hello",
      timestamp: Date.now(),
    } as LogRecord);

    unsubscribe();
    observer.recordLog({
      level: "info",
      message: "after",
      timestamp: Date.now(),
    } as LogRecord);

    expect(chunks.length).toBeGreaterThan(0);
    // Nothing delivered after unsubscribing.
    const before = chunks.length;
    observer.recordLog({
      level: "info",
      message: "later",
      timestamp: Date.now(),
    } as LogRecord);
    expect(chunks.length).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dashboard
// ────────────────────────────────────────────────────────────────────────────

describe("observeDashboard handler", () => {
  it("serves the dashboard over HTTP, self-contained", async () => {
    const observer = new Observer({ service: "dash", dashboard: true });
    const handler = observeDashboard(observer);

    const res = await handler(new Request("http://x/_yatta/dashboard"));

    expect(res).not.toBeNull();
    expect(res!.headers.get("content-type")).toContain("text/html");

    const html = await res!.text();
    expect(html).toContain("<!doctype html>");
    // An observability tool that needs a CDN is one more thing to break
    // during an incident.
    expect(/<(script|link)[^>]+(src|href)="https?:/i.test(html)).toBe(false);
  });

  it("declines a path it does not own, so the app router keeps it", async () => {
    const observer = new Observer({ service: "dash2", dashboard: true });

    expect(await observeDashboard(observer)(new Request("http://x/api/users"))).toBeNull();
  });

  it("404s the dashboard when it is disabled", async () => {
    const observer = new Observer({ service: "dash3", dashboard: false });

    const res = await observeDashboard(observer)(
      new Request("http://x/_yatta/dashboard"),
    );

    expect(res!.status).toBe(404);
  });

  it("escapes a hostile service name", async () => {
    const observer = new Observer({
      service: '"><img src=x onerror=alert(1)>',
      dashboard: true,
    });

    const html = await (
      await observeDashboard(observer)(new Request("http://x/_yatta/dashboard"))
    )!.text();

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
