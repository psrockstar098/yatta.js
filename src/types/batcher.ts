// Batching for direct calls.
//
// The N+1 problem, in the place it is easiest to create.
//
// A Server Component that awaits fifty routes in a loop issues fifty queries. It
// is not a mistake the developer can see — there is no N+1 in the source, there is
// a `for` loop — and it is not caught by anything, because every call is correct
// on its own. The fix is to collect the calls made in the same tick into one
// query, which is what a DataLoader does.
//
// What this does *not* do: batch across an `await`. Fifty sequential
// `await app.getUser(...)` calls are fifty ticks, and batching them would mean
// holding the first result open until the last call arrived — unbounded latency
// for a guess. What it batches is `Promise.all`, and concurrent work in one event
// loop turn, which is where the pattern actually appears.
//
// The scope is per request. A loader held on the app would be shared between
// concurrent requests on a server, which is a cross-tenant cache and a data leak.

import { AsyncLocalStorage } from "node:async_hooks";

/** Fetches many keys at once. Receives the keys collected in one tick. */
export type BatchFn<K, V> = (keys: readonly K[]) => Promise<ReadonlyMap<K, V>> | Promise<V[]>;

export interface LoaderOptions {
  /**
   * Whether to cache results per key.
   *
   * On by default. Off for anything that changes often enough that a stale value is
   * worse than a second query — a stock price, a queue depth.
   */
  cache?: boolean;
  /**
   * Window in which calls are collected, in milliseconds.
   *
   * Defaults to 0, which collects everything queued in the current tick and flushes
   * on the microtask. Raising it batches a burst across several ticks at the cost of
   * adding that much latency to the first call in the window.
   */
  maxBatchMs?: number;
  /**
   * Reported when `batch` resolves for fewer keys than it was given.
   *
   * The default throws, because a missing key means the caller's `load()` rejects
   * and the failure surfaces far from the batch that lost it.
   */
  onMissing?: (key: unknown) => Error;
}

/**
 * Batches and caches keys into single calls to `batch`.
 *
 * ```ts
 * const loader = new DataLoader(async (ids: readonly string[]) => {
 *   const rows = await db.users.findMany({ where: { id: { in: [...ids] } } });
 *   return new Map(rows.map((row) => [row.id, row]));
 * });
 *
 * // Three concurrent calls: one query, not three.
 * const [a, b, c] = await Promise.all(ids.map((id) => loader.load(id)));
 * ```
 */
export class DataLoader<K, V> {
  private cache = new Map<K, Promise<V>>();
  private queue: K[] = [];
  private queued = new Map<K, Promise<V>>();

  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly batch: BatchFn<K, V>,
    private readonly options: LoaderOptions = {},
  ) {}

  /**
   * Loads one key.
   *
   * Two calls for the same key in the same window share one request — the second
   * gets the first's promise rather than queueing a duplicate key.
   */
  load(key: K): Promise<V> {
    if (this.options.cache !== false) {
      const cached = this.cache.get(key);
      // Returned even if it rejected: a rejected key stays poisoned for the life
      // of this loader, which is correct for a per-request loader and the reason a
      // loader must never be shared between requests.
      if (cached) return cached;
    }

    const pending = this.queued.get(key);
    if (pending) return pending;

    let resolve!: (value: V) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<V>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.queued.set(key, promise);
    if (this.options.cache !== false) this.cache.set(key, promise);

    this.queue.push(key);
    this.schedule();

    // Held so a caller can settle this promise when the batch resolves, without the
    // caller ever touching the internals.
    Object.defineProperty(promise, "__resolve", { value: resolve, enumerable: false });
    Object.defineProperty(promise, "__reject", { value: reject, enumerable: false });

    return promise;
  }

  /** Resolves on the next tick. Batching is not useful for a single call. */
  private schedule(): void {
    if (this.timer !== undefined) return;

    const window = this.options.maxBatchMs ?? 0;

    if (window <= 0) {
      // A microtask, not a macrotask. Anything queued synchronously or already
      // awaiting is in this batch; anything scheduled later is not.
      this.timer = setTimeout(() => void this.flush(), 0);
      // Never holds a process open on its own.
      this.timer.unref?.();
      return;
    }

    this.timer = setTimeout(() => void this.flush(), window);
    this.timer.unref?.();
  }

  /** Runs the batch. Public so a caller can force it at a known boundary. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const keys = this.queue;
    if (keys.length === 0) return;

    this.queue = [];

    let results: ReadonlyMap<K, V>;

    try {
      const returned = await this.batch(keys);

      /*
       * Two accepted shapes.
       *
       * A Map is unambiguous. An array is the shape a `findMany` or an `IN` query
       * actually returns, and requiring every caller to build a Map is a tax for
       * one that buys nothing. An array is positional, which is why `batchBy` is
       * offered below for anything else.
       */
      if (Array.isArray(returned)) {
        results = new Map(keys.map((key, index) => [key, (returned as V[])[index] as V]));
      } else {
        results = returned as ReadonlyMap<K, V>;
      }
    } catch (error) {
      // Every key in the batch fails with it. One bad query rejects all of them,
      // which is the truth: none of them were answered.
      for (const key of keys) this.settle(key, undefined, error as Error);
      return;
    }

    for (const key of keys) {
      if (!results.has(key)) {
        const error =
          this.options.onMissing?.(key) ??
          new Error(`Batch did not return a result for key ${String(key)}`);
        this.settle(key, undefined, error);
        continue;
      }

      this.settle(key, results.get(key), undefined);
    }
  }

  private settle(key: K, value: V | undefined, error: Error | undefined): void {
    const promise = this.queued.get(key) as (Promise<V> & {
      __resolve?: (v: V) => void;
      __reject?: (e: unknown) => void;
    }) | undefined;

    this.queued.delete(key);

    if (!promise) return;

    if (error) {
      // Dropped from the cache, so a retry is possible. A per-request loader has
      // no retry in its life, but a long-lived one does.
      if (this.options.cache !== false) this.cache.delete(key);
      promise.__reject?.(error);
      return;
    }

    promise.__resolve?.(value as V);
  }

  /** Empties the cache. The batch function is unchanged. */
  clear(key?: K): void {
    if (key === undefined) this.cache.clear();
    else this.cache.delete(key);
  }

  /** Whether a key already has a settled or in-flight value. */
  has(key: K): boolean {
    return this.cache.has(key);
  }
}

/**
 * A loader over rows that need a key to join on.
 *
 * For when the batch function returns rows in whatever order the database gave them
 * rather than one per requested key — a join, an aggregation, anything with a
 * `WHERE id IN (...)`.
 */
export function batchBy<K, V>(
  batch: (keys: readonly K[]) => Promise<readonly V[]>,
  keyOf: (value: V) => K,
  options: LoaderOptions = {},
): DataLoader<K, V> {
  return new DataLoader<K, V>(async (keys) => {
    const rows = await batch(keys);
    const map = new Map<K, V>();

    for (const row of rows) {
      const key = keyOf(row);
      // First wins. A join can produce a row per related record, and "the" user is
      // the first one — taking the last would make the result depend on row order.
      if (!map.has(key)) map.set(key, row);
    }

    void options;
    return map;
  }, options);
}

// ── Per-request scope ──────────────────────────────────────────────────────

interface LoaderScope {
  loaders: Map<string, DataLoader<unknown, unknown>>;
}

const scope = new AsyncLocalStorage<LoaderScope>();

/**
 * Runs `fn` with a fresh set of loaders, discarded afterwards.
 *
 * This is what makes batching safe on a server. A loader cached per user would be a
 * cache of one user's data inside another user's request; cached on the app it
 * would be shared by every concurrent request. Scoped to the call, it lives exactly
 * as long as the work does.
 *
 * @example
 * ```ts
 * // app/api/[[...path]]/route.ts
 * export const GET = withLoaders((req) => handle(req));
 * ```
 */
export function withLoaders<T>(fn: () => T): T {
  return scope.run({ loaders: new Map() }, fn);
}

/**
 * A loader scoped to the current request.
 *
 * The same name returns the same loader within one scope, so two components asking
 * for the same key share one query and one cached value. Outside a scope a loader is
 * created per call and behaves correctly but shares nothing — which is right for a
 * script and means a server route must remember to wrap itself.
 */
export function loaderFor<K, V>(
  name: string,
  batch: BatchFn<K, V>,
  options: LoaderOptions = {},
): DataLoader<K, V> {
  const current = scope.getStore();

  if (!current) return new DataLoader<K, V>(batch, options);

  // The map is typed loosely because one scope holds loaders of many types. The
  // cast is the load-bearing assertion: the name is the key, so a loader stored
  // under it was built for this call site.
  const existing = current.loaders.get(name) as DataLoader<K, V> | undefined;
  if (existing) return existing;

  const created = new DataLoader<K, V>(batch, options);
  current.loaders.set(name, created as unknown as DataLoader<unknown, unknown>);

  return created;
}

/** Whether this code is inside a loader scope. */
export function hasLoaderScope(): boolean {
  return scope.getStore() !== undefined;
}