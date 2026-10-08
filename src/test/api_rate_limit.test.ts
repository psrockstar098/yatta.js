import { describe, it, expect } from "bun:test";

import { createAPI } from "../types/api";

/*
 * rateLimit() with a limit that is not a number.
 *
 * The check is `bucket.count > maxRequests`, and `count > NaN` is false — so a NaN did
 * not fail the limit, it removed it. Every request was answered 200 and the limiter
 * never fired.
 *
 * This is the fourth time a guard in this codebase has been written so that a
 * non-finite value selects "no limit" rather than raising: `maxSize: NaN` in storage,
 * `ttl: NaN` in the cache, `ttlMs: NaN` in the L2 store, and now this. The common
 * source is `Number(process.env.X)` with the variable unset, which is how a limit
 * reaches a framework at all.
 */

function app(maxRequests: number, windowMs: number) {
  const api = createAPI();
  api.get("/x", () => new Response("ok"));
  api.rateLimit({ maxRequests, windowMs });
  return api;
}

const statuses = async (api: ReturnType<typeof app>, times = 6) => {
  const out: number[] = [];
  for (let i = 0; i < times; i++) {
    out.push((await api.handle(new Request("http://localhost/x"), {})).status);
  }
  return out;
};

describe("rateLimit refuses a limit that is not a number", () => {
  it("throws for a NaN maxRequests rather than removing the limit", () => {
    // The finding. Measured before the fix: six requests, six 200s, no 429 ever.
    expect(() => app(Number(process.env.YATTA_TEST_UNSET_MAX), 60_000)).toThrow(TypeError);
    expect(() => app(Number("nope"), 60_000)).toThrow(/maxRequests/);
  });

  it("throws for Infinity", () => {
    expect(() => app(Infinity, 60_000)).toThrow(/finite/);
  });

  it("throws for a NaN window", () => {
    expect(() => app(2, Number(process.env.YATTA_TEST_UNSET_WINDOW))).toThrow(/windowMs/);
  });

  it("still rejects zero and negative values", () => {
    // Zero is not a limit, and `windowMs: 0` resets the bucket every millisecond, so
    // the count never accumulates — the same "no limit" outcome by a different route.
    expect(() => app(0, 60_000)).toThrow(/maxRequests/);
    expect(() => app(-1, 60_000)).toThrow(/maxRequests/);
    expect(() => app(2, 0)).toThrow(/windowMs/);
    expect(() => app(2, -1)).toThrow(/windowMs/);
  });

  it("accepts a real limit and still enforces it", async () => {
    const result = await statuses(app(2, 60_000));

    expect(result.slice(0, 2)).toEqual([200, 200]);
    expect(result.slice(2)).toEqual([429, 429, 429, 429]);
  });

  it("answers 429 with a Retry-After header", async () => {
    const api = app(1, 60_000);

    expect((await api.handle(new Request("http://localhost/x"), {})).status).toBe(200);

    const limited = await api.handle(new Request("http://localhost/x"), {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts per key, so one client cannot exhaust another's budget", async () => {
    const api = createAPI();
    api.get("/x", () => new Response("ok"));
    api.rateLimit({ maxRequests: 1, windowMs: 60_000, getKey: (ctx) => ctx.req.headers.get("x-key") ?? "none" });

    const first = await api.handle(new Request("http://localhost/x", { headers: { "x-key": "a" } }), {});
    const second = await api.handle(new Request("http://localhost/x", { headers: { "x-key": "b" } }), {});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("lets the window elapse and start a new bucket", async () => {
    const api = app(1, 30);

    expect((await api.handle(new Request("http://localhost/x"), {})).status).toBe(200);
    expect((await api.handle(new Request("http://localhost/x"), {})).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await api.handle(new Request("http://localhost/x"), {})).status).toBe(200);
  });
});