import { describe, it, expect } from "bun:test";

import { createAPI, API, HttpError } from "../types/api";

/*
 * Middleware and cancellation, against the one router.
 *
 * This file used to test `createApp` from the removed universal layer, where middleware
 * and the HTTP transport were separate and a check could be bypassed by calling a route
 * directly. That separation is gone, so the "middleware belongs to the app" invariant is
 * now structural: there is no direct-call path that skips it.
 *
 * What is left worth pinning is that middleware actually gates the handler, that
 * answering from middleware stops the handler running, that ordering is what the code
 * says it is, and that an aborted request reaches the handler as a signal.
 */

/**
 * Serve on an ephemeral port and hand back both the port and a stop function.
 *
 * Returning only the port loses the reference to the `Server`, and a collected server
 * that is still bound makes the *next* test's request land somewhere unexpected — which
 * showed up as one test receiving Bun's default welcome page.
 */
function serve(api: ReturnType<typeof createAPI>): { port: number; stop: () => void } {
  const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req, {}) });

  // `port` is `number | undefined` in Bun's types because a server can be built without
  // one. It cannot here: port 0 asks the OS for a free port, so there is nothing to
  // fetch if it is missing.
  const port = server.port;
  if (port === undefined) throw new Error("The test server bound no port");

  return { port, stop: () => server.stop(true) };
}

describe("Middleware gates the handler", () => {
  function guarded() {
    const api = createAPI();

    api.use((ctx) => {
      if (!ctx.req.headers.get("cookie")) {
        throw new HttpError(401, "Not signed in");
      }
    });

    api.get("/secret", () => API.json({ ok: true }));
    return api;
  }

  it("refuses the request", async () => {
    const api = guarded();
    const { port, stop } = serve(api);

    const res = await fetch(`http://localhost:${port}/secret`);

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Not signed in");

    stop();
  });

  it("lets the request through once the check passes", async () => {
    const api = guarded();
    const { port, stop } = serve(api);

    const res = await fetch(`http://localhost:${port}/secret`, {
      headers: { cookie: "session=1" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    stop();
  });

  it("does not run the handler when it refuses", async () => {
    const api = guarded();

    let ran = false;
    api.get("/tracked", () => {
      ran = true;
      return API.json({ ok: true });
    });

    // Throwing from middleware has to stop the handler. A check that logs and returns
    // is not a check.
    //
    // `handle` catches and formats rather than rejecting — that is the contract for
    // every error in a handler, and it is why the status has to be asserted instead.
    const res = await api.handle(new Request("http://x/tracked"), {});

    expect(res.status).toBe(401);
    expect(ran).toBe(false);
  });

  it("continues the chain when a guard allows the request", async () => {
    const api = createAPI();

    /*
     * The guard shape, written the way anyone writes it: throw to deny, return nothing
     * to allow.
     *
     *   api.use((ctx) => { if (!ctx.req.headers.get("cookie")) throw new HttpError(401); })
     *
     * Returning nothing used to end the chain. `handle` then resolved to `undefined`,
     * Bun fell back to its default welcome page, and an authenticated request got HTML
     * with a 200 — no error anywhere, and the middleware written to allow the request
     * was the thing that stopped it.
     */
    api.use((ctx) => {
      if (ctx.req.headers.get("cookie") !== "session=1") {
        throw new HttpError(401, "Not signed in");
      }
    });

    api.get("/guarded", () => API.json({ ok: true }));

    const res = await api.handle(
      new Request("http://x/guarded", { headers: { cookie: "session=1" } }),
      {},
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("continues when a middleware forwards without returning", async () => {
    const api = createAPI();

    // `await next()` with no `return` — a slip worth allowing, since the intent is
    // unambiguous and the alternative is an undefined response.
    api.use(async (_ctx, next) => {
      await next();
    });

    api.get("/x", () => API.json({ ok: true }));

    const res = await api.handle(new Request("http://x/x"), {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("treats a returned value as the answer and skips the handler", async () => {
    const api = createAPI();

    let ran = false;
    api.use(() => API.json({ from: "cache" }));
    api.get("/cached", () => {
      ran = true;
      return API.json({ from: "handler" });
    });

    const res = await api.handle(new Request("http://x/cached"), {});

    // Answering without calling next is how a cache short-circuits. If the handler ran
    // anyway, every cache in the chain would be decorative.
    expect(await res.json()).toEqual({ from: "cache" });
    expect(ran).toBe(false);
  });

  it("runs in registration order", async () => {
    const order: string[] = [];

    const api = createAPI();
    api.use((_ctx, next) => {
      order.push("first");
      return next();
    });
    api.use((_ctx, next) => {
      order.push("second");
      return next();
    });
    api.get("/x", () => {
      order.push("handler");
      return API.json({ ok: true });
    });

    await api.handle(new Request("http://x/x"), {});

    expect(order).toEqual(["first", "second", "handler"]);
  });

  it("does not interfere when none is registered", async () => {
    const api = createAPI();
    api.get("/plain", () => API.json({ ok: true }));

    const res = await api.handle(new Request("http://x/plain"), {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses to let one middleware call next twice", async () => {
    let handlerRuns = 0;

    const api = createAPI();
    api.use(async (_ctx, next) => {
      await next();
      return next();
    });
    api.get("/x", () => {
      handlerRuns++;
      return API.json({ ok: true });
    });

    const res = await api.handle(new Request("http://x/x"), {});

    /*
     * The property is the count, not the status. A double next() would run the handler
     * — and every middleware after it — twice, which for a "charge a card" or "send an
     * email" middleware is the exact failure worth being hard about.
     *
     * The message is not asserted: a plain Error is masked as "Internal Server Error"
     * by the error handler, which is a separate decision.
     */
    expect(res.status).toBe(500);
    expect(handlerRuns).toBe(1);
  });
});

describe("Cancellation reaches the handler", () => {
  it("hands the request's signal to the handler", async () => {
    let seen: AbortSignal | undefined;

    const api = createAPI();
    api.get("/watch", (ctx) => {
      seen = ctx.req.signal;
      return API.json({ ok: true });
    });

    const controller = new AbortController();
    const req = new Request("http://x/watch", { signal: controller.signal });

    await api.handle(req, {});

    // A handler that cannot see the signal has no way to stop work the caller has
    // already abandoned.
    expect(seen).toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  it("reports an aborted request as aborted", async () => {
    const api = createAPI();

    let abortedDuringHandler = false;
    api.get("/slow", async (ctx) => {
      await Bun.sleep(50);
      abortedDuringHandler = ctx.req.signal.aborted;
      return API.json({ ok: true });
    });

    const controller = new AbortController();
    const req = new Request("http://x/slow", { signal: controller.signal });

    const pending = api.handle(req, {});
    controller.abort();
    await pending;

    expect(abortedDuringHandler).toBe(true);
  });

  it("stops a real request when the client disconnects", async () => {
    let sawAbort = false;

    const api = createAPI();
    api.get("/slow", async (ctx) => {
      await Bun.sleep(30);
      sawAbort = ctx.req.signal.aborted;
      return API.json({ ok: true });
    });

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req, {}) });

    const controller = new AbortController();
    const pending = fetch(`http://localhost:${server.port}/slow`, {
      signal: controller.signal,
    });

    // Give the request time to reach the handler, then walk away.
    await Bun.sleep(5);
    controller.abort();

    await expect(pending).rejects.toThrow();
    await Bun.sleep(60);

    // The server saw the disconnect, so a long handler can stop early instead of
    // finishing work nobody will read.
    expect(sawAbort).toBe(true);

    server.stop(true);
  });
});