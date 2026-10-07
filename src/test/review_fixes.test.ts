import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { createAPI, API, HttpError, ValidationError } from "../types/api";

/*
 * Regression tests for a review pass, against the router that remains.
 *
 * Each one names the behaviour that was wrong, because a test that only says "this
 * works" gives no clue what it is holding in place. Every case here was a real defect.
 *
 * This file previously covered a second routing layer that no longer exists. The cases
 * below are the ones that describe the router rather than that layer: response
 * passthrough, validator transforms, an empty return, and route specificity.
 */

describe("A handler may return a Response", () => {
  function serve(api: ReturnType<typeof createAPI>) {
    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req, {}) });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  }

  it("keeps the status the handler chose", async () => {
    const api = createAPI();
    api.get("/created", () => new Response(null, { status: 201 }));
    const { url, stop } = serve(api);

    const res = await fetch(`${url}/created`);
    expect(res.status).toBe(201);

    stop();
  });

  it("keeps every header the handler chose", async () => {
    const api = createAPI();
    api.get("/typed", () =>
      new Response("{}", {
        headers: { "content-type": "application/vnd.acme+json", "x-trace": "abc" },
      }),
    );
    const { url, stop } = serve(api);

    const res = await fetch(`${url}/typed`);

    // Rewriting a handler's content-type would break the client it was written for,
    // and the failure looks like a parsing bug somewhere else entirely.
    expect(res.headers.get("content-type")).toBe("application/vnd.acme+json");
    expect(res.headers.get("x-trace")).toBe("abc");

    stop();
  });

  it("passes a stream body through unread", async () => {
    const api = createAPI();

    // A stream must not be buffered: `text()` on a multi-gigabyte upload would be the
    // whole point of streaming it in the first place.
    const chunks = ["one ", "two ", "three"];
    api.get("/stream", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });

      return new Response(stream, { headers: { "content-type": "text/plain" } });
    });

    const { url, stop } = serve(api);
    const res = await fetch(`${url}/stream`);

    expect(await res.text()).toBe("one two three");

    stop();
  });

  it("sends the validated value, not the raw one", async () => {
    const api = createAPI();

    // A validator that coerces. If the raw body were echoed back, the coercion would
    // be silently lost and the endpoint would disagree with its own schema.
    const schema = z.object({
      count: z.coerce.number(),
      name: z.string().trim(),
    });

    api.post("/echo", async (ctx) => {
      const parsed = await ctx.json(schema);
      return API.json(parsed);
    });

    const { url, stop } = serve(api);
    const res = await fetch(`${url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: "42", name: "  ada  " }),
    });

    expect(await res.json()).toEqual({ count: 42, name: "ada" });

    stop();
  });

  it("refuses a body that does not match, with the issues", async () => {
    const api = createAPI();
    api.post("/echo", async (ctx) => API.json(await ctx.json(z.object({ count: z.number() }))));

    const { url, stop } = serve(api);
    const res = await fetch(`${url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: "not a number" }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();

    stop();
  });

  it("treats a handler that returned nothing as a bug, not an empty success", async () => {
    const api = createAPI();
    api.delete("/x", async () => undefined);

    const { url, stop } = serve(api);
    const res = await fetch(`${url}/x`, { method: "DELETE" });

    /*
     * A 200 with an empty body reads as success. A route whose last statement forgets
     * to return would then fail silently, with the data simply gone — the worst
     * possible shape for a bug that deletes something.
     */
    expect(res.status).toBe(500);

    stop();
  });
});

describe("Route specificity", () => {
  it("matches and reads a parameter", async () => {
    const api = createAPI();
    api.get("/users/:id", (ctx) => API.json({ id: ctx.params.id }));

    const res = await api.handle(new Request("http://x/users/ada"), {});

    expect(await res.json()).toEqual({ id: "ada" });
  });

  it("prefers a static route over a dynamic one", async () => {
    const api = createAPI();
    api.get("/users/:id", (ctx) => API.json({ matched: "dynamic", id: ctx.params.id }));
    api.get("/users/new", () => API.json({ matched: "static" }));

    const res = await api.handle(new Request("http://x/users/new"), {});

    /*
     * Declaration order cannot decide this. With the dynamic route registered first,
     * `/users/new` resolves to the user whose id is the literal string "new", so a
     * create endpoint becomes a fetch for a user that does not exist.
     */
    expect(await res.json()).toEqual({ matched: "static" });
  });

  it("distinguishes methods on the same path", async () => {
    const api = createAPI();
    api.get("/thing", () => API.json({ method: "GET" }));
    api.post("/thing", () => API.json({ method: "POST" }));
    api.delete("/thing", () => API.json({ method: "DELETE" }));

    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await api.handle(new Request("http://x/thing", { method }), {});
      expect(await res.json()).toEqual({ method });
    }
  });

  it("answers 404 for a path it does not serve", async () => {
    const api = createAPI();
    api.get("/known", () => API.json({ ok: true }));

    const res = await api.handle(new Request("http://x/unknown"), {});

    expect(res.status).toBe(404);
  });
});

describe("Errors carry their status", () => {
  it("uses the status on an HttpError", async () => {
    const api = createAPI();
    api.get("/missing", () => {
      throw new HttpError(404, "No such thing");
    });

    const res = await api.handle(new Request("http://x/missing"), {});

    // Read structurally rather than by `instanceof`, because auth, db and jobs each
    // define their own error base class. An error carrying status 404 that came back
    // as a 500 would turn every client-side branch into a dead end.
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("No such thing");
  });

  it("uses the status on a ValidationError", async () => {
    const api = createAPI();
    api.get("/bad", () => {
      // One argument: the cause. Recognised by its `status`, not by `instanceof
      // HttpError`, which is what makes it work for a store's own error type too.
      throw new ValidationError("nope");
    });

    const res = await api.handle(new Request("http://x/bad"), {});

    expect(res.status).toBe(400);
  });
});