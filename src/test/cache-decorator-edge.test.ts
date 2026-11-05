import { describe, it, expect } from "bun:test";

import { MemoryCacheEngine } from "../types/cache_queue";
import {
  cacheMethod,
  defaultCacheKey,
  wrapCached,
} from "../types/cache_decorator";
import {
  CloudflareEdgePurgeProvider,
  EdgeAwareCacheEngine,
  VercelEdgePurgeProvider,
  createEdgePurgeFromEnv,
  invalidateTagsWithEdge,
  type EdgeFetch,
  type EdgePurgeProvider,
} from "../types/cache_edge";

/*
 * Decorator sugar over the existing engine, and edge purge bindings.
 * No test here touches the network or a real credential: every provider
 * gets a fake fetch, and every env-built provider gets a fake env object.
 */

type Call = { url: string; body: string; headers: Record<string, string> };

function fakeFetch(calls: Call[], failWith?: Error): EdgeFetch {
  return async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (failWith) throw failWith;
    return { ok: true, status: 200 };
  };
}

function failingFetch(): EdgeFetch {
  return async () => ({ ok: false, status: 500 });
}

function captureWarn() {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  return {
    seen,
    restore: () => {
      console.warn = original;
    },
  };
}

describe("wrapCached delegates to the existing engine", () => {
  it("runs the function once and serves the second call from cache", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const greet = wrapCached(
      async (name: string) => {
        runs++;
        return `hello ${name}`;
      },
      { ttl: "5m" },
      cache,
    );
    expect(await greet("ada")).toBe("hello ada");
    expect(await greet("ada")).toBe("hello ada");
    expect(runs).toBe(1);
    // A different argument is a different entry, not a shared one.
    expect(await greet("bob")).toBe("hello bob");
    expect(runs).toBe(2);
  });

  it("respects TTL: after expiry the function runs again", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const value = wrapCached(
      async () => {
        runs++;
        return runs;
      },
      { ttl: 50 },
      cache,
    );
    expect(await value()).toBe(1);
    expect(await value()).toBe(1);
    await Bun.sleep(70);
    expect(await value()).toBe(2);
  });

  it("does not cache failures", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const flaky = wrapCached(
      async () => {
        runs++;
        if (runs === 1) throw new Error("boom");
        return "ok";
      },
      { ttl: "5m" },
      cache,
    );
    await expect(flaky()).rejects.toThrow("boom");
    expect(await flaky()).toBe("ok");
    expect(runs).toBe(2);
  });

  it("requires a TTL and an engine, rather than guessing either", () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    // Missing TTL is refused at wrap time: the engine would otherwise
    // treat it as "default, or never expire", which is silent forever.
    expect(() => wrapCached(async () => 1, {} as never, cache)).toThrow(
      /TTL is required/,
    );
    expect(() =>
      wrapCached(async () => 1, { ttl: "5m" }, undefined as never),
    ).toThrow(/engine is required/);
  });

  it("tag invalidation through the decorator path drops the entry", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const profile = wrapCached(
      async (id: string) => {
        runs++;
        return `profile:${id}:${runs}`;
      },
      { ttl: "5m", tags: (id: string) => [`user:${id}`] },
      cache,
    );
    expect(await profile("42")).toBe("profile:42:1");
    expect(await profile("42")).toBe("profile:42:1");
    await cache.invalidateTags("user:42");
    expect(await profile("42")).toBe("profile:42:2");
    // Invalidating a different tag leaves this entry alone.
    expect(await profile("42")).toBe("profile:42:2");
  });

  it("scope keeps one tenant's result out of another tenant's entry", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    const load = wrapCached(
      async (tenant: string, doc: string) => `${tenant}:${doc}`,
      { ttl: "5m", scope: (tenant: string) => `tenant:${tenant}` },
      cache,
    );
    expect(await load("acme", "report")).toBe("acme:report");
    expect(await load("globex", "report")).toBe("globex:report");
  });

  it("a string key is a prefix, not the whole key", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const f = wrapCached(
      async (x: number) => {
        runs++;
        return x * 2;
      },
      { ttl: "5m", key: "double" },
      cache,
    );
    expect(await f(2)).toBe(4);
    expect(await f(3)).toBe(6);
    expect(runs).toBe(2);
  });

  it("the default key hashes arguments instead of storing them raw", () => {
    const key = defaultCacheKey("fn", ["secret-value-123"]);
    expect(key).not.toContain("secret-value-123");
    expect(defaultCacheKey("fn", ["secret-value-123"])).toBe(key);
    expect(defaultCacheKey("fn", ["other-value"])).not.toBe(key);
  });

  it("values JSON erases do not collide: NaN, null, nested NaN", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    let runs = 0;
    const f = wrapCached(
      async (x: unknown) => {
        runs++;
        return runs;
      },
      { ttl: "5m" },
      cache,
    );
    expect(await f(NaN)).toBe(1);
    expect(await f(null)).toBe(2);
    expect(await f(NaN)).toBe(1);
    expect(await f({ x: NaN })).toBe(3);
    expect(await f({ x: null })).toBe(4);
    expect(runs).toBe(4);
  });

  it("refuses an unserializable argument instead of colliding keys", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const f = wrapCached(async (x: unknown) => x, { ttl: "5m" }, cache);
    await expect(f(circular)).rejects.toThrow(/cannot be serialized/);
  });
});

describe("cacheMethod decorates a class method", () => {
  it("caches per method and keeps `this` working", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    class Service {
      prefix = "v";
      runs = 0;
      async load(id: string) {
        this.runs++;
        return `${this.prefix}:${id}:${this.runs}`;
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Service.prototype,
      "load",
    )!;
    cacheMethod({ ttl: "5m" }, cache)(
      Service.prototype,
      "load",
      descriptor,
    );
    Object.defineProperty(Service.prototype, "load", descriptor);
    const svc = new Service();
    expect(await svc.load("7")).toBe("v:7:1");
    expect(await svc.load("7")).toBe("v:7:1");
    expect(svc.runs).toBe(1);
  });
});

describe("edge purge providers", () => {
  it("cloudflare purges by tag, and by URL as a separate request", async () => {
    const calls: Call[] = [];
    const provider = new CloudflareEdgePurgeProvider(
      "zone-1",
      "tok-abc",
      fakeFetch(calls),
    );
    await provider.purge({
      tags: ["users", "users"],
      urls: ["https://example.com/a"],
    });
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache",
    );
    expect(JSON.parse(calls[0]!.body)).toEqual({ tags: ["users"] });
    expect(JSON.parse(calls[1]!.body)).toEqual({
      files: ["https://example.com/a"],
    });
    // The token travels only in the header, never in a URL or body.
    for (const call of calls) {
      expect(call.url).not.toContain("tok-abc");
      expect(call.body).not.toContain("tok-abc");
      expect(call.headers.Authorization).toBe("Bearer tok-abc");
    }
  });

  it("an empty purge is a no-op, never a purge-everything", async () => {
    const calls: Call[] = [];
    const provider = new CloudflareEdgePurgeProvider(
      "zone-1",
      "tok-abc",
      fakeFetch(calls),
    );
    await provider.purge({ tags: [], urls: [] });
    await provider.purge({});
    expect(calls.length).toBe(0);
  });

  it("vercel purges by tag and cannot purge by URL", async () => {
    const calls: Call[] = [];
    const provider = new VercelEdgePurgeProvider(
      "my-project",
      "tok-xyz",
      undefined,
      fakeFetch(calls),
    );
    await provider.purge({ tags: ["posts"] });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain(
      "api.vercel.com/v1/edge-cache/invalidate-by-tags",
    );
    expect(calls[0]!.url).toContain("projectIdOrName=my-project");
    expect(JSON.parse(calls[0]!.body)).toEqual({ tags: ["posts"] });
    // URL-only: nothing to purge by tag, so no request goes out.
    await provider.purge({ urls: ["https://example.com/a"] });
    expect(calls.length).toBe(1);
  });

  it("env factory returns null when nothing is configured", () => {
    expect(createEdgePurgeFromEnv({})).toBeNull();
    expect(createEdgePurgeFromEnv({ YATTA_EDGE_PROVIDER: "" })).toBeNull();
  });

  it("env factory returns null with a warning when credentials are missing", () => {
    const warn = captureWarn();
    try {
      const provider = createEdgePurgeFromEnv({
        YATTA_EDGE_PROVIDER: "cloudflare",
        CLOUDFLARE_ZONE_ID: "zone-1",
      });
      expect(provider).toBeNull();
      expect(warn.seen.join(" ")).toContain("CLOUDFLARE_API_TOKEN");
      expect(warn.seen.join(" ")).not.toContain("zone-1");
    } finally {
      warn.restore();
    }
  });

  it("env factory builds a vercel provider from env, never from code", () => {
    const calls: Call[] = [];
    const provider = createEdgePurgeFromEnv(
      {
        YATTA_EDGE_PROVIDER: "vercel",
        VERCEL_API_TOKEN: "tok-xyz",
        VERCEL_PROJECT_ID: "my-project",
      },
      fakeFetch(calls),
    );
    expect(provider?.name).toBe("vercel");
  });
});

describe("edge-aware engine wiring", () => {
  it("purges the edge with the same tags it invalidated locally", async () => {
    const calls: Call[] = [];
    const fake: EdgePurgeProvider = {
      name: "fake",
      purge: async (req) => {
        calls.push({
          url: "fake://purge",
          body: JSON.stringify(req),
          headers: {},
        });
      },
    };
    const cache = new EdgeAwareCacheEngine({ maxItems: 100, edge: fake });
    await cache.set("k1", "v1", { tags: ["users"] });
    expect(await cache.get("k1")).toBe("v1");
    const evicted = await cache.invalidateTags("users");
    expect(evicted).toBe(1);
    expect(await cache.get("k1")).toBeNull();
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ tags: ["users"] });
  });

  it("with no provider configured, invalidation is exactly local-only", async () => {
    const cache = new EdgeAwareCacheEngine({ maxItems: 100, edge: null });
    expect(cache.edgeProvider).toBeNull();
    await cache.set("k1", "v1", { tags: ["users"] });
    expect(await cache.invalidateTags("users")).toBe(1);
    expect(await cache.get("k1")).toBeNull();
  });

  it("a provider failure does not break local invalidation", async () => {
    const warn = captureWarn();
    try {
      const cache = new EdgeAwareCacheEngine({
        maxItems: 100,
        edge: new CloudflareEdgePurgeProvider(
          "zone-1",
          "tok-abc",
          failingFetch(),
        ),
      });
      await cache.set("k1", "v1", { tags: ["users"] });
      const evicted = await cache.invalidateTags("users");
      expect(evicted).toBe(1);
      expect(await cache.get("k1")).toBeNull();
      expect(warn.seen.join(" ")).toContain("cloudflare");
      expect(warn.seen.join(" ")).not.toContain("tok-abc");
    } finally {
      warn.restore();
    }
  });

  it("the one-off helper also fails open", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 100 });
    await cache.set("k1", "v1", { tags: ["users"] });
    const failing: EdgePurgeProvider = {
      name: "fake",
      purge: async () => {
        throw new Error("edge down");
      },
    };
    const warn = captureWarn();
    try {
      expect(await invalidateTagsWithEdge(cache, "users", failing)).toBe(1);
      expect(await cache.get("k1")).toBeNull();
    } finally {
      warn.restore();
    }
    // And with no provider it is just local invalidation.
    await cache.set("k2", "v2", { tags: ["users"] });
    expect(await invalidateTagsWithEdge(cache, "users", null)).toBe(1);
  });
});
