import { describe, it, expect } from "bun:test";
import { Span } from "../types/observe";
import {
  enableOpenTelemetry,
  isOpenTelemetryEnabled,
  startOtelSpan,
  withOtelSpan,
} from "../types/otel";

/*
 * OpenTelemetry bridge tests.
 *
 * Verifies that Yatta's built-in spans flow to OpenTelemetry
 * when bridging is enabled, and that manual OTel spans work.
 */

describe("OpenTelemetry integration", () => {
  it("enables without crashing", () => {
    expect(() => enableOpenTelemetry()).not.toThrow();
    expect(isOpenTelemetryEnabled()).toBe(true);
  });

  it("creates OTel spans when enabled", () => {
    enableOpenTelemetry({ tracerName: "test" });
    const span = startOtelSpan("test-span", {
      attributes: { "test.key": "test-value" },
    });
    expect(span).not.toBeNull();
    span!.setAttribute("another.key", 42);
    span!.end();
  });

  it("bridges Yatta spans to OTel", () => {
    enableOpenTelemetry({ tracerName: "test-bridge" });

    // Create a Yatta span — the bridge should forward it to OTel on end()
    const yattaSpan = new Span({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "test-yatta-span",
      kind: "internal",
    });
    yattaSpan.setAttribute("yatta.key", "yatta-value");

    // This should not throw, even though OTel SDK may not be configured
    // (the API package handles the no-op case)
    expect(() => yattaSpan.end()).not.toThrow();
    expect(yattaSpan.endTime).toBeDefined();
  });

  it("withOtelSpan runs function in span context", async () => {
    enableOpenTelemetry({ tracerName: "test" });

    let spanSeen: any = null;
    const result = await withOtelSpan(
      "test-operation",
      async (span) => {
        spanSeen = span;
        span.setAttribute("result", "success");
        return "done";
      },
      { attributes: { "test": true } }
    );

    expect(result).toBe("done");
    expect(spanSeen).not.toBeNull();
  });

  it("withOtelSpan handles errors", async () => {
    enableOpenTelemetry({ tracerName: "test" });

    await expect(
      withOtelSpan("failing-operation", async (span) => {
        throw new Error("Test error");
      })
    ).rejects.toThrow("Test error");
  });
});
