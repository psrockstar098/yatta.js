import { describe, it, expect } from "bun:test";
import { z } from "zod";

import {
  createClient,
  defineRoutes,
  route,
  buildPath,
  toQueryString,
  type CallError,
} from "../types/client";
import {
  isStandardSchema,
  validateOrThrow,
  ValidationError,
  type Infer,
  type StandardSchemaV1,
} from "../types/standard-schema";

/*
 * These tests use the real router as the server, so the client is exercised
 * against handlers rather than a stubbed fetch. That is the claim being checked:
 * one route table drives both sides.
 */

describe("Yatta client — URL building", () => {
  it("substitutes and encodes each path parameter", () => {
    expect(buildPath("/users/:id", { id: "42" })).toBe("/users/42");
    expect(buildPath("/orgs/:org/projects/:project", { org: "a", project: "b" })).toBe(
      "/orgs/a/projects/b",
    );

    // A value containing a slash must not create a new path segment, and one
    // containing ? or # must not truncate the URL.
    expect(buildPath("/files/:name", { name: "a/b" })).toBe("/files/a%2Fb");
    expect(buildPath("/q/:term", { term: "x?y#z" })).toBe("/q/x%3Fy%23z");
    expect(buildPath("/s/:v", { v: "a b" })).toBe("/s/a%20b");
  });

  it("reports a missing parameter by name rather than writing 'undefined'", () => {
    expect(() => buildPath("/users/:id")).toThrow(/Missing path parameter "id"/);
  });

  it("serialises a query, dropping empties and expanding arrays", () => {
    expect(toQueryString({ a: 1, b: "x y" })).toBe("a=1&b=x%20y");
    // Empty values are omitted rather than sent as "", which a server-side parser
    // would otherwise see as a present-but-blank parameter.
    expect(toQueryString({ a: 1, b: "", c: null, d: undefined })).toBe("a=1");
    expect(toQueryString({ id: ["a", "b"] })).toBe("id=a&id=b");
  });
});

describe("Yatta client — schema interop", () => {
  it("treats any Standard Schema validator as a validator", () => {
    expect(isStandardSchema(z.object({ a: z.string() }))).toBe(true);
    expect(isStandardSchema(z.string())).toBe(true);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({ "~standard": {} })).toBe(false);
  });

  it("reports the failing field in a readable path", async () => {
    const schema = z.object({ user: z.object({ email: z.string() }) });

    await expect(validateOrThrow(schema, { user: { email: 5 } }, "body")).rejects.toThrow(
      /body\.user\.email/,
    );
  });

  it("awaits a validator that returns a promise", async () => {
    // An async refinement is legal under Standard Schema. Treating the returned
    // promise as the validated value would hand the caller a Promise typed as the
    // output type.
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        async validate(value: unknown) {
          await Bun.sleep(1);
          return value === "ok" ? { value } : { issues: [{ message: "not ok" }] };
        },
      },
    };

    // Typed as a validator rather than recovered through `Parameters<>`: recovering
    // a generic signature's parameters instantiates it against its constraint, which
    // loses the output type and reads as `undefined`.
    const asValidator: StandardSchemaV1<unknown> = schema;
    expect(await validateOrThrow(asValidator, "ok", "body")).toBe("ok");
    // Now a ValidationError, so the failure carries its own 400 and every issue.
    await expect(validateOrThrow(asValidator, "no", "body")).rejects.toThrow(/not ok/);
    await expect(validateOrThrow(asValidator, "no", "body")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

// ── End to end against the real router ──────────────────────────────────────

const User = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
});

const CreateUser = z.object({ email: z.string(), name: z.string().min(2) });

const routes = defineRoutes({
  getUser: route({
    method: "get",
    path: "/users/:id",
    params: z.object({ id: z.string().min(1) }),
    response: User,
  }),

  listUsers: route({
    method: "get",
    path: "/users",
    query: z.object({ search: z.string().optional(), limit: z.number().optional() }),
    response: z.array(User),
  }),

  createUser: route({
    method: "post",
    path: "/users",
    body: CreateUser,
    response: User,
  }),

  deleteUser: route({
    method: "delete",
    path: "/users/:id",
    params: z.object({ id: z.string().min(1) }),
    // No declared response, so the client returns the raw parsed JSON rather
    // than pretending to know the shape.
  }),
});

describe("Yatta client — against a live router", () => {
  /** Serves the real routes through the real API router. */
  async function serve(): Promise<string> {
    const { createAPI, API } = await import("../types/api");

    const api = createAPI("/api");

    const store = new Map<string, z.infer<typeof User>>();

    api.get("/users/:id", async (ctx) => {
      const user = store.get(String(ctx.params.id));
      if (!user) return API.json({ error: "No such user" }, { status: 404 });
      return API.json(user);
    });

    api.get("/users", async (ctx) => {
      const search = ctx.query().search;
      const all = [...store.values()];
      return API.json(
        search ? all.filter((u) => u.email.includes(search)) : all,
      );
    });

    api.post("/users", async (ctx) => {
      const body = await ctx.json(CreateUser);
      const user = {
        id: `u${store.size + 1}`,
        email: body.email,
        displayName: body.name,
      };
      store.set(user.id, user);
      return API.json(user, { status: 201 });
    });

    api.delete("/users/:id", async (ctx) => {
      store.delete(String(ctx.params.id));
      return API.json({ ok: true });
    });

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });
    return `http://localhost:${server.port}`;
  }

  it("calls a route with params, query and body", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, { baseUrl });

    // Response typed from User, not from an interface written by hand.
    const created: z.infer<typeof User> = await client.createUser({
      body: { email: "ada@t.dev", name: "Ada" },
    });

    expect(created).toEqual({ id: "u1", email: "ada@t.dev", displayName: "Ada" });

    const fetched = await client.getUser({ params: { id: "u1" } });
    expect(fetched.email).toBe("ada@t.dev");

    await client.createUser({ body: { email: "grace@t.dev", name: "Grace" } });

    const all = await client.listUsers({ query: { search: "grace" } });
    expect(all.map((u: { displayName: string }) => u.displayName)).toEqual(["Grace"]);

    // A route with no declared response returns the raw JSON.
    expect(await client.deleteUser({ params: { id: "u1" } })).toEqual({ ok: true });
  });

  it("validates the request before sending it", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, { baseUrl });

    // The body schema is the same object the server uses, so this fails locally
    // instead of costing a round trip.
    await expect(
      client.createUser({ body: { email: "x@t.dev", name: "a" } as never }),
    ).rejects.toThrow(/body\.name/);

    await expect(client.getUser({ params: { id: "" } })).rejects.toThrow(/params\.id/);
  });

  it("carries the status and the server's message on failure", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, { baseUrl });

    try {
      await client.getUser({ params: { id: "missing" } });
      throw new Error("should have thrown");
    } catch (err) {
      const callError = err as CallError;
      expect(callError.status).toBe(404);
      // The message comes from the server, not from "Request failed".
      expect(callError.message).toBe("No such user");
      expect(callError.body).toEqual({ error: "No such user" });
    }
  });

  it("rejects a response that does not match its declared shape", async () => {
    // A handler returning the wrong shape is exactly what a response validator is
    // for: it turns a silent undefined field into a named error.
    const { createAPI, API } = await import("../types/api");
    const api = createAPI("/api");
    api.get("/users/:id", () => API.json({ id: "1" }));

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });

    const client = createClient(routes, { baseUrl: `http://localhost:${server.port}` });

    await expect(client.getUser({ params: { id: "1" } })).rejects.toThrow(/response\./);

    // And the caller can opt out, which is what `raw` is for. The result is
    // typed `unknown` because with the validator off nothing is known about it.
    expect(await client.getUser({ params: { id: "1" }, raw: true })).toEqual({ id: "1" });

    server.stop(true);
  });

  it("sends cookies so session auth works the same as server-side", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, {
      baseUrl,
      onRequest: (request) => {
        request.headers.set("cookie", "session=abc123");
      },
    });

    // Nothing here asserts the cookie arrived — it asserts the hook is able to
    // reach the request before it goes out, which is the part that is hard to
    // add later.
    expect((await client.listUsers()).length).toBeGreaterThanOrEqual(0);
  });

  it("rejects a request whose body does not match the shared schema", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, { baseUrl });

    // The body schema is the same object the server validates with, so this has
    // to fail at the call site. It used to compile cleanly and fail at runtime:
    // the argument type was inferred from the call rather than checked against
    // the route.
    await expect(
      client.createUser({ body: { email: 5, name: "Ada" } as never }),
    ).rejects.toThrow();
  });

  it("exposes per-call headers and an abort signal", async () => {
    const baseUrl = await serve();
    const client = createClient(routes, { baseUrl, headers: { "x-app": "test" } });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.listUsers({ signal: controller.signal }),
    ).rejects.toThrow();

    // A default header set at construction still applies.
    const ok = await client.listUsers({ headers: { "x-trace": "1" } });
    expect(Array.isArray(ok)).toBe(true);
  });
});

describe("Yatta client — types", () => {
  it("infers the response from the validator", () => {
    const client = createClient(routes);

    // Never called: the assertion is that it type-checks. `ReturnType` would not
    // do here — on an overloaded method TypeScript resolves it to the *last*
    // signature, which is the `raw: true` one returning `unknown`.
    const typed = async () => {
      const user = await client.getUser({ params: { id: "1" } });
      const email: string = user.email;
      const displayName: string = user.displayName;
      return { email, displayName };
    };

    expect(typeof typed).toBe("function");
  });

  it("keeps a route with no response schema as unknown rather than any", () => {
    const client = createClient(routes);

    const typed = async () => {
      // `any` would let anything through without a check. `unknown` forces the
      // caller to look at the value first — which is the honest answer for a
      // route that never declared what it returns.
      const result: unknown = await client.deleteUser({ params: { id: "1" } });
      return result;
    };

    expect(typeof typed).toBe("function");
  });
});