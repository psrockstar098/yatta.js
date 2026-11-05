import { describe, it, expect } from "bun:test";

import { createAPI } from "../types/api";
import {
  createRateLimit,
  oauthTokenRateLimit,
  normalizeRoutePath,
  resolveClientIp,
  MemoryRateLimitStore,
} from "../func/ratelimit";
import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore as AuthMemoryRateLimitStore,
} from "../types/auth";
import { createMailer } from "../types/mail";

const get = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });
const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers });

async function statuses(
  api: ReturnType<typeof createAPI>,
  reqs: Request[],
): Promise<number[]> {
  const out: number[] = [];
  for (const req of reqs) out.push((await api.handle(req, {})).status);
  return out;
}

function limitedApi(
  options: Parameters<typeof createRateLimit>[0],
  path = "/x",
) {
  const api = createAPI();
  api.use(createRateLimit(options));
  api.get(path, () => new Response("ok"));
  return api;
}

describe("general rate-limit middleware", () => {
  it("limits per IP: one IP's budget does not affect another's", async () => {
    const api = limitedApi({
      limit: 2,
      windowSec: 60,
      getClientIp: (req) => req.headers.get("x-test-ip") ?? undefined,
    });
    const req = (ip: string) => get("http://localhost/x", { "x-test-ip": ip });
    expect(await statuses(api, [req("1.1.1.1"), req("1.1.1.1"), req("1.1.1.1")])).toEqual([
      200, 200, 429,
    ]);
    // A different IP is untouched by the first IP's exhaustion.
    expect((await api.handle(req("2.2.2.2"), {})).status).toBe(200);
  });

  it("applies per-route overrides and keeps other routes on the default", async () => {
    const api = createAPI();
    api.use(
      createRateLimit({
        limit: 100,
        windowSec: 60,
        routes: { "/sensitive": { limit: 1, windowSec: 60 } },
        getClientIp: () => "1.1.1.1",
      }),
    );
    api.get("/sensitive", () => new Response("ok"));
    api.get("/plain", () => new Response("ok"));
    expect(await statuses(api, [get("http://localhost/sensitive"), get("http://localhost/sensitive")])).toEqual([
      200, 429,
    ]);
    expect((await api.handle(get("http://localhost/plain"), {})).status).toBe(200);
  });

  it("limits per user across IPs, without merging distinct users", async () => {
    const api = createAPI();
    api.use(async (ctx, next) => {
      // Stand-in for the auth middleware: it puts the user on state.
      const user = ctx.req.headers.get("x-user");
      if (user) (ctx.state as Record<string, unknown>).user = { id: user };
      return next();
    });
    api.use(
      createRateLimit({
        limit: 2,
        windowSec: 60,
        dimensions: ["ip", "user"],
        getClientIp: (req) => req.headers.get("x-test-ip") ?? undefined,
      }),
    );
    api.get("/x", () => new Response("ok"));

    const req = (user: string, ip: string) =>
      get("http://localhost/x", { "x-user": user, "x-test-ip": ip });
    // Alice spends her per-user budget of 2 across two IPs.
    expect((await api.handle(req("alice", "1.1.1.1"), {})).status).toBe(200);
    expect((await api.handle(req("alice", "1.1.1.2"), {})).status).toBe(200);
    // Bob is untouched by Alice's spending.
    expect((await api.handle(req("bob", "2.2.2.2"), {})).status).toBe(200);
    // Alice again, from a fresh IP: her per-user bucket is spent, and
    // the refusal consumes none of the fresh IP bucket.
    expect((await api.handle(req("alice", "9.9.9.9"), {})).status).toBe(429);
    // Bob, also from a fresh IP, still has budget.
    expect((await api.handle(req("bob", "8.8.8.8"), {})).status).toBe(200);
  });

  it("does not let separator characters in an id collapse two keys", async () => {
    const store = new MemoryRateLimitStore();
    const api = createAPI();
    api.use(async (ctx, next) => {
      const user = ctx.req.headers.get("x-user");
      if (user) (ctx.state as Record<string, unknown>).user = { id: user };
      return next();
    });
    api.use(createRateLimit({ limit: 1, windowSec: 60, dimensions: ["user"], store }));
    api.get("/x", () => new Response("ok"));
    // One id is the encoded form of the other. Encoded keys are
    // injective: each id must hold its own bucket, not share one.
    expect(
      (await api.handle(get("http://localhost/x", { "x-user": "a/b" }), {})).status,
    ).toBe(200);
    expect(
      (await api.handle(get("http://localhost/x", { "x-user": "a%2Fb" }), {})).status,
    ).toBe(200);
    expect(store.size()).toBe(2);
  });

  it("window reset: a 1s window allows again after it elapses", async () => {
    const api = limitedApi({ limit: 1, windowSec: 1, getClientIp: () => "1.1.1.1" });
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
  });

  it("answers 429 with Retry-After and a generic body that leaks nothing", async () => {
    const api = limitedApi({ limit: 1, windowSec: 60, getClientIp: () => "203.0.113.7" });
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    const limited = await api.handle(get("http://localhost/x"), {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await limited.text();
    expect(body).not.toContain("203.0.113.7");
    expect(body).not.toContain("penalt");
    expect(JSON.parse(body)).toEqual({ error: "Too many requests" });
  });

  it("shares one bucket across trailing-slash and casing variants", async () => {
    const api = createAPI();
    api.use(createRateLimit({ limit: 1, windowSec: 60, getClientIp: () => "1.1.1.1" }));
    api.get("/oauth/token", () => new Response("ok"));
    api.get("/oauth/token/", () => new Response("ok"));
    expect(normalizeRoutePath("/OAuth/Token/")).toBe("/oauth/token");
    expect((await api.handle(get("http://localhost/oauth/token"), {})).status).toBe(200);
    // Same route with a trailing slash must not get a fresh budget.
    expect((await api.handle(get("http://localhost/oauth/token/"), {})).status).toBe(429);
  });

  it("rejects non-finite or zero limits and windows instead of disabling the limit", () => {
    expect(() => createRateLimit({ limit: NaN })).toThrow(/limit/);
    expect(() => createRateLimit({ limit: 0 })).toThrow(/limit/);
    expect(() => createRateLimit({ windowSec: 0 })).toThrow(/windowSec/);
    expect(() => createRateLimit({ routes: { "/x": { limit: 2, windowSec: NaN } } })).toThrow(
      /windowSec/,
    );
    expect(() => createRateLimit({ maxKeys: NaN })).toThrow(/maxKeys/);
  });
});

describe("escalating penalties", () => {
  // Short windows keep this test fast: base window 1s. Violations: 3
  // per level, so levels change after 3 and 6 violations, and the
  // window doubles per level — a fixed sleep would stop working once
  // the penalty doubles the window, so each violation waits out the
  // window recorded in the store instead of guessing a duration.
  const BUCKET_KEY = `rl:${encodeURIComponent("/x")}:ip:${encodeURIComponent("1.1.1.1")}`;
  async function violateOnce(
    api: ReturnType<typeof createAPI>,
    store: MemoryRateLimitStore,
  ) {
    // Spend the window until refused: that refusal is the violation.
    let status = (await api.handle(get("http://localhost/x"), {})).status;
    while (status === 200) status = (await api.handle(get("http://localhost/x"), {})).status;
    expect(status).toBe(429);
    const record = await store.get(BUCKET_KEY);
    expect(record).not.toBeNull();
    const wait = Math.max(0, record!.resetAt - Date.now() + 50);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  async function driveViolations(
    api: ReturnType<typeof createAPI>,
    store: MemoryRateLimitStore,
    count: number,
  ) {
    for (let i = 0; i < count; i++) await violateOnce(api, store);
  }

  it("counts at most one violation per window, so one burst cannot max out the penalty", async () => {
    const store = new MemoryRateLimitStore();
    const api = limitedApi({ limit: 1, windowSec: 60, store, getClientIp: () => "1.1.1.1" });
    await statuses(api, Array.from({ length: 20 }, () => get("http://localhost/x")));
    const record = await store.get("rl:%2Fx:ip:1.1.1.1");
    expect(record?.violations).toBe(1);
    expect(record?.count).toBe(1);
  });

  it("halves the limit and doubles the window after 3 violations, and recovers after clean windows", async () => {
    const store = new MemoryRateLimitStore();
    const api = createAPI();
    api.use(
      createRateLimit({
        limit: 2,
        windowSec: 1,
        store,
        getClientIp: () => "1.1.1.1",
      }),
    );
    api.get("/x", () => new Response("ok"));
    await driveViolations(api, store, 3);
    // Level 1 now: limit 1 per 2s window. Two quick requests: one
    // passes, the second is refused even though the base limit is 2.
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(429);
    // Wait out the doubled window, then behave for clean windows:
    // each clean window decays one violation, so the penalty level
    // falls back and the base limit of 2 applies again.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    for (let i = 0; i < 3; i++) {
      expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 2100));
    }
    // Recovered: the base limit of 2 applies again.
    expect(await statuses(api, [get("http://localhost/x"), get("http://localhost/x")])).toEqual([
      200, 200,
    ]);
  }, 60_000);

  it("never degrades to a limit of zero, even after many violations", async () => {
    const store = new MemoryRateLimitStore();
    const api = createAPI();
    api.use(
      createRateLimit({
        limit: 1,
        windowSec: 1,
        store,
        getClientIp: () => "1.1.1.1",
      }),
    );
    api.get("/x", () => new Response("ok"));
    await driveViolations(api, store, 7);
    // Level 2: limit 1 per 4s window. One request still gets through.
    // driveViolations already waited out the last window, so this
    // window is fresh and unspent.
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(429);
  }, 60_000);
});

describe("proxy-aware client IP", () => {
  it("ignores forwarded headers unless proxies are trusted", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" },
    });
    expect(resolveClientIp(req, {})).toBe("unknown");
    expect(resolveClientIp(req, { getClientIp: () => "198.51.100.2" })).toBe("198.51.100.2");
  });

  it("counts back from the right past the trusted proxies, never taking the client-written entry", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.1, 10.0.0.1" },
    });
    // One trusted proxy: the client is the entry before the last.
    expect(resolveClientIp(req, { trustProxy: true })).toBe("198.51.100.1");
    // Two trusted proxies: one further back.
    expect(resolveClientIp(req, { trustProxy: true, trustedProxyCount: 2 })).toBe("203.0.113.9");
    // A forged leftmost entry alone cannot mint a new identity when
    // the count is right: with one trusted proxy, "attacker, proxy"
    // resolves to the attacker-written entry only if the operator
    // actually trusts zero proxies — with the default of 1 it resolves
    // to the last entry, which the proxy appended.
    const forged = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1" },
    });
    expect(resolveClientIp(forged, { trustProxy: true })).toBe("6.6.6.6");
    expect(resolveClientIp(forged, { trustProxy: true, trustedProxyCount: 0 })).toBe("10.0.0.1");
  });

  it("a forged header does not bypass the limit when proxies are untrusted", async () => {
    const api = limitedApi({ limit: 1, windowSec: 60, getClientIp: () => "1.1.1.1" });
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    // Fresh forged header on every request, same peer: still limited.
    expect(
      (await api.handle(
        get("http://localhost/x", { "x-forwarded-for": "203.0.113.99" }),
        {},
      )).status,
    ).toBe(429);
  });

  it("prefers cf-connecting-ip and x-real-ip over x-forwarded-for when trusted", () => {
    const req = new Request("http://localhost/x", {
      headers: {
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
    });
    expect(resolveClientIp(req, { trustProxy: true })).toBe("203.0.113.5");
  });
});

describe("OAuth token endpoint wiring", () => {
  it("allows 5 token requests per minute per IP, then 429s, without changing the handler", async () => {
    const api = createAPI();
    api.use(oauthTokenRateLimit());
    api.post("/oauth/token", () => new Response(JSON.stringify({ token_type: "Bearer" }), {
      headers: { "content-type": "application/json" },
    }));
    const results = await statuses(
      api,
      Array.from({ length: 6 }, () => post("http://localhost/oauth/token")),
    );
    // All six come from the same unidentified client, so they share
    // the "unknown" bucket — the point is the preset's limit, not the IP.
    expect(results).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("separates token budgets per IP when the peer address is known", async () => {
    const api = createAPI();
    api.use(oauthTokenRateLimit({ getClientIp: (req) => req.headers.get("x-test-ip") ?? undefined }));
    api.post("/oauth/token", () => new Response("ok"));
    const req = (ip: string) => post("http://localhost/oauth/token", { "x-test-ip": ip });
    await statuses(api, Array.from({ length: 5 }, () => req("1.1.1.1")));
    expect((await api.handle(req("1.1.1.1"), {})).status).toBe(429);
    expect((await api.handle(req("2.2.2.2"), {})).status).toBe(200);
  });
});

describe("auth flows still work with the middleware in place", () => {
  it("a correct login succeeds through the middleware, and auth's own limiter is untouched", async () => {
    const auth = createAuth({
      secret: "super-secret-cryptographic-signing-key-32-chars-minimum",
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new AuthMemoryRateLimitStore(),
      security: { allowUnverifiedSession: true },
      email: { mailer: createMailer({ mode: "memory" }), appUrl: "https://app.test" },
      passwordPolicy: { minLength: 8, requireNumbers: true, requireUppercase: true },
      rateLimits: { enabled: true, login: { maxAttempts: 3, windowSec: 60, lockoutSec: 120 } },
    });
    await auth.signup({ email: "user@test.com", password: "Password123!" });

    const api = createAPI();
    api.use(createRateLimit({ limit: 100, windowSec: 60, getClientIp: () => "1.1.1.1" }));
    api.post("/login", async () => {
      const pair = (await auth.login({ email: "user@test.com", password: "Password123!" })) as {
        tokens?: { accessToken?: string };
      };
      return new Response(JSON.stringify({ ok: true, hasToken: !!pair.tokens?.accessToken }), {
        headers: { "content-type": "application/json" },
      });
    });
    const res = await api.handle(post("http://localhost/login"), {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).hasToken).toBe(true);
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
  });
});

describe("pluggable store", () => {
  it("accepts a custom store, so counters can live outside the process", async () => {
    const backing = new Map<string, { data: import("../func/ratelimit").RateLimitCounter; expires: number }>();
    const custom = {
      async get(key: string) {
        const item = backing.get(key);
        if (!item || item.expires < Date.now()) return null;
        return item.data;
      },
      async set(key: string, data: import("../func/ratelimit").RateLimitCounter, ttlSec: number) {
        backing.set(key, { data, expires: Date.now() + ttlSec * 1000 });
      },
      async delete(key: string) {
        backing.delete(key);
      },
    };
    const api = limitedApi({ limit: 1, windowSec: 60, store: custom, getClientIp: () => "1.1.1.1" });
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(200);
    expect((await api.handle(get("http://localhost/x"), {})).status).toBe(429);
    expect(backing.size).toBe(1);
  });

  it("caps distinct keys: forged keys past the cap share one bucket", async () => {
    const api = limitedApi({
      limit: 2,
      windowSec: 60,
      maxKeys: 2,
      getClientIp: (req) => req.headers.get("x-test-ip") ?? undefined,
    });
    const req = (ip: string) => get("http://localhost/x", { "x-test-ip": ip });
    expect(
      await statuses(api, [req("a"), req("a"), req("b"), req("b"), req("c"), req("d"), req("e")]),
    ).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});
