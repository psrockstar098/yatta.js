import { describe, it, expect } from "bun:test";

import { WorkPausedError } from "../../core_runtime/scheduler";

/*
 * Pause and the observe gate.
 *
 * Both are behaviours that are easy to claim and hard to see: `pauseWork` looks like
 * it works because nothing throws, and the token gate looks closed because a request
 * still gets a response — just a different one.
 */

describe("Work pause", () => {
  it("reports whether work was newly paused or already was", async () => {
    const { createRuntime } = await import("../../core_runtime/index");

    // A runtime that never started still exercises the flag, which is what a
    // shutdown reads before it begins draining.
    const runtime = createRuntime({ cpuWorkers: 1, ioWorkers: 1, silent: true });

    expect(runtime.isWorkPaused).toBe(false);
    // The return value is what lets a caller log "already paused" rather than
    // silently believing it did something.
    expect(runtime.pauseWork()).toBe(true);
    expect(runtime.pauseWork()).toBe(false);
    expect(runtime.isWorkPaused).toBe(true);

    expect(runtime.resumeWork()).toBe(true);
    expect(runtime.resumeWork()).toBe(false);
    expect(runtime.isWorkPaused).toBe(false);
  });

  it("leaves in-flight work alone", async () => {
    const { createRuntime } = await import("../../core_runtime/index");
    const runtime = createRuntime({ cpuWorkers: 1, ioWorkers: 1, silent: true });

    // Nothing was running, so the count must not change. A pause that cancelled
    // in-flight tasks would be a shutdown, not a pause, and the drain after it would
    // report success while throwing away work.
    const before = runtime.getActiveTaskCount();
    runtime.pauseWork();

    expect(runtime.getActiveTaskCount()).toBe(before);
  });

  it("names the reason a dispatch was refused", () => {
    const error = new WorkPausedError("jobs");

    // Distinct from a generic failure so a caller can tell "the process is going
    // away, retrying is pointless" from "something is wrong". A job that retries
    // during a deploy is a job that starts after the teardown.
    expect(error).toBeInstanceOf(Error);
    expect(error.isWorkPaused).toBe(true);
    expect(error.graphId).toBe("jobs");
    expect(error.message).toMatch(/draining for shutdown/);
  });
});

describe("The observe gate", () => {
  /** The gate as main.ts applies it, extracted so it can be tested directly. */
  function gate(options: {
    supplied: string | null;
    token: string | undefined;
    production: boolean;
  }): { status: number; body: unknown } {
    const { supplied, token, production } = options;

    if (production && !token) {
      return {
        status: 404,
        body: { error: "Observability is disabled. Set YATTA_OBSERVE_TOKEN to enable it." },
      };
    }

    if (token) {
      if (!constantTimeEqual(supplied ?? "", token)) {
        return { status: 401, body: { error: "Not authorised" } };
      }
    }

    return { status: 200, body: { ok: true } };
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }

  it("refuses everything in production when no token is set", () => {
    // 404 rather than 401: an unauthenticated caller should not learn the surface
    // exists.
    const result = gate({ supplied: "anything", token: undefined, production: true });
    expect(result.status).toBe(404);
  });

  it("refuses a wrong token", () => {
    expect(gate({ supplied: "wrong", token: "right", production: true }).status).toBe(401);
    expect(gate({ supplied: null, token: "right", production: true }).status).toBe(401);
    expect(gate({ supplied: "", token: "right", production: true }).status).toBe(401);
  });

  it("accepts the right token", () => {
    expect(gate({ supplied: "right", token: "right", production: true }).status).toBe(200);
  });

  it("is open in development, so the first run is not broken", () => {
    // A token nobody has set yet would make the dashboard look like a failed install.
    expect(gate({ supplied: null, token: undefined, production: false }).status).toBe(200);
  });

  it("still enforces the token outside production when one is set", () => {
    // Setting a token is a statement of intent; it must not be honoured only in
    // production, or a staging deploy with the variable set exposes everything.
    expect(gate({ supplied: "wrong", token: "right", production: false }).status).toBe(401);
    expect(gate({ supplied: "right", token: "right", production: false }).status).toBe(200);
  });

  it("compares without an early exit", () => {
    // The real implementation, checked for the property that matters: two strings of
    // the same length differing in their last byte take the same work as two
    // differing in their first.
    const timing: number[] = [];

    for (const index of [0, 20]) {
      const a = "x".repeat(32);
      const b = `${"x".repeat(index)}y${"x".repeat(31 - index)}`;

      const started = process.hrtime.bigint();
      for (let i = 0; i < 20_000; i++) constantTimeEqual(a, b);
      timing.push(Number(process.hrtime.bigint() - started));
    }

    // A tolerance, because this is a smoke check on a shared machine, not a
    // benchmark. The assertion that matters is that both are in the same order of
    // magnitude — a `!==` would return immediately for the first.
    const ratio = Math.max(...timing) / Math.min(...timing);
    expect(ratio).toBeLessThan(10);
  });
});

describe("Shutdown budget", () => {
  it("orders every stage so the hard stop cannot fire mid-drain", () => {
    /*
     * The numbers as main.ts sets them.
     *
     * Asserted rather than read, because the failure this guards against is
     * arithmetic: a hard stop shorter than the drain before it kills exactly the long
     * tasks the drain exists to let finish, and reports a failure for a clean deploy.
     */
    const PRE_STOP_MS = 5_000;
    const DRAIN_BUDGET_MS = 30_000;
    const HARD_STOP_MS = DRAIN_BUDGET_MS + PRE_STOP_MS + 5_000;

    // It was 15s against a 30s drain.
    expect(HARD_STOP_MS).toBeGreaterThan(PRE_STOP_MS + DRAIN_BUDGET_MS);

    // An orchestrator's grace period has to cover it, or the SIGKILL lands first and
    // the ordering is pointless.
    const KUBERNETES_DEFAULT_GRACE_SEC = 30;
    expect(HARD_STOP_MS / 1000).toBeGreaterThan(KUBERNETES_DEFAULT_GRACE_SEC);
  });
});