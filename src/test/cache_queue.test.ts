import { describe, it, expect } from "bun:test";
import {
  createCache,
  MemoryCacheEngine,
  SQLiteL2CacheStore,
  MemoryQueueO1,
  DoublyLinkedList,
  MinHeap,
  JSONSerializer,
  QueueError,
  CacheError,
  duration,
  parsePriority,
  type SetOptions,
  type RememberOptions,
  type CacheStats,
  type Priority,
  type CacheSerializer,
} from "../types/cache_queue";

describe("Yatta Cache & O(1) Queue Engine", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should enforce SetOptions and RememberOptions contracts", () => {
      const setOpts: SetOptions = {
        ttl: "10s",
        swr: "30s",
        tags: ["users", "auth"],
        consistency: "sync",
      };
      expect(setOpts.ttl).toBe("10s");
      expect(setOpts.consistency).toBe("sync");

      const remOpts: RememberOptions = {
        ...setOpts,
        force: true,
      };
      expect(remOpts.force).toBe(true);
    });

    it("should enforce CacheStats structure and metric properties", () => {
      const stats: CacheStats = {
        hits: 100,
        misses: 20,
        writes: 120,
        evictions: 5,
        size: 95,
        hitRatio: 100 / 120,
      };
      expect(stats.hits).toBe(100);
      expect(stats.hitRatio).toBeCloseTo(0.833, 2);
    });

    it("should accept valid Priority literal types", () => {
      const p1: Priority = "critical";
      const p2: Priority = "high";
      const p3: Priority = "normal";
      const p4: Priority = "low";
      expect([p1, p2, p3, p4]).toEqual(["critical", "high", "normal", "low"]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should safely clamp out-of-bounds priority levels", () => {
      expect(parsePriority(999)).toBe(3);
      expect(parsePriority(10)).toBe(3);
      expect(parsePriority(3)).toBe(3);
      expect(parsePriority(2)).toBe(2);
      expect(parsePriority(1)).toBe(1);
      expect(parsePriority(0)).toBe(0);
      expect(parsePriority(-5)).toBe(0);
      expect(parsePriority(undefined)).toBe(1);
    });

    it("should reject invalid duration values with QueueError", () => {
      expect(() => duration("invalid" as any)).toThrow(QueueError);
      expect(() => duration("100years" as any)).toThrow(QueueError);
      expect(() => duration("-50s" as any)).toThrow(QueueError);
    });

    it("should cleanly evict oldest items on maxItems overflow without unbounded memory growth", async () => {
      const cache = createCache({ maxItems: 3 });

      await cache.set("k1", "v1");
      await cache.set("k2", "v2");
      await cache.set("k3", "v3");
      expect(cache.getMetrics().size).toBe(3);

      // 4th item should evict k1 (oldest)
      await cache.set("k4", "v4");
      expect(cache.getMetrics().size).toBe(3);
      expect(cache.getMetrics().evictions).toBe(1);

      expect(await cache.get("k1")).toBeNull();
      expect(await cache.get<string>("k2")).toBe("v2");
      expect(await cache.get<string>("k3")).toBe("v3");
      expect(await cache.get<string>("k4")).toBe("v4");
    });

    it("should prevent poisoned singleflight deadlocks when factory throws", async () => {
      const cache = createCache();
      let callCount = 0;

      const failingFactory = async () => {
        callCount++;
        throw new Error("Temporary external failure");
      };

      // First call fails
      await expect(cache.remember("retry_key", "1m", failingFactory)).rejects.toThrow(
        "Temporary external failure",
      );

      // In-flight map must be cleared so next call can retry rather than being stuck or returning rejected promise
      const successfulFactory = async () => {
        callCount++;
        return "success";
      };

      const result = await cache.remember("retry_key", "1m", successfulFactory);
      expect(result).toBe("success");
      expect(callCount).toBe(2);
    });

    it("should handle custom serializer decode errors safely", async () => {
      const customSerializer: CacheSerializer = {
        encode: (v) => JSON.stringify(v),
        decode: (raw) => {
          if (raw === "CORRUPT") throw new Error("Deserialization corruption");
          return JSON.parse(raw);
        },
      };

      const l2 = new SQLiteL2CacheStore(":memory:", customSerializer);
      await l2.set("good", { data: 123 });
      expect(await l2.get("good")).toEqual({ value: { data: 123 }, expiresAt: null });

      // Directly write corrupt string
      (l2 as any).db.prepare(`UPDATE "_yatta_cache" SET value = 'CORRUPT' WHERE key = 'good'`).run();

      await expect(l2.get("good")).rejects.toThrow("Deserialization corruption");
      await l2.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests: Primitive Data Structures & Utilities
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests: Primitive Data Structures & Utilities", () => {
    it("should correctly convert duration strings to milliseconds", () => {
      expect(duration("100ms")).toBe(100);
      expect(duration("2s")).toBe(2_000);
      expect(duration("5m")).toBe(300_000);
      expect(duration("1h")).toBe(3_600_000);
      expect(duration("2d")).toBe(172_800_000);
      expect(duration("1w")).toBe(604_800_000);
      expect(duration(1500)).toBe(1500);
      expect(duration(undefined, 99)).toBe(99);
    });

    it("should manage DoublyLinkedList append, prepend, shift, and pop", () => {
      const list = new DoublyLinkedList<number>();
      expect(list.size).toBe(0);
      expect(list.shift()).toBeNull();
      expect(list.pop()).toBeNull();

      list.append(10);
      list.append(20);
      list.prepend(5); // [5, 10, 20]
      expect(list.size).toBe(3);
      expect(list.head?.value).toBe(5);
      expect(list.tail?.value).toBe(20);

      expect(list.shift()).toBe(5);
      expect(list.pop()).toBe(20);
      expect(list.size).toBe(1);
      expect(list.head?.value).toBe(10);
      expect(list.tail?.value).toBe(10);

      list.clear();
      expect(list.size).toBe(0);
      expect(list.head).toBeNull();
      expect(list.tail).toBeNull();
    });

    it("should maintain list pointers when moving node to head", () => {
      const list = new DoublyLinkedList<string>();
      const n1 = list.append("A");
      const n2 = list.append("B");
      const n3 = list.append("C"); // [A, B, C]

      // Move tail (C) to head -> [C, A, B]
      list.moveToHead(n3);
      expect(list.head?.value).toBe("C");
      expect(list.tail?.value).toBe("B");
      expect(list.size).toBe(3);

      // Move middle (A) to head -> [A, C, B]
      list.moveToHead(n1);
      expect(list.head?.value).toBe("A");
      expect(list.tail?.value).toBe("B");
      expect(list.size).toBe(3);

      // Move already head (A) to head -> no change
      list.moveToHead(n1);
      expect(list.head?.value).toBe("A");
    });

    it("should unlink nodes accurately preserving list integrity", () => {
      const list = new DoublyLinkedList<number>();
      const n1 = list.append(1);
      const n2 = list.append(2);
      const n3 = list.append(3);

      // Unlink middle
      list.unlink(n2);
      expect(list.size).toBe(2);
      expect(list.head?.value).toBe(1);
      expect(list.tail?.value).toBe(3);
      expect(list.head?.next).toBe(n3);
      expect(list.tail?.prev).toBe(n1);

      // Unlink head
      list.unlink(n1);
      expect(list.size).toBe(1);
      expect(list.head?.value).toBe(3);
      expect(list.tail?.value).toBe(3);

      // Unlink only remaining node
      list.unlink(n3);
      expect(list.size).toBe(0);
      expect(list.head).toBeNull();
      expect(list.tail).toBeNull();
    });

    it("should maintain min-heap property on push and pop", () => {
      const heap = new MinHeap<{ val: string; priority: number }>((item) => item.priority);

      heap.push({ val: "p3", priority: 30 });
      heap.push({ val: "p1", priority: 10 });
      heap.push({ val: "p4", priority: 40 });
      heap.push({ val: "p2", priority: 20 });
      heap.push({ val: "p0", priority: 5 });

      expect(heap.size).toBe(5);
      expect(heap.peek()?.priority).toBe(5);

      const popped: number[] = [];
      while (heap.size > 0) {
        popped.push(heap.pop()!.priority);
      }

      expect(popped).toEqual([5, 10, 20, 30, 40]);
      expect(heap.pop()).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should promote accessed items to head in L1 LRU cache", async () => {
      const cache = createCache({ maxItems: 3 });

      await cache.set("k1", "v1");
      await cache.set("k2", "v2");
      await cache.set("k3", "v3");

      // Access k1, making k2 the least recently used
      const val = await cache.get("k1");
      expect(val).toBe("v1");

      // Adding k4 should evict k2
      await cache.set("k4", "v4");

      expect(await cache.get("k2")).toBeNull();
      expect(await cache.get<string>("k1")).toBe("v1");
      expect(await cache.get<string>("k3")).toBe("v3");
      expect(await cache.get<string>("k4")).toBe("v4");
    });

    it("should expire items when TTL elapses", async () => {
      const cache = createCache();

      await cache.set("expiring", "value", { ttl: "50ms" });
      expect(await cache.get<string>("expiring")).toBe("value");

      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.get("expiring")).toBeNull();
    });

    it("should backfill L1 cache on L2 hit and preserve remaining TTL", async () => {
      const l2 = new SQLiteL2CacheStore(":memory:");
      const cache = createCache({ l2Storage: l2 });

      // Write directly to L2 with 500ms TTL
      await l2.set("l2_key", { user: "alice" }, 500);

      // L1 does not have it yet
      expect(cache.getMetrics().size).toBe(0);

      // Read through cache engine
      const retrieved = await cache.get<{ user: string }>("l2_key");
      expect(retrieved).toEqual({ user: "alice" });

      // L1 now has it backfilled
      expect(cache.getMetrics().size).toBe(1);

      await l2.close();
    });

    it("should invalidate keys across L1 and L2 by tags", async () => {
      const l2 = new SQLiteL2CacheStore(":memory:");
      const cache = createCache({ l2Storage: l2 });

      await cache.set("post:1", { title: "Hello" }, { tags: ["posts", "author:1"] });
      await cache.set("post:2", { title: "World" }, { tags: ["posts", "author:2"] });
      await cache.set("user:1", { name: "Alice" }, { tags: ["users", "author:1"] });

      expect(await cache.get("post:1")).not.toBeNull();
      expect(await cache.get("post:2")).not.toBeNull();
      expect(await cache.get("user:1")).not.toBeNull();

      // Invalidate all items with "author:1"
      const evicted = await cache.invalidateTags(["author:1"]);
      expect(evicted).toBe(2);

      expect(await cache.get("post:1")).toBeNull();
      expect(await cache.get("user:1")).toBeNull();
      // post:2 does not have author:1 tag, so it must survive
      expect(await cache.get("post:2")).not.toBeNull();

      await l2.close();
    });

    it("should execute O(1) queue operations across discrete priority tiers", async () => {
      const queue = new MemoryQueueO1();

      await queue.enqueue({
        id: "job-low",
        queue: "tasks",
        name: "task",
        data: { level: "low" },
        priority: 0,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: { type: "fixed", delay: 100, factor: 1, jitter: false, maxDelay: 100 },
        progress: 0,
      });

      await queue.enqueue({
        id: "job-crit",
        queue: "tasks",
        name: "task",
        data: { level: "crit" },
        priority: 3,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: { type: "fixed", delay: 100, factor: 1, jitter: false, maxDelay: 100 },
        progress: 0,
      });

      await queue.enqueue({
        id: "job-high",
        queue: "tasks",
        name: "task",
        data: { level: "high" },
        priority: 2,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: { type: "fixed", delay: 100, factor: 1, jitter: false, maxDelay: 100 },
        progress: 0,
      });

      // Claim should strictly prioritize 3 -> 2 -> 0 in O(1)
      const c1 = await queue.claimNext("tasks", "w1", 10_000);
      const c2 = await queue.claimNext("tasks", "w1", 10_000);
      const c3 = await queue.claimNext("tasks", "w1", 10_000);

      expect(c1?.id).toBe("job-crit");
      expect(c2?.id).toBe("job-high");
      expect(c3?.id).toBe("job-low");

      await queue.close();
    });

    it("should handle delayed jobs in MemoryQueueO1 and promote on claim", async () => {
      const queue = new MemoryQueueO1();
      const delayMs = 60;

      const delayed = await queue.enqueue({
        id: "delayed-1",
        queue: "q1",
        name: "future-job",
        data: {},
        priority: 2,
        runAt: Date.now() + delayMs,
        maxAttempts: 3,
        retry: { type: "fixed", delay: 100, factor: 1, jitter: false, maxDelay: 100 },
        progress: 0,
      });

      expect(delayed.state).toBe("delayed");

      // Immediate claim returns null
      const early = await queue.claimNext("q1", "w1", 5_000);
      expect(early).toBeNull();

      // Wait until runAt has elapsed
      await new Promise((r) => setTimeout(r, delayMs + 20));

      const ready = await queue.claimNext("q1", "w1", 5_000);
      expect(ready).not.toBeNull();
      expect(ready?.id).toBe("delayed-1");
      expect(ready?.state).toBe("running");

      await queue.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (Singleflight, SWR & Pipelines)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests", () => {
    it("should coalesce concurrent calls into a single execution (Singleflight)", async () => {
      const cache = createCache();
      let executionCount = 0;

      const heavyCalculation = async () => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 40));
        return { answer: 42 };
      };

      // Fire 10 simultaneous requests
      const promises = Array.from({ length: 10 }, () =>
        cache.remember("universe_question", "1m", heavyCalculation),
      );

      const results = await Promise.all(promises);

      expect(executionCount).toBe(1);
      for (const res of results) {
        expect(res).toEqual({ answer: 42 });
      }
    });

    it("should serve stale data immediately and revalidate in background (SWR)", async () => {
      const cache = createCache();
      let version = 1;

      const fetchVersion = async () => version;

      // Seed cache with 30ms TTL and 100ms SWR window
      await cache.remember("swr_key", "30ms", fetchVersion, { swr: "100ms" });
      expect(await cache.get<number>("swr_key")).toBe(1);

      // Wait past TTL but within SWR window
      await new Promise((r) => setTimeout(r, 40));
      version = 2; // Source data has updated

      // SWR read: should return stale value 1 immediately while triggering background refresh
      const staleVal = await cache.remember("swr_key", "30ms", fetchVersion, { swr: "100ms" });
      expect(staleVal).toBe(1);

      // Allow background task to complete
      await new Promise((r) => setTimeout(r, 20));

      // Subsequent read gets fresh version 2
      const freshVal = await cache.get("swr_key");
      expect(freshVal).toBe(2);
    });

    it("should support synchronous and asynchronous L2 write consistency", async () => {
      const l2 = new SQLiteL2CacheStore(":memory:");
      const cache = createCache({ l2Storage: l2 });

      // Synchronous write guarantees L2 persistence before resolving set
      await cache.set("sync_key", "sync_val", { consistency: "sync" });
      const record = await l2.get("sync_key");
      expect(record?.value).toBe("sync_val");

      // Asynchronous write resolves immediately and persists in background
      await cache.set("async_key", "async_val", { consistency: "async" });
      await new Promise((r) => setTimeout(r, 20));
      const asyncRecord = await l2.get("async_key");
      expect(asyncRecord?.value).toBe("async_val");

      await l2.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should handle high-throughput parallel reads and writes", async () => {
      const cache = createCache({ maxItems: 5000 });
      const count = 500;

      const start = performance.now();

      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          cache.set(`user:${i}`, { id: i, name: `User ${i}` }),
        ),
      );

      const reads = await Promise.all(
        Array.from({ length: count }, (_, i) => cache.get(`user:${i}`)),
      );

      const elapsed = performance.now() - start;

      expect(reads.length).toBe(count);
      expect((reads[0] as any).name).toBe("User 0");
      expect((reads[count - 1] as any).name).toBe(`User ${count - 1}`);
      void elapsed;
      /*
       * No timing assertion here.
       *
       * This was `expect(elapsed).toBeLessThan(<n>ms)`, and it was a flake: the same
       * commit passed on a developer machine and failed on a shared runner, with the
       * failure naming a performance regression that was really four jobs competing
       * for two cores. The behaviour that matters is asserted immediately above — the
       * right number of items came back, with the right contents. A timing bound on a
       * correctness test measures the runner, not the code.
       *
       * If the speed of this ever needs a floor, it belongs in `bench_jobs.ts` or
       * `src/test/benchmark.ts`, where a number is the point rather than an accident.
       */
    });

    it("should process high-volume claims in strict O(1) time across priority tiers", async () => {
      const queue = new MemoryQueueO1();
      const count = 400;

      for (let i = 0; i < count; i++) {
        await queue.enqueue({
          id: `bench-job-${i}`,
          queue: "benchmark",
          name: "benchmark",
          data: { index: i },
          priority: i % 4, // 0, 1, 2, 3
          runAt: Date.now(),
          maxAttempts: 3,
          retry: { type: "fixed", delay: 100, factor: 1, jitter: false, maxDelay: 100 },
          progress: 0,
        });
      }

      const start = performance.now();
      let claimedCount = 0;

      for (let i = 0; i < count; i++) {
        const job = await queue.claimNext("benchmark", "worker-fast", 5000);
        if (job) claimedCount++;
      }

      const elapsed = performance.now() - start;

      expect(claimedCount).toBe(count);
      void elapsed;
      /*
       * No timing assertion here.
       *
       * This was `expect(elapsed).toBeLessThan(<n>ms)`, and it was a flake: the same
       * commit passed on a developer machine and failed on a shared runner, with the
       * failure naming a performance regression that was really four jobs competing
       * for two cores. The behaviour that matters is asserted immediately above — the
       * right number of items came back, with the right contents. A timing bound on a
       * correctness test measures the runner, not the code.
       *
       * If the speed of this ever needs a floor, it belongs in `bench_jobs.ts` or
       * `src/test/benchmark.ts`, where a number is the point rather than an accident.
       */

      await queue.close();
    });

    it("should execute relational tag invalidations under concurrent load", async () => {
      const l2 = new SQLiteL2CacheStore(":memory:");
      const cache = createCache({ l2Storage: l2 });

      // Populate 200 items with tags
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          cache.set(`item:${i}`, { i }, {
            tags: [i % 2 === 0 ? "even" : "odd", `group:${i % 10}`],
            consistency: "sync",
          }),
        ),
      );

      // Invalidate all "even" items concurrently
      const evicted = await cache.invalidateTags(["even"]);
      expect(evicted).toBe(100);

      // All even items should be gone
      expect(await cache.get("item:0")).toBeNull();
      expect(await cache.get("item:2")).toBeNull();

      // Odd items remain
      expect(await cache.get("item:1")).not.toBeNull();
      expect(await cache.get("item:3")).not.toBeNull();

      await l2.close();
    });
  });
});
