import { describe, it, expect } from "bun:test";
import { createAPI, API } from "../types/api";
import { createAuth, MemoryAuthStore, MemoryChallengeStore, MemoryRateLimitStore, type AuthStore, type PublicUser } from "../types/auth";

/*
 * Two security regressions, both of which had been introduced or preserved by an
 * earlier pass and were caught by a review rather than by a test.
 */

/** Serves the router and returns a base URL. */
async function serve(build: (api: ReturnType<typeof createAPI>) => void) {
  const api = createAPI("/api");
  build(api);
  const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });
  return { server, base: `http://localhost:${server.port}` };
}

describe("Query parsing is not a prototype-pollution vector", () => {
  async function queryOf(search: string) {
    const { server, base } = await serve((api) => {
      api.get("/x", (ctx) => API.json({ all: ctx.queryAll(), one: ctx.query() }));
    });

    const res = await fetch(`${base}/api/x?${search}`);
    // Typed loosely because the whole point is that these keys exist on a
    // null-prototype object and `Record<string, unknown>` would not describe it.
    const body = (await res.json()) as {
      all: Record<string, unknown>;
      one: Record<string, unknown>;
    };
    server.stop(true);
    return { status: res.status, body };
  }

  it("accepts a parameter named constructor", async () => {
    // `?constructor=1` was a 500 on every route: `if (!out[key]) out[key] = []` saw
    // the inherited `Object.prototype.constructor` as already set, then called
    // `.push` on a function. Not an exotic input — a dictionary key is a normal
    // thing to send.
    const { status, body } = await queryOf("constructor=1");

    expect(status).toBe(200);
    expect(body.all["constructor"]).toEqual(["1"]);
  });

  it("builds the object with no prototype, so nothing inherited can be read as data", () => {
    // Checked here rather than over HTTP: a JSON round-trip restores a normal
    // prototype, so the property that matters would be gone by the time a test could
    // see it.
    const api = createAPI("/api");
    let built: Record<string, unknown> | undefined;
    api.get("/p", (ctx) => {
      built = ctx.queryAll();
      return API.json({ ok: true });
    });

    const server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) });
    return (async () => {
      // `server.ready` does not exist on Bun's Server; awaiting it was a no-op that
      // looked like a wait. The request itself is the synchronisation point.
      await fetch(`http://localhost:${server.port}/api/p?a=1`);
      server.stop(true);

      expect(Object.getPrototypeOf(built)).toBeNull();
      // So `constructor`, `toString` and `__proto__` are simply absent unless sent.
      expect((built as Record<string, unknown>)["toString"]).toBeUndefined();
      expect((built as Record<string, unknown>)["__proto__"]).toBeUndefined();
    })();
  });

  it("accepts toString and hasOwnProperty", async () => {
    // Bracketed, because a dotted `.toString` would resolve to the prototype's own
    // method rather than to the parameter — which is the confusion this fix removes.
    expect((await queryOf("toString=1")).body.all["toString"]).toEqual(["1"]);
    expect((await queryOf("hasOwnProperty=1")).body.all["hasOwnProperty"]).toEqual(["1"]);
  });

  it("treats __proto__ as a plain parameter", async () => {
    const { body } = await queryOf("__proto__=1");

    // The dangerous one: assigning through `__proto__` reaches the prototype rather
    // than a property, which is a prototype-pollution primitive. Here it is just a
    // key like any other.
    expect(Object.keys(body.all)).toContain("__proto__");
    expect(body.all["__proto__"]).toEqual(["1"]);
    // The prototype itself is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps repeated values as an array", async () => {
    const { body } = await queryOf("a=1&a=2&a=3");
    expect(body.all["a"]).toEqual(["1", "2", "3"]);
  });

  it("still collapses to a scalar in query()", async () => {
    const { body } = await queryOf("a=1&a=2");
    expect(body.one["a"]).toBe("1");
  });
});

describe("Client IP from x-forwarded-for", () => {
  const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

  function authWith(proxyCount: number | undefined) {
    return createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      security: { allowUnverifiedSession: true, trustProxy: true, trustedProxyCount: proxyCount },
      // Enabled, because the assertion reads the address back out of the bucket the
      // limiter wrote.
      rateLimits: { enabled: true, login: { maxAttempts: 10, windowSec: 60, lockoutSec: 60 } },
    });
  }

  /** The address the limiter would key on for this request. */
  async function clientIp(forwardedFor: string | undefined, proxyCount?: number) {
    const auth = authWith(proxyCount);

    const headers: Record<string, string> = {};
    if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;

    const request = new Request("https://app.test/login", { method: "POST", headers });

    let captured = "";
    const original = console.error;
    console.error = () => {};

    try {
      // The limiter records under `rl:<bucket>:ip:<ip>`, so the address is read back
      // from the store rather than taken from an internal.
      await auth.signIn({
        email: `nobody-${Date.now()}@test.dev`,
        password: "wrong-password",
        req: request,
      }).catch(() => undefined);

      const rateStore = (auth as unknown as { rateLimiter: { store: MemoryRateLimitStore } })
        .rateLimiter.store;
      for (const key of await allKeys(rateStore)) {
        if (key.startsWith("rl:login:ip:")) captured = key.slice("rl:login:ip:".length);
      }
    } finally {
      console.error = original;
    }

    return captured;
  }

  async function allKeys(store: MemoryRateLimitStore): Promise<string[]> {
    // Reached by name rather than by adding an accessor to the class: this is a
    // white-box check of an internal key format, not a public contract.
    const entries = (store as unknown as { store?: Map<string, unknown> }).store;
    return entries ? [...entries.keys()] : [];
  }

  it("ignores entries the client appended", async () => {
    /*
     * The property that matters.
     *
     * `x-forwarded-for` reads `client, proxy1, proxy2…`. A client can prepend or
     * append entries of its own; a trusted proxy appends the address it saw. So the
     * real address is found by counting back from the right, past every proxy you
     * trust — whatever the client wrote before that is noise.
     *
     * An earlier pass took index 0, with a comment claiming the leftmost entry "is
     * the only one the client does not control". That is backwards, and it turned
     * every IP bucket into no protection.
     */
    // One trusted proxy, and the client prepended a forged entry.
    const forged = await clientIp("6.6.6.6, 203.0.113.9, 198.51.100.1", 1);
    expect(forged).toBe("203.0.113.9");
    expect(forged).not.toBe("6.6.6.6");
  });

  it("counts back by the configured number of proxies", async () => {
    // One trusted proxy: `client, proxy1` — the client is second to last.
    expect(await clientIp("203.0.113.9, 198.51.100.1", 1)).toBe("203.0.113.9");

    // Two trusted proxies: `client, proxy1, proxy2` — third to last.
    expect(await clientIp("203.0.113.9, 198.51.100.1, 198.51.100.2", 2)).toBe("203.0.113.9");

    // Trusting none takes the rightmost, which is the address the closest proxy
    // appended. Naming the failure mode: trusting every client to be your own proxy.
    expect(await clientIp("203.0.113.9, 198.51.100.1", 0)).toBe("198.51.100.1");
  });

  it("puts a rotating client in one bucket, not several", async () => {
    // The reason the direction matters: varying the header per request must not vary
    // the bucket, or every limit is trivially evaded.
    const a = await clientIp("6.6.6.6, 203.0.113.9, 198.51.100.1", 1);
    const b = await clientIp("7.7.7.7, 203.0.113.9, 198.51.100.1", 1);

    expect(a).toBe(b);
    expect(a).toBe("203.0.113.9");
  });
});

describe("Cookies are parsed without reaching the prototype", () => {
  it("treats a cookie named __proto__ as a cookie", async () => {
    const { server, base } = await serve((api) => {
      api.get("/c", (ctx) => API.json({ names: Object.keys(ctx.cookies()) }));
    });

    const res = await fetch(`${base}/api/c`, { headers: { cookie: "__proto__=x; real=1" } });
    const body = (await res.json()) as { names: string[] };

    expect(body.names).toContain("__proto__");
    expect(body.names).toContain("real");
    expect(({} as Record<string, unknown>).x).toBeUndefined();

    server.stop(true);
  });
});