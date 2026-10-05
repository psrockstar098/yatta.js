import { describe, it, expect } from "bun:test";
import {
  createAPI,
  API,
  Context,
  HttpError,
  ValidationError,
  type ExtractRouteParams,
  type RouteParams,
} from "../types/api";

describe("API & HTTP Layer", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should infer single route parameter types correctly", () => {
      type Params = ExtractRouteParams<"/users/[id]">;
      // Compile-time & runtime type verification
      const p: Params = { id: "123" };
      expect(p.id).toBe("123");
    });

    it("should infer multiple route parameter types", () => {
      type Params = ExtractRouteParams<"/orgs/[orgId]/teams/[teamId]">;
      const p: Params = { orgId: "org-1", teamId: "team-2" };
      expect(p.orgId).toBe("org-1");
      expect(p.teamId).toBe("team-2");
    });

    it("should clean Next.js catch-all ellipsis from parameter names", () => {
      type CatchAllParams = ExtractRouteParams<"/docs/[...slug]">;
      const p: CatchAllParams = { slug: "guide/getting-started" };
      expect(p.slug).toBe("guide/getting-started");
    });

    it("should return empty object type for static paths", () => {
      type StaticParams = ExtractRouteParams<"/health">;
      const p: StaticParams = {};
      expect(Object.keys(p).length).toBe(0);
    });

    it("should allow Context state typing", () => {
      const req = new Request("http://localhost/test");
      const ctx = new Context<{ id: string }>(req, { id: "42" });
      ctx.state.userId = "user_abc";
      ctx.state.role = "admin";

      expect(ctx.params.id).toBe("42");
      expect(ctx.state.userId).toBe("user_abc");
      expect(ctx.state.role).toBe("admin");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should safely handle malformed percent-encoding in cookies without crashing", () => {
      const req = new Request("http://localhost/test", {
        headers: { Cookie: "valid=123; malformed=%E0%A4%A; test=ok" },
      });
      const ctx = new Context(req, {});
      const cookies = ctx.cookies();

      expect(cookies.valid).toBe("123");
      expect(cookies.malformed).toBe("%E0%A4%A");
      expect(cookies.test).toBe("ok");
    });

    it("should reject invalid JSON payloads with ValidationError (400)", async () => {
      const api = createAPI();
      api.post(async (ctx) => {
        const body = await ctx.json();
        return API.json({ body });
      });

      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ this is invalid json ;",
      });

      const res = await api.handle(req, {});
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it("should prevent middleware next() double-invocation attack", async () => {
      const api = createAPI();
      api.use(async (ctx, next) => {
        await next();
        return await next(); // Malicious/erroneous second call
      });
      api.get(() => API.text("ok"));

      const req = new Request("http://localhost/test", { method: "GET" });
      const res = await api.handle(req, {});

      // Internal Server Error due to illegal multiple next() calls
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Internal Server Error");
    });

    it("never emits '*' for a credentialed request, and fails closed without an allowlist", async () => {
      const api = createAPI();
      // No origin allowlist, credentials on. Reflecting the request origin here
      // would be "allow any origin with cookies" — the exact thing the rule
      // exists to prevent — so the safe answer is to emit no header at all and
      // let the browser block it.
      api.cors({ credentials: true });
      api.get(() => API.json({ ok: true }));

      const req = new Request("http://localhost/test", {
        method: "GET",
        headers: { Origin: "http://evil.com" },
      });
      const res = await api.handle(req, {});

      // No allow origin at all is the fail-closed answer: with no
      // Access-Control-Allow-Origin the browser blocks the response, which is
      // what we want when no allowlist was configured. Credentials and Vary are
      // only meaningful alongside it, so they are deliberately absent too.
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    describe("handler return coercion", () => {
      it("serialises a plain object rather than sending an empty 200", async () => {
        const api = createAPI();
        // A route that ends in a database insert returns the row, not a
        // Response. Previously that produced a 200 with an empty body and no
        // error anywhere — the request looked fine and the data had vanished.
        api.get("/obj", () => ({ id: "1", name: "Ada" }));

        const res = await api.handle(new Request("http://localhost/obj"), {});
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "1", name: "Ada" });
      });

      it("serialises an array", async () => {
        const api = createAPI();
        api.get("/arr", () => [1, 2, 3] as never);

        const res = await api.handle(new Request("http://localhost/arr"), {});
        expect(await res.json()).toEqual([1, 2, 3]);
      });

      it("passes a Response through untouched", async () => {
        const api = createAPI();
        api.get("/res", () => API.json({ ok: true }, { status: 201 }));

        const res = await api.handle(new Request("http://localhost/res"), {});
        expect(res.status).toBe(201);
      });

      it("sends a bare string as the body", async () => {
        const api = createAPI();
        api.get("/str", () => "hello" as never);

        const res = await api.handle(new Request("http://localhost/str"), {});
        expect(await res.text()).toBe("hello");
      });

      it("fails loudly when a handler returns nothing", async () => {
        const api = createAPI();
        api.get("/void", () => undefined as never);

        const res = await api.handle(new Request("http://localhost/void"), {});
        // An empty 200 would read as success with no body, hiding the bug.
        expect(res.status).toBe(500);
        expect(await res.text()).toContain("returned nothing");
      });
    });

    it("should return 405 Method Not Allowed with Allow header on unsupported methods", async () => {
      const api = createAPI();
      api.get(() => API.text("hello"));
      api.post(() => API.text("created"));

      const req = new Request("http://localhost/test", { method: "DELETE" });
      const res = await api.handle(req, {});

      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("GET");
      expect(res.headers.get("Allow")).toContain("POST");
    });

    it("should return 404 when no handlers are registered on the route", async () => {
      const api = createAPI();
      const req = new Request("http://localhost/test", { method: "GET" });
      const res = await api.handle(req, {});

      expect(res.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should construct and serialize API responses correctly", async () => {
      const jsonRes = API.json({ name: "Bun" }, { status: 201 });
      expect(jsonRes.status).toBe(201);
      expect(jsonRes.headers.get("Content-Type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(await jsonRes.json()).toEqual({ name: "Bun" });

      const textRes = API.text("Plain text content");
      expect(textRes.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(await textRes.text()).toBe("Plain text content");
    });

    it("should parse query parameters accurately", () => {
      const req = new Request(
        "http://localhost/search?q=bun&page=2&filter=active",
      );
      const ctx = new Context(req, {});
      const query = ctx.query();

      expect(query.q).toBe("bun");
      expect(query.page).toBe("2");
      expect(query.filter).toBe("active");
    });

    it("should build formatted Set-Cookie header strings", () => {
      const cookieStr = API.cookie("session_id", "xyz123", {
        maxAge: 3600,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      });

      expect(cookieStr).toContain("session_id=xyz123");
      expect(cookieStr).toContain("Max-Age=3600");
      expect(cookieStr).toContain("Path=/");
      expect(cookieStr).toContain("HttpOnly");
      expect(cookieStr).toContain("Secure");
      expect(cookieStr).toContain("SameSite=Strict");
    });

    it("should attach multiple cookies with withCookies", () => {
      const base = new Response("Body");
      const cookies = [API.cookie("c1", "v1"), API.cookie("c2", "v2")];
      const withC = API.withCookies(base, cookies);

      const setCookies = withC.headers.getSetCookie();
      expect(setCookies.length).toBe(2);
      expect(setCookies[0]).toContain("c1=v1");
      expect(setCookies[1]).toContain("c2=v2");
    });

    it("should allow schema validation on ctx.json()", async () => {
      const mockSchema = {
        parse(data: unknown) {
          const d = data as any;
          if (!d.title || typeof d.title !== "string") {
            throw new Error("Title is required");
          }
          return { title: d.title.trim() };
        },
      };

      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "  Clean Code  " }),
      });
      const ctx = new Context(req, {});
      const parsed = await ctx.json(mockSchema);

      expect(parsed.title).toBe("Clean Code");
    });

    it("should cache parsed JSON so multiple middleware can read ctx.json()", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counter: 10 }),
      });
      const ctx = new Context(req, {});

      const firstRead = await ctx.json<{ counter: number }>();
      const secondRead = await ctx.json<{ counter: number }>();

      expect(firstRead.counter).toBe(10);
      expect(secondRead.counter).toBe(10);
      expect(firstRead).toBe(secondRead); // Same cached instance
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should execute full onion middleware pipeline in correct order", async () => {
      const order: string[] = [];
      const api = createAPI();

      api.use(async (ctx, next) => {
        order.push("mw1_start");
        const res = await next();
        order.push("mw1_end");
        return res;
      });

      api.use(async (ctx, next) => {
        order.push("mw2_start");
        const res = await next();
        order.push("mw2_end");
        return res;
      });

      api.get((ctx) => {
        order.push("handler");
        return API.json({ success: true });
      });

      const req = new Request("http://localhost/test", { method: "GET" });
      const res = await api.handle(req, {});

      expect(res.status).toBe(200);
      expect(order).toEqual([
        "mw1_start",
        "mw2_start",
        "handler",
        "mw2_end",
        "mw1_end",
      ]);
    });

    it("should dispatch custom onError handlers gracefully", async () => {
      const api = createAPI();
      api.onError((err, ctx) => {
        expect(err).toBeInstanceOf(HttpError);
        return API.json(
          { intercepted: true, msg: (err as Error).message },
          { status: 418 },
        );
      });

      api.get(() => {
        throw new HttpError(418, "I am a teapot");
      });

      const req = new Request("http://localhost/teapot", { method: "GET" });
      const res = await api.handle(req, {});

      expect(res.status).toBe(418);
      const json = await res.json();
      expect(json.intercepted).toBe(true);
      expect(json.msg).toBe("I am a teapot");
    });

    it("should handle automatic CORS preflight (OPTIONS 204)", async () => {
      const api = createAPI();
      api.cors({
        origin: "http://example.com",
        methods: ["GET", "POST"],
        headers: ["X-Custom-Header", "Authorization"],
        maxAge: 3600,
      });
      api.get(() => API.text("hello"));

      const req = new Request("http://localhost/test", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "X-Custom-Header",
        },
      });

      const res = await api.handle(req, {});
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://example.com",
      );
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain(
        "GET, POST",
      );
      expect(res.headers.get("Access-Control-Max-Age")).toBe("3600");
    });

    it("should support sub-route path overloads in API instance", async () => {
      const api = createAPI();
      api.get("/profile", () => API.json({ page: "profile" }));
      api.post("/profile", () => API.json({ updated: true }, { status: 201 }));

      const reqGet = new Request("http://localhost/user/profile", {
        method: "GET",
      });
      const resGet = await api.handle(reqGet, {}, "/user");
      expect(resGet.status).toBe(200);
      expect(await resGet.json()).toEqual({ page: "profile" });

      const reqPost = new Request("http://localhost/user/profile", {
        method: "POST",
      });
      const resPost = await api.handle(reqPost, {}, "/user");
      expect(resPost.status).toBe(201);
      expect(await resPost.json()).toEqual({ updated: true });
    });

    it("should route file-based requests to both / and /user via routerHelper", async () => {
      const routers = (await import("../func/routerHelper")).default;

      const rootReq = new Request("http://localhost:4000/");
      const rootRes = await routers(rootReq, {} as any);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.json()).toEqual({ ok: "yes" });

      const userReq = new Request("http://localhost:4000/user");
      const userRes = await routers(userReq, {} as any);
      expect(userRes.status).toBe(200);
      expect(await userRes.json()).toEqual({ user: "yes" });

      const userSlashReq = new Request("http://localhost:4000/user/");
      const userSlashRes = await routers(userSlashReq, {} as any);
      expect(userSlashRes.status).toBe(200);
      expect(await userSlashRes.json()).toEqual({ user: "yes" });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests", () => {
    it("should support ReadableStream streaming responses", async () => {
      const api = createAPI();
      api.get(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("part 1 - "));
            controller.enqueue(new TextEncoder().encode("part 2 - "));
            controller.enqueue(new TextEncoder().encode("done"));
            controller.close();
          },
        });
        return API.stream(stream, {
          headers: { "Content-Type": "text/plain" },
        });
      });

      const req = new Request("http://localhost/stream", { method: "GET" });
      const res = await api.handle(req, {});

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("part 1 - part 2 - done");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should handle high volume of concurrent requests with state isolation", async () => {
      const api = createAPI();
      api.use(async (ctx, next) => {
        const id = ctx.query().id;
        ctx.state.requestId = id;
        return next();
      });

      api.get((ctx) => {
        return API.json({ requestId: ctx.state.requestId });
      });

      const totalRequests = 100;
      const promises = Array.from({ length: totalRequests }).map(
        async (_, idx) => {
          const req = new Request(`http://localhost/test?id=${idx}`, {
            method: "GET",
          });
          const res = await api.handle(req, {});
          const data = await res.json();
          return data.requestId;
        },
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(totalRequests);
      // Ensure each concurrent request maintained its isolated state
      results.forEach((id, idx) => {
        expect(id).toBe(String(idx));
      });
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// API mounting (used by the scaffolded yatta/backend/routes.ts)
// ────────────────────────────────────────────────────────────────────────────

describe("yatta/api — mount", () => {
  it("delegates to a child router under a prefix", async () => {
    const child = createAPI();
    child.get("/", () => Response.json({ from: "child root" }));
    child.get("/z", () => Response.json({ liveness: true }));

    const api = createAPI("/api");
    api.mount("/health", child);

    expect(await (await api.handle(new Request("http://x/api/health/z"), {})).json()).toEqual({
      liveness: true,
    });
  });

  it("extracts path parameters from the child's own patterns", async () => {
    const posts = createAPI();
    posts.get("/:id", (ctx) => Response.json({ id: ctx.params.id }));

    const api = createAPI("/api");
    api.mount("/posts", posts);

    const res = await api.handle(new Request("http://x/api/posts/42"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("prefers the longest prefix", async () => {
    const generic = createAPI();
    generic.get("/", () => Response.json({ which: "generic" }));

    const specific = createAPI();
    specific.get("/", () => Response.json({ which: "recent" }));

    const api = createAPI("/api");
    api.mount("/posts", generic);
    api.mount("/posts/recent", specific);

    expect(await (await api.handle(new Request("http://x/api/posts/recent"), {})).json()).toEqual({
      which: "recent",
    });
    expect(await (await api.handle(new Request("http://x/api/posts"), {})).json()).toEqual({
      which: "generic",
    });
  });

  it("only matches on whole segments", async () => {
    const child = createAPI();
    child.get("/", () => Response.json({ ok: true }));

    const api = createAPI("/api");
    api.mount("/post", child);

    // /api/postscript must not be swallowed by the /post mount.
    const res = await api.handle(new Request("http://x/api/postscript"), {});
    expect(res.status).toBe(404);
  });

  it("falls through to the parent when the child has no match", async () => {
    const child = createAPI();
    child.get("/known", () => Response.json({ ok: true }));

    const api = createAPI("/api");
    api.mount("/thing", child);
    api.get("/thing", () => Response.json({ from: "parent" }));

    // The child declares /known, not /, so the mount declines and the
    // parent's own /thing route answers.
    expect(await (await api.handle(new Request("http://x/api/thing"), {})).json()).toEqual({
      from: "parent",
    });
  });

  it("preserves the query string across the mount", async () => {
    const child = createAPI();
    child.get("/", (ctx) => Response.json({ q: ctx.url.searchParams.get("q") }));

    const api = createAPI("/api");
    api.mount("/search", child);

    expect(await (await api.handle(new Request("http://x/api/search?q=hi"), {})).json()).toEqual({
      q: "hi",
    });
  });

  it("keeps the child's own error handling and CORS", async () => {
    const child = createAPI();
    child.cors({ origin: "https://app.test", credentials: true });
    child.get("/", () => {
      throw new HttpError(418, "teapot");
    });
    child.onError((err) => Response.json({ caught: (err as Error).message }, { status: 418 }));

    const api = createAPI("/api");
    api.mount("/brew", child);

    const res = await api.handle(new Request("http://x/api/brew"), {});
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ caught: "teapot" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });
});

describe("yatta/api — error handling across mounts", () => {
  it("runs the parent's onError for a mounted router", async () => {
    const child = createAPI();
    child.get("/", () => {
      throw new Error("mounted boom");
    });

    const api = createAPI("/api");
    api.mount("/thing", child);
    api.onError((err) => Response.json({ caught: (err as Error).message }, { status: 418 }));

    const res = await api.handle(new Request("http://x/api/thing"), {});
    // Without the parent's handler the child invents its own 500 and the
    // centralised error shape never applies.
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ caught: "mounted boom" });
  });

  it("keeps the child's own onError when it has one", async () => {
    const child = createAPI();
    child.get("/", () => {
      throw new Error("child error");
    });
    child.onError((err) => Response.json({ where: "child", msg: (err as Error).message }));

    const api = createAPI("/api");
    api.mount("/thing", child);
    api.onError((err) => Response.json({ where: "parent", msg: (err as Error).message }));

    expect(await (await api.handle(new Request("http://x/api/thing"), {})).json()).toEqual({
      where: "child",
      msg: "child error",
    });
  });

  it("honours an HTTP status carried by a subsystem error", async () => {
    // yatta/auth defines its own error base that is not an HttpError, but it
    // carries a status. Treating it as unknown turned every 401 into a 500.
    class UnauthorizedError extends Error {
      readonly status = 401;
      constructor() {
        super("Authentication required");
        this.name = "UnauthorizedError";
      }
    }

    const api = createAPI();
    api.get("/", () => {
      throw new UnauthorizedError();
    });

    const res = await api.handle(new Request("http://x/"), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("ignores a status field that is not an HTTP status", async () => {
    // A domain error with a `status` of "pending" or 7 must not be read as an
    // HTTP status code.
    class JobError extends Error {
      readonly status: number = 7;
    }

    const api = createAPI();
    api.get("/", () => {
      throw new JobError("not an http status");
    });

    expect((await api.handle(new Request("http://x/"), {})).status).toBe(500);
  });

  it("passes details through from a subsystem error", async () => {
    class Validationish extends Error {
      readonly status = 422;
      readonly details = { field: "email" };
    }

    const api = createAPI();
    api.get("/", () => {
      throw new Validationish("bad input");
    });

    const res = await api.handle(new Request("http://x/"), {});
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "bad input", details: { field: "email" } });
  });
});

describe("yatta/api — route specificity", () => {
  it("prefers a static segment over a parameter regardless of order", async () => {
    // Declared param-first, which is how people naturally write a catch-all
    // and then add concrete routes after it.
    const api = createAPI();
    api.get("/:id", () => Response.json({ which: "param" }));
    api.get("/slow", () => Response.json({ which: "static" }));

    expect(await (await api.handle(new Request("http://x/slow"), {})).json()).toEqual({
      which: "static",
    });
    expect(await (await api.handle(new Request("http://x/other"), {})).json()).toEqual({
      which: "param",
    });
  });

  it("keeps the same result when the order is reversed", async () => {
    const api = createAPI();
    api.get("/slow", () => Response.json({ which: "static" }));
    api.get("/:id", () => Response.json({ which: "param" }));

    expect(await (await api.handle(new Request("http://x/slow"), {})).json()).toEqual({
      which: "static",
    });
  });

  it("ranks a deeper literal path above a param at the same depth", async () => {
    const api = createAPI();
    api.get("/:a/:b", () => Response.json({ which: "two-params" }));
    api.get("/count/bad-query", () => Response.json({ which: "literal-literal" }));
    api.get("/count/:name", () => Response.json({ which: "literal-param" }));

    expect(await (await api.handle(new Request("http://x/count/bad-query"), {})).json()).toEqual({
      which: "literal-literal",
    });
    expect(await (await api.handle(new Request("http://x/count/anything"), {})).json()).toEqual({
      which: "literal-param",
    });
    expect(await (await api.handle(new Request("http://x/x/y"), {})).json()).toEqual({
      which: "two-params",
    });
  });

  it("still prefers a deeper literal path over a shorter one", async () => {
    const api = createAPI();
    api.get("/", () => Response.json({ which: "root" }));
    api.get("/users", () => Response.json({ which: "users" }));

    expect(await (await api.handle(new Request("http://x/users"), {})).json()).toEqual({
      which: "users",
    });
    expect(await (await api.handle(new Request("http://x/"), {})).json()).toEqual({
      which: "root",
    });
  });

  it("does not let specificity cross HTTP methods", async () => {
    const api = createAPI();
    api.post("/:id", () => Response.json({ which: "post-param" }));
    api.get("/slow", () => Response.json({ which: "get-static" }));

    expect(await (await api.handle(new Request("http://x/slow", { method: "POST" }), {})).json()).toEqual({
      which: "post-param",
    });
  });

  it("applies specificity inside a mounted router too", async () => {
    const users = createAPI();
    users.get("/:id", (ctx) => Response.json({ which: "param", id: ctx.params.id }));
    users.get("/slow", () => Response.json({ which: "static" }));

    const api = createAPI("/api");
    api.mount("/users", users);

    expect(await (await api.handle(new Request("http://x/api/users/slow"), {})).json()).toEqual({
      which: "static",
    });
  });
});
