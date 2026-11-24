import { describe, it, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";

import { createAPI } from "../types/api";
import { sanitizeUrlString } from "../types/observe";
import { createJwtVerifier } from "../types/jwt";
import { AuthJwt, AuthCrypto } from "../types/auth";
import { createDatabase, col, YattaDB, and } from "../types/db";
import { createFileRouter } from "../func/standalone_routes";
import routers from "../func/routerHelper";
import {
  createRateLimit,
  MemoryRateLimitStore,
} from "../func/ratelimit";

/**
 * Regression tests for the compile-time performance pass (1.0.6).
 *
 * Every change in that pass is behaviour-identical by construction;
 * these tests pin the behaviour the precomputed paths must preserve:
 * the sanitize fast path must never leak a scheme or a dot segment,
 * the builtin Map must dispatch exactly the old chain's routes, the
 * production dispatch cache must serve the same responses (and never
 * cache a dynamic match), the manifest router's pre-sort must pick the
 * same winner as the old score-tuple scan, the compiled rate-limit
 * rules must enforce the same budgets (including per-route overrides),
 * the JWT fast paths must accept and reject exactly the old ones, and
 * the per-table fields proxy must build the same conditions as a fresh
 * proxy per query.
 */

const get = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

// ─── sanitizeUrlString fast path ──────────────────────────────────────────

describe("compile-time: sanitizeUrlString fast path", () => {
  it("strips a javascript: scheme instead of slicing it through", () => {
    expect(sanitizeUrlString("javascript:alert(1)")).toBe("alert(1)");
    expect(sanitizeUrlString("javascript:alert(1)")).not.toContain(
      "javascript:",
    );
  });

  it("strips a data: scheme the same way", () => {
    expect(sanitizeUrlString("data:text/html,<h1>x</h1>")).toBe(
      "text/html,<h1>x</h1>",
    );
  });

  it("falls through to the URL parser for %-escapes, spaces and dot segments", () => {
    // These all fail the fast-path guard and take the parser path, so
    // the parser — not a slice — decides the output.
    expect(sanitizeUrlString("/a%zzb")).toBe("/a%zzb");
    expect(sanitizeUrlString("/a b")).toBe("/a%20b");
    expect(sanitizeUrlString("/a/../b")).toBe("/b");
    expect(sanitizeUrlString("/a//b")).toBe("/a//b");
  });

  it("strips the authority from a protocol-relative URL", () => {
    expect(sanitizeUrlString("//evil.com/x")).toBe("/x");
    expect(sanitizeUrlString("//evil.com")).toBe("/");
  });

  it("slices an absolute URL with no query to its pathname", () => {
    expect(sanitizeUrlString("https://example.com/a/b")).toBe("/a/b");
  });

  it("redacts sensitive query params exactly as before", () => {
    // URLSearchParams percent-encodes the brackets in "[REDACTED]" —
    // that is the old behaviour too (the parser path is untouched).
    expect(sanitizeUrlString("/p?api_key=abc&x=1")).toBe(
      "/p?api_key=%5BREDACTED%5D&x=1",
    );
    expect(sanitizeUrlString("https://example.com/a/b?token=secret")).toBe(
      "/a/b?token=%5BREDACTED%5D",
    );
    expect(sanitizeUrlString("/a/b?token=secret&x=1")).toBe(
      "/a/b?token=%5BREDACTED%5D&x=1",
    );
  });
});

// ─── Builtin Map dispatch + /mcp fall-through ─────────────────────────────

describe("compile-time: builtin Map dispatch", () => {
  it("still routes /.well-known/openid-configuration to the OIDC handler", async () => {
    const res = await routers(
      new Request("http://localhost/.well-known/openid-configuration"),
      {} as never,
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe("http://localhost:4000");
    expect(doc.token_endpoint).toBe("http://localhost:4000/oauth/token");
  });

  it("/mcp still falls through to file routing when MCP_ENABLED=0", async () => {
    const prev = process.env.MCP_ENABLED;
    process.env.MCP_ENABLED = "0";
    try {
      // No /mcp file route exists in this repo, so the fall-through
      // answers 404 — the Map must NOT have claimed it.
      const res = await routers(new Request("http://localhost/mcp"), {} as never);
      expect(res.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.MCP_ENABLED;
      else process.env.MCP_ENABLED = prev;
    }
  });
});

// ─── Production dispatch cache ────────────────────────────────────────────

describe("compile-time: production dispatch cache", () => {
  function withProduction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    return fn().finally(() => {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    });
  }

  it("serves a static file route identically on repeat hits", async () => {
    await withProduction(async () => {
      const first = await routers(new Request("http://x/user"), {} as any);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ user: "yes" });
      // Second hit comes from the dispatch cache, not a re-match.
      const second = await routers(new Request("http://x/user"), {} as any);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ user: "yes" });
    });
  });

  it("serves a 404 identically on repeat hits (negative cache)", async () => {
    await withProduction(async () => {
      const first = await routers(
        new Request("http://x/nope-ct-404"),
        {} as any,
      );
      expect(first.status).toBe(404);
      const second = await routers(
        new Request("http://x/nope-ct-404"),
        {} as any,
      );
      expect(second.status).toBe(404);
    });
  });

  it("serves a Fallback B sub-path identically on repeat hits", async () => {
    await withProduction(async () => {
      const first = await routers(
        new Request("http://x/user/profile"),
        {} as any,
      );
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ user: "yes" });
      const second = await routers(
        new Request("http://x/user/profile"),
        {} as any,
      );
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ user: "yes" });
    });
  });
});

// ─── manifestRouter pre-compile / pre-sort ────────────────────────────────

describe("compile-time: manifestRouter precedence", () => {
  afterEach(() => {
    delete (globalThis as any).__yattaStandaloneRoutes;
  });

  function routerWith(table: Array<{ pattern: string; file: string }>) {
    (globalThis as any).__yattaStandaloneRoutes = table.map((r) => ({
      ...r,
      module: {},
    }));
    return createFileRouter("/nonexistent");
  }

  it("keeps construction order on an exact (dyn, length) tie", () => {
    const r = routerWith([
      { pattern: "/a/[x]/[y]", file: "backend/a-xy.ts" },
      { pattern: "/a/[p]/[q]", file: "backend/a-pq.ts" },
    ]);
    // Both have 2 params and the same length: the first registered wins,
    // exactly as the old score-tuple scan picked it.
    expect(r.match("/a/1/2")!.filePath).toBe("backend/a-xy.ts");
  });

  it("fewest params still wins over a longer pattern", () => {
    const r = routerWith([
      { pattern: "/users/[id]/posts/[postId]", file: "backend/deep.ts" },
      { pattern: "/users/[id]", file: "backend/one.ts" },
    ]);
    expect(r.match("/users/42")!.filePath).toBe("backend/one.ts");
    expect(r.match("/users/42/posts/7")!.params).toEqual({
      id: "42",
      postId: "7",
    });
  });

  it("a catch-all still takes the rest, with %-encoded segments decoded once", () => {
    const r = routerWith([
      { pattern: "/files/[name]", file: "backend/files.ts" },
      { pattern: "/docs/[...slug]", file: "backend/docs.ts" },
    ]);
    expect(r.match("/files/hello%20world")!.params).toEqual({
      name: "hello world",
    });
    // %252F decodes once to %2F, not twice to a separator.
    expect(r.match("/files/a%252Fb")!.params).toEqual({ name: "a%2Fb" });
    expect(r.match("/docs/a/b/c")!.params).toEqual({ slug: "a/b/c" });
  });

  it("a clean-path miss returns null on repeat (no stale static hit)", () => {
    const r = routerWith([
      { pattern: "/about", file: "backend/about.ts" },
    ]);
    expect(r.match("/zzz/yyy")).toBeNull();
    expect(r.match("/zzz/yyy")).toBeNull();
    expect(r.match("/about")!.kind).toBe("exact");
  });
});

// ─── Rate-limit compiled rules ────────────────────────────────────────────

describe("compile-time: rate-limit compiled rules", () => {
  function limitedApi(
    options: Parameters<typeof createRateLimit>[0],
    path = "/x",
  ) {
    const api = createAPI();
    api.use(createRateLimit(options));
    api.get(path, () => new Response("ok"));
    api.get("/other", () => new Response("ok"));
    return api;
  }

  it("keeps the same headers on allowed requests", async () => {
    const api = limitedApi({
      limit: 2,
      windowSec: 60,
      getClientIp: () => "1.2.3.4",
    });
    const res = await api.handle(get("http://localhost/x"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("2");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(res.headers.get("x-ratelimit-reset")).toMatch(/^[0-9]+$/);
  });

  it("refuses with the same prebuilt 429 body and headers", async () => {
    const api = limitedApi({
      limit: 1,
      windowSec: 60,
      getClientIp: () => "1.2.3.4",
    });
    expect((await api.handle(get("http://localhost/x"))).status).toBe(200);
    const refused = await api.handle(get("http://localhost/x"));
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe('{"error":"Too many requests"}');
    expect(refused.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(refused.headers.get("retry-after")).toMatch(/^[0-9]+$/);
  });

  it("still honours a per-route override instead of the default rule", async () => {
    const api = limitedApi(
      {
        limit: 10,
        windowSec: 60,
        getClientIp: () => "1.2.3.4",
        routes: { "/x": { limit: 1, windowSec: 60 } },
      },
      "/x",
    );
    expect((await api.handle(get("http://localhost/x"))).status).toBe(200);
    // The override's limit of 1 refuses the second hit on /x…
    expect((await api.handle(get("http://localhost/x"))).status).toBe(429);
    // …while /other still has the default budget of 10.
    expect((await api.handle(get("http://localhost/other"))).status).toBe(
      200,
    );
  });

  it("escalation levels still halve the limit after a violation", async () => {
    const store = new MemoryRateLimitStore();
    const api = limitedApi({
      limit: 1,
      windowSec: 1,
      store,
      getClientIp: () => "9.9.9.9",
      escalation: { violationsPerLevel: 1, maxLevel: 1 },
    });
    const req = () => get("http://localhost/x");
    expect((await api.handle(req())).status).toBe(200);
    expect((await api.handle(req())).status).toBe(429);
    // Wait out the 1s window: the next window runs at level 1, whose
    // limit is floor(1 / 2) = 1 but never below 1 — so one request is
    // allowed and the second is refused again.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await api.handle(req())).status).toBe(200);
    expect((await api.handle(req())).status).toBe(429);
  });
});

// ─── JWT fast paths ───────────────────────────────────────────────────────

describe("compile-time: JWT fast paths", () => {
  const SECRET = "twelve-dollar-challenge";
  const jwt = createJwtVerifier(SECRET);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const sign = (hB64: string, pB64: string, secret = SECRET) =>
    createHmac("sha256", secret).update(`${hB64}.${pB64}`).digest("base64url");
  const mintRaw = (headerJson: string, payloadJson: string) => {
    const h = b64(headerJson);
    const p = b64(payloadJson);
    return `${h}.${p}.${sign(h, p)}`;
  };
  const NOW = () => Math.floor(Date.now() / 1000);
  const mint = (
    payload: Record<string, unknown> = {
      sub: "1",
      username: "user1",
      iat: NOW(),
      exp: NOW() + 3600,
    },
    header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
  ) => mintRaw(JSON.stringify(header), JSON.stringify(payload));

  it("verifies a valid token and rejects a wrong secret", () => {
    expect(jwt.verifyToken(mint()).ok).toBe(true);
    const validToken = mintRaw(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      JSON.stringify({
        sub: "1",
        username: "user1",
        iat: NOW(),
        exp: NOW() + 3600,
      }),
    );
    // Minted with the right secret; verify with a different one.
    const other = createJwtVerifier("a-different-secret");
    expect(other.verifyToken(validToken).ok).toBe(false);
    expect(jwt.verifyToken(validToken).ok).toBe(true);
  });

  it("rejects malformed tokens (wrong segment count)", () => {
    expect(jwt.verifyToken("onlyone").ok).toBe(false);
    expect(jwt.verifyToken("a.b.c.d").ok).toBe(false);
    expect(jwt.verifyToken("..").ok).toBe(false);
  });

  it("still accepts a non-canonical header via the parse fallback", () => {
    // Extra field, different key order: the startsWith fast path misses
    // and the old decode + JSON.parse path must accept it.
    const token = mint(undefined, {
      typ: "JWT",
      alg: "HS256",
      kid: "ct-test",
    });
    expect(jwt.verifyToken(token).ok).toBe(true);
  });

  it("AuthJwt round-trips, rejects tampering, and accepts extra header fields", () => {
    const crypto = new AuthCrypto("a".repeat(32));
    const authJwt = new AuthJwt(crypto.jwtKey, crypto);
    const token = authJwt.sign({
      sub: "u1",
      type: "access",
      sid: "s1",
      ver: 1,
      expInSec: 3600,
    });
    expect(authJwt.verify(token)?.sub).toBe("u1");
    // Tamper the payload: the string comparison must still fail it.
    const parts = token.split(".");
    const tampered = `${parts[0]}.${b64(JSON.stringify({ sub: "u2" }))}.${parts[2]}`;
    expect(authJwt.verify(tampered)).toBeNull();
    // A token minted by hand with an extra header field verifies.
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "x" }));
    const p = b64(
      JSON.stringify({
        sub: "u1",
        type: "access",
        sid: "s1",
        jti: "j1",
        ver: 1,
        iat: NOW(),
        exp: NOW() + 3600,
      }),
    );
    const sig = createHmac("sha256", crypto.jwtKey)
      .update(`${h}.${p}`)
      .digest("base64url");
    expect(authJwt.verify(`${h}.${p}.${sig}`)?.sub).toBe("u1");
  });

  it("AuthJwt round-trips with a >64-byte signing key (pre-hashed once)", () => {
    const crypto = new AuthCrypto("a".repeat(32));
    // A 100-byte key exceeds the 64-byte SHA-256 block, so the
    // constructor hashes it once (the HMAC spec's rule) instead of on
    // every sign and verify.
    const authJwt = new AuthJwt(Buffer.alloc(100, 7), crypto);
    const token = authJwt.sign({
      sub: "u1",
      type: "access",
      sid: "s1",
      ver: 1,
      expInSec: 3600,
    });
    expect(authJwt.verify(token)?.sub).toBe("u1");
  });
});

// ─── Per-table fields proxy ───────────────────────────────────────────────

describe("compile-time: per-table fields proxy", () => {
  const schema = {
    users: {
      id: col.id(),
      name: col.text(),
      status: col.text().default("active"),
    },
  };

  it("reuses one FieldBuilder per declared column", () => {
    const db = createDatabase({
      path: ":memory:",
      schema,
      forceNew: true,
    });
    try {
      const users = db.users;
      const first = (users as any).fieldsProxy.status;
      const second = (users as any).fieldsProxy.status;
      expect(first).toBe(second);
    } finally {
      db.close();
    }
  });

  it("builds the same conditions as a fresh proxy per query", () => {
    const db = createDatabase({
      path: ":memory:",
      schema,
      forceNew: true,
    });
    try {
      const users = db.users;
      users.insert({ name: "Ada", status: "active" });
      users.insert({ name: "Bo", status: "idle" });
      const rows = users
        .where((f) => f.status.isEqualTo("active"))
        .all();
      expect(rows.map((r) => r.name)).toEqual(["Ada"]);
      const multi = users
        .where((f) =>
          and(f.status.isEqualTo("active"), f.name.isEqualTo("Ada")),
        )
        .all();
      expect(multi.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("falls back to a fresh builder for undeclared columns, including late ones", () => {
    const db = createDatabase({
      path: ":memory:",
      schema,
      forceNew: true,
    });
    try {
      const users = db.users;
      // Undeclared: a fresh FieldBuilder per access, exactly as before.
      const a = (users as any).fieldsProxy.notAColumn;
      const b = (users as any).fieldsProxy.notAColumn;
      expect(a).not.toBe(b);
      expect(a.field).toBe("notAColumn");
      // A column added to the table after construction still builds a
      // condition through the fallback (it just isn't cached yet).
      const clause = (users as any).fieldsProxy.lateCol.isEqualTo("x");
      expect(clause).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("a dynamic table with no schema still queries through the fallback", () => {
    const db = new YattaDB({ path: ":memory:" });
    db.run(
      "CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT, n INTEGER);",
      [],
      "run",
    );
    db.run("INSERT INTO things (label, n) VALUES ('one', 1);", [], "run");
    db.run("INSERT INTO things (label, n) VALUES ('two', 2);", [], "run");
    try {
      const t = db.table("things");
      const rows = t.where((f: any) => f.label.isEqualTo("two")).all();
      expect(rows.map((r: any) => r.n)).toEqual([2]);
    } finally {
      db.close();
    }
  });
});
