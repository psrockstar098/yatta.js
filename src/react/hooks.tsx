// React bindings for the frontend core.
//
// Thin on purpose. Every hook here is a `useSyncExternalStore` over something the
// framework core already owns, plus the effect that starts and stops work. None
// of them hold state of their own, so a component unmounting cannot leave a
// socket open or a fetch running that something else still depends on.
//
// Why `useSyncExternalStore` rather than `useState` plus a subscription: it is
// the only React primitive that stays correct across concurrent rendering. A
// subscription that misses a notification between render and effect paints a
// stale value and never corrects it, and the fix for that is a second render
// rather than correctness.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { Frontend } from "../types/frontend";
import { cacheKey } from "../types/frontend";
import type { RouteDef } from "../types/client";

/** Anything with the shape a hook needs. Structural, so a test can pass a stub. */
export interface FrontendLike {
  cache: Frontend<never>["cache"];
  realtime: Frontend<never>["realtime"];
  interactive: boolean;
}

const FrontendContext = createContext<FrontendLike | null>(null);

/**
 * Provides the frontend to everything below it.
 *
 * Put it high in the tree — Next.js `layout.tsx` for an app router app. One
 * instance per request on the server: a module-level instance would share one
 * user's data with the next request.
 */
export function YattaProvider({
  frontend,
  children,
}: {
  frontend: FrontendLike;
  children: ReactNode;
}): ReactNode {
  return createElement(FrontendContext.Provider, { value: frontend }, children);
}

/**
 * The frontend from context.
 *
 * Throws rather than returning null when it is missing, because a component that
 * silently does nothing is much harder to diagnose than one that says why.
 */
export function useFrontend(): FrontendLike {
  const frontend = useContext(FrontendContext);
  if (!frontend) {
    throw new Error(
      "No Yatta frontend in context. Wrap the tree in <YattaProvider frontend={…}>.",
    );
  }
  return frontend;
}

// ── Queries ────────────────────────────────────────────────────────────────

export interface UseQueryOptions {
  /**
   * Skip the request.
   *
   * For a query whose argument depends on something not loaded yet. Skipping is
   * not the same as passing nothing: an unskipped query with no id would call a
   * route with a missing required parameter.
   */
  enabled?: boolean;
  /** Load even if a fresh value is cached. */
  refetchOnMount?: boolean;
}

/**
 * Loads one route and keeps the result.
 *
 * Takes the method as a function rather than a name, so the argument types and
 * the return type come from the route itself and cannot be declared separately:
 *
 * ```ts
 * const { data, error, fetching } = useQuery(
 *   (args) => api.getUser({ params: { id } }),
 *   [id],
 *   { enabled: id !== undefined },
 * );
 * ```
 *
 * The dependency list is by argument, because that is what the request actually
 * depends on. Naming a route and passing its id separately is how a query ends up
 * showing the previous id's data.
 */
export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  options: UseQueryOptions = {},
): {
  data: T | undefined;
  error: Error | undefined;
  fetching: boolean;
  stale: boolean;
  refetch: () => void;
  set: (updater: T | ((previous: T | undefined) => T)) => void;
} {
  const { cache } = useFrontend();
  const enabled = options.enabled ?? true;

  /*
   * The key has to be stable across renders.
   *
   * Built from the fetcher's source plus its arguments. A key rebuilt on every
   * render would look like a new query each time, so the cache would never hit
   * and every render would refetch.
   */
  const source = useMemo(() => fetcher.toString(), [fetcher]);
  const key = cacheKey(source, deps);

  const entry = useSyncExternalStore(
    useCallback((onChange) => cache.subscribe(onChange), [cache]),
    () => cache.get(key),
    // The server snapshot has no browser cache yet, so it reads as empty rather
    // than as whatever a previous request happened to leave.
    () => cache.get(key),
  );

  const load = useCallback(
    (force: boolean) => {
      if (!enabled) return;
      void cache.resolve(key, fetcher, { force });
    },
    [cache, key, enabled, fetcher],
  );

  const started = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Re-fetch when the key changes, but not on every render. `started` records
    // which key this effect last began, so a re-render with the same arguments
    // does not refetch.
    if (started.current === key && !options.refetchOnMount) return;
    started.current = key;
    load(false);
  }, [key, load, options.refetchOnMount]);

  return {
    data: entry.data as T | undefined,
    error: entry.error,
    fetching: entry.fetching,
    stale: entry.stale,
    refetch: useCallback(() => load(true), [load]),
    set: useCallback(
      (updater: T | ((previous: T | undefined) => T)) => cache.set(key, updater),
      [cache, key],
    ),
  };
}

/**
 * Calls a route that changes something, and can undo it on screen.
 *
 * The optimistic write happens before the request and is rolled back if it fails,
 * because a form that does not respond until the server answers feels broken on a
 * slow connection. `onError` and `onSuccess` run after the real outcome, not after
 * the optimistic one.
 */
export function useMutation<TArgs, TResult>(
  mutate: (args: TArgs) => Promise<TResult>,
  options: {
    /** Cache key and value written before the request. */
    optimistic?: { key: string; value: unknown | ((args: TArgs) => unknown) };
    onSuccess?: (result: TResult, args: TArgs) => void;
    onError?: (error: Error, args: TArgs) => void;
    /** Keys invalidated when the mutation succeeds. */
    invalidates?: string[];
  } = {},
): {
  mutate: (args: TArgs) => Promise<TResult | undefined>;
  pending: boolean;
  error: Error | undefined;
  reset: () => void;
} {
  const { cache } = useFrontend();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const run = useCallback(
    async (args: TArgs) => {
      setPending(true);
      setError(undefined);

      // Kept so a failure can put back exactly what was there. `structuredClone`
      // is a copy rather than the same reference — mutating the live cached
      // object in place while the request is in flight would corrupt it for
      // every other reader.
      const previous = options.optimistic ? cache.get(options.optimistic.key).data : undefined;

      if (options.optimistic) {
        const value =
          typeof options.optimistic.value === "function"
            ? (options.optimistic.value as (a: TArgs) => unknown)(args)
            : options.optimistic.value;
        cache.set(options.optimistic.key, value);
      }

      try {
        const result = await mutate(args);

        for (const key of options.invalidates ?? []) cache.invalidate(key);

        options.onSuccess?.(result, args);
        return result;
      } catch (err) {
        // Undo, then report. Leaving the optimistic value in place shows a change
        // that never happened.
        if (options.optimistic && previous !== undefined) {
          cache.set(options.optimistic.key, previous);
        }

        setError(err as Error);
        options.onError?.(err as Error, args);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    // `cache` and `mutate` are the inputs; the rest are read at call time so a
    // caller can pass fresh closures without the callback identity changing.
    [cache, mutate],
  );

  const reset = useCallback(() => {
    setPending(false);
    setError(undefined);
  }, []);

  return { mutate: run, pending, error, reset };
}

// ── Realtime ───────────────────────────────────────────────────────────────

/**
 * Whether the app is connected.
 *
 * ```tsx
 * const { status } = useConnection();
 * return status === "open" ? null : <Banner>Reconnecting…</Banner>;
 * ```
 */
export function useConnection(): { status: "connecting" | "open" | "closed" } {
  const { realtime } = useFrontend();
  const [status, setStatus] = useState(realtime?.status ?? "closed");

  useEffect(() => {
    if (!realtime) return;
    // Subscribing also reports the current status, so this never paints one
    // frame of the wrong value.
    return realtime.onStatus(setStatus);
  }, [realtime]);

  return { status };
}

/**
 * Runs a handler whenever an event arrives.
 *
 * The handler is kept in a ref so a component that re-renders every second does
 * not resubscribe every second, and so a socket is not opened and closed for
 * every keystroke elsewhere in the tree.
 *
 * ```ts
 * useRealtimeEvent("task.created", (task) => store.add(task));
 * ```
 */
export function useRealtimeEvent<T = unknown>(
  event: string,
  handler: (data: T) => void,
): void {
  const { realtime } = useFrontend();
  const latest = useRef(handler);

  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    if (!realtime) return;
    return realtime.on<T>(event, (data) => latest.current(data));
  }, [realtime, event]);
}

/**
 * Collects the events on a topic into an array.
 *
 * Bounded by `limit`, so a busy topic cannot grow a component's state without
 * end. Oldest entries are dropped first.
 *
 * ```ts
 * const messages = useTopic<Message>("room:42", { limit: 50 });
 * ```
 */
export function useTopic<T = unknown>(
  topic: string,
  options: { limit?: number; event?: string } = {},
): T[] {
  const { realtime } = useFrontend();
  const limit = options.limit ?? 100;
  const event = options.event ?? "message";

  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    if (!realtime) return;

    const leave = realtime.join(topic);
    const off = realtime.on<T>(event, (data) => {
      setItems((previous) => {
        const next = [...previous, data];
        // Trim from the front: the newest entry is the one a reader wants.
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    });

    return () => {
      // Both halves matter. Leaving the topic stops the server pushing, and
      // dropping the listener stops this component rendering.
      off();
      leave();
    };
  }, [realtime, topic, event, limit]);

  const clear = useCallback(() => setItems([]), []);
  void clear;

  return items;
}

/**
 * Sends on a realtime event.
 *
 * Refuses before the connection is open unless asked not to, because a send that
 * silently vanished looks identical to one that worked.
 */
export function useRealtimeSend(): {
  send: (event: string, data: unknown) => Promise<boolean>;
  status: "connecting" | "open" | "closed";
  queued: number;
} {
  const { realtime } = useFrontend();
  const { status } = useConnection();

  const send = useCallback(
    async (event: string, data: unknown) => {
      if (!realtime) return false;
      if (realtime.status !== "open") return false;
      await realtime.send(event, data);
      return true;
    },
    [realtime],
  );

  // Read during render rather than tracked, so a queued send does not re-render
  // the tree on every flush. Deliberately not reactive.
  return { send, status, queued: realtime?.queued ?? 0 };
}

/**
 * The typed API client from the frontend.
 *
 * A one-line accessor so components do not reach through context themselves.
 */
export function useApi<
  R extends Record<string, RouteDef>,
>(): Frontend<R>["api"] {
  const frontend = useFrontend() as unknown as Frontend<R>;
  return frontend.api;
}

/**
 * Whether this is a server render.
 *
 * For the cases where a hook cannot do the right thing on its own — reading
 * `localStorage`, or rendering something that only makes sense once mounted.
 */
export function useIsInteractive(): boolean {
  return useFrontend().interactive;
}

/**
 * Runs a value-producing function after mount, once.
 *
 * The escape hatch for browser-only reads. Server-rendered HTML and the first
 * client render must match, so the value starts as `undefined` and arrives on the
 * second render.
 */
export function useAfterMount<T>(produce: () => T): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    setValue(produce());
  }, [produce]);

  return value;
}