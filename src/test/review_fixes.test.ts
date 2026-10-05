import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { createApp, createClient, defineRoute, invoke, mount, ENGINE_NAMES } from "../types/universal";
import { HttpError } from "../types/api";
import { QueryCache } from "../types/frontend";
import { stableStringify, callKey, watchCall, sameState } from "../types/binding";
import { callKey as frameworkCallKey, runMutation, createDomCall } from "../frameworks/index";
import type { CallStore } from "../react/universal-hooks";

/*
 * Regression tests for a review pass.
 *
 * Each one names the behaviour that was wrong, because a test that only says "this
 * works" gives no clue what it is holding in place. Every case here was a real
 * defect, not a hypothetical.
 */

const User = z.object({ id: z.string(), email: z.string(), name: z.string() });

function store() {
  return new QueryCache({ staleTime: 0 }) as unknown as CallStore;
}

describe("invoke — per-call services and context", () => {
  it("lets a call override a service without rebuilding the app", async () => {
    const app = createApp(
      {
        whoami: defineRoute({ method: "get", path: "/whoami" }, async ({ services }) => {
          return services.db as string;
        }),
      },
      { services: { db: "app default" } },
    );

    expect(await app.whoami()).toBe("app default");

    // `options.services` was accepted and then ignored, so the override was a lie.
    const withOverride = await invoke(app as never, "whoami" as never, {} as never, {
      services: { db: "per call" } as never,
    });

    expect(withOverride).toBe("per call");
    // And the app is unchanged, so the override did not leak into the next call.
    expect(await app.whoami()).toBe("app default");
  });

  it("passes a caller's context through to the handler", async () => {
    let seen: unknown;

    const app = createApp({
      ctx: defineRoute({ method: "get", path: "/ctx" }, async ({ ctx }) => {
        seen = ctx;
        return "ok";
      }),
    });

    const fake = { req: { method: "GET", url: "https://x/ctx", headers: { cookie: "a=1" } } };

    // A Server Component handing in the request context used to get an empty one
    // back, so every `ctx.headers` read returned undefined rather than failing.
    await app.ctx({ ctx: fake as never });
    expect(seen).toBe(fake);

    await invoke(app as never, "ctx" as never, { ctx: fake } as never);
    expect(seen).toBe(fake);
  });

  it("still gives a context when none is passed", async () => {
    const app = createApp({
      ctx: defineRoute({ method: "get", path: "/ctx" }, async ({ ctx }) => ctx !== undefined),
    });

    expect(await app.ctx()).toBe(true);
  });
});

describe("Transport — a handler that returns a Response", () => {
  function csvApp() {
    return createApp({
      export: defineRoute({ method: "get", path: "/export" }, async () =>
        new Response("a,b\n1,2", {
          status: 202,
          headers: {
            "content-type": "text/csv",
            "set-cookie": "download=1; Path=/",
            "cache-control": "private",
          },
        }),
      ),
    });
  }

  it("keeps the status the handler chose", async () => {
    const server = Bun.serve({ port: 0, fetch: mount(csvApp()) });

    // 202 is what the handler said. It used to be replaced by a computed 200.
    const res = await fetch(`http://localhost:${server.port}/export`);
    expect(res.status).toBe(202);

    server.stop(true);
  });

  it("keeps every header the handler chose", async () => {
    const server = Bun.serve({ port: 0, fetch: mount(csvApp()) });

    const res = await fetch(`http://localhost:${server.port}/export`);

    // All of these were replaced with a bare application/json, so a CSV export
    // arrived as JSON and a Set-Cookie was silently dropped. A login response
    // through this path set no cookie at all.
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("cache-control")).toBe("private");
    expect(res.headers.get("set-cookie")).toContain("download=1");

    server.stop(true);
  });

  it("passes a stream body through unread", async () => {
    const app = createApp({
      stream: defineRoute({ method: "get", path: "/stream" }, async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk-1"));
              controller.enqueue(new TextEncoder().encode("chunk-2"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    // Reading the body to inspect it would have drained it before the caller saw
    // it, so a stream endpoint would hang.
    const res = await fetch(`http://localhost:${server.port}/stream`);
    expect(await res.text()).toBe("chunk-1chunk-2");

    server.stop(true);
  });

  it("sends the validated value, not the raw one", async () => {
    // A validator that strips unknown keys is how a field reaches production
    // anyway: the bytes on the wire used to be the raw handler's, because the body
    // was stringified before validation and the validated result discarded.
    const Public = z.object({ id: z.string() });

    const app = createApp({
      leaky: defineRoute(
        { method: "get", path: "/leaky", response: Public },
        // Deliberately returns a field the schema does not declare. Note this is
        // *not* caught at compile time: defineRoute infers the handler's own return
        // type rather than checking it against `response`. The real guard is
        // validateResponses at the transport, asserted below.
        async () => ({ id: "u1", passwordHash: "hunter2" }),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app, { validateResponses: true }) });

    const res = await fetch(`http://localhost:${server.port}/leaky`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({ id: "u1" });
    // The whole point of validating before serialising.
    expect(body.passwordHash).toBeUndefined();

    server.stop(true);
  });

  it("applies a transform the validator makes", async () => {
    const Trimmed = z.object({ name: z.string().transform((v) => v.trim()) });

    const app = createApp({
      greet: defineRoute(
        { method: "get", path: "/greet", response: Trimmed },
        async () => ({ name: "  Ada  " }),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app, { validateResponses: true }) });

    // The transform is discarded when the result is thrown away, so the wire value
    // was untransformed.
    expect(await (await fetch(`http://localhost:${server.port}/greet`)).json()).toEqual({
      name: "Ada",
    });

    server.stop(true);
  });

  it("answers 204 for a handler that returned nothing", async () => {
    const app = createApp({
      remove: defineRoute({ method: "delete", path: "/x" }, async () => undefined),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    const res = await fetch(`http://localhost:${server.port}/x`, { method: "DELETE" });
    expect(res.status).toBe(204);

    server.stop(true);
  });
});

describe("Optional parameters over HTTP", () => {
  it("matches and reads a parameter that was omitted", async () => {
    const app = createApp({
      // Trailing optional, which is the only position that is not ambiguous.
      recent: defineRoute(
        { method: "get", path: "/comments/:id?", response: z.object({ id: z.string() }) },
        async ({ params }) => ({ id: String(params.id ?? "none") }),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    const present = await (await fetch(`http://localhost:${server.port}/comments/9`)).json();
    expect(present).toEqual({ id: "9" });

    // With the segment omitted this used to 404, because the segment count no
    // longer matched the template's.
    const absent = await fetch(`http://localhost:${server.port}/comments`);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ id: "none" });

    server.stop(true);
  });

  it("prefers a static route over a dynamic one", async () => {
    const app = createApp({
      dynamic: defineRoute(
        { method: "get", path: "/users/:id", response: z.object({ from: z.string() }) },
        async ({ params }) => ({ from: `dynamic:${params.id}` }),
      ),
      specific: defineRoute(
        { method: "get", path: "/users/new", response: z.object({ from: z.string() }) },
        async () => ({ from: "static" }),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    // Without specificity ordering, "new" matched ":id" and the endpoint became a
    // fetch of the user whose id is the literal string "new".
    expect(await (await fetch(`http://localhost:${server.port}/users/new`)).json()).toEqual({
      from: "static",
    });
    expect(await (await fetch(`http://localhost:${server.port}/users/42`)).json()).toEqual({
      from: "dynamic:42",
    });

    server.stop(true);
  });
});

describe("Cache keys for values that are not plain objects", () => {
  it("tells two different dates apart", () => {
    // `Object.entries(new Date())` is [], so every Date flattened to "{}" and every
    // date-range query shared one cache entry.
    const a = stableStringify({ since: new Date("2026-01-01T00:00:00Z") });
    const b = stableStringify({ since: new Date("2027-12-31T00:00:00Z") });

    expect(a).not.toBe(b);
    expect(a).toContain("2026-01-01");
  });

  it("gives the same date the same key", () => {
    expect(stableStringify({ d: new Date("2026-01-01") })).toBe(
      stableStringify({ d: new Date("2026-01-01") }),
    );
  });

  it("survives a circular structure", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    // Unbounded recursion: this used to be a RangeError, which took down whatever
    // render was building the arguments.
    expect(() => stableStringify(circular)).not.toThrow();
    expect(stableStringify(circular)).toContain("Circular");
  });

  it("does not mistake a repeated sibling for a cycle", () => {
    const shared = { id: 1 };
    // A shared "seen" set would call this circular and throw on an ordinary object.
    expect(() => stableStringify({ a: shared, b: shared })).not.toThrow();
  });

  it("tells other non-plain values apart", () => {
    expect(stableStringify({ r: /ab/gi })).not.toBe(stableStringify({ r: /ab/g }));
    expect(stableStringify({ u: new URL("https://a.dev") })).toContain("a.dev");
    expect(stableStringify({ s: new Set([1]) })).toBe(stableStringify({ s: new Set([1]) }));
    expect(stableStringify({ m: new Map([["k", 1]]) })).toBe(
      stableStringify({ m: new Map([["k", 1]]) }),
    );
  });

  it("handles undefined, functions and symbols without colliding", () => {
    expect(stableStringify(undefined)).toBe(stableStringify({}));
    expect(stableStringify({ f: () => {} })).not.toBe(stableStringify({}));
    expect(stableStringify({ s: Symbol("x") })).not.toBe(stableStringify({}));
  });
});

describe("Subscription storms", () => {
  it("does not wake a subscriber whose key did not change", () => {
    const cache = new QueryCache({ staleTime: 0 });
    const s = cache as unknown as CallStore;

    let wokenForA = 0;
    let wokenForB = 0;

    s.subscribe(() => {
      wokenForA++;
    }, "a");
    s.subscribe(() => {
      wokenForB++;
    }, "b");

    s.set("a", 1);
    expect(wokenForA).toBe(1);
    // A keyed subscription ignores every other key, so one route's write cannot
    // re-render fifty other components. Before this, `subscribe` was global.
    expect(wokenForB).toBe(0);

    s.set("b", 2);
    expect(wokenForA).toBe(1);
    expect(wokenForB).toBe(1);
  });

  it("does not tell a subscriber when nothing it reads changed", async () => {
    const cache = new QueryCache({ staleTime: 0 });
    const s = cache as unknown as CallStore;

    const before = s.get("k");
    const after = s.get("k");

    // The store hands out a fresh object per write, so an identity check reports a
    // change every time and the filter is useless.
    expect(before).not.toBe(after);
    expect(sameState(before, after)).toBe(true);
  });

  it("reports a real change", () => {
    const a = { data: undefined, error: undefined, fetching: false, stale: false };
    const b = { data: { id: "1" }, error: undefined, fetching: false, stale: false };

    expect(sameState(a, b)).toBe(false);
    expect(sameState(a, { ...a, fetching: true })).toBe(false);
  });

  it("only notifies a bound call when its own key is written", async () => {
    const s = store();
    const rows = new Map([["u1", { id: "u1", email: "a@t.dev", name: "Ada" }]]);

    const app = createApp(
      {
        getUser: defineRoute(
          { method: "get", path: "/users/:id", params: z.object({ id: z.string() }), response: User },
          async ({ params }) => rows.get(params.id)!,
        ),
      },
      { services: { rows } },
    );

    const call = createDomCall(s, app.getUser, { params: { id: "u1" } });
    await Bun.sleep(20);

    let changes = 0;
    const off = call.subscribe(() => {
      changes++;
    });

    const baseline = changes;

    // A different key entirely. This used to wake every mounted component on the
    // page, which is why a small change could feel like a janky one.
    s.set("someOtherRoute:{}", { anything: true });
    await Bun.sleep(5);
    expect(changes).toBe(baseline);

    // Its own key does change it.
    s.set(callKey(app.getUser, { params: { id: "u1" } }), { id: "u1", email: "b@t.dev", name: "Bea" });
    await Bun.sleep(5);
    expect(changes).toBeGreaterThan(baseline);

    off();
    call.destroy();
  });
});

describe("Optimistic rollback with nothing cached", () => {
  it("removes the placeholder when there was no previous value", async () => {
    const s = store();
    const key = frameworkCallKey("createThing", undefined);

    const failing = createApp({
      save: defineRoute({ method: "post", path: "/save" }, async () => {
        throw new HttpError(500, "nope");
      }),
    });

    await runMutation(s, failing.save, undefined, { optimistic: { key, value: { temp: true } } }, {
      onPending: () => {},
      onSuccess: () => {},
      onError: () => {},
    });

    // The guard was `previous !== undefined`, so a create on a cold cache skipped
    // the rollback and the placeholder stayed forever — showing an item that was
    // never created.
    expect(s.get(key).data).toBeUndefined();
  });

  it("restores the previous value when there was one", async () => {
    const s = store();
    const key = frameworkCallKey("updateThing", undefined);
    s.set(key, { id: "real" });

    const failing = createApp({
      save: defineRoute({ method: "post", path: "/save" }, async () => {
        throw new Error("nope");
      }),
    });

    await runMutation(s, failing.save, undefined, { optimistic: { key, value: { id: "temp" } } }, {
      onPending: () => {},
      onSuccess: () => {},
      onError: () => {},
    });

    expect(s.get(key).data).toEqual({ id: "real" });
  });
});

describe("Svelte reactivity", () => {
  it("notifies subscribers when the value arrives", async () => {
    const s = store();
    const rows = new Map([["u1", { id: "u1", email: "a@t.dev", name: "Ada" }]]);

    const app = createApp(
      {
        getUser: defineRoute(
          { method: "get", path: "/users/:id", params: z.object({ id: z.string() }), response: User },
          async ({ params }) => rows.get(params.id)!,
        ),
      },
      { services: { rows } },
    );

    const { useSvelteCall } = await import("../frameworks/index");
    const call = useSvelteCall(s, app.getUser, { params: { id: "u1" } });

    const seen: unknown[] = [];
    const off = call.subscribe((state) => seen.push(state.data));

    await Bun.sleep(20);

    // Plain getters are invisible to Svelte — it tracks reads of $state and store
    // subscriptions, and nothing else. The earlier version returned getters with an
    // empty change callback, which rendered once and never updated again.
    expect(seen[0]).toBeUndefined();
    expect(seen[seen.length - 1]).toEqual({ id: "u1", email: "a@t.dev", name: "Ada" });

    off();
    call.destroy();
  });
});

describe("No require in the browser path", () => {
  it("names the engine rather than crashing when a service was not supplied", async () => {
    const app = createApp({
      read: defineRoute({ method: "get", path: "/read" }, async ({ services }) => {
        return (services.db as { users: { findById: () => unknown } }).users.findById();
      }),
    });

    // `require` is not defined in an ESM bundle, so a browser threw a
    // ReferenceError the moment anything here ran. Now the error says what to do.
    let error: unknown;
    try {
      await app.read();
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toMatch(/services\.db/);
    expect((error as Error).message).toMatch(/createApp/);
  });

  it("does not throw for a service the handler never touches", async () => {
    const app = createApp({
      fine: defineRoute({ method: "get", path: "/fine" }, async () => "ok"),
    });

    // Reading a service must not raise on its own — only using it should.
    expect(await app.fine()).toBe("ok");
  });

  it("lists the engines a service may be named after", () => {
    expect(ENGINE_NAMES).toContain("db");
    expect(ENGINE_NAMES).toContain("auth");
    expect(ENGINE_NAMES).toContain("realtime");
  });

  it("still accepts an explicitly supplied service", async () => {
    const app = createApp(
      {
        read: defineRoute({ method: "get", path: "/read" }, async ({ services }) => {
          return (services.db as { ok: boolean }).ok;
        }),
      },
      { services: { db: { ok: true } } },
    );

    expect(await app.read()).toBe(true);
  });
});

describe("client — headers reach the server", () => {
  it("keeps a response's headers all the way to the client", async () => {
    const app = createApp({
      who: defineRoute(
        {
          method: "get",
          path: "/who",
          response: z.object({ user: z.string() }),
        },
        async () => Response.json({ user: "ada" }, { headers: { "x-total-count": "7" } }),
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    // Collected in an array rather than a variable: a closure assignment does not
    // widen the type at the assertion below, so TypeScript still believed the
    // initial value.
    const headers: (string | null)[] = [];

    const client = createClient(app, {
      baseUrl: `http://localhost:${server.port}`,
      onResponse: (res) => {
        headers.push(res.headers.get("x-total-count"));
      },
    });

    const user = await client.who();
    expect((user as { user: string }).user).toBe("ada");
    // The header survived the handler, the transport and the client.
    expect(headers).toEqual(["7"]);

    server.stop(true);
  });
});