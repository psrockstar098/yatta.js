import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CacheError,
  MemoryCacheEngine,
  SQLiteL2CacheStore,
} from "../types/cache_queue";

/*
 * The persistent L2 cache store's expiry handling.
 *
 * `L2CacheStore` is an exported interface, so `ttlMs` reaches it from outside the
 * engine as well as from inside it — and the store cannot assume the value was checked
 * on the way in.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "l2-expiry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = (name = "l2.db") => new SQLiteL2CacheStore(join(dir, name));

describe("SQLiteL2CacheStore validates its own ttl", () => {
  /*
   * `ttlMs && ttlMs > 0` treats NaN as absent, because NaN is falsy. The result was
   * `expires_at = NULL` — and in L1 that is one process's memory, while here the row is
   * in SQLite, survives a restart, and the background sweeper only deletes rows that
   * *have* an expiry. Nothing ever collects it.
   */
  it("throws for a NaN ttl instead of storing an entry that never expires", async () => {
    const l2 = store();

    await expect(l2.set("k", "v", Number("nope"))).rejects.toThrow(CacheError);
    await expect(l2.set("k", "v", Number("nope"))).rejects.toThrow(/NaN/);

    expect(await l2.get("k")).toBeNull();
  });

  it("throws for a negative ttl", async () => {
    await expect(store().set("k", "v", -1)).rejects.toThrow(/negative/);
  });

  it("throws for Infinity", async () => {
    await expect(store().set("k", "v", Infinity)).rejects.toThrow(/finite/);
  });

  it("accepts no ttl at all, which means no expiry", async () => {
    const l2 = store();

    await l2.set("k", "v");

    const record = await l2.get<string>("k");
    expect(record?.value).toBe("v");
    expect(record?.expiresAt ?? null).toBeNull();
  });

  it("accepts zero, which also means no expiry", async () => {
    const l2 = store();

    await l2.set("k", "v", 0);

    expect((await l2.get<string>("k"))?.value).toBe("v");
  });

  it("stores a real expiry for a real ttl", async () => {
    const l2 = store();

    await l2.set("k", "v", 60_000);

    const record = await l2.get<string>("k");
    expect(record?.expiresAt ?? null).toBeGreaterThan(Date.now());
  });

  it("expires an entry whose ttl has elapsed", async () => {
    const l2 = store();

    await l2.set("k", "v", 20);
    expect((await l2.get<string>("k"))?.value).toBe("v");

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await l2.get("k")).toBeNull();
  });

  it("is reachable through the engine, which already validated the value", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 10, l2Storage: store("eng.db") });

    // The engine resolves the TTL through duration(), so this is refused before it ever
    // reaches the store — the store's own check is for direct callers.
    await expect(cache.set("k", "v", { ttl: Number("x") })).rejects.toThrow(/Invalid duration/);
  });

  it("writes through to L2 with a valid ttl", async () => {
    const l2 = store("write.db");
    const cache = new MemoryCacheEngine({
      maxItems: 10,
      l2Storage: l2,
      // `sync` so the write has happened by the time the assertion runs.
    });

    await cache.set("k", "v", { ttl: "5m", consistency: "sync" });

    expect((await l2.get<string>("k"))?.value).toBe("v");
  });

  it("cleans up an expired entry on sweep", async () => {
    // The reason a NULL expiry is worse here than in L1: the sweeper only removes rows
    // that have one.
    const l2 = store("sweep.db");

    await l2.set("gone", "v", 20);
    await l2.set("kept", "v", 0);
    await new Promise((resolve) => setTimeout(resolve, 40));

    await l2.cleanupExpired();

    expect(await l2.get("gone")).toBeNull();
    expect((await l2.get<string>("kept"))?.value).toBe("v");
  });
});