import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DoublyLinkedList,
  duration,
  MemoryCacheEngine,
  MinHeap,
  parsePriority,
  QueueError,
} from "../types/cache_queue";

/*
 * Cache expiry arithmetic and the O(1) structures underneath it.
 *
 * The existing cache_queue suite covers the lifecycle well — LRU promotion, tags, SWR,
 * singleflight, L2 backfill, priority tiers. What it did not pin is what happens when a
 * TTL is not a number, and that turns out to be the whole guard.
 */

describe("duration rejects values that are not durations", () => {
  /*
   * The string path already threw on anything unparseable. The number path returned
   * whatever it was given, and every TTL is consumed by `ttlMs > 0 ? now + ttlMs : null`.
   * `NaN > 0` is false, so `ttl: NaN` did not fail the expiry — it produced
   * `expiresAt = null`, which means never expires.
   */
  it("throws for NaN", () => {
    expect(() => duration(NaN)).toThrow(QueueError);
    expect(() => duration(NaN)).toThrow(/NaN/);
  });

  it("throws for Infinity and -Infinity", () => {
    expect(() => duration(Infinity)).toThrow(QueueError);
    expect(() => duration(-Infinity)).toThrow(QueueError);
  });

  it("throws for a negative duration", () => {
    expect(() => duration(-1)).toThrow(QueueError);
    expect(() => duration(-0.5)).toThrow(QueueError);
  });

  it("accepts zero, which means no expiry and is legitimate", () => {
    expect(duration(0)).toBe(0);
  });

  it("accepts the documented strings, which were always checked", () => {
    expect(duration("500ms")).toBe(500);
    expect(duration("5m")).toBe(300_000);
    expect(duration("1.5h")).toBe(5_400_000);
  });

  it("still rejects a malformed string", () => {
    expect(() => duration("garbage" as never)).toThrow(QueueError);
    expect(() => duration("" as never)).toThrow(QueueError);
  });

  it("falls back when the value is absent", () => {
    expect(duration(undefined)).toBe(0);
    expect(duration(undefined, 1000)).toBe(1000);
  });
});

describe("a TTL that is not a number is refused rather than cached forever", () => {
  let cache: MemoryCacheEngine;

  beforeEach(() => {
    cache = new MemoryCacheEngine({ maxItems: 100 });
  });

  /** The stored entry, which is what the expiry decision is made from. */
  const expiresAtOf = (key: string): number | null =>
    (cache as never as { map: Map<string, { value: { expiresAt: number | null } }> }).map.get(key)
      ?.value.expiresAt ?? null;

  it("throws on set with a NaN ttl", async () => {
    // Measured before the fix: accepted, and stored with expiresAt null — an entry that
    // never expires, from a limit that was meant to bound it.
    await expect(cache.set("k", "v", { ttl: NaN })).rejects.toThrow(/Invalid duration/);

    expect(await cache.get<string>("k")).toBeNull();
  });

  it("throws on set with a negative ttl", async () => {
    await expect(cache.set("k", "v", { ttl: -1 })).rejects.toThrow(/Invalid duration/);
    expect(await cache.get<string>("k")).toBeNull();
  });

  it("refuses to construct with a default ttl that is not a number", () => {
    /*
     * The shape that produces a NaN in practice: a TTL read out of the environment.
     *
     * Failing at construction rather than at the first set() is deliberate — a cache
     * with a broken default is broken for every entry, so there is no point accepting
     * the object and failing later.
     */
    expect(
      () =>
        new MemoryCacheEngine({
          maxItems: 10,
          defaultTtl: Number(process.env.YATTA_TEST_UNSET_TTL),
        }),
    ).toThrow(/Invalid duration/);
  });

  it("accepts a default ttl that is a number", () => {
    expect(() => new MemoryCacheEngine({ defaultTtl: 60_000 })).not.toThrow();
  });

  it("throws on a NaN swr window rather than silently dropping it", async () => {
    await expect(cache.set("k", "v", { ttl: "1h", swr: NaN })).rejects.toThrow(/Invalid duration/);
  });

  it("stores a real expiry for a real ttl", async () => {
    await cache.set("k", "v", { ttl: 60_000 });

    const expiresAt = expiresAtOf("k");
    expect(typeof expiresAt).toBe("number");
    expect(expiresAt!).toBeGreaterThan(Date.now());
  });

  it("still allows an entry with no ttl at all", async () => {
    await cache.set("k", "v");

    expect(expiresAtOf("k")).toBeNull();
    expect(await cache.get<string>("k")).toBe("v");
  });

  it("expires an entry whose ttl has elapsed", async () => {
    await cache.set("k", "v", { ttl: 20 });

    expect(await cache.get<string>("k")).toBe("v");

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await cache.get<string>("k")).toBeNull();
  });
});

describe("parsePriority", () => {
  it("maps the named levels", () => {
    expect(parsePriority("critical")).toBe(3);
    expect(parsePriority("high")).toBe(2);
    expect(parsePriority("normal")).toBe(1);
    expect(parsePriority("low")).toBe(0);
  });

  it("defaults to normal", () => {
    expect(parsePriority()).toBe(1);
  });

  it("clamps rather than throwing, which is the documented choice", () => {
    expect(parsePriority(99)).toBe(3);
    expect(parsePriority(-5)).toBe(0);
  });
});

describe("DoublyLinkedList", () => {
  it("appends and prepends in order", () => {
    const list = new DoublyLinkedList<string>();

    list.append("b");
    list.prepend("a");
    list.append("c");

    expect(list.size).toBe(3);
    expect(list.head?.value).toBe("a");
    expect(list.tail?.value).toBe("c");
  });

  it("shifts from the front and pops from the back", () => {
    const list = new DoublyLinkedList<string>();

    list.append("a");
    list.append("b");
    list.append("c");

    expect(list.shift()).toBe("a");
    expect(list.pop()).toBe("c");
    expect(list.size).toBe(1);
    expect(list.head?.value).toBe("b");
  });

  it("keeps both pointers consistent after both ends are emptied", () => {
    const list = new DoublyLinkedList<string>();

    list.append("a");

    expect(list.shift()).toBe("a");
    expect(list.head).toBeNull();
    expect(list.tail).toBeNull();
    expect(list.size).toBe(0);
  });

  it("moves an existing node to the head", () => {
    const list = new DoublyLinkedList<string>();

    list.append("a");
    list.append("b");
    list.append("c");
    const middle = list.head!.next!;

    list.moveToHead(middle);

    expect(list.head?.value).toBe("b");
    expect(list.tail?.value).toBe("c");
    expect(list.size).toBe(3);
  });

  it("unlinks a node without disturbing the rest", () => {
    const list = new DoublyLinkedList<string>();

    list.append("a");
    list.append("b");
    list.append("c");
    list.unlink(list.head!.next!);

    expect(list.size).toBe(2);
    expect(list.head?.next?.value).toBe("c");
    expect(list.head?.next?.prev?.value).toBe("a");
  });

  it("returns null rather than throwing when emptied", () => {
    const list = new DoublyLinkedList<string>();

    expect(list.shift()).toBeNull();
    expect(list.pop()).toBeNull();
  });
});

describe("MinHeap", () => {
  it("pops in score order", () => {
    const heap = new MinHeap<{ id: number }>((n) => n.id);

    for (const id of [5, 1, 4, 2, 3]) heap.push({ id });

    const order: number[] = [];
    while (heap.size > 0) order.push(heap.pop()!.id);

    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("holds the heap property with many items", () => {
    const heap = new MinHeap<number>((n) => n);

    const values = Array.from({ length: 500 }, () => Math.floor(Math.random() * 10_000));
    for (const v of values) heap.push(v);

    const sorted = [...values].sort((a, b) => a - b);
    const popped: number[] = [];
    while (heap.size > 0) popped.push(heap.pop()!);

    expect(popped).toEqual(sorted);
  });

  it("peeks without removing", () => {
    const heap = new MinHeap<number>((n) => n);

    heap.push(7);
    heap.push(2);

    expect(heap.peek()).toBe(2);
    expect(heap.size).toBe(2);
  });

  it("returns null when empty", () => {
    const heap = new MinHeap<number>((n) => n);

    expect(heap.pop()).toBeNull();
    expect(heap.peek()).toBeNull();
  });
});

describe("L1 eviction", () => {
  it("drops the oldest entry past maxItems", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 3 });

    for (const key of ["a", "b", "c", "d"]) await cache.set(key, key);

    expect(await cache.get<string>("a")).toBeNull();
    expect(await cache.get<string>("d")).toBe("d");
  });

  it("holds nothing at maxItems 0 instead of spinning", async () => {
    /*
     * `maxItems: 0` used to hang: the eviction loop's condition was true on an empty
     * list and had nothing to remove, so no iteration ever ended.
     */
    const cache = new MemoryCacheEngine({ maxItems: 0 });

    await cache.set("a", "a");

    expect(await cache.get<string>("a")).toBeNull();
  });

  it("keeps a recently read entry out of the eviction path", async () => {
    const cache = new MemoryCacheEngine({ maxItems: 3 });

    for (const key of ["a", "b", "c"]) await cache.set(key, key);

    // Promote "a" so "b" becomes the oldest.
    await cache.get<string>("a");
    await cache.set("d", "d");

    expect(await cache.get<string>("a")).toBe("a");
    expect(await cache.get<string>("b")).toBeNull();
  });
});

describe("maxItems is not the only bound worth checking", () => {
  it("reports its statistics after use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cq-stats-"));

    try {
      const cache = new MemoryCacheEngine({ maxItems: 2 });

      await cache.set("a", "a");
      await cache.get<string>("a");
      await cache.get<string>("missing");
      await cache.set("b", "b");
      await cache.set("c", "c");

      const stats = cache.getMetrics();

      expect(stats.writes).toBeGreaterThanOrEqual(3);
      expect(stats.hits).toBeGreaterThanOrEqual(1);
      expect(stats.misses).toBeGreaterThanOrEqual(1);
      expect(stats.evictions).toBeGreaterThanOrEqual(1);
      expect(stats.hitRatio).toBeGreaterThanOrEqual(0);
      expect(stats.hitRatio).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});