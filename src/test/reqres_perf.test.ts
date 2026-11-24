import { describe, it, expect } from "bun:test";
import { createAPI, API } from "../types/api";
import routers from "../func/routerHelper";

/**
 * Regression tests for the Req & Res performance pass (1.0.6).
 *
 * Every change in that pass is behaviour-identical by construction; these
 * tests pin the behaviour the fast paths must preserve, especially the
 * first-segment route index, which replaced a linear scan with bucketed
 * lookup — precedence across literal / param / catch-all patterns, across
 * registration orders and segment counts, is the property that must not
 * move.
 */

const text = async (res: Response) => res.text();

describe("Req & Res perf pass: route index precedence", () => {
  it("literal beats param regardless of registration order", async () => {
    // Param registered FIRST, literal second: the old linear scan and the
    // index must both answer with the literal handler.
    const api = createAPI();
    api.get("/users/:id", () => API.json({ kind: "param" }));
    api.get("/users/slow", () => API.json({ kind: "literal" }));
    const res = await api.handle(new Request("http://x/users/slow"));
    expect(await res.json()).toEqual({ kind: "literal" });
    const res2 = await api.handle(new Request("http://x/users/42"));
    expect(await res2.json()).toEqual({ kind: "param" });
  });

  it("literal beats param when the param route has more segments", async () => {
    const api = createAPI();
    api.get("/:org/:team/:id", () => API.json({ kind: "param3" }));
    api.get("/users", () => API.json({ kind: "literal1" }));
    const res = await api.handle(new Request("http://x/users"));
    expect(await res.json()).toEqual({ kind: "literal1" });
    const res2 = await api.handle(
      new Request("http://x/acme/eng/7"),
    );
    expect(await res2.json()).toEqual({ kind: "param3" });
  });

  it("param beats catch-all, catch-all still serves nested paths", async () => {
    const api = createAPI();
    api.get("/files/**", () => API.json({ kind: "catch" }));
    api.get("/files/:id", () => API.json({ kind: "param" }));
    const res = await api.handle(new Request("http://x/files/9"));
    expect(await res.json()).toEqual({ kind: "param" });
    const res2 = await api.handle(new Request("http://x/files/a/b/c"));
    expect(await res2.json()).toEqual({ kind: "catch" });
  });

  it("[...slug] catch-all keeps its params", async () => {
    const api = createAPI();
    api.get("/docs/[...slug]", (c) =>
      API.json({ slug: c.params.slug }),
    );
    const res = await api.handle(
      new Request("http://x/docs/guide/getting-started"),
    );
    expect(await res.json()).toEqual({ slug: "guide/getting-started" });
  });

  it("root route still wins for / with sub-routes present", async () => {
    const api = createAPI();
    api.get("/users/:id", () => API.json({ kind: "param" }));
    api.get("/", () => API.json({ kind: "root" }));
    const res = await api.handle(new Request("http://x/"));
    expect(await res.json()).toEqual({ kind: "root" });
  });

  it("HEAD falls back to GET sub-routes", async () => {
    const api = createAPI();
    api.get("/users/:id", () => API.json({ ok: true }));
    const res = await api.handle(
      new Request("http://x/users/7", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(await text(res)).toBe("");
  });

  it("404/405 stay correct with 100 routes (Allow lists the right verbs)", async () => {
    const api = createAPI();
    for (let i = 0; i < 100; i++) {
      api.get(`/r${i}/:id`, () => API.json({ ok: true }));
    }
    api.post("/r50/:id", () => API.json({ ok: true }));
    const miss = await api.handle(new Request("http://x/nope/1"));
    expect(miss.status).toBe(404);
    const wrongVerb = await api.handle(
      new Request("http://x/r50/7", { method: "PUT" }),
    );
    expect(wrongVerb.status).toBe(405);
    const allow = wrongVerb.headers.get("Allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
  });

  it("different-length patterns with the same first segment both match", async () => {
    const api = createAPI();
    api.get("/a/b", () => API.json({ kind: "two" }));
    api.get("/a/b/c", () => API.json({ kind: "three" }));
    api.get("/a/:x", () => API.json({ kind: "param" }));
    expect(
      await (await api.handle(new Request("http://x/a/b"))).json(),
    ).toEqual({ kind: "two" });
    expect(
      await (await api.handle(new Request("http://x/a/b/c"))).json(),
    ).toEqual({ kind: "three" });
    expect(
      await (await api.handle(new Request("http://x/a/z"))).json(),
    ).toEqual({ kind: "param" });
  });
});

describe("Req & Res perf pass: CORS methods cache", () => {
  it("Allow-Methods picks up routes registered after CORS was first served", async () => {
    const api = createAPI();
    api.cors();
    api.get("/one", () => API.json({ ok: true }));
    const first = await api.handle(
      new Request("http://x/one", { headers: { Origin: "http://a" } }),
    );
    expect(first.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    api.post("/two", () => API.json({ ok: true }));
    const second = await api.handle(
      new Request("http://x/one", { headers: { Origin: "http://a" } }),
    );
    const methods = second.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
  });

  it("CORS headers are set in place: same response object, body intact", async () => {
    const api = createAPI();
    api.cors({ origin: "http://a" });
    api.get("/one", () => API.json({ ok: true }));
    const res = await api.handle(
      new Request("http://x/one", { headers: { Origin: "http://a" } }),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://a");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("Req & Res perf pass: response fast paths", () => {
  it("API.json fast path keeps the exact content-type", () => {
    const res = API.json({ ok: true });
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("API.text fast path keeps the exact content-type", () => {
    const res = API.text("hello");
    expect(res.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
  });
});

describe("Req & Res perf pass: body parsing", () => {
  it("ctx.json still parses with a malformed content-length (parseInt vs Number preserved)", async () => {
    const api = createAPI();
    api.post("/echo", async (c) => API.json(await c.json()));
    const res = await api.handle(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-length": "10abc", "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });
});

describe("Req & Res perf pass: URL threading", () => {
  it("handle() reuses a caller-supplied URL: same query, no re-parse", async () => {
    const api = createAPI();
    api.get("/q", (c) => API.json({ q: c.query().q }));
    const url = new URL("http://x/q?q=hello");
    const res = await api.handle(new Request(url), {}, undefined, { url });
    expect(await res.json()).toEqual({ q: "hello" });
  });
});

describe("Req & Res perf pass: production route cache", () => {
  it("routers() serves file routes in production (cached module path)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const root = await routers(new Request("http://x/"), {} as any);
      expect(root.status).toBe(200);
      // Second call hits the production module cache.
      const user = await routers(new Request("http://x/user"), {} as any);
      expect(user.status).toBe(200);
      expect(await user.json()).toEqual({ user: "yes" });
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
