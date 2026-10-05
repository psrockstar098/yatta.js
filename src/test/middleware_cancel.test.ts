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
import { QueryCache } from "../types/frontend";
import { runMutation, createDomCall, routePrefix } from "../frameworks/index";
import type { CallStore } from "../react/universal-hooks";

/*
 * Middleware, route-level invalidation and cancellation.
 *
 * Middleware is the security-relevant one. A check that only runs over HTTP is
 * bypassed by every direct call, and a Server Component that calls a route directly
 * is exactly the code path a reader would believe is guarded.
 */

const User = z.object({ id: z.string(), email: z.string(), name: z.string() });

function store() {
  return new QueryCache({ staleTime: 0 }) as unknown as CallStore;
}

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

const ada: z.infer<typeof User> = { id: "u1", email: "a@t.dev", name: "Ada" };

describe("Route-level invalidation", () => {
  it("invalidates every call to a route", async () => {
    const s = store();
    const app = createApp({
      getUser: defineRoute({ method: "get", path: "/users/:id" }, async () => ({ ok: true })),
    });

    s.set("getUser:{\"params\":{\"id\":\"1\"}}", { ok: true });
    s.set("getUser:{\"params\":{\"id\":\"2\"}}", { ok: true });
    s.set("getUser:{\"params\":{\"id\":\"3\"}}", { ok: true });

    await runMutation(s, app.getUser as never, undefined, { invalidates: [app.getUser] } as never, {
      onPending: () => {},
      onSuccess: () => {},
      onError: () => {},
    });

    // A mutation on a user has to invalidate getUser for every id. Listing each key
    // means writing down every id ever fetched, which is wrong the moment a
    // component asks for one nobody predicted.
    expect((s.get("getUser:{\"params\":{\"id\":\"1\"}}") as { stale: boolean }).stale).toBe(true);
    expect((s.get("getUser:{\"params\":{\"id\":\"2\"}}") as { stale: boolean }).stale).toBe(true);
    expect((s.get("getUser:{\"params\":{\"id\":\"3\"}}") as { stale: boolean }).stale).toBe(true);
  });

  it("leaves other routes alone", () => {
    const s = store();

    s.set("getUser:{}", 1);
    s.set("listUsers:{}", 2);

    s.invalidate(routePrefix("getUser"));

    expect((s.get("getUser:{}") as { stale: boolean }).stale).toBe(true);
    expect((s.get("listUsers:{}") as { stale: boolean }).stale).toBe(false);
  });

  it("still invalidates one exact key", () => {
    const s = store();

    s.set("a:1", 1);
    s.set("a:2", 2);

    s.invalidate("a:1");

    expect((s.get("a:1") as { stale: boolean }).stale).toBe(true);
    expect((s.get("a:2") as { stale: boolean }).stale).toBe(false);
  });

  it("refuses a target it cannot identify", () => {
    // Better a clear error than a prefix of "unknown:" that silently matches
    // nothing and leaves stale data on screen.
    expect(() => routePrefix((() => {}) as never)).toThrow(/route method/);
  });

  it("gives an anonymous route method a real name", () => {
    // The derived methods are named after their routes precisely so this works. An
    // anonymous function here is the mistake, and it is reported rather than
    // producing a key that matches nothing.
    const app = createApp({
      getThing: defineRoute({ method: "get", path: "/thing" }, async () => "ok"),
    });

    expect(routePrefix(app.getThing)).toBe("getThing:");
  });

  it("wakes nobody when a prefix matches nothing", () => {
    const s = store();
    s.set("present:{}", 1);

    let woken = 0;
    s.subscribe(() => {
      woken++;
    }, "present");

    s.invalidate("absent:");
    expect(woken).toBe(0);
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

  it("abandons a bound call when its signal fires", async () => {
    const s = store();
    const rows = new Map([["u1", { id: "u1", email: "a@t.dev", name: "Ada" }]]);

    const app = createApp(
      {
        getUser: defineRoute(
          {
            method: "get",
            path: "/users/:id",
            params: z.object({ id: z.string() }),
            response: User,
          },
          async ({ params }) => {
            await Bun.sleep(50);
            return rows.get(params.id)!;
          },
        ),
      },
      { services: { rows } },
    );

    const controller = new AbortController();
    controller.abort();

    const call = createDomCall(s, app.getUser, { params: { id: "u1" } }, {
      signal: controller.signal,
    } as never);

    await Bun.sleep(120);

    // The work still ran — it is a server-side query and nobody can un-issue it —
    // but the abort must not be reported as a failure, or every cancelled search
    // would show an error to the person who typed it.
    expect(call.state.error).toBeUndefined();

    call.destroy();
  });

  it("still works with no signal at all", async () => {
    const s = store();
    const rows = new Map([["u1", { id: "u1", email: "a@t.dev", name: "Ada" }]]);

    const app = createApp(
      {
        getUser: defineRoute(
          {
            method: "get",
            path: "/users/:id",
            params: z.object({ id: z.string() }),
            response: User,
          },
          async ({ params }) => rows.get(params.id)!,
        ),
      },
      { services: { rows } },
    );

    const call = createDomCall(s, app.getUser, { params: { id: "u1" } });
    await Bun.sleep(30);

    expect(call.state.data).toEqual(ada);
    call.destroy();
  });
});