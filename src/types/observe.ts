/**
 * ============================================================================
 *  YATTA OBSERVE (v6.0) — Unified Application & Hardware Mission Control
 * ============================================================================
 *
 *  Engineered for Bun. v6.0 changelog:
 *  - FIXED: slow-query threshold was defined twice (50ms capture vs 100ms
 *    buffer filter) so queries between 50–100ms were flagged in breadcrumbs
 *    but never recorded. One source of truth now.
 *  - FIXED: SSE polling fallback leaked — the 3s poll timer started on error
 *    was never cleared when the stream reopened, causing permanent double
 *    fetching. Also added heartbeat pings so proxies don't kill idle streams.
 *  - FIXED: /api/errors was refetched on every telemetry render (SSE
 *    transaction burst → N+1 fetch storm). Issues are cached and refreshed
 *    only when needed.
 *  - FIXED: dashboardPath was interpolated raw into inline JS (script
 *    breakout). Now injected via JSON.stringify.
 *  - FIXED: maskPayload referenced the Buffer global unguarded.
 *  - FIXED: instrument() crashed on responses that cannot be re-wrapped
 *    (101 upgrades, null bodies). Falls back to the original response.
 *  - FIXED: endpoint p95 used a loose index; now uses the shared percentile().
 *  - UI:   fully redesigned professional control console (see section 13).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

// ────────────────────────────────────────────────────────────────────────────
// 0. Security, Sanitization & PII Masking
// ────────────────────────────────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-session-token",
]);

/**
 * Credential-looking keys, matched as a substring rather than an anchored
 * alternation, so `authToken` / `refreshToken` / `sessionId` are masked too.
 */
const SENSITIVE_KEY_REGEX =
  /(password|passwd|secret|token|apikey|api_key|credential|cookie|session_?id|auth|private_?key|encryptionkey|credit_?card|cvv|ssn)/i;

const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "key",
  "api_key",
  "apikey",
  "session",
  "code",
  "auth",
  "signature",
  "sig",
  "email",
  "reset",
]);

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeUrlString(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (
        SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ||
        SENSITIVE_KEY_REGEX.test(key)
      ) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.pathname + parsed.search;
  } catch {
    return rawUrl.split("?")[0] || rawUrl;
  }
}

export function maskHeaders(
  headers: Headers | Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  if (headers instanceof Headers) {
    for (const [k, v] of headers.entries()) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
    }
  } else {
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase())
        ? "[REDACTED]"
        : String(v);
    }
  }
  return out;
}

export function maskPayload<T>(
  data: T,
  seen = new WeakSet<object>(),
  depth = 0,
  maxDepth = 6,
): T {
  if (!data || typeof data !== "object") return data;
  if (depth >= maxDepth) return "[MAX_DEPTH]" as any;
  if (seen.has(data as object)) return "[CIRCULAR]" as any;
  seen.add(data as object);

  if (data instanceof Date) return data.toISOString() as any;
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack } as any;
  }
  if (
    data instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(data))
  ) {
    return `[Binary ${(data as Uint8Array).byteLength} bytes]` as any;
  }
  if (Array.isArray(data)) {
    return data
      .slice(0, 50)
      .map((item) => maskPayload(item, seen, depth + 1, maxDepth)) as any;
  }

  const masked: Record<string, any> = {};
  let count = 0;
  for (const [k, v] of Object.entries(data)) {
    if (++count > 100) {
      masked["__truncated__"] = "...";
      break;
    }
    if (SENSITIVE_KEY_REGEX.test(k)) {
      masked[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      masked[k] = maskPayload(v, seen, depth + 1, maxDepth);
    } else if (typeof v === "string" && v.length > 1000) {
      masked[k] = v.slice(0, 1000) + "...[TRUNCATED]";
    } else {
      masked[k] = v;
    }
  }
  return masked as T;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Identifiers & Strict W3C Trace Context
// ────────────────────────────────────────────────────────────────────────────

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  sampled: boolean;
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function parseTraceparent(
  header: string | null | undefined,
): TraceContext | null {
  if (!header) return null;
  const match = header.trim().match(TRACEPARENT_REGEX);
  if (!match) return null;

  const traceId = match[1]!.toLowerCase();
  const spanId = match[2]!.toLowerCase();
  const flagsStr = match[3]!.toLowerCase();

  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;

  const traceFlags = parseInt(flagsStr, 16);
  if (Number.isNaN(traceFlags)) return null;

  return { traceId, spanId, traceFlags, sampled: (traceFlags & 0x01) === 1 };
}

export function formatTraceparent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

import {
  analyzeMemoryTrend,
  BaselineEngine,
  buildSpanTree,
  flattenTree,
  JobIntelligence,
  buildIncidentReport,
  FileSystemTraceToCode,
  GoldenTraceStore,
  NPlusOneDetector,
  SafeActions,
  ServiceMapBuilder,
  SloEngine,
  IncidentAnalyzer,
  MetricsHistory,
  ReleaseIntelligence,
  ReleaseTimeline,
  type AnalysisSource,
  type IncidentAnalysis,
  type AnomalyVerdict,
  type Baseline,
  type MemoryTrend,
  type ServiceMap,
  type NPlusOneFinding,
  type SloDefinition,
  type SloResult,
  type JobHealth,
  type ActionPreview,
  type ActionOutcome,
  type GoldenTrace,
  type GoldenTraceComparison,
  type SourceContext,
  type SourceSnippet,
  type TraceToCodeResolver,
  type ActionRequest,
  type IncidentReport,
  type ReleaseHealth,
  type WhatChanged,
} from "./observe_analysis";

export {
  buildSpanTree,
  flattenTree,
};

export {
  GoldenTraceStore,
  FileSystemTraceToCode,
  NPlusOneDetector,
  ServiceMapBuilder,
  SafeActions,
  IncidentAnalyzer,
  MetricsHistory,
  BaselineEngine,
  ReleaseIntelligence,
  ReleaseTimeline,
  SloEngine,
  JobIntelligence,
  analyzeMemoryTrend,
  buildIncidentReport,
};

export type {
  TraceToCodeResolver,
  IncidentReport,
  SloDefinition,
  SloResult,
  JobHealth,
  ServiceMap,
  ServiceNode,
  ServiceCall,
  NPlusOneFinding,
  IncidentAnalysis,
  AnomalyVerdict,
  Baseline,
  MemoryTrend,
  HistorySample,
  ReleaseHealth,
  WhatChanged,
  MetricDelta,
  ReleaseMarker,
  Evidence,
  Suspect,
  TimelineEvent,
  SuggestedAction,
  Confidence,
} from "./observe_analysis";

export type SpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

export type SpanStatus = "unset" | "ok" | "error";

export interface SpanAttributeValue {
  string?: string;
  number?: number;
  boolean?: boolean;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, SpanAttributeValue>;
}

export interface AiSpanData {
  operation: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  streaming?: boolean;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
  events: SpanEvent[];
  ai?: AiSpanData;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. High-Resolution Span Implementation
// ────────────────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_SPAN = 64;

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceFlags: number;
  readonly sampled: boolean;

  readonly startTime: number;
  readonly startPerf: number;

  endTime?: number;
  finished = false;
  status: SpanStatus = "unset";
  attributes: Record<string, SpanAttributeValue> = {};
  events: SpanEvent[] = [];
  ai?: AiSpanData;

  private ended = false;
  private endPerf = performance.now();

  constructor(init: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: SpanKind;
    traceFlags?: number;
    sampled?: boolean;
    startTime?: number;
    ai?: AiSpanData;
  }) {
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    this.parentSpanId = init.parentSpanId;
    this.name = init.name;
    this.kind = init.kind;
    this.traceFlags = init.traceFlags ?? ((init.sampled ?? true) ? 1 : 0);
    this.sampled = (this.traceFlags & 0x01) === 1;

    this.startPerf = performance.now();
    this.startTime = init.startTime ?? performance.timeOrigin + this.startPerf;
    this.ai = init.ai;
  }

  get durationMs(): number | undefined {
    if (this.endTime === undefined) return undefined;
    const delta = this.endPerf - this.startPerf;
    return delta >= 0 ? delta : 0;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      this.attributes[key] = { string: "[REDACTED]" };
      return this;
    }
    if (typeof value === "string") this.attributes[key] = { string: value };
    else if (typeof value === "number")
      this.attributes[key] = { number: value };
    else this.attributes[key] = { boolean: value };
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }

  addEvent(
    name: string,
    attributes: Record<string, string | number | boolean> = {},
  ): this {
    if (this.events.length >= MAX_EVENTS_PER_SPAN) return this;
    const attrs: Record<string, SpanAttributeValue> = {};
    for (const [k, v] of Object.entries(attributes)) {
      attrs[k] =
        typeof v === "string"
          ? { string: v }
          : typeof v === "number"
            ? { number: v }
            : { boolean: v };
    }
    this.events.push({
      name,
      timestamp: performance.timeOrigin + performance.now(),
      attributes: attrs,
    });
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  ok(): this {
    return this.setStatus("ok");
  }

  fail(error?: unknown): this {
    this.status = "error";
    if (error instanceof Error) {
      this.setAttribute("error.type", error.name);
      this.setAttribute("error.message", error.message);
      if (error.stack) this.setAttribute("error.stack", error.stack);
    }
    return this;
  }

  setHttpStatus(status: number): this {
    this.setAttribute("http.status_code", status);
    if (status >= 500) this.status = "error";
    return this;
  }

  recordError(error: unknown): this {
    this.fail(error);
    if (error instanceof Error) {
      this.addEvent("exception", {
        "exception.type": error.name,
        "exception.message": error.message,
      });
    }
    return this;
  }

  end(): this {
    if (this.ended) return this;
    this.ended = true;
    this.endPerf = performance.now();
    this.endTime = performance.timeOrigin + this.endPerf;

    // An explicitly backdated startTime can yield end < start; clamp.
    if (this.endTime < this.startTime) this.endTime = this.startTime;
    return this;
  }

  toJSON(): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      status: this.status,
      attributes: this.attributes,
      events: this.events,
      ai: this.ai,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Ring Buffer & Core Primitives
// ────────────────────────────────────────────────────────────────────────────

export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>;
  private head = 0;
  private count = 0;
  private dropped = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be at least 1");
    this.buf = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    if (this.count === this.capacity) {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
      return;
    }
    this.buf[(this.head + this.count) % this.capacity] = item;
    this.count++;
  }

  get size(): number {
    return this.count;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  all(): T[] {
    const out: T[] = [];
    const start = this.count === this.capacity ? this.head : 0;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[(start + i) % this.capacity];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.dropped = 0;
  }
}

export class ObserveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObserveError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Metrics & True Histogram / Quantiles
// ────────────────────────────────────────────────────────────────────────────

export class Counter {
  constructor(
    readonly name: string,
    readonly description: string,
    private readonly values: Map<string, number>,
  ) {}

  add(delta: number, labels: Record<string, string> = {}): number {
    const key = labelKey(labels);
    const next = (this.values.get(key) ?? 0) + delta;
    this.values.set(key, next);
    return next;
  }
}

export class Gauge {
  constructor(
    readonly name: string,
    readonly description: string,
    private readonly values: Map<string, number>,
  ) {}

  set(value: number, labels: Record<string, string> = {}): number {
    this.values.set(labelKey(labels), value);
    return value;
  }

  get(labels: Record<string, string> = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
}

export class Histogram {
  private state = new Map<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      bucketCounts: number[];
      samples: number[];
    }
  >();

  constructor(
    readonly name: string,
    readonly description: string,
    readonly buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    readonly reservoirSize = 2048,
  ) {}

  /**
   * Reads every recorded label set back, for {@link MetricsRegistry.snapshot}.
   *
   * Returns copies rather than the live state, so a caller cannot mutate the
   * registry's buckets or samples through what it is handed.
   */
  readAll(): Array<{
    labels: string;
    count: number;
    sum: number;
    min: number;
    max: number;
    buckets: number[];
    bucketCounts: number[];
    samples: number[];
  }> {
    return [...this.state.entries()].map(([labels, st]) => ({
      labels,
      count: st.count,
      sum: st.sum,
      // An empty label set reports 0 rather than Infinity/-Infinity, which
      // would poison any average computed over the snapshot.
      min: st.count === 0 ? 0 : st.min,
      max: st.count === 0 ? 0 : st.max,
      buckets: [...this.buckets],
      bucketCounts: [...st.bucketCounts],
      samples: [...st.samples],
    }));
  }

  observe(value: number, labels: Record<string, string> = {}): void {
    const key = labelKey(labels);
    let s = this.state.get(key);
    if (!s) {
      s = {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        bucketCounts: new Array(this.buckets.length + 1).fill(0),
        samples: [],
      };
      this.state.set(key, s);
    }
    s.count++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;

    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        s.bucketCounts[i] = (s.bucketCounts[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      s.bucketCounts[this.buckets.length] =
        (s.bucketCounts[this.buckets.length] ?? 0) + 1;
    }

    if (s.samples.length < this.reservoirSize) {
      s.samples.push(value);
    } else {
      const slot = Math.floor(Math.random() * s.count);
      if (slot < this.reservoirSize) s.samples[slot] = value;
    }
  }

  startTimer(labels: Record<string, string> = {}): () => number {
    const start = performance.now();
    return () => {
      const ms = performance.now() - start;
      this.observe(ms, labels);
      return ms;
    };
  }
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) => `${encodeURIComponent(k)}=${encodeURIComponent(labels[k] ?? "")}`,
    )
    .join(",");
}

export class MetricsRegistry {
  private counters = new Map<
    string,
    { metric: Counter; values: Map<string, number> }
  >();
  private gauges = new Map<
    string,
    { metric: Gauge; values: Map<string, number> }
  >();
  private histograms = new Map<string, Histogram>();

  counter(name: string, description = ""): Counter {
    let entry = this.counters.get(name);
    if (!entry) {
      const values = new Map<string, number>();
      entry = { metric: new Counter(name, description, values), values };
      this.counters.set(name, entry);
    }
    return entry.metric;
  }

  gauge(name: string, description = ""): Gauge {
    let entry = this.gauges.get(name);
    if (!entry) {
      const values = new Map<string, number>();
      entry = { metric: new Gauge(name, description, values), values };
      this.gauges.set(name, entry);
    }
    return entry.metric;
  }

  histogram(name: string, description = ""): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, description);
      this.histograms.set(name, h);
    }
    return h;
  }

  /**
   * Reads every recorded metric back.
   *
   * The registry previously only accepted writes: a counter could be incremented
   * but there was no supported way to read its value, so a metric could be
   * recorded, exported nowhere, and never checked. Label sets are returned as
   * strings rather than parsed, because the registry does not keep the original
   * label object and reconstructing one would mean encoding keys back into an
   * object with a different key order.
   */
  snapshot(): {
    counters: Array<{ name: string; description: string; values: Record<string, number> }>;
    gauges: Array<{ name: string; description: string; values: Record<string, number> }>;
    histograms: Array<{
      name: string;
      description: string;
      /**
       * One entry per label set. Per-label rather than a single total, because a
       * histogram aggregated across labels is the thing that hides which route
       * got slower.
       */
      values: Array<{
        labels: string;
        count: number;
        sum: number;
        min: number;
        max: number;
        /** `buckets[i]` is the upper bound; `bucketCounts[i]` counts values <= it. */
        buckets: number[];
        bucketCounts: number[];
        samples: number[];
      }>;
    }>;
  } {
    const toRecord = (values: Map<string, number>): Record<string, number> => {
      const record: Record<string, number> = {};
      for (const [key, value] of values) record[key] = value;
      return record;
    };

    return {
      counters: [...this.counters.values()].map((e) => ({
        name: e.metric.name,
        description: e.metric.description,
        values: toRecord(e.values),
      })),
      gauges: [...this.gauges.values()].map((e) => ({
        name: e.metric.name,
        description: e.metric.description,
        values: toRecord(e.values),
      })),
      histograms: [...this.histograms.values()].map((h) => ({
        name: h.name,
        description: h.description,
        values: h.readAll(),
      })),
    };
  }
}

/** Nearest-rank percentile calculation. Expects a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

export function computeApdexAndPercentiles(
  transactions: Array<{ durationMs: number; status: number }>,
  T = 100,
) {
  if (transactions.length === 0) {
    return {
      apdex: 1.0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      avg: 0,
      min: 0,
      max: 0,
      total: 0,
    };
  }

  const sorted = transactions.map((t) => t.durationMs).sort((a, b) => a - b);
  const total = transactions.length;
  let satisfied = 0;
  let tolerating = 0;

  for (const t of transactions) {
    if (t.status >= 500) continue;
    if (t.durationMs <= T) satisfied++;
    else if (t.durationMs <= 4 * T) tolerating++;
  }

  const apdex = Number(((satisfied + tolerating * 0.5) / total).toFixed(2));
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    apdex: isNaN(apdex) ? 1.0 : apdex,
    p50: Math.round(percentile(sorted, 50)),
    p75: Math.round(percentile(sorted, 75)),
    p90: Math.round(percentile(sorted, 90)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    avg: Math.round(sum / total),
    min: Math.round(sorted[0]!),
    max: Math.round(sorted[total - 1]!),
    total,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Stack Trace Parser & Smart Fingerprinting
// ────────────────────────────────────────────────────────────────────────────

export interface ParsedStackFrame {
  functionName: string;
  fileName: string;
  lineno: number;
  colno: number;
  inApp: boolean;
  raw: string;
}

export function parseStackTrace(stack?: string): ParsedStackFrame[] {
  if (!stack) return [];
  const lines = stack.split("\n");
  const frames: ParsedStackFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;

    const match = trimmed.match(
      /^at\s+(?:async\s+)?(?:(.+?)\s+\((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))$/,
    );
    if (match) {
      const fn = match[1] || "<anonymous>";
      const file = match[2] || match[5] || "";
      const lineno = parseInt(match[3] || match[6] || "0", 10);
      const colno = parseInt(match[4] || match[7] || "0", 10);
      const inApp =
        !file.includes("node_modules") &&
        !file.startsWith("node:") &&
        !file.startsWith("bun:");

      frames.push({
        functionName: fn.trim(),
        fileName: file.trim(),
        lineno,
        colno,
        inApp,
        raw: trimmed,
      });
    }
  }

  return frames;
}

export function computeSmartFingerprint(
  error: unknown,
  frames: ParsedStackFrame[],
): string {
  const errName = error instanceof Error ? error.name : typeof error;
  const inApp = frames.filter((f) => f.inApp);
  const salientFrames =
    inApp.length > 0 ? inApp.slice(0, 3) : frames.slice(0, 2);

  if (salientFrames.length === 0) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const scrubbed = rawMsg
      .replace(/[0-9a-f-]{16,}/gi, ":id")
      .replace(/\d+/g, ":n");
    return createHash("sha256")
      .update(`${errName}:${scrubbed}`)
      .digest("hex")
      .slice(0, 16);
  }

  const sig = salientFrames
    .map((f) => `${path.basename(f.fileName)}#${f.functionName}:${f.lineno}`)
    .join(";");
  return createHash("sha256")
    .update(`${errName}:${sig}`)
    .digest("hex")
    .slice(0, 16);
}

// ────────────────────────────────────────────────────────────────────────────
// 6. Breadcrumbs Timeline & Error Reporter
// ────────────────────────────────────────────────────────────────────────────

const OBSERVED_ERROR = Symbol.for("yatta.observed");

export function isAlreadyObserved(error: unknown): boolean {
  return error instanceof Error && Boolean((error as any)[OBSERVED_ERROR]);
}

export function markObserved(error: unknown): void {
  if (error instanceof Error) {
    try {
      Object.defineProperty(error, OBSERVED_ERROR, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    } catch {}
  }
}

export interface Breadcrumb {
  timestamp: number;
  category:
    | "http"
    | "db"
    | "cache"
    | "job"
    | "auth"
    | "mail"
    | "storage"
    | "realtime"
    | "log"
    | "system";
  message: string;
  level: "info" | "warn" | "error" | "debug";
  data?: Record<string, unknown>;
}

export interface ErrorOccurrence {
  id: string;
  fingerprint: string;
  timestamp: number;
  traceId?: string;
  spanId?: string;
  message: string;
  name: string;
  stack?: string;
  parsedFrames: ParsedStackFrame[];
  level: "fatal" | "error" | "warning";
  statusCode?: number;
  request: {
    method?: string;
    url?: string;
    route?: string;
    status?: number;
    headers?: Record<string, string>;
  };
  breadcrumbs: Breadcrumb[];
  handled: boolean;
}

export interface ErrorIssue {
  fingerprint: string;
  status: "unresolved" | "resolved" | "ignored";
  firstSeen: number;
  lastSeen: number;
  count: number;
  statusCode?: number;
  name: string;
  message: string;
  topFrame?: ParsedStackFrame;
  routes: string[];
  occurrences: ErrorOccurrence[];
  sparkline: Array<{ minute: number; count: number }>;
}

export class ErrorReporter {
  readonly issues = new Map<string, ErrorIssue>();
  readonly crumbsStorage = new AsyncLocalStorage<Breadcrumb[]>();
  private globalCrumbs: Breadcrumb[] = [];

  constructor(private readonly observer: Observer) {}

  breadcrumb(
    category: Breadcrumb["category"],
    message: string,
    data?: Record<string, unknown>,
    level: Breadcrumb["level"] = "info",
  ): void {
    const list = this.crumbsStorage.getStore() ?? this.globalCrumbs;
    const sanitizedData = data ? maskPayload(data) : undefined;
    list.push({
      timestamp: performance.timeOrigin + performance.now(),
      category,
      message,
      level,
      data: sanitizedData,
    });
    if (list.length > 50) list.shift();
  }

  capture(
    error: unknown,
    context: { request?: any; route?: string; handled?: boolean } = {},
  ): ErrorIssue {
    const now = performance.timeOrigin + performance.now();
    const parsedFrames = parseStackTrace(
      error instanceof Error ? error.stack : undefined,
    );
    const fingerprint = computeSmartFingerprint(error, parsedFrames);

    let issue = this.issues.get(fingerprint);

    if (isAlreadyObserved(error) && issue) {
      return issue;
    }
    markObserved(error);

    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const req =
      context.request instanceof Request ? context.request : undefined;
    const route =
      context.route ||
      (req ? sanitizeUrlString(new URL(req.url).pathname) : "internal");

    const statusCode =
      (error as { status?: number })?.status ??
      (error as { statusCode?: number })?.statusCode ??
      (context.request && "status" in context.request
        ? context.request.status
        : 500);

    const occurrence: ErrorOccurrence = {
      id: generateSpanId() + generateSpanId(),
      fingerprint,
      timestamp: now,
      traceId: this.observer.tracer.activeTraceId,
      spanId: this.observer.tracer.active?.spanId,
      message,
      name,
      stack,
      parsedFrames,
      level: statusCode >= 500 ? "error" : "warning",
      statusCode,
      request: {
        method: req ? req.method : undefined,
        url: req ? sanitizeUrlString(req.url) : undefined,
        route,
        status: statusCode,
        headers: req ? maskHeaders(req.headers) : undefined,
      },
      breadcrumbs: [...(this.crumbsStorage.getStore() ?? this.globalCrumbs)],
      handled: context.handled ?? true,
    };

    if (!issue) {
      issue = {
        fingerprint,
        status: "unresolved",
        firstSeen: now,
        lastSeen: now,
        count: 0,
        statusCode,
        name,
        message,
        topFrame: parsedFrames.find((f) => f.inApp) ?? parsedFrames[0],
        routes: [route],
        occurrences: [],
        sparkline: [],
      };
      this.issues.set(fingerprint, issue);
    } else if (issue.status === "resolved") {
      issue.status = "unresolved"; // regress on new occurrence
    }

    issue.count++;
    issue.lastSeen = now;
    if (!issue.routes.includes(route)) issue.routes.push(route);
    issue.occurrences.unshift(occurrence);
    if (issue.occurrences.length > 25) issue.occurrences.pop();

    const currentMinute = Math.floor(now / (5 * 60 * 1000));
    const lastBucket = issue.sparkline[issue.sparkline.length - 1];
    if (lastBucket && lastBucket.minute === currentMinute) {
      lastBucket.count++;
    } else {
      issue.sparkline.push({ minute: currentMinute, count: 1 });
      if (issue.sparkline.length > 10) issue.sparkline.shift();
    }

    this.observer.pushError(occurrence);
    return issue;
  }

  /** Groups a pre-built occurrence into the issue queue. */
  ingest(occurrence: ErrorOccurrence): ErrorIssue {
    const fingerprint = occurrence.fingerprint;
    let issue = this.issues.get(fingerprint);

    if (!issue) {
      issue = {
        fingerprint,
        status: "unresolved",
        firstSeen: occurrence.timestamp,
        lastSeen: occurrence.timestamp,
        count: 0,
        statusCode: occurrence.statusCode,
        name: occurrence.name,
        message: occurrence.message,
        topFrame:
          occurrence.parsedFrames.find((f) => f.inApp) ??
          occurrence.parsedFrames[0],
        routes: occurrence.request.route ? [occurrence.request.route] : [],
        occurrences: [],
        sparkline: [],
      };
      this.issues.set(fingerprint, issue);
    } else if (issue.status === "resolved") {
      issue.status = "unresolved";
    }

    issue.count++;
    issue.lastSeen = occurrence.timestamp;
    const route = occurrence.request.route;
    if (route && !issue.routes.includes(route)) issue.routes.push(route);
    issue.occurrences.unshift(occurrence);
    if (issue.occurrences.length > 25) issue.occurrences.pop();

    const currentMinute = Math.floor(occurrence.timestamp / (5 * 60 * 1000));
    const lastBucket = issue.sparkline[issue.sparkline.length - 1];
    if (lastBucket && lastBucket.minute === currentMinute) {
      lastBucket.count++;
    } else {
      issue.sparkline.push({ minute: currentMinute, count: 1 });
      if (issue.sparkline.length > 10) issue.sparkline.shift();
    }

    this.observer.pushError(occurrence);
    return issue;
  }

  applyAction(fingerprint: string, action: "resolve" | "ignore" | "unresolve") {
    const issue = this.issues.get(fingerprint);
    if (issue) {
      issue.status =
        action === "unresolve"
          ? "unresolved"
          : action === "resolve"
            ? "resolved"
            : "ignored";
    }
    return issue;
  }

  stats() {
    const list = [...this.issues.values()];
    return {
      total: list.length,
      unresolved: list.filter((i) => i.status === "unresolved").length,
      resolved: list.filter((i) => i.status === "resolved").length,
      ignored: list.filter((i) => i.status === "ignored").length,
      totalEvents: list.reduce((acc, i) => acc + i.count, 0),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 7. Structured Logging
// ────────────────────────────────────────────────────────────────────────────

export interface LogRecord {
  timestamp: number;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  traceId?: string;
  spanId?: string;
  context: Record<string, unknown>;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_SEVERITY: Record<LogLevel | "silent", number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

function logLevelAllows(
  configured: LogLevel | "silent" | undefined,
  level: LogRecord["level"],
): boolean {
  const floor = LOG_SEVERITY[configured ?? "info"];
  return LOG_SEVERITY[level] >= floor;
}

export class Logger {
  constructor(private readonly observer: Observer) {}

  log(
    level: LogRecord["level"],
    message: string,
    context: Record<string, unknown> = {},
  ): void {
    if (!logLevelAllows(this.observer.config.logLevel, level)) return;

    const maskedContext = maskPayload(context);
    const record: LogRecord = {
      timestamp: performance.timeOrigin + performance.now(),
      level,
      message,
      traceId: this.observer.tracer.activeTraceId,
      spanId: this.observer.tracer.active?.spanId,
      context: maskedContext,
    };
    this.observer.errors.breadcrumb(
      "log",
      message,
      maskedContext,
      level === "fatal" || level === "error" ? "error" : "info",
    );
    this.observer.recordLog(record);
  }

  debug(msg: string, ctx?: Record<string, unknown>) {
    this.log("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>) {
    this.log("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>) {
    this.log("warn", msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>) {
    this.log("error", msg, ctx);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8. Hardware & Kernel Telemetry Engine
// ────────────────────────────────────────────────────────────────────────────

export interface HardwareMetrics {
  os: {
    platform: string;
    arch: string;
    hostname: string;
    uptimeSeconds: number;
    loadAverage: number[];
  };
  cpu: { cores: number; model: string; processCpuPercent: number };
  memory: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
  };
  eventLoop: { delayMs: number; isBlocked: boolean };
  storage: { appDbBytes: number; jobsDbBytes: number; cacheDbBytes: number };
}

export class HardwareEngine {
  private histogram?: ReturnType<typeof monitorEventLoopDelay>;
  private lastCpu = process.cpuUsage();
  private lastCpuTime = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private currentCpuPercent = 0;

  constructor(private readonly observer: Observer) {
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
    } catch {}
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), 3000);
    this.timer.unref?.();
    this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.histogram?.disable();
    } catch {}
  }

  private sample(): void {
    const now = Date.now();
    const elapsedUs = (now - this.lastCpuTime) * 1000;
    if (elapsedUs > 0) {
      const diff = process.cpuUsage(this.lastCpu);
      this.lastCpu = process.cpuUsage();
      this.lastCpuTime = now;
      const totalUs = diff.user + diff.system;
      this.currentCpuPercent = Number(((totalUs / elapsedUs) * 100).toFixed(2));
    }

    /*
     * Retain the sample.
     *
     * Only the values already computed here — calling getSnapshot() from the
     * timer would reset the event-loop histogram mid-flight and steal the
     * measurement window from whoever reads it next.
     */
    const mem = process.memoryUsage();
    this.observer.history.record(now, {
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(3)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(3)),
      heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(3)),
      externalMb: Number((mem.external / 1024 / 1024).toFixed(3)),
      cpuPercent: this.currentCpuPercent,
    });

    /*
     * Queue depth is sampled here too.
     *
     * Backlog direction is derived from a trend over time, and nothing else was
     * ever written to `queueDepth`, so it stayed empty and every report said
     * "unknown" — the same declare-but-never-populate pattern as `release`.
     *
     * Failures are swallowed: a store that cannot be read should not stop the
     * hardware sample.
     */
    const jobsInstance = this.observer.subsystem("jobs") as any;
    if (jobsInstance?.store?.getMetrics) {
      void (async () => {
        try {
          const m = await jobsInstance.store.getMetrics();
          if (typeof m?.queued === "number") {
            this.observer.history.record(Date.now(), { queueDepth: m.queued });
          }
        } catch {
          /* no depth this tick */
        }
      })();
    }
  }

  getSnapshot(): HardwareMetrics {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    let loopDelay = 0;
    if (this.histogram && Number.isFinite(this.histogram.mean)) {
      loopDelay = Number((this.histogram.mean / 1e6).toFixed(2));
      this.histogram.reset();
    }

    const getFileSize = (filePath: string): number => {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    };

    return {
      os: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptimeSeconds: Math.round(os.uptime()),
        loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
      },
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || "V8 Engine",
        processCpuPercent: this.currentCpuPercent,
      },
      memory: {
        totalMb: Math.round(totalMem / (1024 * 1024)),
        freeMb: Math.round(freeMem / (1024 * 1024)),
        usedMb: Math.round((totalMem - freeMem) / (1024 * 1024)),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
        heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(1)),
        externalMb: Number((mem.external / (1024 * 1024)).toFixed(1)),
      },
      eventLoop: { delayMs: loopDelay, isBlocked: loopDelay > 50 },
      storage: {
        appDbBytes: getFileSize("Database/app.db"),
        jobsDbBytes: getFileSize("Database/jobs.db"),
        cacheDbBytes: getFileSize("Database/cache.db"),
      },
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 9. Tracer & Active In-Flight Request Tracker
// ────────────────────────────────────────────────────────────────────────────

export interface HttpTransaction {
  id: string;
  traceId: string;
  method: string;
  route: string;
  url: string;
  status: number;
  durationMs: number;
  clientIp?: string;
  timestamp: number;
  inFlight: boolean;
}

export interface SlowQueryRecord {
  id: string;
  sql: string;
  durationMs: number;
  timestamp: number;
  table?: string;
  traceId?: string;
  spanId?: string;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  action: string;
  target?: string;
  actor: string;
  ip?: string;
  traceId?: string;
  /**
   * Structured detail about the change.
   *
   * Without it an entry says only *that* something happened: "member.updated"
   * cannot answer which role someone moved from or to, which is the whole
   * question an audit log gets consulted for. Optional, so callers with nothing
   * to add are not pushed into inventing a value.
   */
  meta?: Record<string, unknown>;
}

export class Tracer {
  private storage = new AsyncLocalStorage<Span>();
  private inFlightMap = new Map<
    string,
    {
      traceId: string;
      spanId: string;
      start: number;
      method: string;
      route: string;
      url: string;
      ip?: string;
    }
  >();

  constructor(private readonly observer: Observer) {}

  get active(): Span | undefined {
    return this.storage.getStore();
  }

  get activeTraceId(): string | undefined {
    return this.active?.traceId;
  }

  /** Position in the deterministic sampling cycle. */
  private sampleCounter = 0;

  startSpan(
    name: string,
    options: {
      kind?: SpanKind;
      parent?: TraceContext;
      attributes?: Record<string, any>;
      /**
       * AI usage for this span.
       *
       * `AiSpanData` was declared and serialised but had no way in: the Span
       * constructor accepted it while every public entry point dropped it, so
       * the field was unreachable in practice.
       */
      ai?: AiSpanData;
    } = {},
  ): Span {
    const parent =
      options.parent ??
      (this.active
        ? {
            traceId: this.active.traceId,
            spanId: this.active.spanId,
            traceFlags: this.active.traceFlags,
            sampled: this.active.sampled,
          }
        : undefined);

    /*
     * Sampling.
     *
     * `tracesSampleRate` was declared, documented and read by nothing, so every
     * span was always recorded: setting it to 0.01 to cut trace volume still cost
     * full volume. An upstream decision is respected when there is one, and
     * otherwise the rate decides.
     */
    const sampled = parent ? parent.sampled : this.sampleDecision();

    const span = new Span({
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parent?.spanId,
      name,
      kind: options.kind ?? "internal",
      traceFlags: parent?.sampled === undefined ? (sampled ? 1 : 0) : parent?.traceFlags,
      sampled,
      ai: options.ai,
    });

    if (options.attributes) span.setAttributes(options.attributes);
    return span;
  }

  /**
   * Decides whether a request's spans are recorded.
   *
   * Called only for a span with no parent, so one roll covers a whole request:
   * every span below it inherits the decision through the parent chain. Rolling
   * per span would give a request with ten spans a chance of 0.1^10 of being
   * recorded in full, which is not what "10% of requests" means.
   *
   * Not random sampling — a seedable one. A recorded trace is a sample you can
   * read, and a real sample cannot be chosen after seeing the results.
   */
  private sampleDecision(): boolean {
    const rate = this.observer.config.tracesSampleRate ?? 1;

    if (rate >= 1) return true;
    if (rate <= 0) return false;

    /*
     * Take every n-th span, where n is 1/rate.
     *
     * Which ones is decided by position rather than by chance, so the same load
     * always produces the same traces. Counting spans rather than clock time also
     * means the share is a share of the work done, not of how busy the machine
     * happened to be — a rate of 0.1 on a slow day keeps the same ratio.
     */
    const every = Math.max(1, Math.round(1 / rate));

    this.sampleCounter = (this.sampleCounter + 1) % every;

    return this.sampleCounter === 0;
  }

  startRequestSpan(req: Request, route?: string): Span {
    const parent = parseTraceparent(req.headers.get("traceparent"));
    const cleanRoute = route ?? sanitizeUrlString(new URL(req.url).pathname);
    const sanitizedUrl = sanitizeUrlString(req.url);

    let ip = "127.0.0.1";
    if (this.observer.config.trustProxy) {
      ip =
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-real-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "127.0.0.1";
    }

    const span = this.startSpan(`${req.method} ${cleanRoute}`, {
      kind: "server",
      parent: parent ?? undefined,
      attributes: {
        "http.method": req.method,
        "http.url": sanitizedUrl,
        "http.route": cleanRoute,
        "client.address": ip,
      },
    });

    this.inFlightMap.set(span.spanId, {
      traceId: span.traceId,
      spanId: span.spanId,
      start: span.startTime,
      method: req.method,
      route: cleanRoute,
      url: sanitizedUrl,
      ip,
    });

    return span;
  }

  async withSpan<T>(
    name: string,
    options: { kind?: SpanKind; attributes?: Record<string, any>; ai?: AiSpanData },
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return this.storage.run(span, async () => {
      try {
        const res = await fn(span);
        span.ok();
        return res;
      } catch (err) {
        span.recordError(err);
        this.observer.errors.capture(err);
        throw err;
      } finally {
        this.endSpan(span);
      }
    });
  }

  activate<T>(span: Span, fn: () => T): T {
    return this.storage.run(span, fn);
  }

  endSpan(span: Span): Span {
    if (span.finished) return span;
    span.finished = true;
    span.end();

    const inFlightRecord = this.inFlightMap.get(span.spanId);
    if (inFlightRecord) {
      this.inFlightMap.delete(span.spanId);
      const statusCode = span.attributes["http.status_code"]?.number ?? 200;
      this.observer.recordTransaction({
        id: span.spanId,
        traceId: span.traceId,
        method: inFlightRecord.method,
        route: inFlightRecord.route,
        url: inFlightRecord.url,
        status: statusCode,
        durationMs: Number(
          (
            span.durationMs ??
            performance.timeOrigin + performance.now() - inFlightRecord.start
          ).toFixed(1),
        ),
        clientIp: inFlightRecord.ip,
        timestamp: span.startTime,
        inFlight: false,
      });
    }

    this.observer.recordSpan(span);
    return span;
  }

  getInFlightRequests(): HttpTransaction[] {
    const now = performance.timeOrigin + performance.now();
    return [...this.inFlightMap.values()].map((req) => ({
      id: req.spanId,
      traceId: req.traceId,
      method: req.method,
      route: req.route,
      url: req.url,
      status: 0,
      durationMs: Math.round(now - req.start),
      clientIp: req.ip,
      timestamp: req.start,
      inFlight: true,
    }));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 10. Observer Facade & Subsystem Instrumentation
// ────────────────────────────────────────────────────────────────────────────

export interface ObserveConfig {
  service: string;
  release?: string;
  environment?: string;
  version?: string;
  bufferSize?: number;
  dashboard?: boolean;
  dashboardPath?: string;
  dashboardApiKey?: string;
  runtimeMetrics?: boolean;
  runtimeSampleMs?: number;
  logLevel?: LogLevel | "silent";
  slowQueryThresholdMs?: number;
  /**
   * "fixed" uses `slowQueryThresholdMs` as an absolute number.
   *
   * "adaptive" treats it as a multiple of the query's own rolling p95, so a
   * table whose queries normally take 400ms does not flag every one of them and
   * a table that normally takes 5ms still gets caught at 50ms.
   */
  slowQueryMode?: "fixed" | "adaptive";
  /** Window used for adaptive thresholds and baselines. Default 15m. */
  baselineWindowMs?: number;
  /**
   * Service level objectives, evaluated and reported on the dashboard.
   *
   * Each needs real traffic to mean anything — an objective with no samples
   * reports `no-data` rather than a flattering 100%.
   */
  slos?: Array<{
    name: string;
    target: number;
    /** Window in milliseconds, e.g. `30 * 86_400_000` for 30 days. */
    windowMs: number;
    query?: { route?: string; method?: string };
  }>;
  fatalErrorPolicy?: "exit" | "continue";
  trustProxy?: boolean;
  /**
   * Share of requests to trace, from 0 to 1.
   *
   * Defaults to 1, which records every span. At 0.1, roughly one request in ten
   * gets a span, and the rest record nothing.
   *
   * A decision made upstream wins: if an incoming `traceparent` header says the
   * request was not sampled, its spans are not sampled either, whatever this is
   * set to. That keeps a sampled caller from silently losing its trace, and an
   * unsampled one from flooding this service.
   */
  tracesSampleRate?: number;
  subsystems?: Record<string, any>;
  [key: string]: any;
}

/**
 * What an audit entry says when the caller did not say who they were.
 *
 * Deliberately not a person-shaped name. See `ObserverRouter.actorFor`.
 */
const UNKNOWN_ACTOR = "unknown (shared token)";

const OBSERVE_CONFIG_KEYS = new Set([
  "service",
  "release",
  "environment",
  "version",
  "bufferSize",
  "dashboard",
  "dashboardPath",
  "dashboardApiKey",
  "runtimeMetrics",
  "runtimeSampleMs",
  "slowQueryThresholdMs",
  "slowQueryMode",
  "baselineWindowMs",
  "slos",
  "logLevel",
  "fatalErrorPolicy",
  "trustProxy",
  "tracesSampleRate",
  "subsystems",
]);

function validateObserveConfig(config: ObserveConfig): void {
  if (!config || typeof config !== "object") {
    throw new TypeError("createObserver: config object is required");
  }

  const unknown = Object.keys(config).filter(
    (k) => !OBSERVE_CONFIG_KEYS.has(k),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `createObserver: unknown config key(s): ${unknown.join(", ")}. ` +
        `Valid keys: ${[...OBSERVE_CONFIG_KEYS].sort().join(", ")}`,
    );
  }

  if (typeof config.service !== "string" || config.service.length === 0) {
    throw new TypeError(
      'createObserver: "service" is required and must be a non-empty string',
    );
  }

  if (config.tracesSampleRate !== undefined) {
    const rate = config.tracesSampleRate;
    if (typeof rate !== "number" || Number.isNaN(rate) || rate < 0 || rate > 1) {
      throw new TypeError(
        'createObserver: "tracesSampleRate" must be a number from 0 to 1',
      );
    }
  }

  if (config.bufferSize !== undefined && config.bufferSize <= 0) {
    throw new TypeError('createObserver: "bufferSize" must be greater than 0');
  }

  if (config.logLevel !== undefined && !(config.logLevel in LOG_SEVERITY)) {
    throw new TypeError(
      `createObserver: "logLevel" must be one of ${Object.keys(LOG_SEVERITY).join(", ")}`,
    );
  }

  if (
    config.slowQueryMode !== undefined &&
    config.slowQueryMode !== "fixed" &&
    config.slowQueryMode !== "adaptive"
  ) {
    throw new TypeError(
      `createObserver: "slowQueryMode" must be "fixed" or "adaptive", got ${JSON.stringify(config.slowQueryMode)}`,
    );
  }

  for (const [i, slo] of (config.slos ?? []).entries()) {
    if (typeof slo?.name !== "string" || slo.name.length === 0) {
      throw new TypeError(`createObserver: slos[${i}].name is required`);
    }
    if (typeof slo.target !== "number" || slo.target <= 0 || slo.target > 100) {
      throw new TypeError(
        `createObserver: slos[${i}].target must be a percentage above 0 and at most 100`,
      );
    }
    if (typeof slo.windowMs !== "number" || slo.windowMs <= 0) {
      throw new TypeError(
        `createObserver: slos[${i}].windowMs must be greater than 0`,
      );
    }
  }

  if (
    config.baselineWindowMs !== undefined &&
    config.baselineWindowMs <= 0
  ) {
    throw new TypeError('createObserver: "baselineWindowMs" must be greater than 0');
  }

  for (const key of ["runtimeMetrics", "dashboard", "trustProxy"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new TypeError(`createObserver: "${key}" must be a boolean`);
    }
  }
}

const TABLE_METHODS = [
  "findFirst",
  "findMany",
  "findById",
  "insert",
  "insertMany",
  "update",
  "delete",
  "deleteById",
  "count",
] as const;

function isTableHandle(value: object): boolean {
  for (const method of TABLE_METHODS) {
    if (typeof (value as Record<string, unknown>)[method] === "function") {
      return true;
    }
  }
  return false;
}

export class Observer {
  readonly config: ObserveConfig;
  readonly service: string;
  readonly release?: string;
  readonly environment: string;
  readonly version: string;

  readonly tracer: Tracer;
  readonly releases = new ReleaseTimeline(50);
  /*
   * Held as an instance, not constructed per call.
   *
   * The idempotency ledger lives on SafeActions, so building a fresh one per
   * request emptied it every time and a retried destructive action ran twice —
   * exactly the failure the key exists to prevent.
   */
  readonly safeActions = new SafeActions(this as unknown as AnalysisSource);
  /** Traces developers have marked as known-good baselines. */
  readonly goldens = new GoldenTraceStore();
  /**
   * Source lookup for trace-to-code.
   *
   * Replaceable, and unset by default: a production build usually has no sources
   * on disk, and reading files off a running server is not something to enable
   * implicitly.
   */
  sourceResolver?: TraceToCodeResolver;
  /** Retained metric samples, bounded — an unbounded series is itself a leak. */
  readonly history = new MetricsHistory(720);
  readonly baselines = new BaselineEngine(this.history);
  readonly metrics: MetricsRegistry;
  readonly errors: ErrorReporter;
  readonly log: Logger;
  readonly hardware: HardwareEngine;
  readonly router: ObserverRouter;

  readonly spans: RingBuffer<Span>;
  readonly errorLog: RingBuffer<ErrorOccurrence>;
  readonly logs: RingBuffer<LogRecord>;
  readonly transactions: RingBuffer<HttpTransaction>;
  readonly slowQueries: RingBuffer<SlowQueryRecord>;
  readonly auditLogs: RingBuffer<AuditRecord>;

  private attachedSubsystems: Record<string, any> = {};
  private startedAt = performance.timeOrigin + performance.now();
  private safetyHandlersAttached = false;
  private installed = false;
  private sseSubscribers = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private cachedDbStats: {
    lastChecked: number;
    tables: Array<{ name: string; rows: number }>;
  } = { lastChecked: 0, tables: [] };

  constructor(config: ObserveConfig) {
    validateObserveConfig(config);
    this.config = config;
    this.service = config.service || "yatta";
    this.release = config.release;
    this.environment = config.environment || "development";
    this.version = config.version || "1.0.0";

    const bufSize = config.bufferSize || 3000;
    this.spans = new RingBuffer<Span>(bufSize);
    this.errorLog = new RingBuffer<ErrorOccurrence>(bufSize);
    this.logs = new RingBuffer<LogRecord>(bufSize);
    this.transactions = new RingBuffer<HttpTransaction>(500);
    this.slowQueries = new RingBuffer<SlowQueryRecord>(200);
    this.auditLogs = new RingBuffer<AuditRecord>(200);

    this.metrics = new MetricsRegistry();
    this.tracer = new Tracer(this);
    this.errors = new ErrorReporter(this);
    this.log = new Logger(this);
    this.hardware = new HardwareEngine(this);

    this.router = new ObserverRouter(this, {
      basePath: config.dashboardPath || "/_yatta",
      apiKey: config.dashboardApiKey,
      dashboard: config.dashboard ?? true,
    });
  }

  /**
   * Single source of truth for the slow-query threshold.
   *
   * v5 instrumented at 50ms but filtered the buffer at 100ms, so queries in
   * the 50–100ms band were announced as slow yet never recorded. Both sides
   * now read this value.
   */
  get slowQueryThresholdMs(): number {
    return this.config.slowQueryThresholdMs ?? 50;
  }

  private onUnhandledRejection = (reason: any) => {
    this.errors.capture(reason, {
      route: "process.unhandledRejection",
      handled: false,
    });
    this.log.error(
      `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  };

  private onUncaughtException = (error: Error) => {
    this.errors.capture(error, {
      route: "process.uncaughtException",
      handled: false,
    });
    this.log.error(`Uncaught Fatal Exception: ${error.message}`);

    const policy =
      this.config.fatalErrorPolicy ??
      (this.environment === "production" ? "exit" : "continue");

    if (policy === "exit") {
      console.error(
        "[Observer] Fatal error policy is 'exit'. Initiating graceful crash exit...",
      );
      setTimeout(() => process.exit(1), 500).unref();
    }
  };

  start(): void {
    if (this.installed) return;
    this.installed = true;

    if (this.config.runtimeMetrics !== false) this.hardware.start();

    // Heartbeat keeps SSE streams alive through proxies that drop idle
    // connections, and lets clients distinguish "idle" from "dead".
    this.heartbeatTimer = setInterval(() => {
      if (this.sseSubscribers.size === 0) return;
      const bytes = new TextEncoder().encode(": hb " + Date.now() + "\n\n");
      for (const controller of this.sseSubscribers) {
        try {
          controller.enqueue(bytes);
        } catch {
          this.sseSubscribers.delete(controller);
        }
      }
    }, 25_000);
    this.heartbeatTimer.unref?.();

    /*
     * Record the running build.
     *
     * Taken from this observer's own config rather than from a caller, so the
     * release timeline cannot claim a version that isn't the one running — the
     * failure mode that makes a deploy correlation worthless.
     */
    this.releases.record({
      release: this.release ?? "unversioned",
      version: this.version,
      environment: this.environment,
      deployedAt: Date.now(),
      pid: process.pid,
    });

    this.attachSafetyHandlers();
  }

  /**
   * Correlate everything recorded about one issue fingerprint.
   *
   * Returns `null` for an unknown fingerprint. A returned analysis may contain
   * no suspects — that means the data did not explain the failure, which is a
   * legitimate answer, reported as such rather than filled in with a guess.
   */
  analyzeIncident(fingerprint: string): IncidentAnalysis | null {
    return new IncidentAnalyzer(this as unknown as AnalysisSource).analyze(
      fingerprint,
    );
  }

  /**
   * Adaptive threshold for one metric, or null while the baseline is immature.
   *
   * Returning null rather than a number is deliberate: a threshold derived from
   * four samples would flag normal traffic as anomalous.
   */
  adaptiveThreshold(metric: string, windowMs = this.config.baselineWindowMs ?? 900_000): number | null {
    const base = this.baselines.baseline(metric, windowMs);
    if (!base.ready) return null;

    /*
     * median + 3*MAD, with a floor at the 95th percentile.
     *
     * Taking the larger of the two stops a metric that has been perfectly flat
     * (MAD 0) from producing a threshold below its own normal value, which would
     * mark every ordinary reading as an anomaly.
     */
    const madFloor = base.median + 3 * base.mad;
    return Number(Math.max(madFloor, base.p95).toFixed(3));
  }

  /** Evaluate current values against their own history. */
  detectAnomalies(
    values: Record<string, number>,
    windowMs = this.config.baselineWindowMs ?? 900_000,
  ): AnomalyVerdict[] {
    return this.baselines.evaluateAll(values, windowMs);
  }

  /** Memory growth over the baseline window. */
  memoryTrend(
    metric: "rssMb" | "heapUsedMb" | "heapTotalMb" | "externalMb" = "rssMb",
    windowMs = this.config.baselineWindowMs ?? 900_000,
  ): MemoryTrend {
    return analyzeMemoryTrend(this.history, metric, windowMs);
  }

  /**
   * Self-contained incident payload, suitable for a model or a colleague with
   * no access to this process.
   *
   * Conclusions travel with the evidence and the reasons they might be wrong, so
   * a reader cannot act on a suspicion without seeing how weak it is.
   */
  incidentReport(fingerprint: string): IncidentReport | null {
    const source = this as unknown as AnalysisSource;
    const analysis = new IncidentAnalyzer(source).analyze(fingerprint);
    if (!analysis) return null;

    const issue = this.errors.issues.get(fingerprint);
    if (!issue) return null;

    return buildIncidentReport(source, analysis, {
      name: issue.name,
      message: issue.message,
      status: issue.status,
    });
  }

  /**
   * Describe an action without performing it.
   *
   * Separate from `performAction` so a confirmation prompt can show exactly what
   * will be affected before anything happens.
   */
  previewAction(
    request: { kind: string; payload?: Record<string, unknown> },
    fingerprint?: string,
  ): ActionPreview | null {
    const analysis = fingerprint ? this.analyzeIncident(fingerprint) ?? undefined : undefined;
    return this.safeActions.preview(request, analysis);
  }

  /**
   * Perform a guarded action.
   *
   * Enforces confirmation and an idempotency key for anything that changes state,
   * and records an audit entry either way — including for attempts that were
   * blocked, since "someone tried to purge the queue at 3am" is itself the record
   * worth keeping.
   */
  async performAction(
    request: { kind: string; payload?: Record<string, unknown>; idempotencyKey?: string },
    executor: (kind: string, payload: Record<string, unknown>) => unknown | Promise<unknown>,
    options: { confirmed?: boolean; actor?: string } = {},
  ): Promise<ActionOutcome> {
    const outcome = await this.safeActions.execute(request, executor, options);

    this.recordAudit({
      action: `action:${outcome.audit.action}`,
      target: outcome.audit.target,
      actor: options.actor ?? UNKNOWN_ACTOR,
    });

    return outcome;
  }

  /** Capture a live trace as a named baseline to compare future runs against. */
  saveGoldenTrace(name: string, traceId: string): GoldenTrace | null {
    const spans = this.spans.all().filter((s) => s.traceId === traceId);
    if (spans.length === 0) return null;

    const roots = buildSpanTree(spans);
    if (!roots) return null;
    const ordered = flattenTree(roots);
    const root = ordered[0]!;

    return this.goldens.save({
      name,
      traceId,
      savedAt: Date.now(),
      steps: ordered.map((n) => n.span.name),
      stepTimings: ordered.map((n) => ({
        name: n.span.name,
        ms: Number((n.span.durationMs ?? 0).toFixed(1)),
      })),
      totalMs: Number(ordered.reduce((a, n) => a + (n.span.durationMs ?? 0), 0).toFixed(1)),
      route: root.span.attributes["http.route"]?.string,
    });
  }

  /** Compare a live trace against a saved baseline, newest first. */
  compareToGolden(name: string, traceId: string): GoldenTraceComparison | null {
    const golden = this.goldens.find(name);
    if (!golden) return null;

    // The golden trace may no longer be in the ring buffer, so the store
    // compares against its own recorded shape plus the live trace's steps.
    return this.goldens.compare(
      { ...golden, traceId },
      this.spans.all(),
    );
  }

  /**
   * Source lines around a stack frame.
   *
   * Returns a snippet whose `missing` flag is set when no resolver is installed
   * or the file is absent, rather than pretending the line is unknown.
   */
  sourceFor(frame: SourceContext, contextLines?: number): SourceSnippet {
    if (!this.sourceResolver) {
      return {
        filePath: frame.filePath,
        line: frame.line,
        column: frame.column,
        lines: [],
        missing: true,
        reason: "No source resolver configured.",
        caveats: [
          "Source navigation needs a resolver, and production builds usually ship without sources.",
        ],
      };
    }
    return this.sourceResolver.resolve(frame, contextLines);
  }

  /** Dependency graph inferred from recorded spans. */
  serviceMap(): ServiceMap {
    return new ServiceMapBuilder(this as unknown as AnalysisSource).build();
  }

  /** Repeated identical queries under one parent — the N+1 shape. */
  detectNPlusOne(minCalls?: number): NPlusOneFinding[] {
    return new NPlusOneDetector(this as unknown as AnalysisSource).detect(minCalls);
  }

  /** Evaluate one objective. */
  evaluateSlo(
    slo: { name: string; target: number; windowMs: number; query?: { route?: string; method?: string } },
  ): SloResult {
    return new SloEngine(this as unknown as AnalysisSource).evaluate(slo);
  }

  /** Evaluate every configured objective. Empty when none are configured. */
  evaluateSlos(): SloResult[] {
    const configured = this.config.slos ?? [];
    return new SloEngine(this as unknown as AnalysisSource).evaluateAll(configured);
  }

  /**
   * Queue and job health, using retained history for backlog direction.
   *
   * Reads the attached jobs store directly. It previously consulted
   * `AnalysisSource.jobSnapshot`, which nothing ever populated, so every call
   * returned zeros and a null success rate — indistinguishable from a queue
   * that had genuinely done nothing.
   */
  async jobHealth(windowMs = this.config.baselineWindowMs ?? 900_000): Promise<JobHealth> {
    const jobsInstance = this.subsystem("jobs") as any;

    const snapshot = await (async () => {
      if (!jobsInstance?.store?.getMetrics) return undefined;
      try {
        return await jobsInstance.store.getMetrics();
      } catch {
        // A store that cannot be read is "unknown", not an empty queue.
        return undefined;
      }
    })();

    const engine = new JobIntelligence({
      ...(this as unknown as AnalysisSource),
      jobSnapshot: () => snapshot,
    } as AnalysisSource);

    // Sample the depth now, so backlog direction has something to compare
    // against on the next call rather than only accumulating from the timer.
    if (snapshot) {
      this.history.record(Date.now(), { queueDepth: Number(snapshot.queued ?? 0) });
    }

    return engine.health(windowMs);
  }

  /** Per-release health, oldest first. Empty until a release has been recorded. */
  releaseHealth(): ReleaseHealth[] {
    return new ReleaseIntelligence(this as unknown as AnalysisSource).health();
  }

  /**
   * Compare the running release against the previous one.
   *
   * Null when nothing has been recorded yet; on a first deploy it returns a
   * result whose `previousRelease` is null and whose caveats say so.
   */
  whatChanged(release?: string): WhatChanged | null {
    return new ReleaseIntelligence(this as unknown as AnalysisSource).whatChanged(
      release,
    );
  }

  /** Analyse every non-ignored issue, most recent failure first. */
  analyzeAllIncidents(): IncidentAnalysis[] {
    const out: IncidentAnalysis[] = [];
    for (const issue of this.errors.issues.values()) {
      if (issue.status === "ignored") continue;
      const analysis = this.analyzeIncident(issue.fingerprint);
      if (analysis) out.push(analysis);
    }
    return out.sort((a, b) => b.stats.lastSeen - a.stats.lastSeen);
  }

  stop(): void {
    this.installed = false;
    this.hardware.stop();
    this.detachSafetyHandlers();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const ctrl of this.sseSubscribers) {
      try {
        ctrl.close();
      } catch {}
    }
    this.sseSubscribers.clear();
  }

  isInstalled(): boolean {
    return this.installed;
  }

  recordSpan(span: Span): void {
    this.spans.push(span);
  }

  recordError(occurrence: ErrorOccurrence): void {
    this.errors.ingest(occurrence);
  }

  pushError(occurrence: ErrorOccurrence): void {
    this.errorLog.push(occurrence);
    this.notifySse("error", occurrence);
  }

  recordLog(record: LogRecord): void {
    this.logs.push(record);
    this.notifySse("log", record);
  }

  recordTransaction(tx: HttpTransaction): void {
    this.transactions.push(tx);
    this.notifySse("transaction", tx);
  }

  recordSlowQuery(q: SlowQueryRecord): void {
    const table = q.table ?? "unknown";

    /*
     * Two ways to decide what counts as slow.
     *
     * "fixed": an absolute millisecond budget. Predictable, but wrong for a
     * table that legitimately takes 400ms — every query there is flagged and the
     * list becomes noise you learn to ignore.
     *
     * "adaptive": the configured value is a multiple of this query's own rolling
     * p95, so "slow" means slow *for this query*.
     *
     * The duration is recorded before filtering, because otherwise the adaptive
     * threshold could never bootstrap: only already-slow queries would be seen,
     * the p95 would creep toward the threshold and detection would quietly stop.
     */
    if (this.config.slowQueryMode === "adaptive") {
      this.history.record(q.timestamp, {
        [`slowQuery:${table}`]: q.durationMs,
      });
    }

    let threshold = this.slowQueryThresholdMs;
    if (this.config.slowQueryMode === "adaptive") {
      /*
       * In adaptive mode `slowQueryThresholdMs` is a *multiplier*, so it cannot
       * be used as a millisecond budget while warming up — doing so flagged
       * essentially every query as slow for the first few dozen calls.
       *
       * With too little history the query is recorded and left unclassified.
       * Saying "not enough data yet" is the truthful answer; inventing a
       * threshold produces a list nobody reads.
       */
      const windowMs = this.config.baselineWindowMs ?? 900_000;
      const reference = this.baselines.reference(`slowQuery:${table}`, windowMs, 5, q.timestamp);
      if (reference === null) return;
      threshold = reference * this.slowQueryThresholdMs;
    }

    if (q.durationMs < threshold) return;

    this.slowQueries.push(q);
    this.notifySse("slow_query", q);
  }

  recordAudit(audit: Omit<AuditRecord, "id" | "timestamp">): void {
    const entry: AuditRecord = {
      ...audit,
      id: generateSpanId(),
      timestamp: performance.timeOrigin + performance.now(),
    };
    this.auditLogs.push(entry);
    this.notifySse("audit", entry);
  }

  registerSseSubscriber(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): () => void {
    this.sseSubscribers.add(controller);
    return () => this.sseSubscribers.delete(controller);
  }

  private notifySse(event: string, data: any) {
    if (this.sseSubscribers.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = new TextEncoder().encode(payload);
    for (const controller of this.sseSubscribers) {
      try {
        controller.enqueue(bytes);
      } catch {
        this.sseSubscribers.delete(controller);
      }
    }
  }

  private attachSafetyHandlers(): void {
    if (this.safetyHandlersAttached || typeof process === "undefined") return;
    this.safetyHandlersAttached = true;
    process.on("unhandledRejection", this.onUnhandledRejection);
    process.on("uncaughtException", this.onUncaughtException);
  }

  private detachSafetyHandlers(): void {
    if (!this.safetyHandlersAttached || typeof process === "undefined") return;
    this.safetyHandlersAttached = false;
    process.off("unhandledRejection", this.onUnhandledRejection);
    process.off("uncaughtException", this.onUncaughtException);
  }

  // ── Deep Subsystem Auto-Instrumentation ──────────────────────────────────

  attach(name: string, instance: any): any {
    if (!instance) return instance;

    let instrumented = instance;
    if (name === "db") instrumented = this.instrumentDb(instance);
    else if (name === "cache") instrumented = this.instrumentCache(instance);
    else if (name === "jobs") instrumented = this.instrumentJobs(instance);
    else if (name === "auth") instrumented = this.instrumentAuth(instance);
    else if (name === "mail") instrumented = this.instrumentMail(instance);
    else if (name === "storage")
      instrumented = this.instrumentStorage(instance);
    else if (name === "realtime")
      instrumented = this.instrumentRealtime(instance);

    this.attachedSubsystems[name] = instrumented;
    return instrumented;
  }

  get subsystems() {
    return this.attachedSubsystems;
  }

  /** Read-only access to an attached subsystem, for the engines that sample it. */
  subsystem(name: string): unknown {
    return this.attachedSubsystems[name];
  }

  private instrumentDb(db: any): any {
    const self = this;
    const slowThreshold = this.slowQueryThresholdMs;

    const normalizeSql = (sql: string): string => {
      return sql.replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, "?");
    };

    const recordSlow = (
      duration: number,
      sql: string,
      table: string | undefined,
      span: Span,
    ) => {
      if (duration < slowThreshold) return;
      self.recordSlowQuery({
        id: generateSpanId(),
        sql,
        table,
        durationMs: duration,
        timestamp: performance.timeOrigin + performance.now(),
        traceId: span.traceId,
        spanId: span.spanId,
      });
    };

    const origRun = db.run;
    if (typeof origRun === "function") {
      db.run = function (sql: string, params: any[] = [], mode = "all") {
        const start = performance.now();
        const normSql = normalizeSql(sql);
        const span = self.tracer.startSpan("db.query", {
          kind: "client",
          attributes: { "db.statement": normSql, "db.system": "sqlite" },
        });

        try {
          const res = origRun.call(this, sql, params, mode);
          const duration = performance.now() - start;
          span.ok();
          self.tracer.endSpan(span);

          self.errors.breadcrumb(
            "db",
            `Executed SQL (${duration.toFixed(1)}ms): ${normSql.slice(0, 80)}`,
            { durationMs: duration },
          );
          recordSlow(duration, normSql, undefined, span);
          return res;
        } catch (err) {
          span.recordError(err);
          self.tracer.endSpan(span);
          self.errors.capture(err);
          throw err;
        }
      };
    }

    return new Proxy(db, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !val || typeof val !== "object") {
          return val;
        }

        // Only wrap real table handles; wrapping storage drivers broke
        // bun:sqlite private-field access in v5.
        if (!isTableHandle(val)) return val;

        return new Proxy(val, {
          get(tableTarget, tableMethod, tableReceiver) {
            const methodFn = Reflect.get(
              tableTarget,
              tableMethod,
              tableReceiver,
            );
            if (typeof methodFn !== "function") return methodFn;

            return function (this: unknown, ...args: any[]) {
              const start = performance.now();
              const opName = `db.${prop}.${String(tableMethod)}`;
              const span = self.tracer.startSpan(opName, {
                kind: "client",
                attributes: {
                  "db.table": prop,
                  "db.operation": String(tableMethod),
                  "db.system": "sqlite",
                },
              });

              const done = (data: any) => {
                const duration = performance.now() - start;
                span.ok();
                self.tracer.endSpan(span);
                self.errors.breadcrumb(
                  "db",
                  `${prop}.${String(tableMethod)} (${duration.toFixed(1)}ms)`,
                );
                recordSlow(
                  duration,
                  `${prop}.${String(tableMethod)}()`,
                  prop,
                  span,
                );
                return data;
              };
              const failed = (err: any) => {
                span.recordError(err);
                self.tracer.endSpan(span);
                self.errors.capture(err);
                throw err;
              };

              try {
                const res = methodFn.apply(this, args);
                if (res instanceof Promise) return res.then(done, failed);
                return done(res);
              } catch (err) {
                return failed(err);
              }
            };
          },
        });
      },
    });
  }

  private instrumentCache(cache: any): any {
    const self = this;

    const wrap = (methodName: string, category: "get" | "set" | "del") => {
      const orig = cache[methodName];
      if (typeof orig !== "function") return;

      cache[methodName] = async function (...args: any[]) {
        const key = String(args[0] ?? "");
        const safeKey = key.includes(":") ? key.split(":")[0] + ":***" : key;

        const span = self.tracer.startSpan(`cache.${methodName}`, {
          kind: "client",
          attributes: { "cache.key": safeKey, "cache.action": methodName },
        });

        try {
          const res = await orig.apply(this, args);
          if (category === "get") {
            const hit = res !== null && res !== undefined;
            span.setAttribute("cache.hit", hit);
            self.errors.breadcrumb(
              "cache",
              `cache.get "${safeKey}" (${hit ? "HIT" : "MISS"})`,
            );
          } else {
            self.errors.breadcrumb("cache", `cache.${methodName} "${safeKey}"`);
          }
          span.ok();
          return res;
        } catch (err) {
          span.recordError(err);
          self.errors.capture(err);
          throw err;
        } finally {
          self.tracer.endSpan(span);
        }
      };
    };

    wrap("get", "get");
    wrap("set", "set");
    wrap("remember", "get");
    wrap("delete", "del");
    wrap("invalidateTags", "del");
    return cache;
  }

  private instrumentJobs(jobs: any): any {
    const self = this;

    const origHandle = jobs.handle;
    if (typeof origHandle === "function") {
      jobs.handle = function (name: string, handler: (...args: any[]) => any) {
        return origHandle.call(this, name, async function (ctx: any) {
          return self.tracer.withSpan(
            `job.process:${name}`,
            {
              kind: "consumer",
              attributes: { "job.name": name, "job.id": ctx.id },
            },
            async () => {
              self.errors.breadcrumb(
                "job",
                `Processing job "${name}" (#${ctx.id})`,
              );
              try {
                const res = await handler(ctx);
                self.errors.breadcrumb(
                  "job",
                  `Job "${name}" completed successfully`,
                );
                return res;
              } catch (err) {
                self.errors.breadcrumb(
                  "job",
                  `Job "${name}" failed: ${String(err)}`,
                  undefined,
                  "error",
                );
                throw err;
              }
            },
          );
        });
      };
    }

    const origEnqueue = jobs.enqueue;
    if (typeof origEnqueue === "function") {
      jobs.enqueue = async function (name: string, data: any, opts: any) {
        const span = self.tracer.startSpan(`job.enqueue:${name}`, {
          kind: "producer",
          attributes: { "job.name": name },
        });
        self.errors.breadcrumb("job", `Enqueuing job "${name}"`);
        try {
          const res = await origEnqueue.call(this, name, data, opts);
          span.ok();
          return res;
        } catch (err) {
          span.recordError(err);
          self.errors.capture(err);
          throw err;
        } finally {
          self.tracer.endSpan(span);
        }
      };
    }

    return jobs;
  }

  private instrumentAuth(auth: any): any {
    const self = this;
    const methods = [
      "signIn",
      "signUp",
      "signOut",
      "getSession",
      "refresh",
      "reauthenticate",
      "verifyEmail",
    ];

    for (const m of methods) {
      const orig = auth[m];
      if (typeof orig === "function") {
        auth[m] = async function (...args: any[]) {
          const span = self.tracer.startSpan(`auth.${m}`, {
            kind: "internal",
            attributes: { "auth.action": m },
          });
          self.errors.breadcrumb("auth", `Auth operation started: ${m}`);
          try {
            const res = await orig.apply(this, args);
            span.ok();
            self.errors.breadcrumb("auth", `Auth operation succeeded: ${m}`);
            return res;
          } catch (err) {
            span.recordError(err);
            self.errors.breadcrumb(
              "auth",
              `Auth operation failed: ${m}`,
              undefined,
              "warn",
            );
            self.errors.capture(err);
            throw err;
          } finally {
            self.tracer.endSpan(span);
          }
        };
      }
    }
    return auth;
  }

  private instrumentMail(mail: any): any {
    const self = this;
    const origSend = mail.send;
    if (typeof origSend === "function") {
      mail.send = async function (options: any) {
        const span = self.tracer.startSpan("mail.send", {
          kind: "client",
          attributes: { "mail.subject": options.subject },
        });
        self.errors.breadcrumb("mail", `Sending mail: "${options.subject}"`);
        try {
          const res = await origSend.call(this, options);
          span.ok();
          self.errors.breadcrumb("mail", `Mail dispatched: ${res.messageId}`);
          return res;
        } catch (err) {
          span.recordError(err);
          self.errors.capture(err);
          throw err;
        } finally {
          self.tracer.endSpan(span);
        }
      };
    }
    return mail;
  }

  private instrumentStorage(storage: any): any {
    const self = this;
    const methods = [
      "upload",
      "download",
      "delete",
      "copy",
      "move",
      "signedUrl",
    ];

    for (const m of methods) {
      const orig = storage[m];
      if (typeof orig === "function") {
        storage[m] = async function (...args: any[]) {
          const key = typeof args[0] === "string" ? args[0] : "";
          const span = self.tracer.startSpan(`storage.${m}`, {
            kind: "client",
            attributes: { "storage.action": m, "storage.key": key },
          });
          self.errors.breadcrumb("storage", `Storage ${m}: "${key}"`);
          try {
            const res = await orig.apply(this, args);
            span.ok();
            return res;
          } catch (err) {
            span.recordError(err);
            self.errors.capture(err);
            throw err;
          } finally {
            self.tracer.endSpan(span);
          }
        };
      }
    }
    return storage;
  }

  private instrumentRealtime(realtime: any): any {
    const self = this;
    const origTo = realtime.to;
    if (typeof origTo === "function") {
      realtime.to = function (topic: string) {
        const broadcaster = origTo.call(this, topic);
        const origSend = broadcaster.send;
        broadcaster.send = function (event: string, data: any, id?: string) {
          self.errors.breadcrumb(
            "realtime",
            `Broadcast to "${topic}": ${event}`,
          );
          return origSend.call(this, event, data, id);
        };
        return broadcaster;
      };
    }
    return realtime;
  }

  async traceDb<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.withSpan(`db.${name}`, { kind: "client" }, fn);
  }

  async traceJob<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.withSpan(`job.${name}`, { kind: "consumer" }, fn);
  }

  instrument(
    handler: (req: Request) => Response | Promise<Response>,
    routeName?: (req: Request) => string,
  ): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
      const route = routeName
        ? routeName(req)
        : sanitizeUrlString(new URL(req.url).pathname);
      const span = this.tracer.startRequestSpan(req, route);
      const start = performance.now();

      return this.errors.crumbsStorage.run([], async () => {
        this.errors.breadcrumb("http", `${req.method} ${route}`);

        try {
          const res = await this.tracer.activate(span, () => handler(req));
          span.setHttpStatus(res.status);

          const duration = performance.now() - start;

          // Some responses (101 upgrades, already-consumed bodies) cannot be
          // re-wrapped; in that case annotate what we can and return as-is.
          try {
            const cloned = new Response(res.body, res);
            cloned.headers.set("x-trace-id", span.traceId);
            cloned.headers.set(
              "server-timing",
              `total;dur=${duration.toFixed(1)}`,
            );
            return cloned;
          } catch {
            return res;
          }
        } catch (err) {
          span.setHttpStatus(
            (err as { status?: number })?.status ??
              (err as { statusCode?: number })?.statusCode ??
              500,
          );
          span.recordError(err);
          this.errors.capture(err, { request: req, route, handled: false });
          throw err;
        } finally {
          this.tracer.endSpan(span);
        }
      });
    };
  }

  // ── Unified Deep Application Intelligence ────────────────────────────────

  async getDeepApplicationState() {
    const now = performance.timeOrigin + performance.now();
    const hardware = this.hardware.getSnapshot();
    const allSpans = this.spans.all();
    const recentSpans = allSpans.filter((s) => s.startTime >= now - 3600_000);

    const inFlight = this.tracer.getInFlightRequests();
    const recentTransactions = this.transactions.all().reverse().slice(0, 50);

    // Endpoints & Apdex / Latency Analysis
    const serverTxs: Array<{ durationMs: number; status: number }> = [];
    const endpointMap = new Map<
      string,
      { method: string; count: number; errors: number; durations: number[] }
    >();

    for (const s of recentSpans) {
      if (s.kind === "server") {
        const method = s.attributes["http.method"]?.string || "GET";
        const route = s.attributes["http.route"]?.string || s.name;
        const key = `${method} ${route}`;
        let e = endpointMap.get(key);
        if (!e) {
          e = { method, count: 0, errors: 0, durations: [] };
          endpointMap.set(key, e);
        }
        e.count++;
        const d = s.durationMs ?? 0;
        e.durations.push(d);

        const status =
          s.attributes["http.status_code"]?.number ??
          (s.status === "error" ? 500 : 200);
        serverTxs.push({ durationMs: d, status });

        if (s.status === "error" || status >= 500) e.errors++;
      }
    }

    const apdexStats = computeApdexAndPercentiles(serverTxs, 100);

    const endpoints = [...endpointMap.entries()]
      .map(([k, v]) => {
        const sorted = [...v.durations].sort((a, b) => a - b);
        const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
        return {
          operationId: k.split(" ")[1] || k,
          method: v.method,
          count: v.count,
          failureRate:
            v.count > 0 ? Number(((v.errors / v.count) * 100).toFixed(2)) : 0,
          avgMs: Number(avg.toFixed(1)),
          p95Ms: Number(percentile(sorted, 95).toFixed(1)),
        };
      })
      .sort((a, b) => b.count - a.count);

    // Subsystem attributions (true own time via child-span subtraction)
    const childDurationMap = new Map<string, number>();
    for (const s of recentSpans) {
      if (s.parentSpanId) {
        const cur = childDurationMap.get(s.parentSpanId) ?? 0;
        childDurationMap.set(s.parentSpanId, cur + (s.durationMs ?? 0));
      }
    }

    const serviceAttribution = new Map<
      string,
      { calls: number; errors: number; ownTimeMs: number; totalTimeMs: number }
    >();

    for (const s of recentSpans) {
      let className = "AppRouter";
      if (s.name.startsWith("db.")) className = "Database";
      else if (s.name.startsWith("job.")) className = "Jobs & Queues";
      else if (s.name.startsWith("cache.")) className = "Cache";
      else if (s.name.startsWith("auth.")) className = "Auth";
      else if (s.name.startsWith("storage.")) className = "Storage";
      else if (s.name.startsWith("mail.")) className = "Mail";
      else if (s.name.startsWith("realtime.")) className = "Realtime";

      let record = serviceAttribution.get(className);
      if (!record) {
        record = { calls: 0, errors: 0, ownTimeMs: 0, totalTimeMs: 0 };
        serviceAttribution.set(className, record);
      }
      record.calls++;
      if (s.status === "error") record.errors++;
      const totalSpanMs = s.durationMs ?? 0;
      const childSum = childDurationMap.get(s.spanId) ?? 0;
      record.totalTimeMs += totalSpanMs;
      record.ownTimeMs += Math.max(0, totalSpanMs - childSum);
    }

    const totalOwnTime =
      [...serviceAttribution.values()].reduce(
        (acc, v) => acc + v.ownTimeMs,
        0,
      ) || 1;

    const services = [...serviceAttribution.entries()]
      .map(([name, s]) => ({
        className: name,
        ownTimeMs: Math.round(s.ownTimeMs),
        ownTimePct: Number(((s.ownTimeMs / totalOwnTime) * 100).toFixed(1)),
        avgOwnMs: Number((s.ownTimeMs / (s.calls || 1)).toFixed(1)),
        totalTimeMs: Math.round(s.totalTimeMs),
        calls: s.calls,
        errors: s.errors,
      }))
      .sort((a, b) => b.ownTimeMs - a.ownTimeMs);

    // Cached DB metadata inspection (prevents poll storms)
    const dbInstance = this.attachedSubsystems["db"];
    let databaseStats = {
      tables: this.cachedDbStats.tables,
      path: dbInstance?.path || "Database/app.db",
      journalMode: "WAL",
    };

    if (dbInstance?.sqlite && now - this.cachedDbStats.lastChecked > 30_000) {
      try {
        const tableRows = dbInstance.sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_yatta_%'",
          )
          .all() as Array<{ name: string }>;

        const tables = tableRows.map((t) => {
          let rows = 0;
          try {
            const countRes = dbInstance.sqlite
              .query(`SELECT COUNT(*) as count FROM "${t.name}"`)
              .get() as { count: number };
            rows = countRes.count;
          } catch {}
          return { name: t.name, rows };
        });

        this.cachedDbStats = { lastChecked: now, tables };
        databaseStats.tables = tables;
      } catch {}
    }

    // Jobs & DLQ
    const jobsInstance = this.subsystem("jobs") as any;
    let queueMetrics = {
      queued: 0,
      delayed: 0,
      running: 0,
      completed: 0,
      dead: 0,
      total: 0,
    };
    let deadJobs: any[] = [];
    if (jobsInstance?.store) {
      try {
        queueMetrics = await jobsInstance.store.getMetrics();
        deadJobs = await jobsInstance.store.listDead(undefined, 15);
      } catch {}
    }

    const cacheInstance = this.attachedSubsystems["cache"];
    let cacheMetrics = {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
      size: 0,
      hitRatio: 0,
    };
    if (cacheInstance?.getMetrics) cacheMetrics = cacheInstance.getMetrics();

    const realtimeInstance = this.attachedSubsystems["realtime"];
    let realtimeStats = {
      websocketConnections: 0,
      sseConnections: 0,
      topics: 0,
      messagesSent: 0,
      messagesReceived: 0,
    };
    if (realtimeInstance?.stats) realtimeStats = realtimeInstance.stats();

    const mailInstance = this.attachedSubsystems["mail"];
    let mailStats = {
      sent: 0,
      failed: 0,
      rejected: 0,
      mode: mailInstance?.mode || "terminal",
    };
    if (mailInstance?.stats)
      mailStats = { ...mailStats, ...mailInstance.stats() };

    // Timeline buckets
    const buckets: Array<{
      time: string;
      c2xx: number;
      c4xx: number;
      c5xx: number;
      avgMs: number;
      p95Ms: number;
    }> = [];

    for (let i = 29; i >= 0; i--) {
      const bStart = now - (i + 1) * 60_000;
      const bEnd = now - i * 60_000;
      const bSpans = recentSpans.filter(
        (s) =>
          s.kind === "server" && s.startTime >= bStart && s.startTime < bEnd,
      );

      let c2xx = 0,
        c4xx = 0,
        c5xx = 0;
      const durs: number[] = [];
      for (const bs of bSpans) {
        const code = bs.attributes["http.status_code"]?.number ?? 200;
        if (code >= 500) c5xx++;
        else if (code >= 400) c4xx++;
        else c2xx++;
        durs.push(bs.durationMs ?? 0);
      }
      durs.sort((a, b) => a - b);
      const avg = durs.reduce((a, b) => a + b, 0) / (durs.length || 1);
      const p95 = percentile(durs, 95);

      const dateObj = new Date(bEnd);
      const timeStr = `${dateObj.getHours().toString().padStart(2, "0")}:${dateObj.getMinutes().toString().padStart(2, "0")}`;
      buckets.push({
        time: timeStr,
        c2xx,
        c4xx,
        c5xx,
        avgMs: Math.round(avg),
        p95Ms: Math.round(p95),
      });
    }

    const alerts: Array<{ level: "critical" | "warning"; message: string }> =
      [];
    if (hardware.eventLoop.isBlocked) {
      alerts.push({
        level: "critical",
        message: `Event loop lag (${hardware.eventLoop.delayMs}ms) exceeds safety budget.`,
      });
    }
    if (queueMetrics.dead > 0) {
      alerts.push({
        level: "warning",
        message: `${queueMetrics.dead} dead job(s) present in DLQ awaiting review.`,
      });
    }
    if (this.errors.stats().unresolved > 5) {
      alerts.push({
        level: "warning",
        message: `${this.errors.stats().unresolved} unresolved application defects detected.`,
      });
    }

    return {
      service: this.service,
      environment: this.environment,
      version: this.version,
      generatedAt: now,
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      hardware,
      apdex: apdexStats,
      alerts,
      endpoints,
      inFlight,
      recentTransactions,
      slowQueries: this.slowQueries.all().reverse().slice(0, 30),
      services,
      database: databaseStats,
      queues: { metrics: queueMetrics, dead: deadJobs },
      cache: cacheMetrics,
      realtime: realtimeStats,
      mail: mailStats,
      errors: this.errors.stats(),
      audit: this.auditLogs.all().reverse().slice(0, 30),
      buckets,
    };
  }

  getTraceWaterfall(traceId: string) {
    const traceSpans = this.spans
      .all()
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startTime - b.startTime);

    if (traceSpans.length === 0) return null;

    const rootSpan = traceSpans.find((s) => !s.parentSpanId) ?? traceSpans[0]!;
    const rootStart = rootSpan.startTime;
    const rootDuration = Math.max(
      1,
      rootSpan.durationMs ??
        Math.max(
          ...traceSpans.map((s) => (s.endTime ?? s.startTime) - rootStart),
        ),
    );

    // Compute tree depth for indentation.
    const depthMap = new Map<string, number>();
    const depthOf = (s: Span): number => {
      const cached = depthMap.get(s.spanId);
      if (cached !== undefined) return cached;
      if (!s.parentSpanId) {
        depthMap.set(s.spanId, 0);
        return 0;
      }
      const parent = traceSpans.find((p) => p.spanId === s.parentSpanId);
      const d = parent ? depthOf(parent) + 1 : 0;
      depthMap.set(s.spanId, d);
      return d;
    };

    const items = traceSpans.map((s) => {
      const offsetMs = Math.max(0, s.startTime - rootStart);
      const durationMs = s.durationMs ?? 0;
      return {
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        kind: s.kind,
        status: s.status,
        depth: depthOf(s),
        offsetMs: Math.round(offsetMs),
        durationMs: Math.round(durationMs),
        leftPct: Number(((offsetMs / rootDuration) * 100).toFixed(2)),
        widthPct: Math.max(
          1,
          Number(((durationMs / rootDuration) * 100).toFixed(2)),
        ),
        attributes: s.attributes,
        events: s.events,
      };
    });

    return {
      traceId,
      rootSpan: rootSpan.name,
      totalDurationMs: Math.round(rootDuration),
      spans: items,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 11. Router for Telemetry API & Dashboard
// ────────────────────────────────────────────────────────────────────────────

export class ObserverRouter {
  readonly basePath: string;
  private readonly apiKey?: string;
  private readonly withDashboard: boolean;

  constructor(
    private readonly observer: Observer,
    options: { basePath?: string; apiKey?: string; dashboard?: boolean } = {},
  ) {
    this.basePath = (options.basePath || "/_yatta").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.withDashboard = options.dashboard ?? true;
  }

  /** Real work behind a guarded action. Only reached after the guard approves. */
  private async runAnalysisAction(
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const o = this.observer;
    switch (kind) {
      case "resolve-issue":
      case "ignore-issue": {
        const fp = String(payload.fingerprint ?? "");
        const action = kind === "resolve-issue" ? "resolve" : "ignore";
        return { issue: o.errors.applyAction(fp, action as "resolve" | "ignore") };
      }
      case "clear-cache": {
        // `subsystems`, not a property on the observer. `(o as any).cache` was always
        // undefined, so the *guarded* path silently did nothing while the unguarded
        // endpoint did the work — which is the wrong way round for a guard.
        const cache = o.subsystems["cache"];
        if (!cache?.clear) return { cleared: 0, note: "No cache subsystem attached." };
        return { cleared: await cache.clear() };
      }
      case "replay-dead-job": {
        const dlq = o.subsystems["jobs"]?.dlq;
        const id = String(payload.id ?? "");
        if (!dlq) return { ok: false, note: "No jobs subsystem attached." };
        if (!id) return { ok: false, note: "A job id is required." };
        await dlq.retry(id);
        return { replayed: id };
      }
      case "purge-dead-jobs": {
        const dlq = o.subsystems["jobs"]?.dlq;
        if (!dlq) return { ok: false, note: "No jobs subsystem attached." };
        await dlq.purge();
        return { purged: true };
      }
      default:
        // The guard has already refused anything it considers unsafe, so reaching
        // here means an unknown kind slipped through rather than something failed.
        return { ok: false, kind, note: "No executor registered for this action." };
    }
  }

  /**
   * Who to record an audit entry against.
   *
   * Read from `x-observe-actor` when the caller sends one, and otherwise stated as
   * unknown. The dashboard is behind a single shared token, so the server has no way
   * to tell two people holding that token apart — which means every entry used to say
   * `dashboard_operator` and the audit log could not answer "who flushed the cache".
   *
   * The header is a self-declared label, not an identity: anyone with the token can
   * put anything in it. It is useful for telling a CI job from a human, and worthless
   * as proof. Anything that needs to attribute an action to a person needs real
   * authentication, not this.
   */
  private actorFor(req: Request): string {
    const claimed = req.headers.get("x-observe-actor")?.trim();

    if (!claimed) return UNKNOWN_ACTOR;

    // Bounded and printable, so an audit record cannot be used to inject newlines
    // into whatever reads it next.
    return claimed.replace(/[^\w .:@/-]/g, "").slice(0, 64) || UNKNOWN_ACTOR;
  }

  matches(pathname: string): boolean {
    return (
      pathname === this.basePath || pathname.startsWith(`${this.basePath}/`)
    );
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!this.matches(url.pathname)) return null;

    if (this.apiKey && req.headers.get("x-observe-key") !== this.apiKey) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const route = url.pathname.slice(this.basePath.length) || "/";

    if (
      req.method === "GET" &&
      (route === "/" || route === "/dashboard" || route === "/observe")
    ) {
      if (!this.withDashboard) {
        return Response.json({ error: "Dashboard disabled" }, { status: 404 });
      }
      return new Response(renderApplicationConsole(this.observer), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && route === "/api/stream") {
      let unsubscribe: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          unsubscribe = this.observer.registerSseSubscriber(controller);
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
        cancel: () => {
          unsubscribe?.();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (req.method === "GET" && route === "/api/telemetry") {
      const data = await this.observer.getDeepApplicationState();
      return Response.json(data);
    }

    if (req.method === "GET" && route.startsWith("/api/traces/")) {
      const traceId = route.split("/").pop()!;
      const waterfall = this.observer.getTraceWaterfall(traceId);
      if (!waterfall) {
        return Response.json({ error: "Trace not found" }, { status: 404 });
      }
      return Response.json(waterfall);
    }

    if (req.method === "GET" && route === "/api/errors") {
      return Response.json({
        issues: [...this.observer.errors.issues.values()],
        stats: this.observer.errors.stats(),
      });
    }

    if (req.method === "POST" && route.startsWith("/api/errors/")) {
      const action = route.split("/").pop() as
        | "resolve"
        | "ignore"
        | "unresolve";
      const fp = url.searchParams.get("fingerprint");
      if (!fp) {
        return Response.json({ error: "Missing fingerprint" }, { status: 400 });
      }
      const updated = this.observer.errors.applyAction(fp, action);
      this.observer.recordAudit({
        action: `errors.${action}`,
        target: fp,
        actor: this.actorFor(req),
      });
      return Response.json({ ok: true, issue: updated });
    }

    /*
     * The three endpoints below used to run their work inline and record an audit
     * entry afterwards. That left the guard — confirmation, idempotency, and a record
     * of refused attempts — bypassable by calling the URL, which is exactly what
     * someone would do. The comment above `/api/analysis/action/` claimed that could
     * not happen; it could.
     *
     * They now go through `performAction` like every other state change, so a
     * double-clicked purge is recognised rather than re-run, and an unconfirmed one is
     * refused and logged as an attempt.
     */
    const guarded: Record<string, string> = {
      "/api/jobs/replay-dead": "replay-dead-job",
      "/api/jobs/purge-dead": "purge-dead-jobs",
      "/api/cache/clear": "clear-cache",
    };

    const kind = guarded[route];
    if (req.method === "POST" && kind) {
      const body = (await req.json().catch(() => ({}))) as {
        idempotencyKey?: string;
        confirmed?: boolean;
      };

      const outcome = await this.observer.performAction(
        {
          kind,
          payload: { id: url.searchParams.get("id") ?? "" },
          // Falls back to the URL's own value, so a curl without a body still gets
          // keying rather than an unguarded action.
          idempotencyKey: body.idempotencyKey ?? url.searchParams.get("key") ?? undefined,
        },
        (actionKind, payload) => this.runAnalysisAction(actionKind, payload),
        {
          confirmed:
            body.confirmed === true || url.searchParams.get("confirmed") === "true",
          actor: this.actorFor(req),
        },
      );

      return Response.json(outcome, { status: outcome.ok ? 200 : 400 });
    }

    if (req.method === "GET" && route === "/api/logs") {
      return Response.json({
        logs: this.observer.logs.all().reverse().slice(0, 300),
      });
    }

    /*
     * Analysis endpoints.
     *
     * Each returns the engine's own `unknowns` and `caveats` alongside its
     * findings. Stripping those at the API boundary would leave a caller showing
     * "Likely cause: connection pool" with no indication it is a guess, which is
     * the one thing this whole feature exists to prevent.
     */
    if (req.method === "GET" && route === "/api/analysis/state") {
      return Response.json({
        incidents: this.observer.analyzeAllIncidents().slice(0, 25),
        releases: this.observer.releaseHealth(),
        whatChanged: this.observer.whatChanged(),
        serviceMap: this.observer.serviceMap(),
        slos: this.observer.evaluateSlos(),
        jobs: this.observer.jobHealth(),
        memory: this.observer.memoryTrend(),
        nPlusOne: this.observer.detectNPlusOne().slice(0, 10),
      });
    }

    if (req.method === "GET" && route.startsWith("/api/analysis/incident/")) {
      const fingerprint = decodeURIComponent(route.slice("/api/analysis/incident/".length));
      const analysis = this.observer.analyzeIncident(fingerprint);
      if (!analysis) return Response.json({ error: "Unknown fingerprint" }, { status: 404 });
      return Response.json(analysis);
    }

    if (req.method === "GET" && route.startsWith("/api/analysis/report/")) {
      const fingerprint = decodeURIComponent(route.slice("/api/analysis/report/".length));
      const report = this.observer.incidentReport(fingerprint);
      if (!report) return Response.json({ error: "Unknown fingerprint" }, { status: 404 });
      return Response.json(report);
    }

    if (req.method === "GET" && route === "/api/analysis/goldens") {
      return Response.json({ goldens: this.observer.goldens.all() });
    }

    if (req.method === "POST" && route.startsWith("/api/analysis/goldens/")) {
      const name = decodeURIComponent(route.slice("/api/analysis/goldens/".length));
      const traceId = url.searchParams.get("trace") ?? "";
      const saved = this.observer.saveGoldenTrace(name, traceId);
      if (!saved) {
        return Response.json(
          { error: "No spans recorded for that trace. It may have aged out of the buffer." },
          { status: 404 },
        );
      }
      this.observer.recordAudit({
        action: "goldens.save",
        target: name,
        actor: this.actorFor(req),
      });
      return Response.json({ ok: true, golden: saved });
    }

    if (req.method === "GET" && route.startsWith("/api/analysis/compare/")) {
      const name = decodeURIComponent(route.slice("/api/analysis/compare/".length));
      const traceId = url.searchParams.get("trace") ?? "";
      const result = this.observer.compareToGolden(name, traceId);
      if (!result) return Response.json({ error: "Unknown golden trace" }, { status: 404 });
      return Response.json(result);
    }

    /*
     * Actions are routed through the guard rather than executed inline, so
     * confirmation and idempotency cannot be bypassed by calling the endpoint
     * directly — which is exactly what someone would do.
     */
    if (req.method === "POST" && route.startsWith("/api/analysis/action/")) {
      const kind = decodeURIComponent(route.slice("/api/analysis/action/".length));
      const body = (await req.json().catch(() => ({}))) as {
        payload?: Record<string, unknown>;
        idempotencyKey?: string;
        confirmed?: boolean;
      };

      const outcome = await this.observer.performAction(
        { kind, payload: body.payload, idempotencyKey: body.idempotencyKey },
        (actionKind, payload) => this.runAnalysisAction(actionKind, payload),
        {
          confirmed:
            body.confirmed === true || url.searchParams.get("confirmed") === "true",
          actor: this.actorFor(req),
        },
      );

      return Response.json(outcome, { status: outcome.ok ? 200 : 400 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 12. Factory, Singletons & main.ts Exports
// ────────────────────────────────────────────────────────────────────────────

const GLOBAL_OBSERVER_KEY = Symbol.for("yatta.observe.default");
const g = globalThis as unknown as { [GLOBAL_OBSERVER_KEY]?: Observer };

/**
 * Creates and starts a new {@link Observer}.
 *
 * Always constructs. It used to return a cached instance on every call after the
 * first, which meant the second caller's config was silently discarded *and*
 * config validation was skipped entirely on that path — so a typo in the second
 * observer's config threw nothing and simply had no effect. Two observers then
 * shared one set of counters, and a test asserting against a fresh observer read
 * the first one's state.
 *
 * For a process-wide shared instance use {@link getDefaultObserver} or the
 * {@link observer} proxy, which is what most applications want.
 */
export function createObserver(config?: ObserveConfig): Observer {
  const cfg = config ?? { service: "yatta", environment: "development" };

  // Validated before construction on every call, not only the first. A factory
  // that checks its first argument and then stops is not validating.
  validateObserveConfig(cfg);

  const obs = new Observer(cfg);
  obs.start();
  return obs;
}

export function getDefaultObserver(): Observer {
  if (!g[GLOBAL_OBSERVER_KEY]) {
    g[GLOBAL_OBSERVER_KEY] = new Observer({
      service: "yatta",
      environment: process.env.NODE_ENV ?? "development",
    });
    g[GLOBAL_OBSERVER_KEY]!.start();
  }
  return g[GLOBAL_OBSERVER_KEY]!;
}

export const observer: Observer = new Proxy(
  function () {} as unknown as Observer,
  {
    get(_t, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_t, prop, receiver);
      }
      const instance = getDefaultObserver();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);

export function attachSubsystems(subsystems: {
  db?: unknown;
  auth?: unknown;
  jobs?: unknown;
  cache?: unknown;
  storage?: unknown;
  mail?: unknown;
  realtime?: unknown;
}): void {
  const obs = getDefaultObserver();
  if (subsystems.db) obs.attach("db", subsystems.db);
  if (subsystems.auth) obs.attach("auth", subsystems.auth);
  if (subsystems.jobs) obs.attach("jobs", subsystems.jobs);
  if (subsystems.cache) obs.attach("cache", subsystems.cache);
  if (subsystems.storage) obs.attach("storage", subsystems.storage);
  if (subsystems.mail) obs.attach("mail", subsystems.mail);
  if (subsystems.realtime) obs.attach("realtime", subsystems.realtime);
}

export const traceDb = (name: string, fn: (span: Span) => Promise<any>) =>
  getDefaultObserver().traceDb(name, fn);

export const traceJob = (name: string, fn: (span: Span) => Promise<any>) =>
  getDefaultObserver().traceJob(name, fn);

export function report(error: unknown, request?: Request): void {
  getDefaultObserver().errors.capture(error, request ? { request } : {});
}

export function observeDashboard(obs: Observer = getDefaultObserver()) {
  return async (req: Request): Promise<Response | null> => {
    return obs.router.handle(req);
  };
}

/*
 * `rumScript` used to live here. It set `window.__yatta_rum` and nothing ever read
 * that variable, so pasting the snippet cost a script tag and produced no
 * measurements at all — worse than offering nothing, because the tag reads as
 * proof that browser telemetry is on.
 *
 * Browser RUM needs an endpoint to accept beacons and a place to show them, and
 * neither existed. It is left out rather than stubbed; `collectTrace` covers
 * server-side tracing, and a beacon endpoint is the honest next step.
 */

// ────────────────────────────────────────────────────────────────────────────
// 13. Application Control Console (v6.0 — redesigned UI)
// ────────────────────────────────────────────────────────────────────────────

function renderApplicationConsole(observer: Observer): string {
  const basePath = observer.router.basePath;
  const safeService = escapeHtml(observer.service);
  const safeEnv = escapeHtml(observer.environment);

  return `<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${safeService} — Mission Control</title>
  <style>
    :root {
      --bg: #08090d;
      --bg-elev: #0c0e14;
      --sidebar: #0a0c11;
      --card: #10121a;
      --card-2: #141724;
      --hover: #181c2b;
      --border: #1d2231;
      --border-strong: #2a3047;
      --text: #eef0f6;
      --muted: #8e96ab;
      --faint: #5a6178;
      --accent: #f43f5e;
      --accent-soft: rgba(244, 63, 94, 0.12);
      --cyan: #22d3ee;
      --indigo: #818cf8;
      --amber: #fbbf24;
      --emerald: #34d399;
      --rose: #fb7185;
      --violet: #c084fc;
      --orange: #fb923c;
      --teal: #2dd4bf;
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      --r-sm: 6px; --r-md: 9px; --r-lg: 12px;
      --shadow: 0 8px 24px rgba(0,0,0,0.35);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: #232838; border-radius: 6px; border: 2px solid var(--bg); }
    ::-webkit-scrollbar-track { background: transparent; }
    .mono { font-family: var(--mono); }
    button { font-family: inherit; }

    /* ── Sidebar ─────────────────────────────────────────── */
    aside {
      width: 236px;
      background: var(--sidebar);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      z-index: 30;
    }
    .brand {
      display: flex; align-items: center; gap: 11px;
      padding: 15px 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand-mark {
      width: 32px; height: 32px; border-radius: 8px;
      background: linear-gradient(135deg, #fb7185, #be123c);
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 15px; color: #fff;
      box-shadow: 0 0 18px rgba(244,63,94,0.35), inset 0 1px 0 rgba(255,255,255,0.25);
      flex-shrink: 0;
    }
    .brand-name { font-weight: 700; font-size: 13.5px; letter-spacing: -0.01em; }
    .brand-env {
      font-family: var(--mono); font-size: 10.5px; color: var(--muted);
      display: inline-flex; align-items: center; gap: 5px; margin-top: 1px;
    }
    .env-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); }
    nav { flex: 1; overflow-y: auto; padding: 10px 8px 16px; }
    .nav-label {
      padding: 14px 10px 5px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--faint);
    }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 10px; margin: 1px 0;
      border-radius: var(--r-sm);
      color: var(--muted); cursor: pointer;
      font-size: 12.5px; font-weight: 500;
      border: none; background: none; width: 100%; text-align: left;
      transition: background 0.12s, color 0.12s;
    }
    .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.035); }
    .nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .nav-item.active {
      color: #fff;
      background: linear-gradient(90deg, var(--accent-soft), rgba(244,63,94,0.03));
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .nav-item svg { width: 15px; height: 15px; opacity: 0.9; flex-shrink: 0; }
    .nav-count {
      margin-left: auto;
      background: #2a1220; color: var(--rose);
      font-size: 10px; font-weight: 700;
      padding: 1px 7px; border-radius: 999px;
      border: 1px solid rgba(244,63,94,0.25);
    }
    .nav-count.zero { background: #141826; color: var(--faint); border-color: var(--border); }
    .sidebar-foot {
      padding: 12px 16px; border-top: 1px solid var(--border);
      font-family: var(--mono); font-size: 10.5px; color: var(--faint);
    }

    /* ── Main / Topbar ───────────────────────────────────── */
    main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
    header {
      height: 54px; flex-shrink: 0;
      display: flex; align-items: center; gap: 16px;
      padding: 0 20px;
      border-bottom: 1px solid var(--border);
      background: rgba(10,12,17,0.85);
      backdrop-filter: blur(10px);
      z-index: 20;
    }
    .view-title { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
    .view-crumb { color: var(--faint); font-weight: 500; }
    .searchbox {
      flex: 1; max-width: 380px; margin-left: auto;
      display: flex; align-items: center; gap: 8px;
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--r-sm); padding: 6px 11px;
      transition: border-color 0.15s;
    }
    .searchbox:focus-within { border-color: var(--border-strong); }
    .searchbox input {
      background: none; border: none; outline: none; color: var(--text);
      font-size: 12.5px; width: 100%; font-family: inherit;
    }
    .searchbox input::placeholder { color: var(--faint); }
    .searchbox kbd {
      font-family: var(--mono); font-size: 10px; color: var(--faint);
      border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
      background: var(--bg-elev); flex-shrink: 0;
    }
    .pill {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 12px; border-radius: 999px;
      background: var(--card); border: 1px solid var(--border);
      font-size: 11px; font-weight: 600; cursor: pointer;
      color: var(--muted); white-space: nowrap;
      transition: all 0.15s;
    }
    .pill:hover { border-color: var(--border-strong); color: var(--text); }
    .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
    .pill.live .dot { background: var(--emerald); box-shadow: 0 0 9px var(--emerald); animation: pulse 2.2s infinite; }
    .pill.dead .dot { background: var(--amber); box-shadow: 0 0 9px var(--amber); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

    .content { flex: 1; overflow-y: auto; padding: 20px; scroll-behavior: smooth; }
    section[data-view] { display: none; }
    section[data-view].on { display: block; }

    /* ── Alerts ──────────────────────────────────────────── */
    .alert {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-radius: var(--r-md);
      font-size: 12.5px; margin-bottom: 10px; font-weight: 500;
    }
    .alert.critical { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.35); color: #fca5a5; }
    .alert.warning { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); color: #fcd34d; }
    .alert svg { width: 15px; height: 15px; flex-shrink: 0; }

    /* ── Cards & grids ───────────────────────────────────── */
    .grid { display: grid; gap: 14px; margin-bottom: 14px; }
    .grid.kpi { grid-template-columns: repeat(5, 1fr); }
    .grid.two { grid-template-columns: 1fr 1fr; }
    .grid.four { grid-template-columns: repeat(4, 1fr); }
    .grid.five { grid-template-columns: repeat(5, 1fr); }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .card-h {
      padding: 11px 16px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      font-size: 11px; font-weight: 650; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--muted);
      background: rgba(255,255,255,0.015);
    }
    .card-b { padding: 16px; }
    .kpi-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
    .kpi-val { font-size: 24px; font-weight: 700; letter-spacing: -0.03em; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 2px; min-height: 16px; }
    .kpi-spark { margin-top: 8px; height: 30px; }
    .kpi-spark svg { width: 100%; height: 100%; display: block; }

    /* ── Charts ──────────────────────────────────────────── */
    .chart-box { height: 140px; position: relative; }
    .chart-box svg { width: 100%; height: 100%; display: block; overflow: visible; }
    .legend { display: flex; gap: 14px; font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

    /* ── Gauges ──────────────────────────────────────────── */
    .gauge-track { height: 6px; background: var(--bg-elev); border-radius: 999px; margin-top: 10px; overflow: hidden; }
    .gauge-fill { height: 100%; border-radius: 999px; transition: width 0.5s ease; }

    /* ── Tables ──────────────────────────────────────────── */
    table.dt { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.dt th {
      padding: 9px 14px; text-align: left;
      font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
      color: var(--faint); border-bottom: 1px solid var(--border);
      background: var(--bg-elev); position: sticky; top: 0; z-index: 2;
      white-space: nowrap;
    }
    table.dt td {
      padding: 9px 14px; border-bottom: 1px solid var(--border);
      vertical-align: middle; font-variant-numeric: tabular-nums;
    }
    table.dt tbody tr { transition: background 0.1s; }
    table.dt tbody tr:hover { background: var(--hover); }
    table.dt tbody tr.clickable { cursor: pointer; }
    table.dt .r { text-align: right; }
    .empty-row td { text-align: center; color: var(--faint); padding: 26px 14px; font-family: var(--mono); font-size: 11.5px; }

    .m-badge {
      display: inline-block; min-width: 44px; text-align: center;
      padding: 2px 7px; border-radius: 5px;
      font-family: var(--mono); font-size: 10px; font-weight: 700;
    }
    .m-get { background: rgba(34,211,238,0.12); color: var(--cyan); }
    .m-post { background: rgba(129,140,248,0.12); color: var(--indigo); }
    .m-put { background: rgba(251,191,36,0.12); color: var(--amber); }
    .m-patch { background: rgba(52,211,153,0.12); color: var(--emerald); }
    .m-delete { background: rgba(244,63,94,0.12); color: var(--rose); }

    .s-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 9px; border-radius: 999px;
      font-size: 10.5px; font-weight: 650; white-space: nowrap;
    }
    .s-badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .s-open { background: rgba(244,63,94,0.1); color: var(--rose); border: 1px solid rgba(244,63,94,0.25); }
    .s-resolved { background: rgba(52,211,153,0.1); color: var(--emerald); border: 1px solid rgba(52,211,153,0.25); }
    .s-ignored { background: rgba(148,163,184,0.08); color: var(--muted); border: 1px solid var(--border); }
    .s-code-2 { color: var(--emerald); }
    .s-code-4 { color: var(--amber); }
    .s-code-5 { color: var(--rose); font-weight: 700; }

    .bar-mini { display: inline-block; height: 5px; border-radius: 3px; background: var(--rose); vertical-align: middle; }
    .bar-mini.ok { background: var(--emerald); }
    .bar-mini.warn { background: var(--amber); }
    .bar-track { display: inline-block; width: 64px; height: 5px; background: var(--bg-elev); border-radius: 3px; margin-right: 8px; vertical-align: middle; overflow: hidden; }
    .bar-track i { display: block; height: 100%; border-radius: 3px; background: var(--cyan); }

    /* ── Buttons, chips ──────────────────────────────────── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: var(--accent); color: #fff;
      border: none; padding: 6px 13px; border-radius: var(--r-sm);
      font-size: 11.5px; font-weight: 650; cursor: pointer;
      transition: filter 0.15s, transform 0.05s;
      white-space: nowrap;
    }
    .btn:hover { filter: brightness(1.12); }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .btn.ghost { background: var(--card-2); color: var(--text); border: 1px solid var(--border); }
    .btn.ghost:hover { border-color: var(--border-strong); filter: none; background: var(--hover); }
    .btn.danger { background: rgba(239,68,68,0.12); color: var(--rose); border: 1px solid rgba(239,68,68,0.3); }
    .btn.danger:hover { background: rgba(239,68,68,0.2); filter: none; }
    .btn.sm { padding: 4px 10px; font-size: 11px; }
    .icon-btn {
      background: none; border: none; color: var(--muted); cursor: pointer;
      width: 30px; height: 30px; border-radius: var(--r-sm);
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px;
    }
    .icon-btn:hover { background: var(--hover); color: var(--text); }

    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      padding: 4px 12px; border-radius: 999px; cursor: pointer;
      background: var(--card); border: 1px solid var(--border);
      color: var(--muted); font-size: 11.5px; font-weight: 600;
      transition: all 0.12s;
    }
    .chip:hover { color: var(--text); border-color: var(--border-strong); }
    .chip.on { background: var(--accent-soft); border-color: rgba(244,63,94,0.4); color: #fff; }
    .chip .n { font-family: var(--mono); font-size: 10px; opacity: 0.75; margin-left: 4px; }

    .filterbar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .filterbar .spacer { flex: 1; }
    .f-input, .f-select {
      background: var(--card); border: 1px solid var(--border);
      color: var(--text); border-radius: var(--r-sm);
      padding: 6px 11px; font-size: 12px; font-family: inherit;
      outline: none;
    }
    .f-input:focus, .f-select:focus { border-color: var(--border-strong); }
    .f-input { min-width: 200px; }

    /* ── Drawer ──────────────────────────────────────────── */
    .backdrop {
      position: fixed; inset: 0; background: rgba(3,4,8,0.65);
      backdrop-filter: blur(3px); z-index: 60; opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .backdrop.open { opacity: 1; pointer-events: auto; }
    .drawer {
      position: fixed; top: 0; right: 0; bottom: 0; width: 780px; max-width: 94vw;
      background: var(--bg-elev); border-left: 1px solid var(--border-strong);
      box-shadow: -16px 0 48px rgba(0,0,0,0.55);
      z-index: 70; display: flex; flex-direction: column;
      transform: translateX(102%);
      transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .drawer.open { transform: translateX(0); }
    .drawer-h {
      padding: 16px 22px; border-bottom: 1px solid var(--border);
      display: flex; align-items: flex-start; gap: 12px;
      background: var(--card);
    }
    .drawer-h .grow { flex: 1; min-width: 0; }
    .drawer-title { font-size: 14.5px; font-weight: 700; letter-spacing: -0.01em; word-break: break-word; }
    .drawer-sub { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-top: 3px; word-break: break-all; }
    .drawer-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--card); padding: 0 12px; gap: 2px; }
    .dtab {
      padding: 10px 14px; font-size: 12px; font-weight: 600;
      color: var(--muted); cursor: pointer; border: none; background: none;
      border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .dtab:hover { color: var(--text); }
    .dtab.on { color: #fff; border-bottom-color: var(--accent); }
    .drawer-body { flex: 1; overflow-y: auto; padding: 20px 22px; }
    .occ-pager {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--mono); font-size: 11px; color: var(--muted);
      padding: 8px 22px; border-bottom: 1px solid var(--border); background: var(--bg-elev);
    }

    .frame {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--r-md); padding: 10px 14px; margin-bottom: 7px;
      font-family: var(--mono); font-size: 11.5px;
    }
    .frame.in-app { border-left: 3px solid var(--accent); background: var(--card-2); }
    .frame .fn { font-weight: 700; color: #fff; }
    .frame .loc { color: var(--muted); font-size: 10.5px; margin-top: 2px; }
    .tag-inapp {
      font-size: 9px; font-weight: 800; letter-spacing: 0.06em;
      background: var(--accent-soft); color: var(--rose);
      padding: 1px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle;
    }

    .crumb { display: flex; gap: 12px; padding: 7px 0; position: relative; }
    .crumb::before {
      content: ""; position: absolute; left: 17px; top: 28px; bottom: -8px;
      width: 1px; background: var(--border);
    }
    .crumb:last-child::before { display: none; }
    .crumb-cat {
      width: 36px; height: 22px; border-radius: 5px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 800; text-transform: uppercase;
      font-family: var(--mono);
    }
    .cc-db { background: #12233f; color: #60a5fa; }
    .cc-http { background: #0a2e2b; color: var(--teal); }
    .cc-cache { background: #241a3f; color: var(--violet); }
    .cc-job { background: #33123f; color: #e879f9; }
    .cc-auth { background: #3a2410; color: var(--orange); }
    .cc-log { background: #1a2233; color: #94a3b8; }
    .cc-mail { background: #0a2e22; color: var(--emerald); }
    .cc-storage { background: #33270f; color: var(--amber); }
    .cc-realtime { background: #0a2e33; color: var(--cyan); }
    .cc-system { background: #222738; color: var(--muted); }
    .crumb-msg { font-weight: 550; }
    .crumb-time { font-family: var(--mono); font-size: 10px; color: var(--faint); }

    /* Waterfall */
    .wf-row {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 6px; border-radius: var(--r-sm); cursor: pointer;
      font-family: var(--mono); font-size: 11.5px;
    }
    .wf-row:hover { background: var(--hover); }
    .wf-row.sel { background: var(--accent-soft); }
    .wf-name { width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
    .wf-track { flex: 1; height: 14px; background: var(--bg); border-radius: 4px; position: relative; overflow: hidden; }
    .wf-bar { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; min-width: 2px; }
    .wf-dur { width: 76px; text-align: right; color: var(--muted); flex-shrink: 0; }
    .kv-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11.5px; }
    .kv-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .kv-table td:first-child { color: var(--faint); width: 200px; white-space: nowrap; }
    .kv-table pre {
      white-space: pre-wrap; word-break: break-all; margin: 0;
      font-family: var(--mono); font-size: 11px; color: var(--muted);
      max-height: 260px; overflow-y: auto;
    }

    /* Terminal */
    .term {
      background: #050609; border: 1px solid var(--border); border-radius: var(--r-lg);
      font-family: var(--mono); font-size: 11.5px;
      height: calc(100vh - 235px); min-height: 300px;
      overflow-y: auto; padding: 12px 8px;
    }
    .log-line { display: flex; gap: 10px; padding: 2.5px 8px; border-radius: 4px; white-space: nowrap; }
    .log-line:hover { background: rgba(255,255,255,0.025); }
    .log-time { color: var(--faint); flex-shrink: 0; }
    .lv {
      flex-shrink: 0; width: 46px; text-align: center; border-radius: 4px;
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em; align-self: center;
    }
    .lv-trace { background: #151a28; color: var(--faint); }
    .lv-debug { background: #12233f; color: #7dd3fc; }
    .lv-info { background: #0a2e2b; color: var(--teal); }
    .lv-warn { background: #33270f; color: var(--amber); }
    .lv-error { background: #33121a; color: var(--rose); }
    .lv-fatal { background: #4c0519; color: #fda4af; }

    /* Modal & toasts */
    /* ── Command palette ───────────────────────────────────────────────── */
    .palette-wrap {
      position: fixed; inset: 0; z-index: 90;
      background: rgba(6, 8, 12, .55);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 12vh;
      opacity: 0; pointer-events: none; transition: opacity .12s ease;
    }
    .palette-wrap.open { opacity: 1; pointer-events: auto; }
    .palette {
      width: min(560px, 92vw);
      background: var(--panel, #12161d);
      border: 1px solid var(--line, #232a35);
      border-radius: 10px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
      overflow: hidden;
    }
    .palette input {
      width: 100%; padding: 14px 16px; font-size: 15px;
      background: transparent; border: 0; border-bottom: 1px solid var(--line, #232a35);
      color: inherit; outline: none; box-sizing: border-box;
    }
    .palette-list { max-height: 46vh; overflow-y: auto; }
    .palette-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; cursor: pointer; font-size: 13px;
    }
    .palette-item[aria-selected="true"] { background: rgba(88, 166, 255, .16); }
    .palette-item:focus-visible { outline: 2px solid #58a6ff; outline-offset: -2px; }
    .palette-item .hint { margin-left: auto; opacity: .55; font-size: 11px; }
    .palette-item[disabled] { opacity: .4; cursor: default; }
    .palette-empty { padding: 16px; opacity: .6; font-size: 13px; }

    .modal-wrap {
      position: fixed; inset: 0; z-index: 90;
      display: flex; align-items: center; justify-content: center;
      background: rgba(3,4,8,0.7); backdrop-filter: blur(4px);
      opacity: 0; pointer-events: none; transition: opacity 0.18s;
    }
    .modal-wrap.open { opacity: 1; pointer-events: auto; }
    .modal {
      width: 440px; max-width: 92vw;
      background: var(--bg-elev); border: 1px solid var(--border-strong);
      border-radius: var(--r-lg); box-shadow: var(--shadow);
      transform: scale(0.96) translateY(8px); transition: transform 0.18s;
    }
    .modal-wrap.open .modal { transform: none; }
    .modal-h { padding: 16px 20px; font-weight: 700; font-size: 14px; border-bottom: 1px solid var(--border); }
    .modal-b { padding: 16px 20px; color: var(--muted); font-size: 12.5px; }
    .modal-f { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }

    #toasts {
      position: fixed; bottom: 18px; right: 18px; z-index: 100;
      display: flex; flex-direction: column; gap: 8px;
    }
    .toast {
      background: var(--card-2); border: 1px solid var(--border-strong);
      border-left: 3px solid var(--emerald);
      border-radius: var(--r-md); padding: 10px 16px;
      font-size: 12.5px; font-weight: 550; box-shadow: var(--shadow);
      animation: slidein 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      max-width: 340px;
    }
    .toast.err { border-left-color: var(--rose); }
    .toast.info { border-left-color: var(--cyan); }
    @keyframes slidein { from { transform: translateX(30px); opacity: 0; } to { transform: none; opacity: 1; } }

    .muted { color: var(--muted); }
    .faint { color: var(--faint); }
    .num { font-variant-numeric: tabular-nums; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .flex { display: flex; align-items: center; gap: 8px; }
    .mt8 { margin-top: 8px; } .mt14 { margin-top: 14px; } .mb14 { margin-bottom: 14px; }

    @media (max-width: 1100px) {
      .grid.kpi, .grid.five { grid-template-columns: repeat(2, 1fr); }
      .grid.two, .grid.four { grid-template-columns: 1fr; }
      aside { width: 64px; }
      .brand-name, .brand-env, .nav-item span.txt, .nav-count, .nav-label { display: none; }
      .nav-item { justify-content: center; }
    }
  </style>
</head>
<body>
  <aside>
    <div class="brand">
      <div class="brand-mark">Y</div>
      <div>
        <div class="brand-name">${safeService}</div>
        <div class="brand-env"><span class="env-dot"></span>${safeEnv}</div>
      </div>
    </div>
    <nav id="nav">
      <div class="nav-label">Overview</div>
      <button class="nav-item active" data-action="nav" data-view="cockpit">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
        <span class="txt">Cockpit</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="errors">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18.4-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21.6h16a2 2 0 0 0 1.7-3.2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        <span class="txt">Issues</span>
        <span class="nav-count zero" id="badge-errors">0</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="traces">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-9 4 18 3-9h6"/></svg>
        <span class="txt">Traces</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="slow-queries">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
        <span class="txt">Slow Queries</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="hardware">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
        <span class="txt">Hardware</span>
      </button>

      <div class="nav-label">Subsystems</div>
      <button class="nav-item" data-action="nav" data-view="database">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
        <span class="txt">Database</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="jobs">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/></svg>
        <span class="txt">Jobs &amp; DLQ</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="cache">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 11-14h-8l1-6z"/></svg>
        <span class="txt">Cache</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="realtime">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/></svg>
        <span class="txt">Realtime</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="mail">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-9 6.3a2 2 0 0 1-2 0L2 7"/></svg>
        <span class="txt">Mail</span>
      </button>

      <div class="nav-label">Diagnostics</div>
      <button class="nav-item" data-action="nav" data-view="audit">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span class="txt">Audit Log</span>
      </button>
      <button class="nav-item" data-action="nav" data-view="logs">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span class="txt">Logs</span>
      </button>
    </nav>
    <div class="sidebar-foot" id="foot-status">yatta observe v6.0</div>
  </aside>

  <main>
    <header>
      <div class="view-title"><span class="view-crumb">${safeService}&nbsp;/</span>&nbsp;<span id="view-title">Cockpit</span></div>
      <div class="searchbox">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="global-search" type="text" placeholder="Filter current view..." autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </div>
      <button class="pill live" id="live-pill" data-action="toggle-live" title="Toggle live stream">
        <span class="dot"></span><span id="live-label">LIVE</span>
      </button>
    </header>

    <div class="content" id="content">
      <div id="alerts"></div>

      <!-- COCKPIT -->
      <section data-view="cockpit" class="on">
        <div class="grid kpi" id="kpi-row"></div>
        <div class="grid two">
          <div class="card">
            <div class="card-h"><span>Throughput</span>
              <div class="legend"><span><i style="background:#3f4560"></i>2xx</span><span><i style="background:var(--amber)"></i>4xx</span><span><i style="background:var(--accent)"></i>5xx</span></div>
            </div>
            <div class="card-b"><div class="chart-box"><svg id="chart-throughput" preserveAspectRatio="none"></svg></div></div>
          </div>
          <div class="card">
            <div class="card-h"><span>Latency</span>
              <div class="legend"><span><i style="background:var(--accent)"></i>p95</span><span><i style="background:var(--cyan)"></i>avg</span></div>
            </div>
            <div class="card-b"><div class="chart-box"><svg id="chart-latency" preserveAspectRatio="none"></svg></div></div>
          </div>
        </div>
        <div class="grid two">
          <div class="card">
            <div class="card-h"><span>Subsystem Attribution — Own Time</span></div>
            <table class="dt"><thead><tr><th>Subsystem</th><th class="r">Calls</th><th class="r">Errors</th><th class="r">Avg Own</th><th style="width:38%">Own Time</th></tr></thead><tbody id="services-tbody"></tbody></table>
          </div>
          <div class="card">
            <div class="card-h"><span>Endpoints — Apdex Drilling</span></div>
            <table class="dt"><thead><tr><th>Method</th><th>Route</th><th class="r">Req</th><th class="r">Fail</th><th class="r">Avg</th><th class="r">P95</th></tr></thead><tbody id="endpoints-tbody"></tbody></table>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span>In-Flight Requests</span><span class="mono" style="font-size:10px;text-transform:none;letter-spacing:0" id="inflight-count"></span></div>
          <table class="dt"><thead><tr><th>Method</th><th>Path</th><th class="r">Elapsed</th><th>Client IP</th><th>State</th></tr></thead><tbody id="inflight-tbody"></tbody></table>
        </div>
      </section>

      <!-- ERRORS -->
      <section data-view="errors">
        <div class="filterbar">
          <div class="chips" id="err-chips"></div>
          <div class="spacer"></div>
          <span class="mono faint" id="err-summary" style="font-size:11px"></span>
        </div>
        <div class="card">
          <table class="dt"><thead><tr><th style="width:110px">Status</th><th>Defect</th><th>Location</th><th class="r">Events</th><th>Last Seen</th><th style="width:150px">Actions</th></tr></thead><tbody id="issues-tbody"></tbody></table>
        </div>
      </section>

      <!-- TRACES -->
      <section data-view="traces">
        <div class="filterbar">
          <select class="f-select" id="trace-method">
            <option value="all">All methods</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
          </select>
          <input class="f-input" id="trace-search" type="text" placeholder="Search route or trace id..." spellcheck="false">
        </div>
        <div class="card">
          <table class="dt"><thead><tr><th>Method</th><th>Route</th><th class="r">Status</th><th class="r">Duration</th><th>Time</th><th>Trace ID</th></tr></thead><tbody id="traces-tbody"></tbody></table>
        </div>
      </section>

      <!-- SLOW QUERIES -->
      <section data-view="slow-queries">
        <div class="card">
          <div class="card-h"><span>Slow Query Monitor</span><span class="mono" style="font-size:10px;text-transform:none;letter-spacing:0" id="slowq-threshold"></span></div>
          <table class="dt"><thead><tr><th class="r">Duration</th><th>Statement</th><th>Time</th><th>Trace</th></tr></thead><tbody id="slowq-tbody"></tbody></table>
        </div>
      </section>

      <!-- HARDWARE -->
      <section data-view="hardware">
        <div class="grid four" id="hw-gauges"></div>
        <div class="grid two">
          <div class="card">
            <div class="card-h"><span>Host</span></div>
            <table class="dt"><tbody id="hw-host-tbody"></tbody></table>
          </div>
          <div class="card">
            <div class="card-h"><span>Memory &amp; Storage</span></div>
            <table class="dt"><tbody id="hw-mem-tbody"></tbody></table>
          </div>
        </div>
      </section>

      <!-- DATABASE -->
      <section data-view="database">
        <div class="grid two">
          <div class="card">
            <div class="card-h"><span>Connection</span></div>
            <table class="dt"><tbody id="db-info-tbody"></tbody></table>
          </div>
          <div class="card">
            <div class="card-h"><span>Tables</span><span class="mono" style="font-size:10px;text-transform:none;letter-spacing:0">row counts cached 30s</span></div>
            <table class="dt"><thead><tr><th>Name</th><th class="r">Rows</th></tr></thead><tbody id="db-tables-tbody"></tbody></table>
          </div>
        </div>
      </section>

      <!-- JOBS -->
      <section data-view="jobs">
        <div class="grid five" id="jobs-stats"></div>
        <div class="card">
          <div class="card-h"><span>Dead-Letter Queue</span>
            <button class="btn danger sm" data-action="purge-dlq">Purge DLQ</button>
          </div>
          <table class="dt"><thead><tr><th>Job</th><th>Name</th><th class="r">Attempts</th><th>Error</th><th style="width:90px"></th></tr></thead><tbody id="dlq-tbody"></tbody></table>
        </div>
      </section>

      <!-- CACHE -->
      <section data-view="cache">
        <div class="grid four" id="cache-stats"></div>
        <div class="card">
          <div class="card-h"><span>Operations</span>
            <button class="btn danger sm" data-action="flush-cache">Flush Cache</button>
          </div>
          <div class="card-b muted" style="font-size:12px">Flushing evicts every cached key and resets hit counters. This action is recorded in the audit log.</div>
        </div>
      </section>

      <!-- REALTIME -->
      <section data-view="realtime">
        <div class="grid four" id="rt-stats"></div>
      </section>

      <!-- MAIL -->
      <section data-view="mail">
        <div class="grid four" id="mail-stats"></div>
      </section>

      <!-- AUDIT -->
      <section data-view="audit">
        <div class="card">
          <div class="card-h"><span>Operator Audit Trail</span></div>
          <table class="dt"><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Actor</th><th>Detail</th></tr></thead><tbody id="audit-tbody"></tbody></table>
        </div>
      </section>

      <!-- LOGS -->
      <section data-view="logs">
        <div class="filterbar">
          <div class="chips" id="log-chips"></div>
          <div class="spacer"></div>
          <button class="btn ghost sm" id="logs-pause" data-action="logs-pause">Pause</button>
        </div>
        <div class="term" id="term"></div>
      </section>
    </div>
  </main>

  <!-- Drawer -->
  <div class="backdrop" id="backdrop" data-action="close-drawer"></div>
  <div class="drawer" id="drawer" role="dialog" aria-modal="true">
    <div class="drawer-h">
      <div class="grow">
        <div class="drawer-title" id="dw-title">—</div>
        <div class="drawer-sub" id="dw-sub"></div>
      </div>
      <div class="flex" id="dw-actions"></div>
      <button class="icon-btn" data-action="close-drawer" aria-label="Close">&#10005;</button>
    </div>
    <div class="occ-pager" id="dw-occ" style="display:none">
      <button class="btn ghost sm" data-action="occ-prev">&larr; Newer</button>
      <span id="dw-occ-label"></span>
      <button class="btn ghost sm" data-action="occ-next">Older &rarr;</button>
    </div>
    <div class="drawer-tabs" id="dw-tabs"></div>
    <div class="drawer-body" id="dw-body"></div>
  </div>

  <!-- Modal -->
  <div class="palette-wrap" id="palette-wrap" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="palette">
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Run a command or search&hellip;" aria-label="Command palette input"
             role="combobox" aria-expanded="true" aria-controls="palette-list">
      <div class="palette-list" id="palette-list" role="listbox" aria-label="Commands"></div>
    </div>
  </div>

  <div class="modal-wrap" id="modal-wrap">
    <div class="modal">
      <div class="modal-h" id="modal-title"></div>
      <div class="modal-b" id="modal-body"></div>
      <div class="modal-f">
        <button class="btn ghost" data-action="modal-cancel">Cancel</button>
        <button class="btn" id="modal-ok" data-action="modal-ok">Confirm</button>
      </div>
    </div>
  </div>

  <div id="toasts"></div>
  <script>
  (function () {
    'use strict';

    var BP = ${JSON.stringify(basePath)};
    var state = null;
    var view = 'cockpit';
    var query = '';
    var live = true;
    var es = null;
    var pollTimer = null;
    var logsTimer = null;
    var logsPaused = false;
    var logsCache = [];
    var logFilter = 'all';
    var errFilter = 'all';
    var issues = [];
    var issueStats = { total: 0, unresolved: 0, resolved: 0, ignored: 0, totalEvents: 0 };
    var issuesLoaded = false;
    var issuesDirty = true;
    var issuesTimer = null;
    var curIssue = null;
    var occIndex = 0;
    var curWf = null;
    var curSpan = null;
    var modalOkFn = null;

    var TITLES = {
      cockpit: 'Cockpit', errors: 'Issues', traces: 'Traces', 'slow-queries': 'Slow Queries',
      hardware: 'Hardware', database: 'Database', jobs: 'Jobs & DLQ', cache: 'Cache',
      realtime: 'Realtime', mail: 'Mail', audit: 'Audit Log', logs: 'Logs'
    };

    // ── Helpers ────────────────────────────────────────────────────────────
    function $(s) { return document.querySelector(s); }
    function esc(v) {
      if (v === null || v === undefined) return '';
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtMs(ms) {
      if (ms === null || ms === undefined || isNaN(ms)) return '—';
      if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
      return Math.round(ms) + ' ms';
    }
    function fmtNum(n) { return (n === null || n === undefined ? 0 : n).toLocaleString(); }
    function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : '—'; }
    function fmtAgo(ts) {
      if (!ts) return '—';
      var d = Date.now() - ts;
      if (d < 60e3) return Math.max(1, Math.round(d / 1e3)) + 's ago';
      if (d < 3600e3) return Math.round(d / 60e3) + 'm ago';
      if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
      return Math.round(d / 86400e3) + 'd ago';
    }
    function fmtUptime(s) {
      var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
      if (h > 0) return h + 'h ' + m + 'm ' + Math.floor(s % 60) + 's';
      return m + 'm ' + Math.floor(s % 60) + 's';
    }
    function baseName(f) { if (!f) return ''; var i = f.lastIndexOf('/'); return i >= 0 ? f.slice(i + 1) : f; }
    function spanColor(n) {
      n = n || '';
      if (n.indexOf('db.') === 0) return '#38bdf8';
      if (n.indexOf('cache.') === 0) return '#c084fc';
      if (n.indexOf('job.') === 0) return '#e879f9';
      if (n.indexOf('auth.') === 0) return '#fb923c';
      if (n.indexOf('storage.') === 0) return '#fbbf24';
      if (n.indexOf('mail.') === 0) return '#34d399';
      if (n.indexOf('realtime.') === 0) return '#2dd4bf';
      return '#f43f5e';
    }
    function attrVal(v) {
      if (v && typeof v === 'object') {
        if (v.string !== undefined) return v.string;
        if (v.number !== undefined) return String(v.number);
        if (v.boolean !== undefined) return String(v.boolean);
      }
      return String(v === undefined || v === null ? '' : v);
    }
    function api(path, opts) {
      return fetch(BP + path, opts || {}).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          /*
           * The server's own words, not "HTTP 400".
           *
           * The guard refuses an action with a sentence explaining why — no key, not
           * confirmed, unknown kind — and that explanation used to be thrown away here,
           * so an operator saw a status code and nothing else.
           */
          if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
          return body;
        });
      });
    }
    function toast(msg, kind) {
      var box = document.createElement('div');
      box.className = 'toast' + (kind === 'err' ? ' err' : kind === 'info' ? ' info' : '');
      box.textContent = msg;
      $('#toasts').appendChild(box);
      setTimeout(function () { box.remove(); }, 3600);
    }
    function spark(values, color) {
      var w = 140, h = 30;
      if (!values || values.length < 2) return '<svg viewBox="0 0 ' + w + ' ' + h + '"></svg>';
      var max = Math.max.apply(null, values.concat([1]));
      var pts = values.map(function (v, i) {
        var x = (i / (values.length - 1)) * w;
        var y = h - 2 - ((v / max) * (h - 6));
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    }

    // ── Data loading ───────────────────────────────────────────────────────
    function fetchTelemetry() {
      api('/api/telemetry').then(function (data) {
        state = data;
        render();
      }).catch(function () {});
    }
    function loadIssues(force) {
      if (!force && issuesLoaded && !issuesDirty) return;
      api('/api/errors').then(function (data) {
        issues = data.issues || [];
        issueStats = data.stats || issueStats;
        issuesLoaded = true;
        issuesDirty = false;
        renderNavBadge();
        if (view === 'errors') renderErrors();
      }).catch(function () {});
    }
    function scheduleIssuesReload() {
      issuesDirty = true;
      if (view !== 'errors') return;
      if (issuesTimer) clearTimeout(issuesTimer);
      issuesTimer = setTimeout(function () { loadIssues(true); }, 800);
    }

    function connect() {
      if (!live) return;
      if (es) es.close();
      es = new EventSource(BP + '/api/stream');
      es.onopen = function () {
        setLiveUI(true);
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };
      es.onerror = function () {
        setLiveUI(false);
        // Only fall back to polling when the stream is fully closed;
        // EventSource retries by itself while CONNECTING.
        if (live && es.readyState === 2 && !pollTimer) {
          pollTimer = setInterval(fetchTelemetry, 4000);
        }
      };
      es.addEventListener('transaction', function (e) {
        try {
          var tx = JSON.parse(e.data);
          if (state) {
            state.recentTransactions.unshift(tx);
            if (state.recentTransactions.length > 50) state.recentTransactions.pop();
            state.inFlight = (state.inFlight || []).filter(function (r) { return r.id !== tx.id; });
            if (view === 'cockpit') { renderCockpit(); }
            else if (view === 'traces') { renderTraces(); }
          }
        } catch (err) {}
      });
      es.addEventListener('error', function (e) {
        if (!e.data) return; // connection-level error event has no data
        scheduleIssuesReload();
      });
      es.addEventListener('log', function (e) {
        try {
          var l = JSON.parse(e.data);
          logsCache.unshift(l);
          if (logsCache.length > 400) logsCache.pop();
          if (view === 'logs' && !logsPaused) renderLogs();
        } catch (err) {}
      });
      es.addEventListener('slow_query', function (e) {
        try {
          var q = JSON.parse(e.data);
          if (state) {
            state.slowQueries.unshift(q);
            if (state.slowQueries.length > 30) state.slowQueries.pop();
            if (view === 'slow-queries') renderSlowQueries();
          }
        } catch (err) {}
      });
      es.addEventListener('audit', function (e) {
        try {
          var a = JSON.parse(e.data);
          if (state) {
            state.audit.unshift(a);
            if (state.audit.length > 30) state.audit.pop();
            if (view === 'audit') renderAudit();
          }
        } catch (err) {}
      });
    }
    function setLiveUI(on) {
      var pill = $('#live-pill');
      pill.className = 'pill' + (on ? ' live' : ' dead');
      $('#live-label').textContent = on ? 'LIVE' : 'RECONNECTING';
    }
    function toggleLive() {
      live = !live;
      if (live) {
        connect();
        fetchTelemetry();
      } else {
        if (es) es.close();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        setLiveUI(false);
        $('#live-label').textContent = 'PAUSED';
      }
    }

    // ── View switching ─────────────────────────────────────────────────────
    function setView(v) {
      view = v;
      document.querySelectorAll('.nav-item').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-view') === v);
      });
      document.querySelectorAll('section[data-view]').forEach(function (s) {
        s.classList.toggle('on', s.getAttribute('data-view') === v);
      });
      $('#view-title').textContent = TITLES[v] || v;
      if (v === 'errors') loadIssues(false);
      if (v === 'logs') startLogsTimer(); else stopLogsTimer();
      render();
    }
    function render() {
      if (!state) return;
      renderNavBadge();
      renderAlerts();
      if (view === 'cockpit') renderCockpit();
      else if (view === 'errors') renderErrors();
      else if (view === 'traces') renderTraces();
      else if (view === 'slow-queries') renderSlowQueries();
      else if (view === 'hardware') renderHardware();
      else if (view === 'database') renderDatabase();
      else if (view === 'jobs') renderJobs();
      else if (view === 'cache') renderCache();
      else if (view === 'realtime') renderRealtime();
      else if (view === 'mail') renderMail();
      else if (view === 'audit') renderAudit();
      else if (view === 'logs') renderLogs();
    }
    function renderNavBadge() {
      var b = $('#badge-errors');
      b.textContent = issueStats.unresolved;
      b.className = 'nav-count' + (issueStats.unresolved > 0 ? '' : ' zero');
    }
    function renderAlerts() {
      var box = $('#alerts');
      if (!state.alerts || !state.alerts.length) { box.innerHTML = ''; return; }
      box.innerHTML = state.alerts.map(function (a) {
        var icon = a.level === 'critical'
          ? '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m21.7 18.4-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21.6h16a2 2 0 0 0 1.7-3.2Z"/><path d="M12 9v4M12 17h.01"/></svg>'
          : '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>';
        return '<div class="alert ' + esc(a.level) + '">' + icon + '<span>' + esc(a.message) + '</span></div>';
      }).join('');
    }

    // ── Cockpit ────────────────────────────────────────────────────────────
    function kpiCard(label, val, sub, sparkSvg) {
      return '<div class="card"><div class="card-b">' +
        '<div class="kpi-label">' + esc(label) + '</div>' +
        '<div class="kpi-val">' + val + '</div>' +
        '<div class="kpi-sub">' + sub + '</div>' +
        (sparkSvg ? '<div class="kpi-spark">' + sparkSvg + '</div>' : '') +
        '</div></div>';
    }
    function renderCockpit() {
      var hw = state.hardware, ap = state.apdex;
      var buckets = state.buckets || [];
      var p95Series = buckets.map(function (b) { return b.p95Ms; });
      var errSeries = buckets.map(function (b) { return b.c5xx; });
      var thrSeries = buckets.map(function (b) { return b.c2xx + b.c4xx + b.c5xx; });

      var apdexColor = ap.apdex >= 0.9 ? 'var(--emerald)' : ap.apdex >= 0.7 ? 'var(--amber)' : 'var(--rose)';
      $('#kpi-row').innerHTML =
        kpiCard('Apdex Score', '<span style="color:' + apdexColor + '">' + ap.apdex.toFixed(2) + '</span>',
          'p50 ' + fmtMs(ap.p50) + ' · p95 ' + fmtMs(ap.p95) + ' · p99 ' + fmtMs(ap.p99), spark(p95Series, '#f43f5e')) +
        kpiCard('Process CPU', hw.cpu.processCpuPercent + '<span style="font-size:13px;color:var(--muted)">%</span>',
          hw.cpu.cores + ' cores · ' + esc(hw.os.platform), spark(thrSeries, '#22d3ee')) +
        kpiCard('Heap Used', fmtNum(hw.memory.heapUsedMb) + '<span style="font-size:13px;color:var(--muted)"> MB</span>',
          'rss ' + fmtNum(hw.memory.rssMb) + ' MB · total ' + fmtNum(hw.memory.totalMb) + ' MB', '') +
        kpiCard('Event Loop', hw.eventLoop.delayMs + '<span style="font-size:13px;color:var(--muted)"> ms</span>',
          hw.eventLoop.isBlocked ? '<span style="color:var(--rose)">BLOCKED</span>' : 'loop healthy',
          spark(errSeries, '#fbbf24')) +
        kpiCard('Unresolved Issues', '<span style="color:' + (state.errors.unresolved > 0 ? 'var(--rose)' : 'var(--emerald)') + '">' + state.errors.unresolved + '</span>',
          fmtNum(state.errors.totalEvents) + ' total occurrences', spark(errSeries, '#fb7185'));

      renderThroughput(buckets);
      renderLatency(buckets);

      $('#services-tbody').innerHTML = (state.services || []).map(function (s) {
        var c = spanColor(s.className === 'Database' ? 'db.' : s.className === 'Cache' ? 'cache.' : s.className === 'Jobs & Queues' ? 'job.' : s.className === 'Auth' ? 'auth.' : s.className === 'Storage' ? 'storage.' : s.className === 'Mail' ? 'mail.' : s.className === 'Realtime' ? 'realtime.' : '');
        return '<tr><td><span style="color:' + c + '">●</span> <strong>' + esc(s.className) + '</strong></td>' +
          '<td class="r mono">' + fmtNum(s.calls) + '</td>' +
          '<td class="r mono" style="color:' + (s.errors > 0 ? 'var(--rose)' : 'var(--muted)') + '">' + s.errors + '</td>' +
          '<td class="r mono">' + fmtMs(s.avgOwnMs) + '</td>' +
          '<td><div class="flex"><span class="bar-track"><i style="width:' + Math.min(100, s.ownTimePct) + '%;background:' + c + '"></i></span><span class="mono" style="font-size:11px">' + s.ownTimePct + '%</span></div></td></tr>';
      }).join('') || emptyRow(5, 'No spans recorded yet');

      $('#endpoints-tbody').innerHTML = (state.endpoints || []).slice(0, 12).map(function (e) {
        var failCls = e.failureRate > 5 ? '' : 'ok';
        if (e.failureRate > 1 && e.failureRate <= 5) failCls = 'warn';
        return '<tr class="clickable" data-action="nav" data-view="traces">' +
          '<td><span class="m-badge m-' + esc(e.method.toLowerCase()) + '">' + esc(e.method) + '</span></td>' +
          '<td class="mono truncate" style="max-width:220px" title="' + esc(e.operationId) + '">' + esc(e.operationId) + '</td>' +
          '<td class="r mono">' + fmtNum(e.count) + '</td>' +
          '<td class="r mono"><span class="bar-mini ' + failCls + '" style="width:' + Math.min(40, e.failureRate * 4) + 'px"></span>' + e.failureRate + '%</td>' +
          '<td class="r mono">' + fmtMs(e.avgMs) + '</td>' +
          '<td class="r mono">' + fmtMs(e.p95Ms) + '</td></tr>';
      }).join('') || emptyRow(6, 'No traffic in the last hour');

      $('#inflight-count').textContent = state.inFlight.length + ' active';
      $('#inflight-tbody').innerHTML = (state.inFlight || []).map(function (r) {
        return '<tr><td><span class="m-badge m-' + esc(r.method.toLowerCase()) + '">' + esc(r.method) + '</span></td>' +
          '<td class="mono truncate" style="max-width:340px">' + esc(r.url) + '</td>' +
          '<td class="r mono" style="color:var(--amber)">' + fmtMs(r.durationMs) + '</td>' +
          '<td class="mono">' + esc(r.clientIp || '127.0.0.1') + '</td>' +
          '<td><span class="s-badge s-open"><i></i>IN FLIGHT</span></td></tr>';
      }).join('') || emptyRow(5, 'No requests in flight');
    }
    function emptyRow(cols, msg) {
      return '<tr class="empty-row"><td colspan="' + cols + '">' + esc(msg) + '</td></tr>';
    }
    function renderThroughput(buckets) {
      var svg = $('#chart-throughput');
      if (!svg || !buckets || !buckets.length) return;
      var W = 560, H = 140;
      var bw = Math.max(3, (W / buckets.length) - 2.5);
      var max = Math.max.apply(null, buckets.map(function (b) { return b.c2xx + b.c4xx + b.c5xx; })) || 1;
      var s = '';
      buckets.forEach(function (b, i) {
        var x = i * (bw + 2.5);
        var t = b.c2xx + b.c4xx + b.c5xx;
        var hT = (t / max) * (H - 12), h5 = (b.c5xx / max) * (H - 12), h4 = (b.c4xx / max) * (H - 12), h2 = hT - h5 - h4;
        if (h2 > 0.5) s += '<rect x="' + x.toFixed(1) + '" y="' + (H - h2).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h2.toFixed(1) + '" rx="1" fill="#3f4560"/>';
        if (h4 > 0.5) s += '<rect x="' + x.toFixed(1) + '" y="' + (H - h2 - h4).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h4.toFixed(1) + '" rx="1" fill="#fbbf24"/>';
        if (h5 > 0.5) s += '<rect x="' + x.toFixed(1) + '" y="' + (H - hT).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h5.toFixed(1) + '" rx="1" fill="#f43f5e"/>';
      });
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.innerHTML = s;
    }
    function renderLatency(buckets) {
      var svg = $('#chart-latency');
      if (!svg || !buckets || buckets.length < 2) return;
      var W = 560, H = 140;
      var max = Math.max.apply(null, buckets.map(function (b) { return b.p95Ms; })) || 1;
      var step = W / (buckets.length - 1);
      var p95 = buckets.map(function (b, i) { return (i * step).toFixed(1) + ',' + (H - 8 - ((b.p95Ms / max) * (H - 22))).toFixed(1); });
      var avg = buckets.map(function (b, i) { return (i * step).toFixed(1) + ',' + (H - 8 - ((b.avgMs / max) * (H - 22))).toFixed(1); });
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.innerHTML =
        '<polygon points="0,' + H + ' ' + p95.join(' ') + ' ' + W + ',' + H + '" fill="rgba(244,63,94,0.10)"/>' +
        '<polyline points="' + avg.join(' ') + '" fill="none" stroke="#22d3ee" stroke-width="1.3" stroke-dasharray="4 3"/>' +
        '<polyline points="' + p95.join(' ') + '" fill="none" stroke="#f43f5e" stroke-width="1.8" stroke-linejoin="round"/>';
    }

    // ── Issues ─────────────────────────────────────────────────────────────
    function statusBadge(st) {
      if (st === 'resolved') return '<span class="s-badge s-resolved"><i></i>Resolved</span>';
      if (st === 'ignored') return '<span class="s-badge s-ignored"><i></i>Ignored</span>';
      return '<span class="s-badge s-open"><i></i>Unresolved</span>';
    }
    function renderErrors() {
      var chips = [
        ['all', 'All', issueStats.total],
        ['unresolved', 'Unresolved', issueStats.unresolved],
        ['resolved', 'Resolved', issueStats.resolved],
        ['ignored', 'Ignored', issueStats.ignored]
      ];
      $('#err-chips').innerHTML = chips.map(function (c) {
        return '<button class="chip' + (errFilter === c[0] ? ' on' : '') + '" data-action="err-chip" data-filter="' + c[0] + '">' + c[1] + '<span class="n">' + c[2] + '</span></button>';
      }).join('');
      $('#err-summary').textContent = issueStats.totalEvents + ' occurrences · ' + issueStats.unresolved + ' unresolved';

      var q = query.toLowerCase();
      var list = issues.filter(function (i) {
        if (errFilter !== 'all' && i.status !== errFilter) return false;
        if (!q) return true;
        var loc = i.topFrame ? baseName(i.topFrame.fileName) + ':' + i.topFrame.lineno : (i.routes[0] || '');
        return (i.name + ' ' + i.message + ' ' + i.fingerprint + ' ' + loc + ' ' + i.routes.join(' ')).toLowerCase().indexOf(q) >= 0;
      });

      $('#issues-tbody').innerHTML = list.map(function (i) {
        var loc = i.topFrame ? baseName(i.topFrame.fileName) + ':' + i.topFrame.lineno : (i.routes[0] || 'internal');
        return '<tr class="clickable" data-action="open-issue" data-fp="' + esc(i.fingerprint) + '">' +
          '<td>' + statusBadge(i.status) + '</td>' +
          '<td><div style="font-weight:650;color:#fff">' + esc(i.name) + '</div><div class="mono truncate" style="max-width:380px;font-size:11px;color:var(--muted)" title="' + esc(i.message) + '">' + esc(i.message) + '</div></td>' +
          '<td class="mono" style="color:var(--cyan);font-size:11px">' + esc(loc) + '</td>' +
          '<td class="r mono"><strong>' + fmtNum(i.count) + '</strong></td>' +
          '<td><div class="mono" style="font-size:11px">' + fmtTime(i.lastSeen) + '</div><div class="faint" style="font-size:10.5px">' + fmtAgo(i.lastSeen) + '</div></td>' +
          '<td><div class="flex">' +
            '<button class="btn ghost sm" data-action="' + (i.status === 'resolved' ? 'issue-reopen' : 'issue-resolve') + '" data-fp="' + esc(i.fingerprint) + '">' + (i.status === 'resolved' ? 'Reopen' : 'Resolve') + '</button>' +
            (i.status === 'ignored'
              ? '<button class="btn ghost sm" data-action="issue-reopen" data-fp="' + esc(i.fingerprint) + '">Unignore</button>'
              : '<button class="btn ghost sm" data-action="issue-ignore" data-fp="' + esc(i.fingerprint) + '">Ignore</button>') +
          '</div></td></tr>';
      }).join('') || emptyRow(6, issues.length ? 'No issues match the current filter' : 'No defects detected — system is clean');
    }

    // ── Traces ─────────────────────────────────────────────────────────────
    function renderTraces() {
      var m = $('#trace-method').value;
      var q = ($('#trace-search').value || '').toLowerCase();
      var list = (state.recentTransactions || []).filter(function (t) {
        if (m !== 'all' && t.method !== m) return false;
        if (!q) return true;
        return (t.route + ' ' + t.traceId + ' ' + t.url).toLowerCase().indexOf(q) >= 0;
      });
      $('#traces-tbody').innerHTML = list.map(function (t) {
        var codeCls = t.status >= 500 ? 's-code-5' : t.status >= 400 ? 's-code-4' : 's-code-2';
        return '<tr class="clickable" data-action="open-trace" data-trace="' + esc(t.traceId) + '" data-title="' + esc(t.method + ' ' + t.route) + '">' +
          '<td><span class="m-badge m-' + esc(t.method.toLowerCase()) + '">' + esc(t.method) + '</span></td>' +
          '<td class="mono truncate" style="max-width:280px" title="' + esc(t.route) + '">' + esc(t.route) + '</td>' +
          '<td class="r mono ' + codeCls + '">' + t.status + '</td>' +
          '<td class="r mono">' + fmtMs(t.durationMs) + '</td>' +
          '<td class="mono faint" style="font-size:11px">' + fmtAgo(t.timestamp) + '</td>' +
          '<td class="mono faint" style="font-size:11px">' + esc(t.traceId.slice(0, 14)) + '…</td></tr>';
      }).join('') || emptyRow(6, 'No traces match the current filter');
    }

    // ── Slow queries ───────────────────────────────────────────────────────
    function renderSlowQueries() {
      var q = query.toLowerCase();
      var list = (state.slowQueries || []).filter(function (s) {
        return !q || (s.sql + ' ' + (s.table || '')).toLowerCase().indexOf(q) >= 0;
      });
      $('#slowq-threshold').textContent = 'showing ' + list.length + ' of ' + (state.slowQueries || []).length;
      $('#slowq-tbody').innerHTML = list.map(function (s) {
        return '<tr class="clickable" ' + (s.traceId ? 'data-action="open-trace" data-trace="' + esc(s.traceId) + '" data-title="Trace ' + esc(s.traceId.slice(0, 12)) + '…"' : '') + '>' +
          '<td class="r mono" style="color:var(--rose)"><strong>' + fmtMs(s.durationMs) + '</strong></td>' +
          '<td class="mono" style="font-size:11px">' + esc(s.sql) + '</td>' +
          '<td class="mono faint" style="font-size:11px;white-space:nowrap">' + fmtAgo(s.timestamp) + '</td>' +
          '<td class="mono faint" style="font-size:11px">' + (s.traceId ? esc(s.traceId.slice(0, 10)) + '…' : '—') + '</td></tr>';
      }).join('') || emptyRow(4, 'No slow queries detected');
    }

    // ── Hardware / Database / Jobs / Cache / Realtime / Mail ───────────────
    function gaugeCard(label, valHtml, pct, sub) {
      var color = pct > 85 ? 'var(--rose)' : pct > 60 ? 'var(--amber)' : 'var(--emerald)';
      return '<div class="card"><div class="card-b"><div class="kpi-label">' + esc(label) + '</div>' +
        '<div class="kpi-val">' + valHtml + '</div><div class="kpi-sub">' + sub + '</div>' +
        '<div class="gauge-track"><div class="gauge-fill" style="width:' + Math.min(100, pct) + '%;background:' + color + '"></div></div></div></div>';
    }
    function kvRow(k, v) { return '<tr><td class="mono" style="color:var(--faint);width:45%">' + esc(k) + '</td><td class="mono" style="font-size:11.5px">' + v + '</td></tr>'; }
    function statCard(label, val, color) {
      return '<div class="card"><div class="card-b"><div class="kpi-label">' + esc(label) + '</div>' +
        '<div class="kpi-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + fmtNum(val) + '</div></div></div>';
    }
    function renderHardware() {
      var hw = state.hardware;
      var memPct = hw.memory.totalMb ? (hw.memory.usedMb / hw.memory.totalMb) * 100 : 0;
      var heapPct = hw.memory.heapTotalMb ? (hw.memory.heapUsedMb / hw.memory.heapTotalMb) * 100 : 0;
      var loopPct = Math.min(100, (hw.eventLoop.delayMs / 50) * 100);
      $('#hw-gauges').innerHTML =
        gaugeCard('Process CPU', hw.cpu.processCpuPercent + '<span style="font-size:13px;color:var(--muted)">%</span>', hw.cpu.processCpuPercent, hw.cpu.cores + ' logical cores') +
        gaugeCard('System Memory', Math.round(memPct) + '<span style="font-size:13px;color:var(--muted)">%</span>', memPct, fmtNum(hw.memory.usedMb) + ' / ' + fmtNum(hw.memory.totalMb) + ' MB') +
        gaugeCard('V8 Heap', Math.round(heapPct) + '<span style="font-size:13px;color:var(--muted)">%</span>', heapPct, fmtNum(hw.memory.heapUsedMb) + ' / ' + fmtNum(hw.memory.heapTotalMb) + ' MB') +
        gaugeCard('Event Loop Delay', hw.eventLoop.delayMs + '<span style="font-size:13px;color:var(--muted)"> ms</span>', loopPct, hw.eventLoop.isBlocked ? 'exceeds 50ms budget' : 'within budget');
      $('#hw-host-tbody').innerHTML =
        kvRow('Hostname', esc(hw.os.hostname)) +
        kvRow('Platform', esc(hw.os.platform + ' (' + hw.os.arch + ')')) +
        kvRow('System Uptime', esc(fmtUptime(hw.os.uptimeSeconds))) +
        kvRow('Load Average', esc(hw.os.loadAverage.join(' · '))) +
        kvRow('CPU Model', esc(hw.cpu.model)) +
        kvRow('CPU Cores', esc(String(hw.cpu.cores)));
      $('#hw-mem-tbody').innerHTML =
        kvRow('Total Memory', fmtNum(hw.memory.totalMb) + ' MB') +
        kvRow('Free Memory', fmtNum(hw.memory.freeMb) + ' MB (' + Math.round((hw.memory.freeMb / hw.memory.totalMb) * 100) + '%)') +
        kvRow('Process RSS', fmtNum(hw.memory.rssMb) + ' MB') +
        kvRow('Heap Allocated', fmtNum(hw.memory.heapTotalMb) + ' MB') +
        kvRow('External (Buffers)', fmtNum(hw.memory.externalMb) + ' MB') +
        kvRow('app.db / jobs.db', (hw.storage.appDbBytes / 1024).toFixed(1) + ' KB / ' + (hw.storage.jobsDbBytes / 1024).toFixed(1) + ' KB');
    }
    function renderDatabase() {
      var db = state.database;
      $('#db-info-tbody').innerHTML =
        kvRow('Path', esc(db.path)) +
        kvRow('Journal Mode', esc(db.journalMode)) +
        kvRow('File Size', (state.hardware.storage.appDbBytes / 1024).toFixed(1) + ' KB');
      $('#db-tables-tbody').innerHTML = (db.tables || []).map(function (t) {
        return '<tr><td class="mono"><strong>' + esc(t.name) + '</strong></td><td class="r mono">' + fmtNum(t.rows) + '</td></tr>';
      }).join('') || emptyRow(2, 'No tables discovered');
    }
    function renderJobs() {
      var q = state.queues.metrics;
      $('#jobs-stats').innerHTML =
        statCard('Queued', q.queued) + statCard('Delayed', q.delayed) + statCard('Running', q.running) +
        statCard('Completed', q.completed) + statCard('Dead (DLQ)', q.dead, q.dead > 0 ? 'var(--rose)' : 'var(--emerald)');
      $('#dlq-tbody').innerHTML = (state.queues.dead || []).map(function (j) {
        return '<tr><td class="mono" style="font-size:11px">' + esc(String(j.id).slice(0, 10)) + '…</td>' +
          '<td class="mono"><strong>' + esc(j.name) + '</strong></td>' +
          '<td class="r mono">' + esc(String(j.attempts)) + ' / ' + esc(String(j.maxAttempts)) + '</td>' +
          '<td class="mono truncate" style="max-width:320px;color:var(--rose);font-size:11px" title="' + esc(j.error ? j.error.message : '') + '">' + esc(j.error ? j.error.message : 'Failure') + '</td>' +
          '<td><button class="btn sm" data-action="replay-job" data-id="' + esc(j.id) + '">Replay</button></td></tr>';
      }).join('') || emptyRow(5, 'Dead-letter queue is empty');
    }
    function renderCache() {
      var c = state.cache;
      $('#cache-stats').innerHTML =
        statCard('Entries', c.size) +
        statCard('Hit Ratio', Math.round((c.hitRatio || 0) * 100) + '%', (c.hitRatio || 0) > 0.7 ? 'var(--emerald)' : 'var(--amber)') +
        statCard('Hits', c.hits) + statCard('Misses', c.misses);
    }
    function renderRealtime() {
      var r = state.realtime;
      $('#rt-stats').innerHTML =
        statCard('WebSocket Clients', r.websocketConnections) + statCard('SSE Streams', r.sseConnections) +
        statCard('Active Topics', r.topics) + statCard('Messages Sent', r.messagesSent);
    }
    function renderMail() {
      var m = state.mail;
      $('#mail-stats').innerHTML =
        statCard('Delivered', m.sent, 'var(--emerald)') + statCard('Failed', m.failed, m.failed > 0 ? 'var(--rose)' : undefined) +
        statCard('Rejected', m.rejected) + statCard('Transport', '<span style="font-size:16px">' + esc(String(m.mode).toUpperCase()) + '</span>');
    }
    function renderAudit() {
      // The detail column shows the meta object inline: an entry recording only
      // "member.updated" cannot answer which role changed, which is the reason
      // anyone reads an audit trail. esc() keeps a value containing markup from
      // being interpreted as HTML.
      $('#audit-tbody').innerHTML = (state.audit || []).map(function (a) {
        var detail = '';
        if (a.meta && typeof a.meta === 'object') {
          var parts = Object.keys(a.meta).map(function (k) {
            var v = a.meta[k];
            if (v !== null && typeof v === 'object') {
              try { v = JSON.stringify(v); } catch { v = '[object]'; }
            }
            return esc(k) + '=' + esc(String(v));
          });
          if (parts.length) detail = '<span style="opacity:.65">' + parts.join(' · ') + '</span>';
        }
        return '<tr><td class="mono faint" style="font-size:11px;white-space:nowrap">' + fmtTime(a.timestamp) + '</td>' +
          '<td class="mono"><strong>' + esc(a.action) + '</strong></td>' +
          '<td class="mono" style="font-size:11px">' + esc(a.target || '—') + '</td>' +
          '<td class="mono" style="font-size:11px">' + esc(a.actor) + '</td>' +
          '<td class="mono faint" style="font-size:11px">' + (detail || '—') + '</td></tr>';
      }).join('') || emptyRow(5, 'No audit records');
    }

    // ── Logs ───────────────────────────────────────────────────────────────
    function startLogsTimer() {
      fetchLogs();
      if (logsTimer) clearInterval(logsTimer);
      logsTimer = setInterval(fetchLogs, 2500);
    }
    function stopLogsTimer() {
      if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
    }
    function fetchLogs() {
      if (logsPaused) return;
      api('/api/logs').then(function (d) {
        logsCache = d.logs || [];
        if (view === 'logs') renderLogs();
      }).catch(function () {});
    }
    function renderLogs() {
      var levels = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      $('#log-chips').innerHTML = levels.map(function (l) {
        return '<button class="chip' + (logFilter === l ? ' on' : '') + '" data-action="log-chip" data-level="' + l + '">' + l + '</button>';
      }).join('');
      var list = logsCache.filter(function (r) { return logFilter === 'all' || r.level === logFilter; });
      var q = query.toLowerCase();
      if (q) list = list.filter(function (r) { return (r.message + ' ' + JSON.stringify(r.context || {})).toLowerCase().indexOf(q) >= 0; });
      $('#term').innerHTML = list.map(function (l) {
        return '<div class="log-line"><span class="log-time">' + fmtTime(l.timestamp) + '</span>' +
          '<span class="lv lv-' + esc(l.level) + '">' + esc(l.level) + '</span>' +
          '<span class="truncate">' + esc(l.message) + '</span></div>';
      }).join('') || '<div style="padding:18px;color:var(--faint)">No log records' + (logFilter !== 'all' ? ' at level "' + esc(logFilter) + '"' : '') + '</div>';
    }

    // ── Drawer ─────────────────────────────────────────────────────────────
    function openDrawer(title, sub, tabs, actionsHtml) {
      $('#dw-title').textContent = title;
      $('#dw-sub').textContent = sub || '';
      $('#dw-actions').innerHTML = actionsHtml || '';
      $('#dw-tabs').innerHTML = tabs.map(function (t, i) {
        return '<button class="dtab' + (i === 0 ? ' on' : '') + '" data-action="dtab" data-dtab="' + t[0] + '">' + t[1] + '</button>';
      }).join('');
      $('#dw-body').innerHTML = '';
      $('#dw-occ').style.display = 'none';
      $('#backdrop').classList.add('open');
      $('#drawer').classList.add('open');
    }
    function closeDrawer() {
      $('#backdrop').classList.remove('open');
      $('#drawer').classList.remove('open');
      curIssue = null;
      curWf = null;
      curSpan = null;
    }
    function switchDTab(tab) {
      document.querySelectorAll('#dw-tabs .dtab').forEach(function (t) {
        t.classList.toggle('on', t.getAttribute('data-dtab') === tab);
      });
      if (curIssue) renderIssuePane(tab);
    }
    function drawerBody() { return $('#dw-body'); }

    function openIssue(fp) {
      var issue = null;
      for (var i = 0; i < issues.length; i++) if (issues[i].fingerprint === fp) { issue = issues[i]; break; }
      if (!issue) return;
      curIssue = issue;
      occIndex = 0;
      var hasTrace = issue.occurrences.length > 0 && issue.occurrences[0].traceId;
      var tabs = [['stack', 'Stack Trace'], ['crumbs', 'Breadcrumbs'], ['req', 'Request']];
      if (hasTrace) tabs.push(['wf', 'Waterfall']);
      var act = issue.status === 'resolved'
        ? '<button class="btn ghost sm" data-action="issue-reopen" data-fp="' + esc(fp) + '">Reopen</button>'
        : '<button class="btn sm" data-action="issue-resolve" data-fp="' + esc(fp) + '">Resolve</button>';
      act += issue.status === 'ignored'
        ? '<button class="btn ghost sm" data-action="issue-reopen" data-fp="' + esc(fp) + '">Unignore</button>'
        : '<button class="btn ghost sm" data-action="issue-ignore" data-fp="' + esc(fp) + '">Ignore</button>';
      openDrawer(issue.name + ': ' + issue.message.slice(0, 70),
        'fingerprint ' + issue.fingerprint + ' · ' + issue.count + ' occurrences · ' + (issue.routes[0] || 'internal'),
        tabs, act);
      renderOccPager();
      renderIssuePane('stack');
      var occ = issue.occurrences[0];
      if (occ && occ.traceId) loadWaterfall(occ.traceId);
    }
    function renderOccPager() {
      if (!curIssue || curIssue.occurrences.length < 2) { $('#dw-occ').style.display = 'none'; return; }
      $('#dw-occ').style.display = 'flex';
      $('#dw-occ-label').textContent = 'Occurrence ' + (occIndex + 1) + ' of ' + Math.min(curIssue.occurrences.length, 25);
    }
    function shiftOccurrence(delta) {
      if (!curIssue) return;
      var max = Math.min(curIssue.occurrences.length, 25);
      occIndex = Math.max(0, Math.min(max - 1, occIndex + delta));
      renderOccPager();
      renderIssuePane(currentDTab());
      var occ = curIssue.occurrences[occIndex];
      if (occ && occ.traceId) loadWaterfall(occ.traceId);
    }
    function currentDTab() {
      var t = document.querySelector('#dw-tabs .dtab.on');
      return t ? t.getAttribute('data-dtab') : 'stack';
    }
    function renderIssuePane(tab) {
      if (!curIssue) return;
      var occ = curIssue.occurrences[occIndex] || curIssue.occurrences[0] || {};
      var body = drawerBody();
      if (tab === 'stack') {
        var frames = occ.parsedFrames || [];
        body.innerHTML = frames.length ? frames.map(function (f) {
          return '<div class="frame' + (f.inApp ? ' in-app' : '') + '"><div class="fn">' + esc(f.functionName) +
            (f.inApp ? '<span class="tag-inapp">IN-APP</span>' : '') + '</div>' +
            '<div class="loc">' + esc(f.fileName) + ':' + f.lineno + ':' + f.colno + '</div></div>';
        }).join('') : '<pre class="mono" style="color:var(--rose);white-space:pre-wrap;font-size:11.5px">' + esc(occ.stack || curIssue.message) + '</pre>';
      } else if (tab === 'crumbs') {
        var crumbs = occ.breadcrumbs || [];
        body.innerHTML = crumbs.length ? crumbs.map(function (c) {
          var cat = ['db', 'http', 'cache', 'job', 'auth'].indexOf(c.category) >= 0 ? c.category : ['log', 'mail', 'storage', 'realtime', 'system'].indexOf(c.category) >= 0 ? c.category : 'system';
          return '<div class="crumb"><div class="crumb-cat cc-' + cat + '">' + esc(c.category) + '</div>' +
            '<div><div class="crumb-msg">' + esc(c.message) + '</div><div class="crumb-time">' + fmtTime(c.timestamp) + '</div></div></div>';
        }).join('') : '<p class="muted">No breadcrumbs were recorded before this error.</p>';
      } else if (tab === 'req') {
        var h = occ.request && occ.request.headers ? occ.request.headers : {};
        body.innerHTML = '<table class="kv-table"><tbody>' +
          kvRow('Route', esc(occ.request && occ.request.route || 'internal')) +
          kvRow('Method', esc(occ.request && occ.request.method || 'N/A')) +
          kvRow('Status Code', esc(String(occ.statusCode || 500))) +
          kvRow('Handled', esc(String(occ.handled !== false))) +
          kvRow('Trace ID', esc(occ.traceId || '—')) +
          kvRow('Headers', '<pre>' + esc(JSON.stringify(h, null, 2)) + '</pre>') +
          '</tbody></table>';
      } else if (tab === 'wf') {
        renderWfPane();
      }
    }

    function openTrace(traceId, title) {
      openDrawer(title || ('Trace ' + traceId.slice(0, 12) + '…'), 'trace ' + traceId, [['wf', 'Waterfall']], '');
      loadWaterfall(traceId);
    }
    function loadWaterfall(traceId) {
      api('/api/traces/' + encodeURIComponent(traceId)).then(function (wf) {
        if (!wf) { drawerBody().innerHTML = '<p class="muted">Trace not found in the span buffer.</p>'; return; }
        var isIssue = !!curIssue;
        if (isIssue && currentDTab() !== 'wf') return; // waterfall is a secondary tab for issues
        if (!isIssue) {
          $('#dw-sub').textContent = 'trace ' + wf.traceId + ' · ' + wf.totalDurationMs + ' ms total';
        }
        curWf = wf;
        curSpan = null;
        renderWfPane();
      }).catch(function () {
        drawerBody().innerHTML = '<p class="muted">Could not load trace.</p>';
      });
    }
    function renderWfPane() {
      if (!curWf) { drawerBody().innerHTML = '<p class="muted">Loading waterfall…</p>'; return; }
      var wf = curWf;
      var html = '<div class="mono faint" style="font-size:11px;margin-bottom:10px">' + wf.spans.length + ' spans · total ' + fmtMs(wf.totalDurationMs) + '</div>';
      html += wf.spans.map(function (s) {
        var c = spanColor(s.name);
        var indent = s.depth * 16;
        return '<div class="wf-row' + (curSpan === s.spanId ? ' sel' : '') + '" data-action="span-inspect" data-span="' + esc(s.spanId) + '">' +
          '<div class="wf-name" style="padding-left:' + indent + 'px" title="' + esc(s.name) + '"><span style="color:' + c + '">●</span> ' + esc(s.name) + '</div>' +
          '<div class="wf-track"><div class="wf-bar" style="left:' + s.leftPct + '%;width:' + s.widthPct + '%;background:' + c + ';opacity:' + (s.status === 'error' ? '1' : '0.85') + '"></div></div>' +
          '<div class="wf-dur">' + fmtMs(s.durationMs) + '</div></div>';
      }).join('');
      html += '<div id="wf-inspect" style="margin-top:14px">' + (curSpan ? inspectHtml() : '<p class="faint" style="font-size:11.5px">Click a span to inspect attributes and events.</p>') + '</div>';
      drawerBody().innerHTML = html;
    }
    function inspectHtml() {
      if (!curWf || !curSpan) return '';
      var s = null;
      for (var i = 0; i < curWf.spans.length; i++) if (curWf.spans[i].spanId === curSpan) { s = curWf.spans[i]; break; }
      if (!s) return '';
      var attrs = Object.keys(s.attributes || {}).map(function (k) {
        return kvRow(k, '<span>' + esc(attrVal(s.attributes[k])) + '</span>');
      }).join('');
      var events = (s.events || []).map(function (ev) {
        return kvRow('event: ' + ev.name, '<pre>' + esc(JSON.stringify(ev.attributes || {}, null, 2)) + '</pre>');
      }).join('');
      return '<div class="card"><div class="card-h"><span>Span Inspector</span><span class="mono" style="font-size:10px;text-transform:none;letter-spacing:0">' + esc(s.spanId) + '</span></div>' +
        '<div class="card-b" style="padding:8px 14px"><table class="kv-table"><tbody>' +
        kvRow('name', esc(s.name)) + kvRow('kind', esc(s.kind)) + kvRow('status', esc(s.status)) + kvRow('offset', fmtMs(s.offsetMs)) + kvRow('duration', fmtMs(s.durationMs)) +
        attrs + events + '</tbody></table></div></div>';
    }
    function inspectSpan(spanId) {
      curSpan = spanId;
      document.querySelectorAll('.wf-row').forEach(function (r) {
        r.classList.toggle('sel', r.getAttribute('data-span') === spanId);
      });
      var box = $('#wf-inspect');
      if (box) box.innerHTML = inspectHtml();
    }

    // ── Actions ────────────────────────────────────────────────────────────
    function actOnIssue(fp, action) {
      api('/api/errors/' + action + '?fingerprint=' + encodeURIComponent(fp), { method: 'POST' })
        .then(function () {
          toast('Issue ' + (action === 'resolve' ? 'resolved' : action === 'ignore' ? 'ignored' : 'reopened'));
          loadIssues(true);
          if (curIssue && curIssue.fingerprint === fp) {
            for (var i = 0; i < issues.length; i++) {
              if (issues[i].fingerprint === fp) { curIssue = issues[i]; break; }
            }
          }
        }).catch(function () { toast('Action failed', 'err'); });
    }
    /*
     * The guarded POSTs need a confirmation flag and an idempotency key, so they go
     * through here rather than through the plain api helper.
     *
     * The key is generated per click and reused only by an automatic retry of that
     * same click. That is what makes a double-click one action instead of two, which
     * is the whole reason the server asks for it.
     */
    function guardedPost(path) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
        }),
      });
    }
    function replayJob(id) {
      guardedPost('/api/jobs/replay-dead?id=' + encodeURIComponent(id))
        .then(function () { toast('Job replayed'); fetchTelemetry(); })
        .catch(function (err) { toast(err.message || 'Replay failed', 'err'); });
    }
    function openModal(title, body, okLabel, okFn, danger) {
      $('#modal-title').textContent = title;
      $('#modal-body').textContent = body;
      var ok = $('#modal-ok');
      ok.textContent = okLabel;
      ok.className = 'btn' + (danger ? ' danger' : '');
      modalOkFn = okFn;
      $('#modal-wrap').classList.add('open');
    }
    function closeModal() {
      $('#modal-wrap').classList.remove('open');
      modalOkFn = null;
    }

    // ── Events ─────────────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      var a = t.getAttribute('data-action');
      if (a === 'nav') { setView(t.getAttribute('data-view')); }
      else if (a === 'toggle-live') { toggleLive(); }
      else if (a === 'close-drawer') { closeDrawer(); }
      else if (a === 'open-issue') { openIssue(t.getAttribute('data-fp')); }
      else if (a === 'issue-resolve') { actOnIssue(t.getAttribute('data-fp'), 'resolve'); }
      else if (a === 'issue-reopen') { actOnIssue(t.getAttribute('data-fp'), 'unresolve'); }
      else if (a === 'issue-ignore') { actOnIssue(t.getAttribute('data-fp'), 'ignore'); }
      else if (a === 'open-trace') { openTrace(t.getAttribute('data-trace'), t.getAttribute('data-title')); }
      else if (a === 'span-inspect') { inspectSpan(t.getAttribute('data-span')); }
      else if (a === 'dtab') { switchDTab(t.getAttribute('data-dtab')); }
      else if (a === 'occ-prev') { shiftOccurrence(-1); }
      else if (a === 'occ-next') { shiftOccurrence(1); }
      else if (a === 'replay-job') { replayJob(t.getAttribute('data-id')); }
      else if (a === 'purge-dlq') {
        openModal('Purge dead-letter queue?', 'All dead jobs will be permanently discarded. This cannot be undone.', 'Purge', function () {
          guardedPost('/api/jobs/purge-dead').then(function () { toast('DLQ purged'); fetchTelemetry(); }).catch(function (err) { toast(err.message || 'Purge failed', 'err'); });
        }, true);
      }
      else if (a === 'flush-cache') {
        openModal('Flush cache?', 'Every cached key will be evicted and hit counters reset.', 'Flush', function () {
          guardedPost('/api/cache/clear').then(function () { toast('Cache flushed'); fetchTelemetry(); }).catch(function (err) { toast(err.message || 'Flush failed', 'err'); });
        }, true);
      }
      else if (a === 'logs-pause') {
        logsPaused = !logsPaused;
        t.textContent = logsPaused ? 'Resume' : 'Pause';
        if (!logsPaused) fetchLogs();
      }
      else if (a === 'err-chip') { errFilter = t.getAttribute('data-filter'); renderErrors(); }
      else if (a === 'log-chip') { logFilter = t.getAttribute('data-level'); renderLogs(); }
      else if (a === 'modal-ok') { var fn = modalOkFn; closeModal(); if (fn) fn(); }
      else if (a === 'modal-cancel') { closeModal(); }
    });

    $('#global-search').addEventListener('input', function (e) {
      query = e.target.value || '';
      if (view === 'errors') renderErrors();
      else if (view === 'slow-queries') renderSlowQueries();
      else if (view === 'logs') renderLogs();
    });
    $('#trace-method').addEventListener('change', renderTraces);
    $('#trace-search').addEventListener('input', renderTraces);

    /* ── Command palette ───────────────────────────────────────────────────
     * Runs commands, not just text search, so the operator can jump to a view,
     * open a specific trace, or start a guarded action from one place.
     * Kept in vanilla DOM to match the rest of this file: the dashboard ships
     * with no external assets so it still works when a CDN is unreachable.
     */
    var paletteOpen = false;
    var paletteIndex = 0;
    var paletteItems = [];

    function paletteCommands() {
      return [
        { label: 'Go to cockpit', hint: 'overview', run: function () { setView('cockpit'); } },
        { label: 'Go to errors', hint: '', run: function () { setView('errors'); } },
        { label: 'Go to traces', hint: '', run: function () { setView('traces'); } },
        { label: 'Go to slow queries', hint: '', run: function () { setView('slow-queries'); } },
        { label: 'Go to logs', hint: '', run: function () { setView('logs'); } },
        { label: 'Show jobs and queues', hint: '', run: function () { setView('jobs'); } },
        { label: 'Show the dependency map', hint: 'analysis', run: function () { setView('graph'); } },
        { label: 'Show release health', hint: 'analysis', run: function () { setView('releases'); } },
        { label: 'Show memory trend', hint: 'analysis', run: function () { setView('memory'); } },
        {
          label: 'Open a trace by id',
          hint: 'abc123',
          freeform: true,
          run: function (value) {
            var id = (value || '').trim();
            if (!id) { toast('Enter a trace id', 'err'); return; }
            openTrace(id, 'trace ' + id);
          },
        },
        {
          label: 'Explain an error fingerprint',
          hint: 'fingerprint',
          freeform: true,
          run: function (value) {
            var fp = (value || '').trim();
            if (!fp) { toast('Enter a fingerprint', 'err'); return; }
            openIssue(fp);
          },
        },
        {
          label: 'Export an incident report',
          hint: 'fingerprint',
          freeform: true,
          run: function (value) {
            var fp = (value || '').trim();
            if (!fp) { toast('Enter a fingerprint', 'err'); return; }
            api('/api/analysis/report/' + encodeURIComponent(fp))
              .then(function (report) {
                // The report is designed to be read by something other than this
                // page, so hand it over verbatim rather than reformatting it.
                var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'incident-' + fp.slice(0, 12) + '.json';
                a.click();
                toast('Incident report exported');
              })
              .catch(function () { toast('No report for that fingerprint', 'err'); });
          },
        },
        {
          label: 'Save the current trace as a golden baseline',
          hint: 'name',
          freeform: true,
          run: function (value) {
            var name = (value || '').trim();
            var trace = $('#trace-search') ? $('#trace-search').value : '';
            if (!name || !trace) { toast('Enter a name and open a trace first', 'err'); return; }
            api('/api/analysis/goldens/' + encodeURIComponent(name) + '?trace=' + encodeURIComponent(trace), { method: 'POST' })
              .then(function () { toast('Golden trace saved'); })
              .catch(function () { toast('Could not save that trace', 'err'); });
          },
        }
      ];
    }

    function paletteScore(label, q) {
      // Subsequence match, favouring word-boundary and prefix hits so "dq"
      // finds "Database queries" before "Dashboard queue".
      var lower = label.toLowerCase();
      var pos = 0;
      var score = 0;
      var boundary = true;
      for (var i = 0; i < q.length; i++) {
        var ch = q.charAt(i);
        var found = lower.indexOf(ch, pos);
        if (found < 0) return -1;
        if (boundary) score += 3;
        if (found === 0) score += 2;
        score += Math.max(0, 3 - (found - pos));
        boundary = lower.charAt(found - 1) === ' ';
        pos = found + 1;
      }
      return score;
    }

    function renderPalette(filter) {
      var list = $('#palette-list');
      var q = (filter || '').trim().toLowerCase();
      paletteItems = paletteCommands()
        .map(function (c) { return { cmd: c, score: q ? paletteScore(c.label, q) : 1 }; })
        .filter(function (x) { return x.score >= 0; })
        .sort(function (a, b) { return b.score - a.score; })
        .map(function (x) { return x.cmd; });

      paletteIndex = 0;
      list.innerHTML = '';

      if (paletteItems.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'palette-empty';
        empty.textContent = 'No matching command';
        list.appendChild(empty);
        return;
      }

      paletteItems.forEach(function (cmd, i) {
        var el = document.createElement('div');
        el.className = 'palette-item';
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        // tabindex="-1" keeps focus in the input while the list is still
        // reachable by keyboard and announced by a screen reader.
        el.tabIndex = -1;

        var text = document.createElement('span');
        text.textContent = cmd.label;
        el.appendChild(text);

        if (cmd.hint) {
          var hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = cmd.hint;
          el.appendChild(hint);
        }

        el.addEventListener('click', function () { runPalette(i); });
        list.appendChild(el);
      });
    }

    function paintPaletteSelection() {
      var nodes = $('#palette-list').querySelectorAll('.palette-item');
      Array.prototype.forEach.call(nodes, function (el, i) {
        el.setAttribute('aria-selected', i === paletteIndex ? 'true' : 'false');
      });
    }

    function openPalette() {
      paletteOpen = true;
      $('#palette-wrap').classList.add('open');
      var input = $('#palette-input');
      input.value = '';
      renderPalette('');
      input.focus();
    }

    function closePalette() {
      paletteOpen = false;
      $('#palette-wrap').classList.remove('open');
    }

    function runPalette(i) {
      var item = paletteItems[i];
      if (!item) return;
      var input = $('#palette-input');
      // A command that needs an argument keeps the typed text rather than
      // discarding it on close.
      var typed = input.value.trim();
      closePalette();
      if (item.freeform) {
        // Re-open the palette with the argument captured, then execute.
        pendingFreeform = { cmd: item, value: typed };
        paletteOpen = true;
        $('#palette-wrap').classList.add('open');
        input.value = '';
        renderPalette('');
        input.focus();
        input.setAttribute('placeholder', item.hint ? 'Value for: ' + item.hint : 'Value');
        return;
      }
      item.run(typed);
    }

    var pendingFreeform = null;

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (paletteOpen) closePalette(); else openPalette();
        return;
      }

      if (!paletteOpen) {
        if (e.key === 'Escape') {
          if ($('#modal-wrap').classList.contains('open')) closeModal();
          else closeDrawer();
        } else if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
          e.preventDefault();
          $('#global-search').focus();
        }
        return;
      }

      // Palette owns the keyboard while open.
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); pendingFreeform = null; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1); paintPaletteSelection(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); paintPaletteSelection(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (pendingFreeform) {
          var cmd = pendingFreeform.cmd;
          var value = $('#palette-input').value.trim();
          pendingFreeform = null;
          $('#palette-input').setAttribute('placeholder', 'Run a command or search\u2026');
          closePalette();
          cmd.run(value);
        } else {
          runPalette(paletteIndex);
        }
      }
    });

    $('#palette-input').addEventListener('input', function (e) {
      // While collecting an argument there is nothing to filter; the next Enter
      // submits it.
      renderPalette(pendingFreeform ? '' : e.target.value);
    });
    $('#palette-wrap').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) { closePalette(); pendingFreeform = null; }
    });

    // ── Boot ───────────────────────────────────────────────────────────────
    setView('cockpit');
    connect();
    fetchTelemetry();
    loadIssues(true);
  })();
  </script>
</body>
</html>`;
}
