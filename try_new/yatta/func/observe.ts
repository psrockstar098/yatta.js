// yatta/func/observe.ts
//
// Built-in observability: distributed tracing, metrics, structured logs,
// error monitoring, user feedback, and a dashboard.
//
// This is the single observer instance. Import it anywhere you need to record
// something; do not create a second one.

import { createObserver } from "yatta.js/observe";

export const observer = createObserver({
  service: "app",
  release: process.env.GIT_SHA,
  // Logical OR, not nullish coalescing: an empty NODE_ENV is common in
  // Docker and CI, and a nullish coalesce treats "" as set. That made a
  // production container read as development and serve the dashboard.
  environment: process.env.NODE_ENV || "development",

  // Keep 2k spans in memory for the dashboard. Lower this on a small box.
  bufferSize: 2000,

  // Sample a fraction of traces in production to bound cost.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1,

  // Everything below this level is dropped before it is masked, buffered,
  // breadcrumbed or broadcast. "silent" turns logging off entirely.
  logLevel: process.env.NODE_ENV === "production" ? "warn" : "info",

  // Serve the dashboard. Off by default so it cannot leak in production.
  dashboard: process.env.NODE_ENV !== "production",

  // Process memory, CPU and event-loop delay. Sampled on a timer, so it is on
  // while developing and off in production unless you turn it on.
  runtimeMetrics: process.env.NODE_ENV !== "production",
  runtimeSampleMs: 10_000,

  // Only queries slower than this are kept in the slow-query list.
  slowQueryThresholdMs: 250,
});

// ── Convenience wrappers ────────────────────────────────────────────────────
//
// The point of these is that a caller cannot forget to report something.

/** Report an error with the current request attached, if there is one. */
export function report(error: unknown, request?: Request): void {
  observer.errors.capture(error, request ? { request } : {});
}

/**
 * Run work inside a span.
 *
 * Always ends the span, and a throw is recorded and re-thrown — this observes,
 * it never swallows.
 */
export function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return observer.tracer.withSpan(name, {}, fn);
}

export const observeLog = observer.log;
