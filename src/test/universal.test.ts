import { describe, it, expect } from "bun:test";
import { z } from "zod";

import {
  createApp,
  createClient,
  defineRoute,
  invoke,
  mount,
  readQuery,
  routesOf,
  defaultServices,
  type App,
  type CallResult,
  type DirectMethods,
} from "../types/universal";
import { HttpError } from "../types/api";

/*
 * The claim under test: one table of routes produces every surface, and a route
 * behaves identically whether it is called in process or over HTTP.
 *
 * Nothing here is written twice. There is no wrapper per endpoint, no client to
 * maintain, and no shared DTO module — because there is nothing to put in one.
 */

const User = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

const UserId = z.object({ id: z.string().min(1) });
const NewUser = z.object({ email: z.string(), name: z.string().min(2) });

/** A stand-in for the database, so the test does not need one. */
function makeStore() {
  const rows = new Map<string, z.infer<typeof User>>();
  return {
    rows,
    findById: (id: string) => rows.get(id),
    insert: (input: { email: string; name: string }) => {
      if ([...rows.values()].some((r) => r.email === input.email)) {
        throw new HttpError(409, "That email is already registered");
      }
      const row = { id: `u${rows.size + 1}`, ...input };
      rows.set(row.id, row);
      return row;
    },
  };
}

type Store = ReturnType<typeof makeStore>;

function build(store: Store) {
  return createApp(
    {
      getUser: defineRoute(
        { method: "get", path: "/users/:id", params: UserId, response: User },
        async ({ params, services }) => {
          const db = services.db as Store;
          const found = db.findById(params.id);
          if (!found) throw new HttpError(404, "No such user");
          return found;
        },
      ),

      createUser: defineRoute(
        { method: "post", path: "/users", body: NewUser, response: User },
        async ({ body, services }) => {
          const db = services.db as Store;
          return db.insert(body as { email: string; name: string });
        },
      ),

      listUsers: defineRoute(
        {
          method: "get",
          path: "/users",
          query: z.object({ search: z.string().optional() }),
          response: z.array(User),
        },
        async ({ query, services }) => {
          const db = services.db as Store;
          const all = [...db.rows.values()];
          const search = query.search;
          return search ? all.filter((u) => u.email.includes(search)) : all;
        },
      ),

      // Returns nothing. A plain "done", not a Response.
      deleteUser: defineRoute({ method: "delete", path: "/users/:id", params: UserId }, async () => {
        return undefined;
      }),
    },
    { services: { db: store } },
  );
}

type TestApp = ReturnType<typeof build>;

describe("Universal routes — the app is the transport", () => {
  it("exposes a method per route with nothing declared by hand", async () => {
    const store = makeStore();
    const app = build(store);

    // No wrapper, no cast, no interface. The method name came from the key in the
    // table and the types came from the route.
    const created = await app.createUser({ body: { email: "ada@t.dev", name: "Ada" } });
    expect(created.name).toBe("Ada");

    const fetched = await app.getUser({ params: { id: created.id } });
    expect(fetched.email).toBe("ada@t.dev");

    const all = await app.listUsers({ query: { search: "ada" } });
    expect(all).toHaveLength(1);

    expect(await app.deleteUser({ params: { id: created.id } })).toBeUndefined();
  });

  it("survives a method being pulled off the app and called on its own", async () => {
    const store = makeStore();
    const app = build(store);

    // The methods are bound. An unbound call loses `services` and fails a long way
    // from the cause, which is the classic reason this pattern breaks.
    const { getUser, createUser } = app;
    const created = await createUser({ body: { email: "g@t.dev", name: "Grace" } });

    expect((await getUser({ params: { id: created.id } })).name).toBe("Grace");
  });

  it("gives a handler the framework services, typed", async () => {
    const store = makeStore();
    const app = build(store);

    // `services.db` is the store passed to createApp, not a global. So a test can
    // pass its own, and two apps in one process cannot see each other's data.
    const created = await app.createUser({ body: { email: "a@t.dev", name: "Alice" } });

    expect(store.rows.get(created.id)?.email).toBe("a@t.dev");
  });

  it("has defaults that load an engine only when a handler asks for it", async () => {
    const services = defaultServices();

    // Reading the map must not construct anything: mounting an app on the server
    // spins up every engine the process owns, including ones no route touches.
    expect(Object.keys(services)).toContain("db");
    expect(Object.keys(services)).toContain("auth");

    // The values are getters, so nothing is resolved until it is touched.
    const described = Object.getOwnPropertyDescriptor(services, "db");
    expect(typeof described?.get).toBe("function");
  });
});

describe("Universal routes — same behaviour in process and over HTTP", () => {
  /**
   * Runs the table both ways against *one* store.
   *
   * One store, not two: the claim is that the two paths are the same function, so
   * they have to be looking at the same data. With two stores the comparison
   * proved nothing — the HTTP call would write to a different database and still
   * return the same-looking row.
   */
  async function bothWays(buildApp: (store: Store) => TestApp) {
    const store = makeStore();

    const app = buildApp(store);
    const httpApp = buildApp(store);

    const server = Bun.serve({ port: 0, fetch: mount(httpApp) });

    const client = createClient(app, { baseUrl: `http://localhost:${server.port}` });

    return { app, client, store, server };
  }

  it("returns the same value from a direct call and an HTTP call", async () => {
    const { app, client, store, server } = await bothWays(build);

    const viaDirect = await app.createUser({ body: { email: "same@t.dev", name: "Same" } });

    // The same row is now in the shared store, so the HTTP call reads it back
    // rather than creating a second one.
    expect(store.rows.size).toBe(1);

    const fetchedDirect = await app.getUser({ params: { id: viaDirect.id } });
    const fetchedHttp = await client.getUser({ params: { id: viaDirect.id } });

    expect(fetchedDirect).toEqual(viaDirect);
    expect(fetchedHttp).toEqual(viaDirect);

    // And a create over HTTP lands in the same store, so the paths really are the
    // same handler on the same data.
    const viaHttp = await client.createUser({ body: { email: "other@t.dev", name: "Other" } });
    expect(store.rows.get(viaHttp.id)).toEqual(viaHttp);

    server.stop(true);
  });

  it("carries the same status and message over HTTP as it throws in process", async () => {
    const { app, client, server } = await bothWays(build);

    // In process the handler throws.
    let thrown: unknown;
    try {
      await app.getUser({ params: { id: "missing" } });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(404);
    expect((thrown as HttpError).message).toBe("No such user");

    // Over HTTP the caller gets the same status and the same message, not a
    // generic 500.
    let overHttp: unknown;
    try {
      await client.getUser({ params: { id: "missing" } });
    } catch (err) {
      overHttp = err;
    }

    expect((overHttp as { status: number }).status).toBe(404);
    expect((overHttp as Error).message).toBe("No such user");

    server.stop(true);
  });

  it("rejects the same bad body in process as over HTTP", async () => {
    const { app, client, server } = await bothWays(build);

    let direct: unknown;
    try {
      await app.createUser({ body: { email: "x@t.dev", name: "a" } as never });
    } catch (err) {
      direct = err;
    }

    let overHttp: unknown;
    try {
      await client.createUser({ body: { email: "x@t.dev", name: "a" } as never });
    } catch (err) {
      overHttp = err;
    }

    // The schema is the same object on both paths, so a value one rejects cannot
    // be accepted by the other. Both name the field, and both say 400 rather than
    // turning a client's typo into an opaque server fault.
    expect((direct as Error).message).toMatch(/body\.name/);
    expect((overHttp as Error).message).toMatch(/body\.name/);
    expect((direct as HttpError).status).toBe(400);
    expect((overHttp as { status: number }).status).toBe(400);

    server.stop(true);
  });

  it("reports a conflict from either path with 409", async () => {
    const { app, client, server } = await bothWays(build);

    await app.createUser({ body: { email: "dupe@t.dev", name: "First" } });

    // Over HTTP: the conflict arrives as a status and the handler's message.
    try {
      await client.createUser({ body: { email: "dupe@t.dev", name: "Second" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { status: number }).status).toBe(409);
      expect((err as Error).message).toBe("That email is already registered");
    }

    // In process: the same conflict, as the same error class.
    try {
      await app.createUser({ body: { email: "dupe@t.dev", name: "Third" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(409);
      expect((err as HttpError).message).toBe("That email is already registered");
    }

    server.stop(true);
  });

  it("handles an empty return over HTTP without a parse error", async () => {
    const { app, client, server } = await bothWays(build);

    const created = await app.createUser({ body: { email: "x@t.dev", name: "Xavier" } });
    await client.deleteUser({ params: { id: created.id } });

    // Nothing returned is a legitimate answer, not malformed JSON.
    expect(await client.deleteUser({ params: { id: created.id } })).toBeUndefined();

    server.stop(true);
  });
});

describe("Universal routes — derived transport details", () => {
  it("tells a wrong verb from a wrong path", async () => {
    const app = build(makeStore());
    const server = Bun.serve({ port: 0, fetch: mount(app) });

    const base = `http://localhost:${server.port}`;

    // The path exists. A 404 would send someone hunting for a typo in a correct
    // path.
    const wrongVerb = await fetch(`${base}/users`, { method: "PUT" });
    expect(wrongVerb.status).toBe(405);
    expect(wrongVerb.headers.get("allow")).toContain("GET");

    const wrongPath = await fetch(`${base}/nope`);
    expect(wrongPath.status).toBe(404);

    server.stop(true);
  });

  it("does not match a static route against a dynamic one", async () => {
    // `/users/new` is a static route and `/users/:id` is dynamic. A prefix match
    // gets this backwards and serves the wrong handler.
    const store = makeStore();
    const app = createApp(
      {
        getUser: defineRoute(
          { method: "get", path: "/users/:id", params: UserId, response: User },
          async ({ params }) => ({ id: params.id, email: "a@t.dev", name: "A" }),
        ),
        createUser: defineRoute(
          { method: "post", path: "/users/new", response: z.object({ made: z.boolean() }) },
          async () => ({ made: true }),
        ),
      },
      { services: { db: store } },
    );

    const server = Bun.serve({ port: 0, fetch: mount(app) });

    // Different verbs, so this checks the matcher rather than the method.
    const dynamic = await fetch(`http://localhost:${server.port}/users/u1`);
    expect((await dynamic.json()) as { id: string }).toMatchObject({ id: "u1" });

    const stat = await fetch(`http://localhost:${server.port}/users/new`, { method: "POST" });
    expect(await stat.json()).toEqual({ made: true });

    server.stop(true);
  });

  it("reads a repeated query key as an array and a single one as a scalar", async () => {
    expect(readQuery("http://x/?limit=10")).toEqual({ limit: "10" });
    expect(readQuery("http://x/?tag=a&tag=b")).toEqual({ tag: ["a", "b"] });
    expect(readQuery("http://x/no-query")).toEqual({});
  });

  it("optionally checks a handler against its declared response", async () => {
    // A handler that no longer matches the shape its clients are typed against is
    // a 200 with missing fields everywhere, and nothing catches it.
    const drifting = createApp({
      broken: defineRoute(
        { method: "get", path: "/broken", response: User },
        async () => ({ id: "1" }) as never,
      ),
    });

    const server = Bun.serve({ port: 0, fetch: mount(drifting, { validateResponses: true }) });

    const res = await fetch(`http://localhost:${server.port}/broken`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/broken/);

    server.stop(true);
  });

  it("does not leak an internal message on an unexpected error", async () => {
    const exploding = createApp({
      boom: defineRoute({ method: "get", path: "/boom" }, async () => {
        throw new Error("database password is hunter2");
      }),
    });

    const server = Bun.serve({ port: 0, fetch: mount(exploding) });

    const res = await fetch(`http://localhost:${server.port}/boom`);
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    // The message goes to the log, not to whoever triggered the error.
    expect(body.error).not.toContain("hunter2");
    expect(body.error).toBe("Internal error");

    server.stop(true);
  });

  it("passes an unexpected error to onError with the response it became", async () => {
    const exploding = createApp({
      boom: defineRoute({ method: "get", path: "/boom" }, async () => {
        throw new Error("nope");
      }),
    });

    const seen: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: mount(exploding, { onError: (err) => seen.push(err) }),
    });

    await fetch(`http://localhost:${server.port}/boom`);

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("nope");

    server.stop(true);
  });
});

// ── Types ──────────────────────────────────────────────────────────────────

describe("Universal routes — types hold at compile time", () => {
  it("types arguments and results without any annotation", () => {
    const app = build(makeStore());

    const check = async () => {
      // Response typed from the declared schema.
      const user = await app.getUser({ params: { id: "u1" } });
      const email: string = user.email;
      const name: string = user.name;

      // A request typed from the body schema.
      await app.createUser({ body: { email: "a@t.dev", name: "Ada" } });

      // @ts-expect-error email must be a string
      await app.createUser({ body: { email: 1, name: "Ada" } });

      // @ts-expect-error params are required
      await app.getUser({});

      // @ts-expect-error id must be a string
      await app.getUser({ params: { id: 1 } });

      // @ts-expect-error this route takes no body
      await app.getUser({ params: { id: "u1" }, body: {} });

      // @ts-expect-error no such route on this app
      await app.deleteEverything();

      return { email, name };
    };

    expect(typeof check).toBe("function");
  });

  it("gives the HTTP client the same surface as the app", () => {
    const app = build(makeStore());

    const check = async () => {
      const api = createClient(app, { baseUrl: "/api" });

      // Both are named `getUser` and take the same arguments. Nothing was written
      // twice to make that so.
      const direct = await app.getUser({ params: { id: "u1" } });
      const overHttp = await api.getUser({ params: { id: "u1" } });

      const a: string = direct.email;
      const b: string = overHttp.email;

      // @ts-expect-error the client rejects the same thing the app rejects
      await api.getUser({ params: { id: 1 } });

      return { a, b };
    };

    expect(typeof check).toBe("function");
  });

  it("lets a handler's own return type reach the caller", () => {
    // A route with no response schema hands back exactly what the handler
    // returned, rather than unknown.
    const counted = createApp({
      count: defineRoute({ method: "get", path: "/count" }, async () => 42),
    });

    const check = async () => {
      const value: number = await counted.count();
      return value;
    };

    expect(typeof check).toBe("function");
  });

  it("reads the routes off either an app or a bare table", () => {
    const app = build(makeStore());

    const fromApp = routesOf(app);
    const fromTable = routesOf(app.routes);

    // Both shapes are accepted, so a caller never has to unwrap at the call site.
    // `routesOf` once sniffed the values for a `spec` key and then returned the
    // wrong one of the two — so `mount()` read the app's own keys as routes and
    // every request failed on a missing `spec`. Ten tests caught it; this names it.
    expect(Object.keys(fromApp).sort()).toEqual(Object.keys(fromTable).sort());
    expect(Object.keys(fromApp)).toContain("getUser");

    for (const route of Object.values(fromApp)) {
      expect(route.spec).toBeDefined();
    }
  });

  it("reports a route name that is not there, listing the ones that are", async () => {
    const app = build(makeStore());

    let error: unknown;
    try {
      await invoke(app as never, "nope" as never, {} as never);
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toMatch(/No route named "nope"/);
    // The message lists what is available, because "unknown route" on its own
    // sends someone reading the table again.
    expect((error as Error).message).toMatch(/getUser/);
  });
});