/**
 * ============================================================================
 *  YATTA CACHE & O(1) QUEUE ENGINE (v2.0) — High-Performance Bun Runtime
 * ============================================================================
 *
 *  OVERVIEW:
 *  Two high-performance subsystems engineered for low-latency in-memory data processing:
 *
 *  1. Multi-Tier Cache:
 *     - L1 LRU memory cache with O(1) get/set and fast pointer-based eviction.
 *     - Optional persistent SQLite L2 backing with WAL mode and indexed expiration.
 *     - Singleflight promise coalescing (eliminates the cache thundering herd problem).
 *     - Stale-While-Revalidate (SWR) background refreshes.
 *     - Grouped relational tag invalidation across L1 and L2 tiers.
 *     - Configurable "async" (fire-and-forget) or "sync" L2 write consistency.
 *
 *  2. O(1) Priority Queue:
 *     - Strict O(1) enqueue and claim engine across discrete priority tiers:
 *       `3: Critical`, `2: High`, `1: Normal`, `0: Low`.
 *     - Binary Min-Heap delayed scheduler with lazy deletion (prevents ghost executions).
 *     - Atomic worker lease claiming with heartbeat renewals and stale recovery.
 *     - Deduplication key mapping to prevent duplicate concurrent jobs.
 *
 *  KEY EXPORTS:
 *  - `Cache`: Zero-configuration global proxy singleton backed by SQLite.
 *  - `createCache(options)`: Factory for isolated, configured `MemoryCacheEngine` instances.
 *  - `MemoryCacheEngine`: Core multi-tier cache engine.
 *  - `SQLiteL2CacheStore`: Persistent L2 SQLite cache adapter with automated TTL sweeps.
 *  - `MemoryQueueO1`: Strict O(1) in-memory priority queue implementing `JobStore`.
 *  - Data Structures: `DoublyLinkedList<T>` and `MinHeap<T>`.
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { Cache, createCache, SQLiteL2CacheStore, MemoryQueueO1 } from "./cache_queue";
 *
 *  // 1. Singleflight memoization with SWR (prevents duplicate db hits)
 *  const user = await Cache.remember(`user:${id}`, "5m", async () => {
 *    return await fetchUserFromDatabase(id);
 *  }, { swr: "15m", tags: ["users", `user:${id}`] });
 *
 *  // 2. Invalidate all tagged keys on update
 *  await Cache.invalidateTags(`user:${id}`);
 *
 *  // 3. True O(1) priority job queue
 *  const queue = new MemoryQueueO1();
 *  await queue.enqueue({
 *    id: "job-101",
 *    queue: "email",
 *    name: "send-welcome",
 *    data: { to: "user@example.com" },
 *    priority: 3, // Critical
 *    runAt: Date.now(),
 *    maxAttempts: 3,
 *    retry: { type: "exponential", delay: 1000, factor: 2, jitter: true, maxDelay: 30000 },
 *    progress: 0,
 *  });
 *  ```
 */

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// ──────────────────────────────────────────────────────────────────────────
// 0. Shared Core: Duration & Errors
// ──────────────────────────────────────────────────────────────────────────

/**
 * Thrown when queue operations (enqueue, claim, lease heartbeat, etc.) fail.
 */
export class QueueError extends Error {
  /**
   * @param message Human-readable error description.
   * @param code Optional machine-readable error code.
   */
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

/**
 * Thrown when cache operations (retrieval, eviction, serialization) fail.
 */
export class CacheError extends Error {
  /**
   * @param message Human-readable error description.
   * @param code Optional machine-readable error code.
   */
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CacheError";
  }
}

/**
 * Human-readable duration string or raw milliseconds as a number.
 *
 * Supported units:
 * - `"ms"`: Milliseconds
 * - `"s"`: Seconds
 * - `"m"`: Minutes
 * - `"h"`: Hours
 * - `"d"`: Days
 * - `"w"`: Weeks
 *
 * @example `"500ms"`, `"10s"`, `"5m"`, `"2h"`, `"7d"`, `"1w"`, or `60000`
 */
export type Duration =
  | `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`
  | number;

/**
 * Parses a human-readable duration string into milliseconds.
 * If passed a numeric value, it is treated strictly as milliseconds and returned as-is.
 *
 * @param value Duration string (e.g. `"5m"`, `"1h"`) or numeric milliseconds.
 * @param fallbackMs Fallback millisecond value if `value` is `null` or `undefined`. Defaults to 0.
 * @returns Parsed duration in milliseconds.
 * @throws {QueueError} If format or time unit is invalid.
 *
 * @example
 * ```ts
 * duration("500ms"); // 500
 * duration("5m");    // 300_000
 * duration("1h");    // 3_600_000
 * duration("1d");    // 86_400_000
 * duration(undefined, 1000); // 1000
 * ```
 */
export function duration(value?: Duration, fallbackMs = 0): number {
  if (value == null) return fallbackMs;
  if (typeof value === "number") return value; // numbers are strictly milliseconds

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) throw new QueueError(`Invalid duration format: "${value}"`);

  const n = parseFloat(match[1]!);
  switch (match[2]!.toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 604_800_000;
    default:
      throw new QueueError(`Invalid duration unit: "${match[2]}"`);
  }
}

/** Named discrete priority levels for background jobs. */
export type Priority = "critical" | "high" | "normal" | "low";

/** Discrete numeric priority tiers: `3` (Critical) down to `0` (Low). */
export const PRIORITY_LEVELS = [3, 2, 1, 0] as const;

/**
 * Normalizes a named priority string or number to an integer priority tier (0–3).
 *
 * Mappings:
 * - `"critical"` or `>= 3` -> `3`
 * - `"high"` or `2`        -> `2`
 * - `"normal"` or `1`      -> `1` (default fallback)
 * - `"low"` or `<= 0`      -> `0`
 *
 * @param p Named priority string or numerical tier.
 * @returns Normalized priority integer: 3, 2, 1, or 0.
 */
export function parsePriority(p?: Priority | number): number {
  if (typeof p === "number") {
    if (p >= 3) return 3;
    if (p === 2) return 2;
    if (p === 1) return 1;
    return 0;
  }
  switch (p) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0;
    default:
      return 1;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Primitive Data Structures
// ──────────────────────────────────────────────────────────────────────────

/**
 * Doubly linked node structure for {@link DoublyLinkedList}.
 *
 * @template T Payload value type stored within the node.
 */
export interface ListNode<T> {
  /** Payload value. */
  value: T;
  /** Pointer to predecessor node, or `null` if head. */
  prev: ListNode<T> | null;
  /** Pointer to successor node, or `null` if tail. */
  next: ListNode<T> | null;
}

/**
 * High-performance Doubly Linked List with strict O(1) insertions, removals, and promotions.
 * Used for LRU memory cache tracking and O(1) FIFO priority queue buckets.
 *
 * @template T The type of elements held in the list.
 */
export class DoublyLinkedList<T> {
  /** Head (front) node of the list. */
  head: ListNode<T> | null = null;
  /** Tail (back) node of the list. */
  tail: ListNode<T> | null = null;
  /** Current number of elements in the list. */
  size = 0;

  /**
   * Appends an element to the back (tail) of the list in O(1) time complexity.
   *
   * @param value Item to add.
   * @returns Newly created {@link ListNode}.
   */
  append(value: T): ListNode<T> {
    const node: ListNode<T> = { value, prev: this.tail, next: null };
    if (this.tail) {
      this.tail.next = node;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.size++;
    return node;
  }

  /**
   * Prepends an element to the front (head) of the list in O(1) time complexity.
   *
   * @param value Item to add.
   * @returns Newly created {@link ListNode}.
   */
  prepend(value: T): ListNode<T> {
    const node: ListNode<T> = { value, prev: null, next: this.head };
    if (this.head) {
      this.head.prev = node;
      this.head = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.size++;
    return node;
  }

  /**
   * Promotes an existing node directly to the front (head) in O(1) pointer operations.
   * Used by LRU caching on cache hits.
   *
   * @param node The existing node in the list to promote.
   */
  moveToHead(node: ListNode<T>): void {
    if (node === this.head) return;

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    if (node === this.tail) {
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    } else {
      this.tail = node;
    }

    this.head = node;
  }

  /**
   * Removes and returns the value at the head (front) of the list in O(1).
   *
   * @returns Value of the removed head node, or `null` if the list is empty.
   */
  shift(): T | null {
    if (!this.head) return null;
    const val = this.head.value;
    this.unlink(this.head);
    return val;
  }

  /**
   * Removes and returns the value at the tail (back) of the list in O(1).
   * Used for LRU eviction of the oldest entry.
   *
   * @returns Value of the removed tail node, or `null` if the list is empty.
   */
  pop(): T | null {
    if (!this.tail) return null;
    const val = this.tail.value;
    this.unlink(this.tail);
    return val;
  }

  /**
   * Decouples an arbitrary node from anywhere in the list in O(1) time.
   *
   * @param node The node to decouple.
   */
  unlink(node: ListNode<T>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;
    node.prev = null;
    node.next = null;
    this.size--;
  }

  /**
   * Clears all nodes from the list and resets size to 0.
   */
  clear(): void {
    this.head = null;
    this.tail = null;
    this.size = 0;
  }
}

/**
 * Binary Min-Heap priority queue used for scheduling delayed jobs by execution timestamp.
 *
 * @template T Type of items stored within the heap.
 */
export class MinHeap<T> {
  private tree: T[] = [];

  /**
   * @param scoreFn Function returning numeric ordering score (e.g. `job => job.runAt`).
   */
  constructor(private readonly scoreFn: (item: T) => number) {}

  /**
   * Total number of elements currently stored in the heap.
   */
  get size(): number {
    return this.tree.length;
  }

  /**
   * Inspects the lowest-scored (root) element without removing it.
   *
   * @returns The root item with the lowest score, or `null` if the heap is empty.
   */
  peek(): T | null {
    return this.tree[0] ?? null;
  }

  /**
   * Inserts an item into the heap and restores min-heap order via bubble-up in O(log N).
   *
   * @param item Item to insert.
   */
  push(item: T): void {
    this.tree.push(item);
    this.bubbleUp(this.tree.length - 1);
  }

  /**
   * Removes and returns the lowest-scored (root) element from the heap in O(log N).
   *
   * @returns The root item with the lowest score, or `null` if the heap is empty.
   */
  pop(): T | null {
    if (this.tree.length === 0) return null;
    const root = this.tree[0]!;
    const bottom = this.tree.pop()!;
    if (this.tree.length > 0) {
      this.tree[0] = bottom;
      this.sinkDown(0);
    }
    return root;
  }

  private bubbleUp(index: number): void {
    const element = this.tree[index]!;
    const score = this.scoreFn(element);

    while (index > 0) {
      const parentIdx = Math.floor((index - 1) / 2);
      const parent = this.tree[parentIdx]!;
      if (score >= this.scoreFn(parent)) break;
      this.tree[index] = parent;
      index = parentIdx;
    }
    this.tree[index] = element;
  }

  private sinkDown(index: number): void {
    const length = this.tree.length;
    const element = this.tree[index]!;
    const score = this.scoreFn(element);

    while (true) {
      const leftIdx = 2 * index + 1;
      const rightIdx = 2 * index + 2;
      let swapIdx: number | null = null;
      let leftScore = 0;

      if (leftIdx < length) {
        const left = this.tree[leftIdx]!;
        leftScore = this.scoreFn(left);
        if (leftScore < score) swapIdx = leftIdx;
      }

      if (rightIdx < length) {
        const right = this.tree[rightIdx]!;
        const rightScore = this.scoreFn(right);
        if (
          (swapIdx === null && rightScore < score) ||
          (swapIdx !== null && rightScore < leftScore)
        ) {
          swapIdx = rightIdx;
        }
      }

      if (swapIdx === null) break;
      this.tree[index] = this.tree[swapIdx]!;
      index = swapIdx;
    }
    this.tree[index] = element;
  }

  /**
   * Removes all items from the heap.
   */
  clear(): void {
    this.tree = [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. High-Performance Multi-Tier Cache Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Register interface reserved for declaration-merging / module augmentation
 * to assign types to specific global cache keys.
 */
export interface CacheRegister {}

/** Registered type mapping for global cache keys. */
export type RegisteredCache = CacheRegister;

/** Resolves the registered cache value type for a key, or `any` if unregistered. */
export type CacheValue<K extends string> = K extends keyof RegisteredCache
  ? RegisteredCache[K]
  : any;

/**
 * Serialization adapter interface for encoding and decoding values stored in L2 persistent cache.
 */
export interface CacheSerializer {
  /**
   * Serializes a value into a string for storage.
   * @param value Raw in-memory payload.
   */
  encode(value: unknown): string;

  /**
   * Deserializes a string from storage back into the typed payload.
   * @template T Expected return type.
   * @param raw Serialized string.
   */
  decode<T>(raw: string): T;
}

/** Standard JSON serializer used by default for L2 SQLite persistence. */
export const JSONSerializer: CacheSerializer = {
  encode: (val) => JSON.stringify(val),
  decode: (raw) => JSON.parse(raw),
};

/**
 * L2 persistence consistency mode:
 * - `"async"`: Writes to L2 in background without awaiting; fastest response (default).
 * - `"sync"`: Awaits L2 write before resolving `.set()`.
 */
export type CacheConsistency = "async" | "sync";

/**
 * Configuration options for storing entries in cache via `.set()` or `.remember()`.
 */
export interface SetOptions {
  /**
   * Time-to-live before entry expires (e.g. `"5m"`, `"1h"`, `300000`).
   *
   * Behavior:
   * - If omitted, falls back to the cache instance's configured `defaultTtl`.
   * - If explicitly `0` (or if instance has no default TTL), persists indefinitely (subject to LRU eviction).
   */
  ttl?: Duration;

  /**
   * Stale-While-Revalidate window (e.g. `"15m"`).
   *
   * During this grace period after TTL expiration:
   * - Calls return the stale cached value immediately.
   * - A background asynchronous refresh is triggered using the factory function in `.remember()`.
   */
  swr?: Duration;

  /**
   * Relational categorization tags for bulk invalidation (e.g. `["users", "org:123"]`).
   */
  tags?: string[];

  /**
   * Persistence consistency mode for writing to L2 cache.
   * - `"async"`: Non-blocking fire-and-forget write to L2 (default).
   * - `"sync"`: Awaits L2 write before completing `.set()`.
   * @default "async"
   */
  consistency?: CacheConsistency;
}

/**
 * Options for `.remember()` singleflight computation.
 */
export interface RememberOptions extends SetOptions {
  /**
   * When `true`, bypasses any existing cached or stale value and forces immediate execution of the factory.
   * @default false
   */
  force?: boolean;
}

/**
 * Performance metrics snapshot for {@link MemoryCacheEngine}.
 */
export interface CacheStats {
  /** Total successful cache lookups (fresh and SWR hits). */
  hits: number;
  /** Total cache misses (expired or missing keys). */
  misses: number;
  /** Total write operations performed. */
  writes: number;
  /** Total items evicted from L1 memory due to `maxItems` capacity limits. */
  evictions: number;
  /** Current count of active keys residing in L1 memory. */
  size: number;
  /** Ratio of hits to total lookups (0.0 to 1.0). */
  hitRatio: number;
}

interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  expiresAt: number | null;
  swrUntil: number | null;
  tags: Set<string>;
}

/**
 * Record retrieved from L2 persistent store.
 *
 * @template T Payload data type.
 */
export interface L2CacheRecord<T = unknown> {
  /** Deserialized payload value. */
  value: T;
  /** Absolute expiration epoch in milliseconds, or `null` if indefinite. */
  expiresAt: number | null;
}

/**
 * Storage interface for persistent L2 secondary cache adapters (e.g. SQLite, Redis).
 */
export interface L2CacheStore {
  /**
   * Retrieves a record by key.
   * @template T Deserialized value type.
   * @param key Unique cache key.
   */
  get<T>(key: string): Promise<L2CacheRecord<T> | null>;

  /**
   * Stores a record with TTL and relational tags.
   * @template T Deserialized value type.
   * @param key Unique cache key.
   * @param value Payload to store.
   * @param ttlMs Time-to-live in milliseconds from now.
   * @param tags Relational tags for group invalidation.
   */
  set<T>(key: string, value: T, ttlMs?: number, tags?: string[]): Promise<void>;

  /**
   * Deletes a key from storage.
   * @param key Unique cache key.
   */
  delete(key: string): Promise<void>;

  /**
   * Invalidates all keys matching any of the specified tags.
   * @param tags Array of tags to purge.
   * @returns Total number of rows/keys deleted.
   */
  invalidateTags(tags: string[]): Promise<number>;

  /**
   * Purges expired entries from storage.
   * @returns Total number of expired entries removed.
   */
  cleanupExpired(): Promise<number>;

  /**
   * Truncates all records from the L2 store.
   */
  clear(): Promise<void>;

  /**
   * Closes the underlying storage connection and terminates background timers.
   */
  close(): Promise<void>;
}

/**
 * Configuration options for initializing {@link MemoryCacheEngine}.
 */
export interface CacheOptions {
  /**
   * Maximum number of items in L1 memory before least-recently-used (LRU) eviction occurs.
   * @default 10000
   */
  maxItems?: number;

  /**
   * Default time-to-live duration applied to entries when `.set()` is called without an explicit TTL.
   * If omitted or 0, items persist indefinitely (subject to LRU memory limits).
   * @default 0
   */
  defaultTtl?: Duration;

  /**
   * Optional persistent L2 storage adapter (e.g. {@link SQLiteL2CacheStore}).
   */
  l2Storage?: L2CacheStore;

  /**
   * Serializer used for L2 encoding/decoding.
   * @default JSONSerializer
   */
  serializer?: CacheSerializer;
}

/**
 * High-Performance Multi-Tier Cache Engine.
 *
 * Features:
 * - O(1) in-memory L1 LRU caching backed by doubly linked list pointers.
 * - Optional durable L2 persistence with TTL-preserving backfill.
 * - Singleflight promise coalescing (prevents dog-piling / thundering herd on concurrent cache misses).
 * - Stale-While-Revalidate (SWR) support for instant reads with asynchronous refresh.
 * - Indexed relational tag invalidation.
 */
export class MemoryCacheEngine {
  private map = new Map<string, ListNode<CacheEntry>>();
  private list = new DoublyLinkedList<CacheEntry>();
  private tagIndex = new Map<string, Set<string>>();
  private inFlight = new Map<string, Promise<any>>();
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private evictions = 0;

  private readonly maxItems: number;
  private readonly defaultTtlMs: number;
  private readonly l2?: L2CacheStore;
  private readonly serializer: CacheSerializer;

  /**
   * @param options Cache configuration options.
   */
  constructor(options: CacheOptions = {}) {
    this.maxItems = options.maxItems ?? 10_000;
    this.defaultTtlMs = duration(options.defaultTtl, 0);
    this.l2 = options.l2Storage;
    this.serializer = options.serializer ?? JSONSerializer;
  }

  /**
   * Retrieves a cached value from L1 memory, or backfills from L2 preserving remaining TTL.
   * Automatically promotes hit entries to the head of the LRU eviction list.
   *
   * @template T The expected type of the cached value.
   * @param key Unique cache key.
   * @returns The cached value if present and unexpired; otherwise `null`.
   *
   * @example
   * ```ts
   * const user = await cache.get<User>("user:123");
   * if (!user) {
   *   // Cache miss
   * }
   * ```
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    const node = this.map.get(key);

    if (node) {
      const entry = node.value;
      const now = Date.now();

      // Check Expiration
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.deleteInternal(key);
        this.misses++;
        return null;
      }

      this.list.moveToHead(node);
      this.hits++;
      return entry.value as T;
    }

    // Try L2 Storage with TTL-preserving backfill
    if (this.l2) {
      const l2Record = await this.l2.get<T>(key);
      if (l2Record !== null) {
        const remainingTtl =
          l2Record.expiresAt !== null
            ? Math.max(0, l2Record.expiresAt - Date.now())
            : undefined;

        await this.set(key, l2Record.value, {
          ttl: remainingTtl,
          consistency: "async",
        });
        this.hits++;
        return l2Record.value;
      }
    }

    this.misses++;
    return null;
  }

  /**
   * Stores a value in L1 memory and optional L2 storage with TTL, SWR grace periods, and relational tags.
   *
   * @template T The value type.
   * @param key Unique cache key.
   * @param value Value to cache.
   * @param options Cache parameters (ttl, swr, tags, consistency).
   *
   * @example
   * ```ts
   * await cache.set("user:42", userData, {
   *   ttl: "15m",
   *   swr: "1h",
   *   tags: ["users", "user:42"],
   *   consistency: "async",
   * });
   * ```
   */
  async set<T = unknown>(
    key: string,
    value: T,
    options?: SetOptions,
  ): Promise<void> {
    const now = Date.now();
    const ttlMs =
      options?.ttl !== undefined ? duration(options.ttl) : this.defaultTtlMs;
    const expiresAt = ttlMs > 0 ? now + ttlMs : null;

    const swrMs = options?.swr !== undefined ? duration(options.swr) : 0;
    const swrUntil = expiresAt !== null && swrMs > 0 ? expiresAt + swrMs : null;

    const tags = new Set(options?.tags ?? []);

    if (this.map.has(key)) {
      this.deleteInternal(key);
    }

    // `maxItems: 0` would otherwise spin forever: the condition is true on an
    // empty list, and evictOldest() has nothing to remove, so no iteration ever
    // ends. A capacity of zero means "hold nothing", which is a legitimate (if
    // useless) configuration and must not hang.
    while (this.list.size >= this.maxItems && this.list.size > 0) {
      this.evictOldest();
    }

    const entry: CacheEntry = { key, value, expiresAt, swrUntil, tags };
    const node = this.list.prepend(entry);
    this.map.set(key, node);

    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }

    this.writes++;

    if (this.l2) {
      const consistency = options?.consistency ?? "async";
      if (consistency === "sync") {
        await this.l2.set(key, value, ttlMs, options?.tags);
      } else {
        this.l2.set(key, value, ttlMs, options?.tags).catch(console.error);
      }
    }
  }

  /**
   * Singleflight memoization with Stale-While-Revalidate (SWR) support.
   *
   * Execution Flow:
   * 1. **L1 Fresh Hit**: If key exists and `now <= expiresAt`, returns immediately.
   * 2. **SWR Grace Hit**: If expired but `now <= swrUntil`, returns the stale value immediately
   *    and triggers an asynchronous background execution of `factory` to refresh the entry.
   * 3. **Singleflight Miss**: If not cached or expired beyond SWR:
   *    - Coalesces concurrent calls to the same key into a single shared execution promise (prevents thundering herd).
   *    - Awaits `factory()`, sets L1/L2 cache, and returns the freshly produced value.
   *
   * @template T The value type.
   * @param key Unique cache key.
   * @param ttl Time-to-live duration string or milliseconds.
   * @param factory Asynchronous or synchronous producer function invoked on cache miss or SWR refresh.
   * @param options Additional options (`swr`, `tags`, `consistency`, `force`).
   * @returns The fresh or cached value.
   *
   * @example
   * ```ts
   * const profile = await cache.remember(`profile:${userId}`, "10m", async () => {
   *   return await fetchRemoteProfile(userId);
   * }, { swr: "1h", tags: ["profiles"] });
   * ```
   */
  async remember<T = unknown>(
    key: string,
    ttl: Duration,
    factory: () => Promise<T> | T,
    options?: Omit<RememberOptions, "ttl">,
  ): Promise<T> {
    if (!options?.force) {
      const existing = this.map.get(key);
      const now = Date.now();

      if (existing) {
        const entry = existing.value;

        // Fresh hit
        if (entry.expiresAt === null || now <= entry.expiresAt) {
          this.list.moveToHead(existing);
          this.hits++;
          return entry.value as T;
        }

        // SWR Hit: Return stale value immediately, refresh in background
        if (entry.swrUntil !== null && now <= entry.swrUntil) {
          this.triggerBackgroundRefresh(key, ttl, factory, options?.tags);
          this.hits++;
          return entry.value as T;
        }
      }
    }

    // Singleflight coalescing: exactly one execution runs
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)! as Promise<T>;
    }

    const task = (async () => {
      try {
        const fresh = await factory();
        await this.set(key, fresh, {
          ttl,
          swr: options?.swr,
          tags: options?.tags,
          consistency: options?.consistency,
        });
        return fresh;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  private triggerBackgroundRefresh(
    key: string,
    ttl: Duration,
    factory: () => any,
    tags?: string[],
  ): void {
    if (this.inFlight.has(key)) return;

    const task = (async () => {
      try {
        const fresh = await factory();
        await this.set(key, fresh, { ttl, tags });
      } catch (err) {
        console.error(
          `[Cache] Background SWR refresh failed for "${key}":`,
          err,
        );
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
  }

  /**
   * Deletes a specific key from L1 memory and L2 storage.
   *
   * @param key Key to remove.
   * @returns `true` if key was present in L1 memory.
   */
  async delete(key: string): Promise<boolean> {
    const existed = this.deleteInternal(key);
    if (this.l2) await this.l2.delete(key);
    return existed;
  }

  private deleteInternal(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;

    this.list.unlink(node);
    this.map.delete(key);

    for (const tag of node.value.tags) {
      const set = this.tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.tagIndex.delete(tag);
      }
    }
    return true;
  }

  /**
   * Evicts all keys associated with one or more tags across L1 memory and L2 persistent storage.
   *
   * @param tags Tag string or array of tag strings to invalidate.
   * @returns Total number of keys evicted from **L1 memory** (L2 records are removed concurrently).
   *
   * @example
   * ```ts
   * await cache.invalidateTags(["users", "user:42"]);
   * ```
   */
  async invalidateTags(tags: string | string[]): Promise<number> {
    const targetTags = Array.isArray(tags) ? tags : [tags];
    let evictedCount = 0;

    for (const tag of targetTags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        for (const key of Array.from(keys)) {
          if (this.deleteInternal(key)) evictedCount++;
        }
        this.tagIndex.delete(tag);
      }
    }

    if (this.l2) {
      await this.l2.invalidateTags(targetTags);
    }

    return evictedCount;
  }

  /**
   * Fluent helper targeting a specific tag or list of tags for group invalidation.
   *
   * @param tags Tag or array of tags.
   * @returns Object providing an `.invalidate()` method.
   *
   * @example
   * ```ts
   * await cache.tags("users").invalidate();
   * ```
   */
  tags(tags: string | string[]) {
    return {
      invalidate: () => this.invalidateTags(tags),
    };
  }

  private evictOldest(): void {
    if (!this.list.tail) return;
    const oldestKey = this.list.tail.value.key;
    this.deleteInternal(oldestKey);
    this.evictions++;
  }

  /**
   * Clears all keys, tags, and inflight tasks from L1 memory and wipes L2 persistent storage.
   */
  async clear(): Promise<void> {
    this.map.clear();
    this.list.clear();
    this.tagIndex.clear();
    this.inFlight.clear();
    if (this.l2) await this.l2.clear();
  }

  /**
   * Returns current cache performance metrics (hits, misses, hitRatio, size, evictions).
   *
   * @returns {@link CacheStats} metrics snapshot.
   */
  getMetrics(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      size: this.map.size,
      hitRatio: total > 0 ? this.hits / total : 0,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Persistent SQLite L2 Cache with Relational Tags & Sweeper
// ──────────────────────────────────────────────────────────────────────────

/**
 * Persistent SQLite-backed secondary cache (L2) with support for time-to-live (TTL),
 * relational tagging, cascading invalidations, and automatic periodic expiration cleanup.
 *
 * Configured with:
 * - `PRAGMA journal_mode = WAL;` (Concurrent reads while writing)
 * - `PRAGMA synchronous = NORMAL;` (High throughput with crash resilience)
 * - `PRAGMA foreign_keys = ON;` (Cascading tag deletes)
 *
 * @example
 * ```ts
 * const l2 = new SQLiteL2CacheStore("Database/cache.db");
 * await l2.set("user:123", { name: "Alice" }, 60_000, ["users"]);
 * const record = await l2.get("user:123");
 * ```
 */
export class SQLiteL2CacheStore implements L2CacheStore {
  private db: Database;
  private sweepTimer?: ReturnType<typeof setInterval>;

  /**
   * Initializes the SQLite L2 persistent cache store.
   *
   * @param dbPath File system path to the SQLite database (e.g. `"Database/cache.db"`), or `":memory:"` for tests.
   * @param serializer Serializer used for encoding and decoding stored objects. Defaults to {@link JSONSerializer}.
   * @param sweepIntervalMs Interval in milliseconds to run background expired cache sweeps. Set to 0 to disable. Defaults to 60,000ms (1 min).
   */
  constructor(
    dbPath = "Database/cache.db",
    private readonly serializer: CacheSerializer = JSONSerializer,
    sweepIntervalMs = 60_000,
  ) {
    const resolved =
      dbPath === ":memory:" ? ":memory:" : path.resolve(process.cwd(), dbPath);
    if (resolved !== ":memory:") {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolved, { create: true });
    // busy_timeout is set first and on its own connection setup, so that the
    // WAL switch below can wait for a lock instead of failing outright.
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.openWithRetry();

    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.cleanupExpired().catch(console.error);
      }, sweepIntervalMs);
    }
  }

  /**
   * Applies pragmas and creates the schema, retrying briefly on SQLITE_BUSY.
   *
   * Switching a database into WAL mode itself requires a lock, so it can fail
   * with SQLITE_BUSY when several worker threads open the same file at once —
   * before busy_timeout has any effect on the remaining DDL. Retrying the whole
   * open sequence (not just init) is what makes mounting `cache` reliable.
   */
  private openWithRetry(attempts = 6): void {
    try {
      this.db.run("PRAGMA journal_mode = WAL;");
      this.db.run("PRAGMA foreign_keys = ON;");
      this.db.run("PRAGMA busy_timeout = 5000;");
      this.db.run("PRAGMA synchronous = NORMAL;");
      this.init();
    } catch (err: any) {
      const busy =
        err?.code === "SQLITE_BUSY" ||
        /database is locked|database table is locked/i.test(String(err?.message));

      if (!busy || attempts <= 1) throw err;

      // Short, escalating backoff. This runs once at construction, before the
      // store is serving traffic, so a synchronous wait is acceptable.
      const delay = 20 * (7 - attempts);
      const until = Date.now() + delay;
      while (Date.now() < until) {
        /* wait for the competing connection to finish */
      }
      this.openWithRetry(attempts - 1);
    }
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "_yatta_cache" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
    `);

    // Indexed relational tag table for genuine O(K) invalidation
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "_yatta_cache_tags" (
        tag TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        PRIMARY KEY(tag, cache_key),
        FOREIGN KEY(cache_key) REFERENCES "_yatta_cache"(key) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS "idx_yatta_cache_expires" 
      ON "_yatta_cache"(expires_at);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS "idx_yatta_cache_tags_tag" 
      ON "_yatta_cache_tags"(tag);
    `);
  }

  /**
   * Retrieves a cached value and its expiration metadata from SQLite.
   * If the record has expired, it is deleted automatically and `null` is returned.
   *
   * @template T The expected deserialized value type.
   * @param key Unique cache key.
   * @returns Deserialized {@link L2CacheRecord} if found and valid, otherwise `null`.
   */
  async get<T>(key: string): Promise<L2CacheRecord<T> | null> {
    const now = Date.now();
    const row = this.db
      .prepare(
        `
      SELECT value, expires_at FROM "_yatta_cache" WHERE key = ?
    `,
      )
      .get(key) as any;

    if (!row) return null;
    if (row.expires_at !== null && now > row.expires_at) {
      this.delete(key);
      return null;
    }

    return {
      value: this.serializer.decode<T>(row.value),
      expiresAt: row.expires_at,
    };
  }

  /**
   * Writes a value into SQLite with optional TTL and relational tags.
   *
   * @template T The value type.
   * @param key Unique cache key.
   * @param value Value to serialize and store.
   * @param ttlMs Time-to-live in milliseconds from now (optional).
   * @param tags Array of tags for grouped invalidation (optional).
   */
  async set<T>(
    key: string,
    value: T,
    ttlMs?: number,
    tags?: string[],
  ): Promise<void> {
    const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null;
    const rawVal = this.serializer.encode(value);

    this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO "_yatta_cache" (key, value, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at
      `,
        )
        .run(key, rawVal, expiresAt);

      if (tags && tags.length > 0) {
        this.db
          .prepare(`DELETE FROM "_yatta_cache_tags" WHERE cache_key = ?`)
          .run(key);
        const insertTag = this.db.prepare(
          `INSERT OR IGNORE INTO "_yatta_cache_tags" (tag, cache_key) VALUES (?, ?)`,
        );
        for (const t of tags) insertTag.run(t, key);
      }
    })();
  }

  /**
   * Removes a cached entry from SQLite by key.
   * Associated relational tag entries are removed automatically via cascade delete.
   *
   * @param key Cache key to delete.
   */
  async delete(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM "_yatta_cache" WHERE key = ?`).run(key);
  }

  /**
   * Evicts all cache keys linked to any of the specified tags.
   *
   * @param tags Array of tag identifiers to invalidate.
   * @returns Total number of cache keys deleted.
   */
  async invalidateTags(tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;
    const placeholders = tags.map(() => "?").join(",");

    const res = this.db
      .prepare(
        `
      DELETE FROM "_yatta_cache"
      WHERE key IN (
        SELECT cache_key FROM "_yatta_cache_tags" WHERE tag IN (${placeholders})
      )
    `,
      )
      .run(...tags);

    return res.changes;
  }

  /**
   * Manually sweeps and deletes all expired keys from SQLite.
   *
   * @returns Total number of expired entries purged.
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    const res = this.db
      .prepare(
        `
      DELETE FROM "_yatta_cache"
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `,
      )
      .run(now);
    return res.changes;
  }

  /**
   * Deletes all records from the L2 cache table.
   */
  async clear(): Promise<void> {
    this.db.run(`DELETE FROM "_yatta_cache";`);
  }

  /**
   * Stops the background sweeper timer and closes the underlying SQLite database connection.
   */
  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.db.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Genuine O(1) Memory Queue Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Represents the current execution lifecycle state of a queued job:
 * - `"queued"`: Ready and waiting in a priority bucket to be claimed by a worker.
 * - `"delayed"`: Scheduled for future execution in the delayed min-heap.
 * - `"running"`: Claimed by a worker with an active expiring lease.
 * - `"completed"`: Finished execution successfully.
 * - `"dead"`: Retries exhausted; moved to the dead-letter queue (DLQ).
 */
export type JobState = "queued" | "delayed" | "running" | "completed" | "dead";

/**
 * Retry and backoff configuration for failed jobs.
 */
export interface RetryPolicy {
  /**
   * Backoff strategy:
   * - `"exponential"`: Delay increases exponentially (`delay * factor ^ attempt`).
   * - `"fixed"`: Delay remains constant (`delay`).
   */
  type: "exponential" | "fixed";
  /** Initial delay duration in milliseconds before the first retry attempt. */
  delay: number;
  /** Exponential multiplier factor (e.g. `2` for doubling delay each attempt). */
  factor: number;
  /** Whether to apply random jitter to prevent the "thundering herd" problem. */
  jitter: boolean;
  /** Maximum upper bound in milliseconds for any retry delay. */
  maxDelay: number;
}

/**
 * Serialized error details saved onto failed or dead jobs for inspection and debugging.
 */
export interface SerializedError {
  /** Error message string. */
  message: string;
  /** Error stack trace if available. */
  stack?: string;
  /** Error code or category identifier. */
  code?: string;
}

/**
 * Complete record of a background job managed by a {@link JobStore}.
 *
 * @template TData The payload data type.
 * @template TResult The return result type upon successful completion.
 */
export interface JobRecord<TData = unknown, TResult = unknown> {
  /** Unique job identifier. */
  id: string;
  /** Target queue name (e.g. `"email"`, `"image-processing"`). */
  queue: string;
  /** Descriptive job action or task name. */
  name: string;
  /** Input payload data passed into the job. */
  data: TData;
  /** Current job lifecycle state. */
  state: JobState;
  /** Number of execution attempts completed so far. */
  attempts: number;
  /** Maximum attempts permitted before the job is moved to the dead-letter state. */
  maxAttempts: number;
  /** Numerical priority (higher values run first: 3 = critical, 2 = high, 1 = normal, 0 = low). */
  priority: number;
  /** Scheduled execution timestamp in milliseconds since epoch (`Date.now()`). */
  runAt: number;
  /** Maximum execution time allowed before the lease expires or the job times out (in milliseconds). */
  timeout?: number;
  /** Retry and backoff policy applied upon execution failure. */
  retry: RetryPolicy;
  /** Active worker lease metadata while in the `"running"` state. */
  lease?: {
    /** Identifier of the worker holding the lock. */
    workerId: string;
    /** Timestamp when the lease was claimed. */
    acquiredAt: number;
    /** Timestamp when the lease expires if not renewed via heartbeat. */
    expiresAt: number;
  };
  /** Execution completion percentage (0 - 100). */
  progress: number;
  /** Human-readable status update or progress message. */
  progressMessage?: string;
  /** The output result produced upon successful job completion. */
  result?: TResult;
  /** Serialized error details if the job failed or died. */
  error?: SerializedError;
  /** Unique deduplication key preventing duplicate concurrent enqueuing within the same queue. */
  uniqueKey?: string;
  /** Timestamp when the job was initially created. */
  createdAt: number;
  /** Timestamp when the job was last updated or changed state. */
  updatedAt: number;
}

/**
 * Real-time queue operational metrics by job state.
 */
export interface QueueMetrics {
  /** Count of jobs ready and waiting to be processed. */
  queued: number;
  /** Count of jobs scheduled for future execution. */
  delayed: number;
  /** Count of jobs currently claimed and being processed by workers. */
  running: number;
  /** Count of successfully processed jobs. */
  completed: number;
  /** Count of jobs in the dead-letter queue (exhausted retries). */
  dead: number;
  /** Total count of all jobs across all states. */
  total: number;
}

/**
 * Storage and state-management interface for job queues.
 * Implemented by in-memory stores (like {@link MemoryQueueO1}) and persistent database backends.
 */
export interface JobStore {
  /** Initializes database schemas, tables, and indexes for queue persistence. */
  init(): Promise<void>;

  /**
   * Enqueues a new job into the queue or delayed heap.
   * If a uniqueKey is provided and an active job with that key exists, the existing record is returned.
   *
   * @param job Job specifications without generated timestamps and initial state.
   * @returns The newly created or existing {@link JobRecord}.
   */
  enqueue(
    job: Omit<JobRecord, "attempts" | "state" | "createdAt" | "updatedAt">,
  ): Promise<JobRecord>;

  /**
   * Atomically claims the next highest-priority ready job in the specified queue.
   *
   * @param queue Target queue name.
   * @param workerId Unique identifier of the requesting worker.
   * @param lockDurationMs Lease duration in milliseconds before the job can be reclaimed if lost.
   * @returns Claimed {@link JobRecord} with active lease, or `null` if no ready jobs exist.
   */
  claimNext(
    queue: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<JobRecord | null>;

  /**
   * Renews the active lease for a currently running job to prevent premature reclamation.
   *
   * @param id Job ID.
   * @param workerId Worker holding the lease.
   * @param lockDurationMs Milliseconds to extend the lock by.
   * @returns `true` if heartbeat succeeded; `false` if job was lost or lease mismatch.
   */
  heartbeat(
    id: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<boolean>;

  /**
   * Updates execution progress and optional status message for a running job.
   *
   * @param id Job ID.
   * @param progress Percentage complete (0 - 100).
   * @param message Optional progress description.
   */
  updateProgress(
    id: string,
    progress: number,
    message?: string,
    workerId?: string,
  ): Promise<void>;

  /**
   * Marks a job as completed and stores its result.
   *
   * @param id Job ID.
   * @param result Optional returned value from the job handler.
   * @param workerId When given, the update is rejected unless this worker still
   *   holds the lease. A worker whose lease expired and whose job was reclaimed
   *   must not be able to complete the re-queued copy — that runs the job twice.
   */
  complete(id: string, result?: unknown, workerId?: string): Promise<boolean>;

  /**
   * Marks a job as failed, scheduling a retry or moving it to dead-letter state.
   *
   * @param id Job ID.
   * @param error Serialized error object.
   * @param nextRunAt Optional scheduled timestamp for retry.
   * @param dead Whether all retry attempts are exhausted.
   * @param workerId When given, the update is rejected unless this worker still
   *   holds the lease. See {@link JobStore.complete}.
   */
  fail(
    id: string,
    error: SerializedError,
    nextRunAt?: number,
    dead?: boolean,
    workerId?: string,
  ): Promise<boolean>;

  /**
   * Reclaims running jobs whose leases expired or became orphaned back to the queued state.
   *
   * @param staleThresholdMs Time elapsed in milliseconds before a running job is deemed abandoned.
   * @returns Total number of reclaimed jobs.
   */
  reclaimStaleJobs(staleThresholdMs: number): Promise<number>;

  /**
   * Returns a running job to `queued` without consuming an attempt or applying
   * backoff.
   *
   * For an infrastructural stop — worker shutdown, lost lease — rather than a
   * failure of the work. See the note on {@link JobStore.release}.
   *
   * @param id Job ID.
   * @param workerId Releasing worker, when it still holds the lease.
   * @returns `true` if the job was released.
   */
  release(id: string, workerId?: string): Promise<boolean>;

  /**
   * Fetches a job record by ID.
   *
   * @param id Job ID.
   * @returns The {@link JobRecord}, or `null` if not found.
   */
  getJob(id: string): Promise<JobRecord | null>;

  /**
   * Returns current queue volume metrics.
   *
   * @param queue Optional queue name filter.
   * @returns {@link QueueMetrics} counts.
   */
  getMetrics(queue?: string): Promise<QueueMetrics>;

  /**
   * Retrieves jobs currently residing in the dead-letter queue.
   *
   * @param queue Optional queue name filter.
   * @param limit Maximum number of records to return. Defaults to 50.
   * @returns List of dead {@link JobRecord}s.
   */
  listDead(queue?: string, limit?: number): Promise<JobRecord[]>;

  /**
   * Requeues a dead job for execution, resetting attempts and clearing errors.
   *
   * @param id Job ID.
   * @returns `true` if replayed, `false` if not found or not in dead state.
   */
  replayDead(id: string): Promise<boolean>;

  /**
   * Purges jobs from the queue.
   *
   * @param queue Queue name.
   * @param state Optional state filter to only purge jobs in a specific state.
   * @returns Count of purged jobs.
   */
  purgeQueue(queue: string, state?: JobState): Promise<number>;

  /**
   * Shuts down the store and releases held resources.
   */
  close(): Promise<void>;
}

/**
 * True O(1) in-memory job queue with discrete priority buckets:
 * - Data Structure: `Map<QueueName, Map<Priority, DoublyLinkedList<JobRecord>>>`
 * - ClaimNext: Checks discrete priority levels `[3, 2, 1, 0]` for the specific target queue in strict O(1).
 * - Delayed Scheduler: Min-Heap with lazy deletion protecting against ghost jobs.
 * - Deduplication: O(1) unique-key lookup ensuring single active job per key.
 */
export class MemoryQueueO1 implements JobStore {
  // queue -> (priorityTier -> DoublyLinkedList)
  private queues = new Map<string, Map<number, DoublyLinkedList<JobRecord>>>();

  private activeNodes = new Map<
    string,
    { node: ListNode<JobRecord>; queue: string; priority: number }
  >();
  private allJobs = new Map<string, JobRecord>();
  private uniqueKeys = new Map<string, string>(); // `${queue}:${uniqueKey}` -> id
  private delayedHeap = new MinHeap<JobRecord>((j) => j.runAt);

  /**
   * Initializes the in-memory queue store (no-op for memory implementation).
   */
  async init(): Promise<void> {}

  private getQueueBucket(
    queue: string,
    priority: number,
  ): DoublyLinkedList<JobRecord> {
    let priorityMap = this.queues.get(queue);
    if (!priorityMap) {
      priorityMap = new Map();
      this.queues.set(queue, priorityMap);
    }
    let list = priorityMap.get(priority);
    if (!list) {
      list = new DoublyLinkedList<JobRecord>();
      priorityMap.set(priority, list);
    }
    return list;
  }

  /**
   * Enqueues a new job into the appropriate priority bucket or delayed min-heap.
   * Deduplicates against existing queued/delayed/running jobs if `uniqueKey` is specified.
   *
   * @param job Partial job definition without timestamps and initial state.
   * @returns Newly scheduled or existing matching {@link JobRecord}.
   */
  async enqueue(
    job: Omit<JobRecord, "attempts" | "state" | "createdAt" | "updatedAt">,
  ): Promise<JobRecord> {
    const now = Date.now();

    /*
     * Reusing an id that is still live created a ghost: the map entry was
     * overwritten while the original node stayed in its bucket, so
     * `activeNodes` tracked a node holding a record that was no longer the one
     * `getJob` returned. The old node could then be shifted and executed.
     *
     * Returning the existing record matches what `uniqueKey` already does, and
     * makes the call idempotent, which is what a caller supplying its own id
     * almost always wants.
     */
    const duplicate = this.allJobs.get(job.id);
    if (duplicate) return { ...duplicate };

    if (job.uniqueKey) {
      const uKey = `${job.queue}:${job.uniqueKey}`;
      const existingId = this.uniqueKeys.get(uKey);
      if (existingId) {
        const existing = this.allJobs.get(existingId);
        if (
          existing &&
          (existing.state === "queued" ||
            existing.state === "delayed" ||
            existing.state === "running")
        ) {
          return { ...existing };
        }
      }
    }

    const state: JobState = job.runAt > now ? "delayed" : "queued";
    const record: JobRecord = {
      ...job,
      priority: parsePriority(job.priority),
      state,
      attempts: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.allJobs.set(record.id, record);
    if (job.uniqueKey)
      this.uniqueKeys.set(`${job.queue}:${job.uniqueKey}`, record.id);

    if (state === "delayed") {
      this.delayedHeap.push(record);
    } else {
      const bucket = this.getQueueBucket(record.queue, record.priority);
      const node = bucket.append(record);
      this.activeNodes.set(record.id, {
        node,
        queue: record.queue,
        priority: record.priority,
      });
    }

    // A copy, so a caller mutating the result cannot corrupt the store. The
    // node keeps the live record.
    return { ...record };
  }

  /**
   * Promotes delayed jobs using Lazy Deletion:
   * Discards cancelled or purged jobs on pop before enqueueing to active buckets.
   */
  private promoteDelayed(): void {
    const now = Date.now();
    while (this.delayedHeap.size > 0) {
      const top = this.delayedHeap.peek()!;
      if (top.runAt > now) break;

      const readyJob = this.delayedHeap.pop()!;

      // Lazy deletion guard: discard ghost jobs
      if (this.allJobs.get(readyJob.id) !== readyJob) continue;
      if (readyJob.state !== "delayed") continue;

      readyJob.state = "queued";
      readyJob.updatedAt = now;
      const bucket = this.getQueueBucket(readyJob.queue, readyJob.priority);
      const node = bucket.append(readyJob);
      this.activeNodes.set(readyJob.id, {
        node,
        queue: readyJob.queue,
        priority: readyJob.priority,
      });
    }
  }

  /**
   * Strict O(1) Queue Claim:
   * Directly targets the specific queue and pops from the first non-empty priority bucket.
   *
   * @param queue Target queue name.
   * @param workerId Claiming worker ID.
   * @param lockDurationMs Lock duration in milliseconds.
   * @returns Claimed {@link JobRecord} or `null` if none available.
   */
  async claimNext(
    queue: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<JobRecord | null> {
    this.promoteDelayed();
    const now = Date.now();

    const priorityMap = this.queues.get(queue);
    if (!priorityMap) return null;

    // Checks [3, 2, 1, 0]: exactly 4 fixed checks
    for (const priority of PRIORITY_LEVELS) {
      const bucket = priorityMap.get(priority);
      if (!bucket || bucket.size === 0) continue;

      // A node can still be sitting in a bucket after its job was completed,
      // failed or purged elsewhere — reclaimed-then-completed is the case that
      // runs a job twice. Skip until a genuinely queued job is found.
      let job: JobRecord | null = null;
      while (bucket.size > 0) {
        const candidate = bucket.shift()!;
        this.activeNodes.delete(candidate.id);

        if (candidate.state === "queued") {
          job = candidate;
          break;
        }
        // Stale node: it is no longer ours to hand out.
      }
      if (!job) continue;

      job.state = "running";
      job.attempts++;
      job.lease = {
        workerId,
        acquiredAt: now,
        expiresAt: now + lockDurationMs,
      };
      job.updatedAt = now;
      return { ...job };
    }

    return null;
  }

  /**
   * Renews the active worker lease for a running job.
   *
   * @param id Job ID.
   * @param workerId ID of worker holding current lease.
   * @param lockDurationMs Lease extension in milliseconds.
   * @returns `true` if lease renewed, `false` otherwise.
   */
  async heartbeat(
    id: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<boolean> {
    const j = this.allJobs.get(id);
    if (!j || j.state !== "running" || j.lease?.workerId !== workerId)
      return false;
    j.lease.expiresAt = Date.now() + lockDurationMs;
    j.updatedAt = Date.now();
    return true;
  }

  /**
   * Updates progress and status message for a running job.
   *
   * @param id Job ID.
   * @param progress Progress percentage (0 - 100).
   * @param message Optional status message.
   */
  async updateProgress(
    id: string,
    progress: number,
    message?: string,
    workerId?: string,
  ): Promise<void> {
    const j = this.allJobs.get(id);
    if (j && !this.owns(j, workerId)) return;
    if (j) {
      j.progress = progress;
      j.progressMessage = message;
      j.updatedAt = Date.now();
    }
  }

  /**
   * Whether `workerId` may still mutate this job.
   *
   * The job must be running, and — when a worker is named — that worker must
   * hold the lease. Without this a worker whose lease expired can complete or
   * fail the copy that was already reclaimed and re-queued, which runs the job
   * a second time and, on failure, leaves it in a bucket and the delayed heap
   * at once.
   *
   * `workerId` is optional so administrative callers keep working; they are
   * trusted, and the running-state check still applies.
   */
  private owns(job: JobRecord, workerId?: string): boolean {
    // No worker named: an administrative caller (DLQ replay, a management
    // endpoint), trusted to act on any state. Requiring "running" there would
    // make it impossible to dead-letter or release a job that was never
    // claimed.
    if (workerId === undefined) return true;

    // A worker may only touch the job while it holds the lease.
    return job.state === "running" && job.lease?.workerId === workerId;
  }

  /**
   * Marks a job completed and records its return result.
   *
   * @param id Job ID.
   * @param result Returned output value.
   */
  async complete(id: string, result?: unknown, workerId?: string): Promise<boolean> {
    const j = this.allJobs.get(id);
    if (!j || !this.owns(j, workerId)) return false;

    j.state = "completed";
    j.progress = 100;
    j.result = result;
    j.lease = undefined;
    j.updatedAt = Date.now();
    // Only release the key if it still points here. A completed job whose key
    // was already claimed by a newer job must not delete the new job's dedup
    // entry.
    if (j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === j.id) {
      this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
    }
    return true;
  }

  /**
   * Handles job failure, updating retry state or moving to the dead-letter queue.
   *
   * @param id Job ID.
   * @param error Serialized error object.
   * @param nextRunAt Timestamp to re-attempt execution.
   * @param dead Whether retries have been exhausted.
   */
  async fail(
    id: string,
    error: SerializedError,
    nextRunAt?: number,
    dead = false,
    workerId?: string,
  ): Promise<boolean> {
    const j = this.allJobs.get(id);
    if (!j || !this.owns(j, workerId)) return false;

    j.state = dead ? "dead" : "delayed";
    j.error = error;
    j.runAt = nextRunAt ?? Date.now();
    j.lease = undefined;
    j.updatedAt = Date.now();

    if (dead) {
      if (j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === j.id) {
        this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
      }
    } else {
      this.delayedHeap.push(j);
    }
    return true;
  }

  /**
   * Resets abandoned running jobs back to queued, and sends exhausted ones to
   * the dead-letter state.
   *
   * Lease expiry is the only staleness signal. An earlier version also
   * reclaimed on `acquiredAt` being older than the threshold, which never
   * cleared for a long job: `heartbeat` only pushes `expiresAt` forward, so any
   * job running longer than the threshold was reclaimed and duplicated while
   * heartbeating perfectly. Pass the threshold a worker should hold a lease
   * for; the size of that lease is what bounds how long a dead worker is
   * tolerated.
   *
   * A job that has used up its attempts goes to `dead` rather than back to
   * queued, otherwise a job that crashes its worker every time is reclaimed
   * forever and never reaches the dead-letter queue.
   *
   * @param staleThresholdMs Retained for interface compatibility; lease expiry
   *   alone determines staleness.
   * @returns Total number of jobs whose state changed.
   */
  async reclaimStaleJobs(_staleThresholdMs: number): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const j of this.allJobs.values()) {
      if (j.state !== "running") continue;
      if (j.lease && j.lease.expiresAt > now) continue;

      j.lease = undefined;
      j.updatedAt = now;

      if (j.attempts >= j.maxAttempts) {
        j.state = "dead";
        if (j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === j.id) {
          this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
        }
        count++;
        continue;
      }

      j.state = "queued";
      const bucket = this.getQueueBucket(j.queue, j.priority);
      const node = bucket.append(j);
      this.activeNodes.set(j.id, { node, queue: j.queue, priority: j.priority });
      count++;
    }

    return count;
  }

  /**
   * Returns a running job to queued without consuming an attempt.
   *
   * The node is put back in its priority bucket, so another worker can claim
   * it immediately rather than waiting for the next stale sweep.
   */
  async release(id: string, workerId?: string): Promise<boolean> {
    const j = this.allJobs.get(id);
    if (!j || !this.owns(j, workerId)) return false;

    j.state = "queued";
    j.lease = undefined;
    j.updatedAt = Date.now();

    // Already back in a bucket (reclaimed already): nothing to re-append.
    if (this.activeNodes.has(id)) return true;

    const bucket = this.getQueueBucket(j.queue, j.priority);
    const node = bucket.append(j);
    this.activeNodes.set(id, { node, queue: j.queue, priority: j.priority });
    return true;
  }

  /**
   * Retrieves a job record by ID.
   *
   * @param id Job ID.
   * @returns A copy of the {@link JobRecord} or `null` if not found.
   */
  async getJob(id: string): Promise<JobRecord | null> {
    return this.allJobs.get(id) ? { ...this.allJobs.get(id)! } : null;
  }

  /**
   * Returns current job counts partitioned by state.
   *
   * @param queue Optional queue name filter.
   * @returns {@link QueueMetrics} counts.
   */
  async getMetrics(queue?: string): Promise<QueueMetrics> {
    let queued = 0,
      delayed = 0,
      running = 0,
      completed = 0,
      dead = 0,
      total = 0;

    for (const j of this.allJobs.values()) {
      if (queue && j.queue !== queue) continue;
      total++;
      if (j.state === "queued") queued++;
      else if (j.state === "delayed") delayed++;
      else if (j.state === "running") running++;
      else if (j.state === "completed") completed++;
      else if (j.state === "dead") dead++;
    }

    return { queued, delayed, running, completed, dead, total };
  }

  /**
   * Lists jobs in the dead-letter queue.
   *
   * @param queue Optional queue filter.
   * @param limit Maximum results to return (default: 50).
   * @returns Array of dead {@link JobRecord}s.
   */
  async listDead(queue?: string, limit = 50): Promise<JobRecord[]> {
    return [...this.allJobs.values()]
      .filter((j) => j.state === "dead" && (!queue || j.queue === queue))
      .slice(0, limit);
  }

  /**
   * Resurrects a dead-letter job and requeues it for execution.
   *
   * @param id Job ID to replay.
   * @returns `true` if replayed, `false` if not dead or not found.
   */
  async replayDead(id: string): Promise<boolean> {
    const j = this.allJobs.get(id);
    if (!j || j.state !== "dead") return false;

    j.state = "queued";
    j.attempts = 0;
    j.error = undefined;
    j.runAt = Date.now();
    j.updatedAt = Date.now();

    const bucket = this.getQueueBucket(j.queue, j.priority);
    const node = bucket.append(j);
    this.activeNodes.set(j.id, { node, queue: j.queue, priority: j.priority });

    // Do not steal a key that another live job already owns, or the replayed
    // job and the current one both look deduplicated.
    if (j.uniqueKey) {
      const uKey = `${j.queue}:${j.uniqueKey}`;
      const owner = this.uniqueKeys.get(uKey);
      if (owner === undefined || owner === j.id) this.uniqueKeys.set(uKey, j.id);
    }
    return true;
  }

  /**
   * Purges all jobs for a queue, optionally filtered by state.
   *
   * @param queue Target queue name.
   * @param state Optional lifecycle state to purge.
   * @returns Count of removed jobs.
   */
  async purgeQueue(queue: string, state?: JobState): Promise<number> {
    let removed = 0;
    for (const [id, j] of this.allJobs.entries()) {
      if (j.queue === queue && (!state || j.state === state)) {
        const active = this.activeNodes.get(id);
        if (active) {
          this.queues
            .get(active.queue)
            ?.get(active.priority)
            ?.unlink(active.node);
          this.activeNodes.delete(id);
        }

        this.allJobs.delete(id);
        // Ownership-checked: purging an old job must not release a key a newer
        // job has since claimed.
        if (j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === id) {
          this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
        }
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clears all jobs, queues, priority buckets, and indices from memory.
   */
  async close(): Promise<void> {
    this.queues.clear();
    this.activeNodes.clear();
    this.allJobs.clear();
    this.uniqueKeys.clear();
    this.delayedHeap.clear();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Singleton & Factories
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_CACHE_KEY = Symbol.for("yatta.cache.default");

const g = globalThis as unknown as {
  [GLOBAL_CACHE_KEY]?: MemoryCacheEngine;
};

/**
 * Creates an independent {@link MemoryCacheEngine} instance with custom configuration.
 *
 * @param options Cache configuration (maxItems, defaultTtl, l2Storage, serializer).
 * @returns Configured {@link MemoryCacheEngine}.
 *
 * @example
 * ```ts
 * import { createCache, SQLiteL2CacheStore } from "./cache_queue";
 *
 * const userCache = createCache({
 *   maxItems: 10_000,
 *   defaultTtl: "30m",
 *   l2Storage: new SQLiteL2CacheStore("Database/users_cache.db"),
 * });
 *
 * await userCache.set("user:42", { name: "Bob" }, { swr: "5m" });
 * ```
 */
export function createCache(options?: CacheOptions): MemoryCacheEngine {
  return new MemoryCacheEngine(options);
}

function getDefaultCache(): MemoryCacheEngine {
  if (!g[GLOBAL_CACHE_KEY]) {
    g[GLOBAL_CACHE_KEY] = new MemoryCacheEngine({
      maxItems: 50_000,
      defaultTtl: "1h",
      l2Storage: new SQLiteL2CacheStore(),
    });
  }
  return g[GLOBAL_CACHE_KEY]!;
}

/**
 * Global default {@link MemoryCacheEngine} proxy singleton.
 *
 * Provides a zero-configuration cache equipped with:
 * - High-speed L1 LRU memory storage (up to 50,000 items)
 * - Persistent SQLite L2 backing (`Database/cache.db`)
 * - Singleflight promise coalescing (`.remember()`)
 * - Grouped relational tag invalidation (`Cache.invalidateTags(...)`)
 * - Stale-While-Revalidate (SWR) background updates
 *
 * @example
 * ```ts
 * import { Cache } from "./cache_queue";
 *
 * // 1. Standard get/set
 * await Cache.set("profile:123", { name: "Alice" }, { ttl: "15m", tags: ["users"] });
 * const user = await Cache.get("profile:123");
 *
 * // 2. Coalesced remember with SWR
 * const product = await Cache.remember("product:99", "1h", async () => {
 *   return await db.products.find(99);
 * }, { swr: "15m", tags: ["products"] });
 *
 * // 3. Invalidate by tag
 * await Cache.invalidateTags(["users"]);
 * ```
 */
export const Cache: MemoryCacheEngine = new Proxy(
  function () {} as unknown as MemoryCacheEngine,
  {
    get(_t, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_t, prop, receiver);
      }
      const instance = getDefaultCache();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);
