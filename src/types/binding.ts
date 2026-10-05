// The shared reactive contract every framework binding is built on.
//
// Nine frameworks would otherwise mean nine implementations of "load this, tell
// me when it changes" — nine places for the caching and de-duplication rules to
// differ, and they always differ. So the behaviour lives here once, and each
// binding is only the connection between "the store changed" and that framework's
// idea of re-rendering.
//
// One rule shapes the design: a bound call reads its value from the store when it
// is read, never from a copy it kept. A copy is only as current as the last
// notification, so a framework that batches, coalesces or drops a notification
// silently serves stale data — and the bug appears as a rendering difference on
// one device and not another.

import type { CallState, CallStore } from "../react/universal-hooks";

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * The route a method came from, used as the key's prefix.
 *
 * The derived methods are named after their routes, so this is the route name.
 * Two routes cannot collide under one key — which matters, because a key built
 * from arguments alone would let one route serve another's cached value.
 */
export function methodName(method: unknown): string {
  // A string is a route name. Accepted because `routePrefix` takes one, and a key
  // helper that silently produced "unknown:{}" for it made every hand-computed key
  // wrong in a way nothing reported.
  if (typeof method === "string") return method;
  if (typeof method !== "function") return "unknown";
  return method.name || "anonymous";
}

/**
 * Serialises arguments so key order does not matter.
 *
 * `{ id: "1", q: 2 }` and `{ q: 2, id: "1" }` are the same call. Keying them
 * differently makes a component refetch whenever its parent reorders a literal.
 *
 * The non-plain cases are handled explicitly, because `Object.entries` sees them as
 * empty and every one of them silently becomes `"{}"`:
 *
 *   - A `Date` has no own enumerable properties, so two *different* dates produced
 *     the same key. Every date-range query then shared one cache entry and returned
 *     whichever date happened to be cached first.
 *   - A `RegExp` and a `Map` or `Set` have the same problem.
 *   - A circular structure recursed until the stack overflowed, which took down
 *     the render that built the arguments.
 *
 * `undefined` and `{}` are the same call, so an omitted argument does not fork the
 * key.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "{}";
  if (value === null) return "null";

  const type = typeof value;

  if (type === "string") return JSON.stringify(value);
  if (type === "number" || type === "boolean") return String(value);
  if (type === "bigint") return `"${value.toString()}"`;
  if (type === "function" || type === "symbol") {
    // Not serialisable, but they can legally appear in an argument object. Named so
    // two different functions do not collide, and so a caller can see which it was.
    return `"[${type}:${String(value)}]"`;
  }

  // A Date is checked before the object branch, where it would flatten to "{}".
  if (value instanceof Date) {
    return `"${Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()}"`;
  }

  if (value instanceof RegExp) return JSON.stringify(value.toString());
  if (value instanceof URL) return JSON.stringify(value.toString());
  if (value instanceof Map) return stableStringify([...value.entries()]);
  if (value instanceof Set) return stableStringify([...value.values()]);

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  // Cycle detection. A `seen` set that is removed on the way out catches a cycle
  // without treating a value repeated in two sibling positions as circular — which
  // a shared set would, and would then throw on an entirely ordinary object.
  return stringifyObject(value as Record<string, unknown>, new Set<object>());
}

function stringifyObject(value: Record<string, unknown>, seen: Set<object>): string {
  if (seen.has(value)) {
    // Rendered rather than thrown. A cycle in an argument object is unusual but not
    // fatal, and refusing to build a key would break the render that produced it.
    // "[Circular]" keeps it distinct from every other shape.
    return `"[Circular:${Object.keys(value).length}]"`;
  }

  seen.add(value);

  try {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifyNested(v, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * The nested case, with the cycle set carried down.
 *
 * It cannot just call `stableStringify`, because that starts a fresh set and a
 * cycle two levels deep would not be seen. It cannot just check "is it an object"
 * either — that skips the Date, RegExp, Map and Set branches, which is how a
 * nested date came back as "{}" and two different dates shared a key.
 */
function stringifyNested(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value !== "object") return stableStringify(value);

  // Built-ins are leaves. A Date nested in an object is the common case here.
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof URL ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return stableStringify(value);
  }

  if (Array.isArray(value)) return `[${value.map((v) => stringifyNested(v, seen)).join(",")}]`;

  return stringifyObject(value as Record<string, unknown>, seen);
}

/** The key one call is stored under: its route and its arguments. */
export function callKey<TArgs>(method: unknown, args: TArgs | undefined): string {
  return `${methodName(method)}:${stableStringify(args)}`;
}

// ── Binding ────────────────────────────────────────────────────────────────

/**
 * A bound call.
 *
 * Reads through to the store, so `state` is correct whether or not a notification
 * has arrived yet.
 */
export interface BoundCall<T> {
  readonly state: CallState<T>;
  /** Starts the load. Returns a teardown; does nothing if already started. */
  start(): () => void;
  /** Reloads, ignoring any cached value. */
  refetch(): void;
  /** Writes a value without a request, for an optimistic update. */
  set(updater: T | ((previous: T | undefined) => T)): void;
}

export interface BindOptions {
  /**
   * Skip the load without tearing anything down, for an argument that is not
   * ready yet. `enabled: false` does not start and reports `fetching: false`, so
   * a caller can tell "not asked" from "asked and still going".
   */
  enabled?: boolean;
  /** Overrides the derived key. Used by the mutation paths. */
  key?: string;
  /**
   * Cancels the request.
   *
   * Forwarded to `fetch` on the HTTP path, and readable from `ctx.signal` in a
   * direct call. Without it, a component whose arguments change mid-flight cannot
   * abandon the answers nobody is waiting for — the work still runs and still
   * occupies a connection.
   */
  signal?: AbortSignal;
}

/**
 * Binds one call to a store.
 *
 * `start` is separate because a binding is built during a render, and a render must
 * not do work — that is what makes it safe to render many times, and what stops a
 * Server Component from multiplying requests.
 *
 * @param store Where results live. Per request on a server, shared in a browser.
 * @param method The route's method, taken from the app.
 * @param args Its arguments. Part of the key, so different arguments never share.
 */
export function bind<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args: TArgs | undefined,
  options: BindOptions = {},
): BoundCall<T> {
  const key = options.key ?? callKey(method, args);
  const enabled = options.enabled ?? true;

  // A single flag rather than a boolean per bind call site. `start` returning a
  // no-op teardown is simpler than making every caller check.
  let started = false;

  return {
    get state(): CallState<T> {
      return store.get<T>(key);
    },

    start() {
      if (started || !enabled) return () => {};
      started = true;

      void store.resolve(key, () => method(args));

      return () => {};
    },

    refetch() {
      if (!enabled) return;
      void store.resolve(key, () => method(args), { force: true });
    },

    set(updater) {
      store.set(key, updater);
    },
  };
}

// ── Framework subscription ─────────────────────────────────────────────────

/**
 * How a binding is told the store changed.
 *
 * One operation: register a callback and get back an unsubscribe.
 */
export interface Binding {
  subscribe(notify: () => void): () => void;
}

/**
 * Shares one framework subscription across many subscribers.
 *
 * Written this way because the alternative — one subscription per component — is
 * a subscription per component on the same store, which is what a framework
 * charges for.
 *
 * @param track Starts the framework subscription and returns its teardown.
 */
export function makeBinding(track: (notify: () => void) => void | (() => void)): Binding {
  const listeners = new Set<() => void>();
  let teardown: (() => void) | undefined;

  return {
    subscribe(notify) {
      listeners.add(notify);

      if (listeners.size === 1) {
        teardown =
          track(() => {
            // Copied before iterating: a listener that unsubscribes during a
            // notification would otherwise mutate the set being walked.
            for (const listener of [...listeners]) listener();
          }) ?? undefined;
      }

      /*
       * Teardown is checked on *every* unsubscribe, not only the first one's.
       *
       * It used to hang off the first subscriber's returned function alone, so the
       * subscription closed only if that particular subscriber happened to leave
       * last. Any other order left the framework subscription running for the life
       * of the page — a watcher nobody owned, firing on every store change.
       */
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          teardown?.();
          teardown = undefined;
        }
      };
    },
  };
}

/** A binding that never notifies: correct on a server, where nothing updates. */
export function serverBinding(): Binding {
  return { subscribe: () => () => {} };
}

/**
 * Subscribes to one call's changes.
 *
 * The one thing every framework binding does. Returns the current state
 * immediately, so a subscriber never renders one frame against an empty cache.
 *
 * Filtered to the key, and gated on the state actually having changed.
 *
 * Without either, the store's subscribe is global: one mutation anywhere woke every
 * mounted component, each allocated a fresh state object, and each re-rendered. On a
 * page with fifty calls that is fifty renders to change one, and the reason a small
 * change could be felt as a janky one.
 */
export function watchCall<T>(
  store: CallStore,
  key: string,
  onChange: (state: CallState<T>) => void,
): () => void {
  let last = store.get<T>(key);

  onChange(last);

  return store.subscribe((changed?: string) => {
    // A keyed store can say what changed. One that cannot is filtered here.
    if (typeof changed === "string" && changed !== key) return;

    const next = store.get<T>(key);
    if (sameState(last, next)) return;

    last = next;
    onChange(next);
  });
}

/**
 * Whether two states are indistinguishable to a reader.
 *
 * Compared field by field, because the store hands out a fresh object on every
 * write: an identity check would report a change on every notification and defeat
 * the whole point of the filter above.
 */
export function sameState<T>(a: CallState<T>, b: CallState<T>): boolean {
  return (
    a.data === b.data &&
    a.error === b.error &&
    a.fetching === b.fetching &&
    a.stale === b.stale
  );
}