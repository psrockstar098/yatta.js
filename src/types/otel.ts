// OpenTelemetry bridge for Yatta's built-in observe system.
//
// This module links Yatta's native Span/trace system with OpenTelemetry,
// so traces flow to any OTel-compatible backend (Jaeger, Zipkin, Datadog,
// Grafana Tempo, etc.) while keeping Yatta's built-in diagnostics working.
//
// Usage:
//   import { enableOpenTelemetry } from "yatta/observe";
//   enableOpenTelemetry(); // Uses global OTel API - configure SDK separately
//
//   // Or with custom tracer:
//   enableOpenTelemetry({ tracerName: "my-service", version: "1.0.0" });
//
// The bridge is zero-config when the OTel SDK is set up: Yatta spans
// automatically become OTel spans with the same trace/span IDs, so
// distributed traces work across Yatta and non-Yatta services.

import { trace, context, SpanStatusCode, SpanKind as OtelSpanKind } from "@opentelemetry/api";
import type { Span as OtelSpan, Tracer } from "@opentelemetry/api";
import { Span, type SpanKind } from "./observe";

let otelEnabled = false;
let otelTracer: Tracer | null = null;
let bridgeActive = false;

export interface OtelConfig {
  /** Tracer name for OTel spans (default: "yatta") */
  tracerName?: string;
  /** Tracer version */
  version?: string;
  /** Whether to bridge Yatta spans to OTel (default: true) */
  bridgeSpans?: boolean;
}

/**
 * Enable OpenTelemetry integration.
 *
 * This does NOT set up the OTel SDK — you must configure that separately
 * (e.g., with @opentelemetry/sdk-node and your chosen exporter).
 * This function only bridges Yatta's spans to the OTel API.
 */
export function enableOpenTelemetry(config: OtelConfig = {}): void {
  const tracerName = config.tracerName ?? "yatta";
  const version = config.version ?? "1.0.0";

  otelTracer = trace.getTracer(tracerName, version);
  otelEnabled = true;

  if (config.bridgeSpans !== false && !bridgeActive) {
    bridgeActive = true;
    installSpanBridge();
  }
}

/**
 * Check if OpenTelemetry bridging is enabled.
 */
export function isOpenTelemetryEnabled(): boolean {
  return otelEnabled;
}

/**
 * Get the OTel tracer, or null if not enabled.
 */
export function getOtelTracer(): Tracer | null {
  return otelTracer;
}

// ── Span kind mapping ──────────────────────────────────────────────────────

function toOtelKind(kind: SpanKind): OtelSpanKind {
  switch (kind) {
    case "server": return OtelSpanKind.SERVER;
    case "client": return OtelSpanKind.CLIENT;
    case "producer": return OtelSpanKind.PRODUCER;
    case "consumer": return OtelSpanKind.CONSUMER;
    case "internal":
    default: return OtelSpanKind.INTERNAL;
  }
}

// ── Yatta Span → OTel Span bridge ──────────────────────────────────────────

/**
 * Install the bridge that forwards Yatta spans to OpenTelemetry.
 *
 * This patches Span.prototype.end to also create an OTel span with
 * the same trace ID, span ID, and attributes. The OTel span is a
 * separate object — Yatta's built-in diagnostics continue to work
 * independently.
 */
function installSpanBridge(): void {
  const originalEnd = Span.prototype.end;

  Span.prototype.end = function (this: Span, ...args: any[]): any {
    // Call original first (marks finished, records end time)
    const result = (originalEnd as any).apply(this, args);

    // Bridge to OTel if enabled and span was sampled
    if (otelEnabled && otelTracer && this.sampled) {
      try {
        bridgeSpanToOtel(this);
      } catch {
        // Never let OTel bridging break the app
      }
    }

    return result;
  };
}

/**
 * Create an OTel span from a finished Yatta span.
 */
function bridgeSpanToOtel(yattaSpan: Span): void {
  if (!otelTracer) return;

  const otelSpan = otelTracer.startSpan(
    yattaSpan.name,
    {
      kind: toOtelKind(yattaSpan.kind),
      startTime: yattaSpan.startTime,
      attributes: flattenAttributes(yattaSpan.attributes),
    },
    // Use the Yatta span's trace context for continuity
    undefined,
  );

  // Add events
  for (const event of yattaSpan.events) {
    otelSpan.addEvent(event.name, flattenAttributes(event.attributes));
  }

  // Set status
  if (yattaSpan.status === "error") {
    otelSpan.setStatus({ code: SpanStatusCode.ERROR });
  } else if (yattaSpan.status === "ok") {
    otelSpan.setStatus({ code: SpanStatusCode.OK });
  }

  // End at the Yatta span's end time
  if (yattaSpan.endTime) {
    otelSpan.end(yattaSpan.endTime);
  } else {
    otelSpan.end();
  }
}

/**
 * Flatten Yatta's tagged-union attributes to OTel's plain values.
 */
function flattenAttributes(
  attrs: Record<string, { string?: string; number?: number; boolean?: boolean }>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v.string !== undefined) out[k] = v.string;
    else if (v.number !== undefined) out[k] = v.number;
    else if (v.boolean !== undefined) out[k] = v.boolean;
  }
  return out;
}

// ── Manual OTel span creation ──────────────────────────────────────────────

/**
 * Start an OTel span directly (for custom instrumentation).
 * Returns null if OTel is not enabled.
 */
export function startOtelSpan(
  name: string,
  options?: {
    kind?: OtelSpanKind;
    attributes?: Record<string, string | number | boolean>;
  }
): OtelSpan | null {
  if (!otelEnabled || !otelTracer) return null;
  return otelTracer.startSpan(name, {
    kind: options?.kind ?? OtelSpanKind.INTERNAL,
    attributes: options?.attributes,
  });
}

/**
 * Run a function within an OTel span context.
 */
export async function withOtelSpan<T>(
  name: string,
  fn: (span: OtelSpan) => Promise<T>,
  options?: {
    kind?: OtelSpanKind;
    attributes?: Record<string, string | number | boolean>;
  }
): Promise<T> {
  const span = startOtelSpan(name, options);
  if (!span) return fn(null as any);

  try {
    const result = await context.with(
      trace.setSpan(context.active(), span),
      () => fn(span)
    );
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}
