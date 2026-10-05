import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";

import { type CallError } from "../types/client";
import { serve, serverRoute, clientFor, route, fail } from "../types/rpc";

/*
 * The claim under test: one table of route definitions produces both the server's
 * routes and the client's methods, from the same validator objects. Nothing here
 * is written twice — no parallel interface, no generated file, no second URL.
 */

const UserId = z.object({ id: z.string().min(1) });
const NewUser = z.object({ email: z.string(), name: z.string().min(2) });
const User = z.object({ id: z.string(), email: z.string(), displayName: z.string() });
const UserList = z.array(User);

const routes = {
  getUser: serverRoute(
    { method: "get", path: "/users/:id", params: UserId, response: User },
    async ({ params }) => {
      const found = store.get(params.id);
      if (!found) return fail(404, "No such user");
      return found;
    },
  ),

  listUsers: serverRoute(
    {
      method: "get",
      path: "/users",
      query: z.object({ search: z.string().optional() }),
      response: UserList,
    },
    async ({ query }) => {
      const search = query.search;
      const all = [...store.values()];
      return search ? all.filter((u) => u.email.includes(search)) : all;
    },
  ),

  createUser: serverRoute(
    { method: "post", path: "/users", body: NewUser, response: User },
    async ({ body }) => {
      if (storeByEmail.has(body.email)) return fail(409, "That email is already registered");
      const user = { id: `u${store.size + 1}`, email: body.email, displayName: body.name };
      store.set(user.id, user);
      storeByEmail.set(user.email, user.id);
      return user;
    },
  ),

  deleteUser: serverRoute(
    { method: "delete", path: "/users/:id", params: UserId },
    async ({ params }) => {
      const user = store.get(params.id);
      store.delete(params.id);
      if (user) storeByEmail.delete(user.email);
      return { ok: true, deleted: Boolean(user) };
    },
  ),
};

const store = new Map<string, z.infer<typeof User>>();
const storeByEmail = new Map<string, string>();

// Cleared per test: the store is module-level so the handlers above can close
// over it, and without this the tests order-dependently inherited each other's
// rows.
beforeEach(() => {
  store.clear();
  storeByEmail.clear();
});

async function startServer(validateResponses = false) {
  const api = serve(routes, { prefix: "/api", validateResponses });

  const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

  const baseUrl = `http://localhost:${server.port}`;
  // The client is built from the same table the server is serving.
  const client = clientFor(routes, { baseUrl });

  return { server, client, baseUrl };
}

describe("Yatta rpc — one definition, both sides", () => {
  it("serves every route in the table", async () => {
    const { server, client } = await startServer();

    const created = await client.createUser({
      body: { email: "ada@t.dev", name: "Ada" },
    });
    expect(created.displayName).toBe("Ada");

    const fetched = await client.getUser({ params: { id: created.id } });
    expect(fetched.email).toBe("ada@t.dev");

    await client.createUser({ body: { email: "grace@t.dev", name: "Grace" } });

    const all = await client.listUsers();
    expect(all).toHaveLength(2);

    // The query is validated by the shared schema, so filtering is typed.
    const filtered = await client.listUsers({ query: { search: "grace" } });
    expect(filtered.map((u: { displayName: string }) => u.displayName)).toEqual(["Grace"]);

    // A route with no declared response returns whatever the handler returned.
    expect(await client.deleteUser({ params: { id: created.id } })).toEqual({
      ok: true,
      deleted: true,
    });

    server.stop(true);
  });

  it("hands the handler a body shaped by the shared schema", async () => {
    const { server, client } = await startServer();

    // The request used `name`; the handler received `displayName`. Only one
    // mapping exists — in the handler — and the response schema is what the
    // client is typed against, so the rename cannot get out of step.
    const created = await client.createUser({
      body: { email: "renamed@t.dev", name: "Renamed" },
    });

    expect(created).toEqual({
      id: created.id,
      email: "renamed@t.dev",
      displayName: "Renamed",
    });

    server.stop(true);
  });

  it("refuses an invalid body before the handler sees it", async () => {
    const { server, client } = await startServer();

    await expect(
      client.createUser({ body: { email: "x@t.dev", name: "a" } as never }),
    ).rejects.toThrow(/body\.name/);

    // Nothing was written, so the handler never ran.
    expect(await client.listUsers()).toHaveLength(0);

    server.stop(true);
  });

  it("carries the handler's own status and message", async () => {
    const { server, client } = await startServer();

    try {
      await client.getUser({ params: { id: "missing" } });
      throw new Error("should have thrown");
    } catch (err) {
      const callError = err as CallError;
      expect(callError.status).toBe(404);
      // From fail(), not from a generic 500.
      expect(callError.message).toBe("No such user");
    }

    server.stop(true);
  });

  it("reports a conflict from the handler", async () => {
    const { server, client } = await startServer();

    await client.createUser({ body: { email: "dupe@t.dev", name: "First" } });

    try {
      await client.createUser({ body: { email: "dupe@t.dev", name: "Second" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as CallError).status).toBe(409);
      expect((err as CallError).message).toBe("That email is already registered");
    }

    server.stop(true);
  });

  it("optionally checks a handler's output against its declared response", async () => {
    const { server, client } = await startServer(true);

    // Every handler here matches its response schema, so nothing is rejected.
    const created = await client.createUser({ body: { email: "ok@t.dev", name: "Ok" } });
    expect(created.id).toBeString();

    server.stop(true);
  });

  it("catches a handler that drifts from its declared response", async () => {
    // A handler whose return type no longer matches the response schema is the
    // exact bug this option exists for: the clients are typed against the schema
    // and would silently read undefined fields.
    const drifted = {
      broken: serverRoute(
        { method: "get", path: "/broken", response: User },
        async () => ({ id: "1" }) as never,
      ),
    };

    const api = serve(drifted, { prefix: "/api", validateResponses: true });
    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    const res = await fetch(`http://localhost:${server.port}/api/broken`);
    const body = (await res.json()) as { error?: string };

    // A 500 naming the offending field, not a 200 with missing fields — and not a
    // generic 500 with the detail stripped out.
    expect(res.status).toBe(500);
    expect(body.error ?? "").toMatch(/broken/);
    expect(body.error ?? "").toMatch(/email|displayName/);

    server.stop(true);
  });

  it("sends repeated query values as arrays", async () => {
    const listRoute = {
      multi: serverRoute(
        {
          method: "get",
          path: "/multi",
          query: z.object({ tag: z.array(z.string()) }),
          response: z.object({ count: z.number() }),
        },
        async ({ query }) => ({ count: query.tag.length }),
      ),
    };

    const api = serve(listRoute, { prefix: "/api" });
    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    const res = await fetch(`http://localhost:${server.port}/api/multi?tag=a&tag=b&tag=c`);
    // The query array survives the round trip rather than collapsing to the last
    // value, which is what a plain string reader would have produced.
    expect(await res.json()).toEqual({ count: 3 });

    server.stop(true);
  });

  it("passes a scalar query value through as a scalar", async () => {
    const oneRoute = {
      one: serverRoute(
        {
          method: "get",
          path: "/one",
          query: z.object({ limit: z.coerce.number() }),
          response: z.object({ limit: z.number() }),
        },
        async ({ query }) => ({ limit: query.limit }),
      ),
    };

    const api = serve(oneRoute, { prefix: "/api" });
    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    // A single ?limit=10 arrives as a number, not as { limit: ["10"] }, so the
    // schema does not have to special-case both shapes.
    expect(await (await fetch(`http://localhost:${server.port}/api/one?limit=10`)).json()).toEqual({
      limit: 10,
    });

    server.stop(true);
  });
});
/*
 * Compile-time assertions.
 *
 * These are the checks that matter most for this module and none of them can be
 * made at runtime: whether the client still knows a request shape, and still
 * refuses a wrong one. Each `@ts-expect-error` is a standing claim that the next
 * line *does* fail to compile. If a change makes it compile, the typecheck fails
 * and the claim is caught.
 *
 * This is not hypothetical. `ClientFor` once intersected each route with the base
 * interface, which widened every validator to `unknown`. The client kept its
 * promise shape while accepting any argument, and no runtime test could see it.
 */
describe("Yatta rpc — types hold at compile time", () => {
  it("checks the client's signatures without running anything", () => {
    const client = clientFor(routes, { baseUrl: "http://localhost:1" });

    const check = async () => {
      // A response is typed from the shared schema.
      const user = await client.getUser({ params: { id: "1" } });
      const email: string = user.email;
      const displayName: string = user.displayName;

      // A request body is typed from the shared schema too.
      await client.createUser({ body: { email: "a@t.dev", name: "Ada" } });

      return { email, displayName };
    };

    /*
     * The calls that must not compile live in a function that is never called.
     * They are promises, and running them would fire real requests at a dead
     * port — the point of the assertions is what the compiler says, not what
     * happens at runtime.
     */
    const mustNotCompile = async () => {
      // @ts-expect-error email must be a string
      await client.createUser({ body: { email: 1, name: "Ada" } });

      // @ts-expect-error params are required
      await client.getUser({});

      // @ts-expect-error id must be a string
      await client.getUser({ params: { id: 1 } });

      // @ts-expect-error there is no query on this route
      await client.getUser({ params: { id: "1" }, query: { a: 1 } });

      // @ts-expect-error this route has no body
      await client.getUser({ params: { id: "1" }, body: {} });

      // A response is typed from the shared schema.
      const user = await client.getUser({ params: { id: "1" } });
      const email: string = user.email;
      const displayName: string = user.displayName;

      // A request body is typed from the shared schema too.
      await client.createUser({ body: { email: "a@t.dev", name: "Ada" } });

      // raw:true means the shape is no longer known.
      const raw: unknown = await client.getUser({ params: { id: "1" }, raw: true });

      return { email, displayName, raw };
    };

    void mustNotCompile;
    void check;

    expect(typeof check).toBe("function");
  });
});

describe("Yatta rpc — handlers kept out of the contract", () => {
  it("serves a route table that carries no handlers", async () => {
    // The shape a browser can import: paths and schemas, no server code.
    const contract = {
      ping: {
        method: "get" as const,
        path: "/ping",
        response: z.object({ pong: z.boolean() }),
      },
    };

    const api = serve(contract, {
      prefix: "/api",
      handlers: { ping: async () => ({ pong: true }) },
    });

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    const res = await fetch(`http://localhost:${server.port}/api/ping`);
    expect(await res.json()).toEqual({ pong: true });

    server.stop(true);
  });

  it("prefers a handler attached inline over one in the map", async () => {
    const definition = {
      method: "get" as const,
      path: "/who",
      response: z.object({ from: z.string() }),
    };

    const api = serve(
      { who: serverRoute(definition, async () => ({ from: "inline" })) },
      { handlers: { who: async () => ({ from: "map" }) } },
    );

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    // One router, both handlers offered. The one attached to the route is used.
    expect(await (await fetch(`http://localhost:${server.port}/who`)).json()).toEqual({
      from: "inline",
    });

    server.stop(true);
  });

  it("says which route has no handler", () => {
    expect(() =>
      serve({ lonely: { method: "get" as const, path: "/lonely" } }),
    ).toThrow(/route "lonely" has no handler/);
  });
});

/*
 * The pattern the README documents, end to end.
 *
 * Worth having as a test rather than as prose: the split between a contract file
 * and a handlers map exists for one reason, so that a browser can import the
 * contract without pulling the database in with it. If the types quietly stopped
 * working across that split, the documented setup would ship a client that
 * accepted anything.
 */
describe("Yatta rpc — the documented three-file setup", () => {
  // api-contract.ts: paths and shapes, no handlers.
  const contract = {
    getUser: route({
      method: "get",
      path: "/users/:id",
      params: z.object({ id: z.string() }),
      response: User,
    }),
    createUser: route({
      method: "post",
      path: "/users",
      body: z.object({ email: z.string(), name: z.string() }),
      response: User,
    }),
  };

  const rows = new Map<string, z.infer<typeof User>>();

  // api-server.ts: the handlers, kept on this side.
  const api = serve(contract, {
    prefix: "/api",
    handlers: {
      getUser: async ({ params }) => {
        const found = rows.get((params as { id: string }).id);
        if (!found) return fail(404, "No such user");
        return found;
      },
      createUser: async ({ body }) => {
        const typed = body as { email: string; name: string };
        const row = {
          id: `u${rows.size + 1}`,
          email: typed.email,
          displayName: typed.name,
        };
        rows.set(row.id, row);
        return row;
      },
    },
  });

  it("gives the client full types from the shared contract", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    const client = clientFor(contract, { baseUrl: `http://localhost:${server.port}/api` });

    const created = await client.createUser({ body: { email: "ada@t.dev", name: "Ada" } });
    expect(created.email).toBe("ada@t.dev");

    const fetched = await client.getUser({ params: { id: created.id } });
    expect(fetched.displayName).toBe("Ada");

    await expect(client.getUser({ params: { id: "missing" } })).rejects.toThrow("No such user");

    server.stop(true);
  });

  it("still types the client when handlers are attached inline instead", async () => {
    // Same routes, handlers inline. Both spellings have to produce the same types,
    // or the choice would be a trade-off rather than a style decision.
    const inline = {
      getUser: serverRoute(
        { method: "get", path: "/users/:id", params: z.object({ id: z.string() }), response: User },
        async ({ params }) => rows.get(params.id) ?? fail(404, "No such user"),
      ),
    };

    const client = clientFor(inline, { baseUrl: "http://localhost:0" });

    const check = async () => {
      const user = await client.getUser({ params: { id: "1" } });
      const email: string = user.email;

      // @ts-expect-error id must be a string
      void client.getUser({ params: { id: 1 } });

      return email;
    };

    expect(typeof check).toBe("function");
  });
});
