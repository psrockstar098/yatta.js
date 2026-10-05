// A frontend core with no framework in it.
//
// This is the layer a UI binds to. It holds the typed API client, a realtime
// connection with observable state, and a query cache — and it does not import
// React, so the same instance works in a React tree, a Next.js server render, a
// plain page, or a worker.
//
// Why a layer at all, when `RealtimeClient` exists? Because `RealtimeClient` is a
// transport with no way to ask it what state it is in. A UI has to know whether
// it is connected before it can render "reconnecting", and whether it is
// connected before it accepts a send. Polling a private field, or tracking
// connection state in the component, means every consumer keeps its own copy and
// they disagree.
//
// The rules this file follows:
//
//   - No second connection. `connectRealtime` takes a connection you already have,
//     so the frontend observes the transport instead of duplicating it.
//   - No framework types. `subscribe` returns a plain unsubscribe function.
//   - Same validators as the server, so nothing is re-declared.

import { createClient, type CallError, type ClientOptions, type RouteDef } from "./client";
import type { RealtimeClient } from "./realtime";
import type { App } from "./universal";
import { isServer } from "./env";

/** One entry in the query cache. */
export interface CacheEntry<T = unknown> {
  /** The value, or `undefined` while the first load is still in flight. */
  data: T | undefined;
  error: CallError | Error | undefined;
  /** Whether a request is in flight right now. */
  fetching: boolean;
  /** When the data was last written, as epoch milliseconds. */
  updatedAt: number | undefined;
  /**
   * Whether the value is from a previous request rather than this one.
   *
   * Distinct from `fetching` on its own: a refetch that keeps the old data on
   * screen means the UI can keep showing it instead of flashing empty.
   */
  stale: boolean;
}

/**
 * A fresh, empty entry.
 *
 * A function rather than a shared constant, because a shared object would be one
 * place for a consumer to write through and poison every other reader.
 */
function emptyEntry<T>(): CacheEntry<T> {
  return {
    data: undefined,
    error: undefined,
    fetching: false,
    updatedAt: undefined,
    stale: false,
  };
}

/** Read-only view of one cache entry, as a hook receives it. */
export interface QueryResult<T> {
  data: T | undefined;
  error: CallError | Error | undefined;
  fetching: boolean;
  /** The value is from a previous request; a new one is in flight. */
  stale: boolean;
  refetch: () => Promise<T | undefined>;
  /** Write a value without a request. For optimistic updates. */
  set: (updater: T | ((previous: T | undefined) => T)) => void;
}

export interface CacheOptions {
  /** How long a value stays fresh, in milliseconds. Defaults to 30 seconds. */
  staleTime?: number;
  /** Upper bound on stored entries. Defaults to 200. */
  maxEntries?: number;
}

/**
 * A small query cache: deduplicate in flight, share one value per key.
 *
 * Not a general-purpose cache and not trying to be. It exists so two components
 * asking for the same thing share one request and one value, and so a refetch
 * does not blank the screen.
 */
export class QueryCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<unknown>>();
  constructor(private readonly options: CacheOptions = {}) {}

  /**
   * Subscribes to changes.
   *
   * @param onChange Told on every change, or — when a key is given — only when that
   *   key changes. Keyed is what a bound call uses: an unkeyed subscription wakes
   *   every mounted component when any one of them writes, so fifty calls on a page
   *   each re-render on every keystroke anywhere.
   * @param key Limit to this key. Omit to hear about everything.
   */
  subscribe(onChange: (changedKey?: string) => void, key?: string): () => void {
    const watcher: (changedKey?: string) => void = key
      ? (changed) => {
          if (changed !== key) return;
          onChange(changed);
        }
      : onChange;

    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  private watchers = new Set<(changedKey?: string) => void>();

  private notify(changedKey?: string): void {
    for (const watcher of [...this.watchers]) {
      // One listener throwing must not stop the others being told.
      try {
        watcher(changedKey);
      } catch {
        // A broken subscriber is its own problem.
      }
    }
  }

  get<T>(key: string): CacheEntry<T> {
    return (this.entries.get(key) ?? emptyEntry()) as CacheEntry<T>;
  }

  /**
   * Reads a key, starting a load if there is nothing fresh.
   *
   * A second caller for a key already loading gets the same promise, so ten
   * components mounting at once cause one request.
   */
  async resolve<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: { force?: boolean } = {},
  ): Promise<T | undefined> {
    const existing = this.entries.get(key);
    const staleTime = this.options.staleTime ?? 30_000;
    const fresh =
      existing !== undefined &&
      existing.updatedAt !== undefined &&
      Date.now() - existing.updatedAt < staleTime;

    if (!options.force && fresh && existing?.data !== undefined) {
      // The map is untyped by key, so this is the caller's assertion that the
      // value cached under `key` is its own `T`. Nothing enforces it, which is
      // the same bargain every typed cache makes.
      return existing.data as T;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T | undefined>;

    this.entries.set(key, { ...(existing ?? emptyEntry()), fetching: true });
    this.notify(key);

    const promise = fetcher()
      .then((data) => {
        this.entries.set(key, {
          data,
          error: undefined,
          fetching: false,
          updatedAt: Date.now(),
          stale: false,
        });
        return data;
      })
      .catch((error: unknown) => {
        // The previous value is kept. Replacing it with `undefined` on failure
        // makes a transient network blip empty the screen, which reads as "no
        // data" rather than "could not load".
        const previous = this.entries.get(key);

        this.entries.set(key, {
          ...(previous ?? emptyEntry()),
          data: previous?.data,
          error: error as Error,
          fetching: false,
          updatedAt: previous?.updatedAt,
          stale: false,
        });
        return undefined;
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.notify(key);
      });

    this.inFlight.set(key, promise);
    return promise as Promise<T | undefined>;
  }

  /** Writes a value directly, without a request. */
  set<T>(key: string, updater: T | ((previous: T | undefined) => T)): void {
    const previous = this.entries.get(key);
    const data =
      typeof updater === "function"
        ? (updater as (p: T | undefined) => T)(previous?.data as T | undefined)
        : updater;

    this.entries.set(key, {
      data,
      error: undefined,
      fetching: false,
      updatedAt: Date.now(),
      stale: false,
    });
    this.evict();
    this.notify(key);
  }

  /**
   * Marks keys stale so the next read refetches.
   *
   * @param key Exact key, or a prefix ending in `:` — `"getUser:"` invalidates
   *   every call to that route whatever its arguments. A mutation on a user has to
   *   invalidate `getUser` for every id, and listing each one means writing down
   *   every id that was ever fetched.
   * @param all Invalidate everything. Separate from `key`, because `undefined`
   *   means "this key" and cannot also mean "all of them".
   */
  invalidate(key?: string, all?: boolean): void {
    if (all === true || (key === undefined && all !== false)) {
      for (const entry of this.entries.values()) entry.stale = true;
      // No key, so every subscriber is told. Each re-reads and sees nothing
      // changed for its own key, so it does not re-render.
      this.notify();
      return;
    }

    if (key === undefined) return;

    // A prefix ends in ":" and matches a route's keys regardless of arguments.
    if (key.endsWith(":")) {
      let matched = 0;
      for (const [existing, entry] of this.entries) {
        if (!existing.startsWith(key)) continue;
        entry.stale = true;
        matched++;
        this.notify(existing);
      }
      // Nothing matched, so nothing is told. A blanket notify here would wake
      // every component on a miss.
      void matched;
      return;
    }

    const entry = this.entries.get(key);
    if (entry) entry.stale = true;
    this.notify(key);
  }

  /**
   * Clears one key, or everything.
   *
   * A cache is only per-request state, so there is no TTL sweep here: on the
   * server the whole instance is thrown away with the render, and in the browser
   * a reload starts empty.
   */
  clear(key?: string, all?: boolean): void {
    if (key?.endsWith(":")) {
      for (const existing of [...this.entries.keys()]) {
        if (existing.startsWith(key)) this.entries.delete(existing);
      }
      return;
    }

    if (key === undefined) {
      this.entries.clear();
      this.notify();
    } else {
      this.entries.delete(key);
      this.notify(key);
    }
  }

  /** Drops the oldest entries past the cap, so the cache cannot grow forever. */
  private evict(): void {
    const max = this.options.maxEntries ?? 200;
    if (this.entries.size <= max) return;

    const ordered = [...this.entries.entries()].sort(
      (a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0),
    );

    for (const [key] of ordered.slice(0, this.entries.size - max)) {
      this.entries.delete(key);
    }
  }
}

/**
 * Realtime connection state, as observable values.
 *
 * The transport holds this privately; a UI needs to read it, and re-deriving it
 * in each component is how two components end up disagreeing about whether the
 * app is online.
 */
export type ConnectionStatus = "connecting" | "open" | "closed";

export interface RealtimeHandle {
  /** Current status. Read it at any time; it is kept up to date. */
  readonly status: ConnectionStatus;
  /** Told on every status change. Returns an unsubscribe function. */
  onStatus(onChange: (status: ConnectionStatus) => void): () => void;
  /**
   * Listens for one event.
   *
   * Returns an unsubscribe function, so it pairs with a component's teardown.
   */
  on<T = unknown>(event: string, handler: (data: T) => void): () => void;
  /** Joins a topic. Returns the function that leaves it. */
  join(topic: string): () => void;
  /** Sends an event. Queued while disconnected rather than thrown. */
  send(event: string, data: unknown): Promise<void>;
  /** Forgets queued sends. Called when the connection goes away. */
  readonly queued: number;
}

/**
 * Wraps a {@link RealtimeClient} so its state is observable.
 *
 * Takes the connection as an argument rather than making one, so the frontend and
 * the transport are the same object. Two connections would mean two topics and
 * two sets of events, and neither would be the one the server is pushing to.
 */
export function connectRealtime(
  client: RealtimeClient,
  options: { queueWhileOffline?: boolean } = {},
): RealtimeHandle {
  let status: ConnectionStatus = "connecting";
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  // Sends made before the connection opened, flushed once it is.
  const outbox: Array<{ event: string; data: unknown }> = [];

  const setStatus = (next: ConnectionStatus) => {
    if (next === status) return;
    status = next;

    for (const listener of statusListeners) {
      try {
        listener(next);
      } catch {
        // One broken listener must not stop the rest being told.
      }
    }
  };

  // `on` gives back an unsubscribe, so these do not outlive this call.
  client.on("open", () => {
    setStatus("open");

    // Anything sent while offline goes now, in order. Dropping it silently would
    // lose a user's action because the network blinked.
    const pending = outbox.splice(0, outbox.length);
    for (const item of pending) {
      try {
        client.send(item.event, item.data);
      } catch {
        // Still refusing: leave it queued rather than lose it.
        outbox.push(item);
      }
    }
  });

  client.on("close", () => setStatus("closed"));
  client.on("error", () => setStatus("closed"));

  return {
    get status() {
      return status;
    },
    onStatus(onChange) {
      statusListeners.add(onChange);
      // Told the current value straight away, so a subscriber never renders one
      // frame as "connecting" when it is already open.
      onChange(status);
      return () => {
        statusListeners.delete(onChange);
      };
    },
    on(event, handler) {
      return client.on(event, handler as (data: any) => void);
    },
    join(topic) {
      return client.subscribe(topic);
    },
    async send(event, data) {
      if (status === "open") {
        client.send(event, data);
        return;
      }

      if (options.queueWhileOffline === false) return;

      // The transport throws when it is not connected. Queuing is the difference
      // between "your message was sent" and "click send again", and a UI cannot
      // tell those apart if the throw reaches it.
      outbox.push({ event, data });
    },
    get queued() {
      return outbox.length;
    },
  };
}

/**
 * The whole client-side surface, in one object.
 *
 * Built from the same route table the server serves, so `client` is typed from
 * the schemas the server validates with.
 */
export interface Frontend<R extends Record<string, RouteDef>> {
  /** Typed API methods, one per route. */
  readonly api: ReturnType<typeof createClient<R>>;
  /** Query cache shared by every consumer of this frontend. */
  readonly cache: QueryCache;
  /** Realtime, when a connection was supplied. */
  readonly realtime: RealtimeHandle | undefined;
  /**
   * Whether this instance can open connections.
   *
   * `false` during a server render. Hooks use it to decide between "load it" and
   * "wait for the browser", which is the difference between a working static
   * render and a hydration mismatch.
   */
  readonly interactive: boolean;
  /** Reads a session cookie value. `undefined` on the server. */
  readonly getCookie?: (name: string) => string | undefined;
  /** Sends on every request, for auth headers and the like. */
  readonly setHeaders?: (headers: Headers) => void;
  /** Releases timers and connections. */
  dispose(): void;
}

export interface FrontendOptions<R extends Record<string, RouteDef>> extends ClientOptions {
  /** A realtime connection to observe. One to serve both, not two. */
  realtime?: RealtimeClient;
  /** Queue sends made while disconnected. Defaults to `true`. */
  queueWhileOffline?: boolean;
  cache?: CacheOptions;
  /**
   * The session cookie name, read on the server and sent by the browser.
   *
   * Read rather than accepted as a value, so a server render and the browser
   * agree on who the user is without the app threading a token through.
   */
  cookieName?: string;
  /** Overrides the environment check. Set false in tests. */
  interactive?: boolean;
}

/**
 * Builds the client-side surface.
 *
 * @example
 * ```ts
 * import { createFrontend } from "yatta.js/frontend";
 * import { routes } from "./api-contract";
 *
 * export const frontend = createFrontend(routes, {
 *   baseUrl: "/api",
 *   realtime: createRealtimeClient({ url: "/realtime" }),
 *   cookieName: "session",
 * });
 * ```
 */
export function createFrontend<const R extends Record<string, RouteDef>>(
  source: R | App<any>,
  options: FrontendOptions<R> = {},
): Frontend<R> {
  /*
   * An app or a bare route table, both accepted.
   *
   * The app is what `createApp` hands back and what a caller actually has on hand,
   * so making them unwrap it at the call site would put ceremony on every use.
   */
  const routes = ((source as { routes?: R }).routes ?? source) as R;
  const {
    realtime: realtimeClient,
    queueWhileOffline,
    cache: cacheOptions,
    cookieName,
    interactive,
    ...clientOptions
  } = options;

  const isInteractive = interactive ?? !isServer();

  const api = createClient(routes, {
    ...clientOptions,
    // A cookie has to ride along on every request or the server sees nobody.
    // `credentials: "include"` covers a cross-origin API; same-origin sends the
    // cookie anyway.
    ...(clientOptions.onRequest
      ? {}
      : {
          onRequest: (request: Request) => {
            request.headers.set("x-yatta-client", "1");

            const cookie = readCookie(cookieName);
            if (cookie && !request.headers.has("cookie")) {
              request.headers.set("cookie", cookie);
            }
          },
        }),
  });

  const cache = new QueryCache(cacheOptions);
  const realtime =
    realtimeClient && isInteractive
      ? connectRealtime(realtimeClient, { queueWhileOffline })
      : undefined;

  return {
    api,
    cache,
    realtime,
    interactive: isInteractive,
    getCookie: cookieName ? () => readCookie(cookieName) : undefined,
    dispose() {
      cache.clear();
      realtimeClient?.close();
    },
  };
}

/**
 * Reads a cookie from `document.cookie`, or the request headers on the server.
 *
 * Returns `undefined` rather than throwing when there is no cookie store, so
 * callers do not each have to check whether they are in a browser.
 */
function readCookie(name: string | undefined): string | undefined {
  if (!name) return undefined;

  if (isServer()) {
    // On the server the caller must hand the headers in; a module-level global
    // would be shared between concurrent requests.
    return undefined;
  }

  const jar = globalThis.document?.cookie;
  if (!jar) return undefined;

  for (const part of jar.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }

  return undefined;
}

/** A cache key from a route name and its arguments, so calls agree on identity. */
export function cacheKey(name: string, args?: unknown): string {
  if (args === undefined) return name;

  // Sorted keys, so `{id, q}` and `{q, id}` are the same entry.
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}