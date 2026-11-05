// Cache decorator / wrapper sugar over the existing cache engine.
//
// This module adds no cache of its own. Every call goes through
// `MemoryCacheEngine.remember`, so TTL, stale-while-revalidate, singleflight,
// L1/L2 tiers and tag invalidation all behave exactly as they do when the
// engine is used directly. What this adds is only the key building and the
// call shape: wrap a function once, and later calls with the same arguments
// hit the engine instead of running the function again.
//
// Security notes, kept next to the code that enforces them:
// - TTL is required. An omitted TTL must never mean "cache forever", so a
//   decorator without one is a construction error, not a silent default.
// - The default key is a hash of the arguments, not the arguments
//   themselves. Keys are stored in the L2 database, so raw argument values
//   (which may include identifiers or other sensitive input) must not
//   become stored key text.
// - The default key does NOT know who is calling. If the result depends on
//   the caller, the instance, or the tenant, and the arguments do not carry
//   that identity, two callers share one entry and one of them reads the
//   other's result. Use `key` or `scope` to put the identity in the key,
//   or do not cache that function. See the docs draft for examples.

import crypto from "node:crypto";

import {
  CacheError,
  type Duration,
  type MemoryCacheEngine,
} from "./cache_queue";

/**
 * Options for `wrapCached` and `cacheMethod`.
 *
 * `ttl` is required on purpose: see the security note at the top of this file.
 */
export interface CachedFunctionOptions {
  /** Time-to-live for each entry, for example `"5m"` or `300_000`. */
  ttl: Duration;

  /**
   * Stale-while-revalidate grace period after TTL expiry. During it the
   * stale value is returned while a background refresh runs. Leave unset
   * for data that must never be served stale.
   */
  swr?: Duration;

  /**
   * Tags attached to every entry this function produces. Either a fixed
   * list, or a function of the call arguments (so one call can be tagged
   * `user:42` and invalidated on its own). Tag invalidation then goes
   * through the normal engine path: `cache.invalidateTags("user:42")`.
   */
  tags?: string[] | ((...args: never[]) => string[]);

  /**
   * Cache key override. A string is treated as a prefix: the hashed
   * arguments are still appended, so different arguments never share an
   * entry. A function returns the full key and owns uniqueness — return a
   * different key for every distinct result, including the caller or
   * tenant identity when the result depends on it.
   */
  key?: string | ((...args: never[]) => string);

  /**
   * Extra namespace prepended to the key, for example a tenant id. A
   * function receives the call arguments. Prefer this over hand-building
   * keys when the same function serves more than one tenant.
   */
  scope?: string | ((...args: never[]) => string);

  /** Prefix for the default key. Defaults to the wrapped function's name. */
  prefix?: string;

  /** The engine to delegate to. Also accepted as the third argument. */
  cache?: MemoryCacheEngine;
}

/** A function whose result is cached by `wrapCached`. */
export type CachedFunction<Args extends unknown[], T> = (
  ...args: Args
) => Promise<T>;

/**
 * Builds the default cache key for a call: `prefix:sha256(arguments)`.
 *
 * Hashing (rather than joining the arguments) keeps argument values out
 * of the stored key. Two calls with the same arguments produce the same
 * key; two calls with different arguments do not, up to hash collision.
 *
 * A value `JSON.stringify` cannot represent — a circular object, a
 * function, a symbol — is refused instead of silently mapping onto some
 * other call's key. Dropping such a value would be a collision: two
 * different calls would read one entry.
 */
export function defaultCacheKey(
  prefix: string,
  args: unknown[],
): string {
  let serialized: string;
  try {
    // A replacer, so the erasure above is fixed at every depth, not just
    // the top level: { x: NaN } and { x: null } must not share a key,
    // and { f: someFunction } must not share one with {}.
    serialized =
      JSON.stringify(args, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          return `\u0000num:${String(value)}`;
        }
        if (typeof value === "function") return "\u0000fn";
        if (typeof value === "symbol") return "\u0000sym";
        if (value === undefined) return "\u0000undef";
        return value;
      }) ?? "null";
  } catch {
    throw new CacheError(
      "Cannot build a cache key: an argument cannot be serialized. " +
        "Pass an explicit `key` function that names the call instead.",
    );
  }
  // JSON.stringify drops functions and undefined array items, so calls
  // that differ only in those would collide. Mark their positions so
  // they stay distinct keys instead of silently sharing an entry.
  const shape = args
    .map((arg) => {
      // JSON.stringify erases more than functions: NaN, Infinity and
      // -Infinity all serialize as `null`, and -0 as `0`. Without this
      // shape, fn(NaN) and fn(null) would share one entry and one of
      // them would read the other's result.
      if (typeof arg === "number") {
        if (Number.isNaN(arg)) return "nan";
        if (arg === Infinity) return "inf";
        if (arg === -Infinity) return "-inf";
        if (Object.is(arg, -0)) return "negzero";
        return "num";
      }
      if (typeof arg === "function") return "fn";
      if (arg === undefined) return "undef";
      if (typeof arg === "symbol") return "sym";
      return "val";
    })
    .join(",");
  const digest = crypto
    .createHash("sha256")
    .update(`${shape}:${serialized}`)
    .digest("hex");
  return `${prefix}:${digest}`;
}

/** Resolves the key for one call from the options and the arguments. */
export function resolveCacheKey(
  options: CachedFunctionOptions,
  fnName: string,
  args: unknown[],
): string {
  if (typeof options.key === "function") {
    const key = (options.key as (...a: unknown[]) => string)(...args);
    if (typeof key !== "string" || key.length === 0) {
      throw new CacheError(
        "Cache key function must return a non-empty string.",
      );
    }
    return key;
  }
  const prefix = options.key ?? options.prefix ?? fnName;
  const scope =
    typeof options.scope === "function"
      ? (options.scope as (...a: unknown[]) => string)(...args)
      : options.scope;
  const base = defaultCacheKey(prefix, args);
  return scope ? `${scope}:${base}` : base;
}

function resolveTags(
  tags: CachedFunctionOptions["tags"],
  args: unknown[],
): string[] | undefined {
  if (typeof tags === "function") {
    return (tags as (...a: unknown[]) => string[])(...args);
  }
  return tags;
}

function requireTtl(options: CachedFunctionOptions): void {
  // Enforced here, not left to the engine: the engine treats an omitted
  // TTL as "use the engine default, or never expire", which is exactly
  // the silent-forever outcome this decorator must not produce.
  if (options.ttl === undefined || options.ttl === null) {
    throw new CacheError(
      "Cache TTL is required: pass `ttl` (for example `ttl: \"5m\"`). " +
        "A decorator without one would cache forever by accident.",
    );
  }
}

function resolveEngine(
  options: CachedFunctionOptions,
  engine?: MemoryCacheEngine,
): MemoryCacheEngine {
  const resolved = engine ?? options.cache;
  if (!resolved) {
    throw new CacheError(
      "A cache engine is required: pass it as the third argument or as " +
        "`options.cache`. There is no implicit global engine, so importing " +
        "this module never opens a database.",
    );
  }
  return resolved;
}

/**
 * Wraps an async (or sync) function so its result is cached in the given
 * engine. The first call runs the function; later calls with the same key
 * return the cached value without running it again, until the TTL expires.
 *
 * Failures are never cached: the engine only stores a value the function
 * actually returned, so a thrown error leaves nothing behind for the
 * next call to read.
 */
export function wrapCached<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T> | T,
  options: CachedFunctionOptions,
  engine?: MemoryCacheEngine,
): CachedFunction<Args, T> {
  requireTtl(options);
  const cache = resolveEngine(options, engine);
  const name = fn.name || "fn";
  return async (...args: Args): Promise<T> => {
    const key = resolveCacheKey(options, name, args);
    return cache.remember(
      key,
      options.ttl,
      () => fn(...args),
      { swr: options.swr, tags: resolveTags(options.tags, args) },
    );
  };
}

/**
 * Method decorator form of `wrapCached`, for class methods.
 *
 * This is the classic decorator shape — `(target, propertyKey, descriptor)`
 * — so it needs the classic decorator setting where it is used. Applied
 * without decorator syntax it is just a function call (see the tests),
 * which works in any setup.
 *
 * The default key is `ClassName.method:hash(args)`. It does not include
 * the instance: if the result depends on instance state, pass a `key`
 * function that reads it (the function receives the instance as its last
 * argument via `this`, see the docs draft), or wrap the method with
 * `wrapCached` per instance instead.
 */
export function cacheMethod(
  options: CachedFunctionOptions,
  engine?: MemoryCacheEngine,
) {
  requireTtl(options);
  const cache = resolveEngine(options, engine);
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (
      ...args: never[]
    ) => Promise<unknown> | unknown;
    if (typeof original !== "function") {
      throw new CacheError(
        `Cannot cache ${String(propertyKey)}: it is not a method.`,
      );
    }
    const className = target.constructor?.name ?? "Class";
    const name = `${className}.${String(propertyKey)}`;
    descriptor.value = async function (
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      // A key function for a method receives the instance as `this` and
      // the arguments after it, so it can include an instance id.
      const key =
        typeof options.key === "function"
          ? (options.key as (...a: unknown[]) => unknown).apply(this, args)
          : resolveCacheKey(options, name, args);
      if (typeof key !== "string" || key.length === 0) {
        throw new CacheError(
          "Cache key function must return a non-empty string.",
        );
      }
      return cache.remember(
        key,
        options.ttl,
        () => (original as (...a: never[]) => unknown).apply(this, args),
        { swr: options.swr, tags: resolveTags(options.tags, args) },
      );
    };
    return descriptor;
  };
}

/** Alias matching the `@cache` name used in the feature description. */
export const cache = cacheMethod;
