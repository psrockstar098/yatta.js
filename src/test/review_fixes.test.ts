import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { createApp, createClient, defineRoute, invoke, mount, ENGINE_NAMES } from "../types/universal";
import { HttpError } from "../types/api";

/*
 * Regression tests for a review pass.
 *
 * Each one names the behaviour that was wrong, because a test that only says "this
 * works" gives no clue what it is holding in place. Every case here was a real
 * defect, not a hypothetical.
 */

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
