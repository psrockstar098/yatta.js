import { describe, it, expect } from "bun:test";
import { z } from "zod";

import {
  createApp,
  createClient,
  defineRoute,
  mount,
  withMiddleware,
} from "../types/universal";
import { HttpError } from "../types/api";

/*
 * Middleware, route-level invalidation and cancellation.
 *
 * Middleware is the security-relevant one. A check that only runs over HTTP is
 * bypassed by every direct call, and a Server Component that calls a route directly
 * is exactly the code path a reader would believe is guarded.
 */

describe("Middleware runs on both paths", () => {
  function guarded() {
    return createApp(
      {
        secret: defineRoute({ method: "get", path: "/secret", response: z.object({ ok: z.boolean() }) }, async () => ({
          ok: true,
        })),
      },
      {
        middleware: [
          ({ ctx }) => {
            const request = ctx.req as unknown as { headers?: Record<string, string> } | undefined;
            const allowed = request?.headers?.cookie;
            if (!allowed) throw new HttpError(401, "Not signed in");
          },
        ],
      },
    );
  }

  it("guards a direct call", async () => {
    // Before this, middleware lived only on the HTTP transport, so this call
    // returned the secret to anyone who asked.
    await expect(guarded().secret()).rejects.toThrow(/Not signed in/);
  });

  it("guards an HTTP call", async () => {
    const server = Bun.serve({ port: 0, fetch: mount(guarded()) });

    const res = await fetch(`http://localhost:${server.port}/secret`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Not signed in");

    server.stop(true);
  });

  it("lets the call through once the check passes", async () => {
    const app = guarded();

    const result = await app.secret({
      ctx: { req: { method: "GET", url: "/secret", headers: { cookie: "a=1" } } } as never,
    });

    expect(result).toEqual({ ok: true });
  });

  it("stops at a middleware that answered", async () => {
    let handlerRan = false;

    const app = createApp(
      {
        cached: defineRoute({ method: "get", path: "/cached" }, async () => {
          handlerRan = true;
          return { from: "handler" };
        }),
      },
      {
        middleware: [
          // Returning a value IS the answer.
          () => ({ from: "cache" }),
        ],
      },
    );

    expect(await app.cached()).toEqual({ from: "cache" });
    // A middleware that returns something and lets the handler run anyway makes
    // every cache in the chain decorative.
    expect(handlerRan).toBe(false);
  });

  it("runs in order, app middleware outside a route's own", async () => {
    const order: string[] = [];

    const route = withMiddleware(
      defineRoute({ method: "get", path: "/x" }, async () => {
        order.push("handler");
        return "ok";
      }),
      () => {
        order.push("route");
      },
    );

    const app = createApp(
      { x: route },
      {
        middleware: [
          () => {
            order.push("app-outer");
          },
          () => {
            order.push("app-inner");
          },
        ],
      },
    );

    await app.x();

    // The app's checks run outside the route's, so a cross-cutting auth check
    // cannot be bypassed by a route declaring its own middleware.
    expect(order).toEqual(["app-outer", "app-inner", "route", "handler"]);
  });

  it("does not run for a route with no middleware on an app with none", async () => {
    const app = createApp({
      plain: defineRoute({ method: "get", path: "/plain" }, async () => "ok"),
    });

    expect(await app.plain()).toBe("ok");
  });
});

describe("Cancellation", () => {
  it("gives a direct call's handler the signal", async () => {
    let seen: AbortSignal | undefined;

    const app = createApp({
      watch: defineRoute({ method: "get", path: "/watch" }, async ({ ctx }) => {
        seen = (ctx as unknown as { signal?: AbortSignal }).signal;
        return "ok";
      }),
    });

    const controller = new AbortController();
    await app.watch({ signal: controller.signal });

    // A direct call with a signal the handler cannot see is the same as no signal.
    expect(seen).toBe(controller.signal);
  });

  it("forwards the signal to fetch on the HTTP path", async () => {
    const app = createApp({
      slow: defineRoute({ method: "get", path: "/slow" }, async () => {
        await Bun.sleep(200);
        return { ok: true };
      }),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    const client = createClient(app, { baseUrl: `http://localhost:${server.port}` });

    const controller = new AbortController();
    // Aborted before the call, so fetch rejects rather than waiting 200ms.
    controller.abort();

    await expect(client.slow({ signal: controller.signal })).rejects.toThrow();

    server.stop(true);
  });
});
