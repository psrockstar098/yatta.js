// React bindings for universal routes.
//
// Nothing here is written per endpoint. A hook takes the route's method and its
// arguments, and the type of both comes from the route — so adding a route adds
// nothing here, and changing one changes these signatures automatically.
//
// The distinction the core makes is carried through: a call made on the server
// runs in process, and a call made in the browser goes over HTTP. The hook does
// not need to know which, because the app decides.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { App, DirectMethods, RouteTable } from "../types/universal";

/**
 * A cache key that identifies a call by what it asked for.
 *
 * Built from the method's name and a stable serialisation of the arguments, so two
 * components asking the same question share one value and one request — and an
 * argument object rebuilt on every render does not look like a different question.
 */
export function callKey(method: unknown, args: unknown): string {
  const name = methodName(method);
  return `${name}:${stableStringify(args)}`;
}

/**
 * The route a method came from.
 *
 * Carried on the function rather than looked up, so a key cannot collide between
 * two apps in one process and a client method is traceable to its route.
 */
export function methodName(method: unknown): string {
  if (typeof method !== "function") return "unknown";
  return method.name || "anonymous";
}

function stableStringify(value: unknown): string {
  // `undefined` and `{}` are the same call. Keying them differently means a
  // component whose parent conditionally spreads an optional argument refetches on
  // every render.
  if (value === undefined) return "{}";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // Sorted, so `{id, q}` and `{q, id}` are the same question.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Somewhere to keep a call's result between renders. */
export interface CallStore {
  get<T>(key: string): CallState<T>;
  resolve<T>(key: string, fetcher: () => Promise<T>, options?: { force?: boolean }): Promise<T | undefined>;
  subscribe(onChange: (changedKey?: string) => void, key?: string): () => void;
  set<T>(key: string, updater: T | ((previous: T | undefined) => T)): void;
  invalidate(key?: string, all?: boolean): void;
}

export interface CallState<T> {
  data: T | undefined;
  error: Error | undefined;
  fetching: boolean;
  stale: boolean;
}

/**
 * Where a call's result is kept.
 *
 * Passed in rather than created here, so the store can be per-request on a server
 * render and shared across the tree in a browser. A module-level store would
 * serve one visitor's data to the next on the server.
 */
export const CallStoreContext = createContext<CallStore | null>(null);

/**
 * Calls a route and keeps the result.
 *
 * The method and the arguments are the whole API — no wrapper function, no
 * dependency array to get wrong, no name string to keep in step:
 *
 * ```tsx
 * const { data, error, fetching, refetch } = useCall(api.getUser, { params: { id } });
 * ```
 *
 * Adding a route adds nothing here. Changing a route's schema changes this
 * signature, because the argument type is read off the route itself.
 */
export function useCall<TArgs, TResult>(
  method: (args?: TArgs) => Promise<TResult>,
  args?: TArgs,
  options: { enabled?: boolean; store?: CallStore | null } = {},
): CallState<TResult> & {
  refetch: () => void;
  set: (updater: TResult | ((previous: TResult | undefined) => TResult)) => void;
} {
  const store = options.store ?? useRequiredStore();
  const enabled = options.enabled ?? true;

  const key = useMemo(() => callKey(method, args), [method, args]);

  const state = useSyncExternalStore(
    useCallback((onChange) => store.subscribe(onChange), [store]),
    () => store.get<TResult>(key),
    // Read the same on the server. A snapshot that differed between render and
    // hydration is what produces a mismatch.
    () => store.get<TResult>(key),
  );

  const load = useCallback(
    (force: boolean) => {
      if (!enabled) return;
      void store.resolve(key, () => method(args), { force });
    },
    [store, key, method, args, enabled],
  );

  // Tracked by key, so a re-render with the same arguments does not refetch.
  const loaded = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      // Cleared, so enabling later starts fresh rather than skipping the load
      // because a previous key was already seen.
      loaded.current = undefined;
      return;
    }
    if (loaded.current === key) return;
    loaded.current = key;
    load(false);
  }, [key, load, enabled]);

  return {
    ...state,
    refetch: useCallback(() => load(true), [load]),
    set: useCallback(
      (updater: TResult | ((previous: TResult | undefined) => TResult)) => store.set(key, updater),
      [store, key],
    ),
  };
}

/**
 * Calls a route that changes something, with an optional optimistic write.
 *
 * The write happens before the request and is undone if it fails, because a form
 * that does not respond until the server answers feels broken on a slow
 * connection. A failure rolls the value back — leaving it would show a change
 * that never happened.
 */
export function useCallMutation<TArgs, TResult>(
  method: (args?: TArgs) => Promise<TResult>,
  options: {
    store?: CallStore | null;
    /** Key and value written before the request. */
    optimistic?: { key: string; value: unknown | ((args: TArgs) => unknown) };
    /** Keys refetched after a success. */
    invalidates?: string[];
    onSuccess?: (result: TResult, args: TArgs) => void;
    onError?: (error: Error, args: TArgs) => void;
  } = {},
): {
  call: (args?: TArgs) => Promise<TResult | undefined>;
  pending: boolean;
  error: Error | undefined;
} {
  const store = options.store ?? useRequiredStore();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const run = useCallback(
    async (args?: TArgs) => {
      setPending(true);
      setError(undefined);

      // Copied before the optimistic write. A copy rather than the same
      // reference, because mutating the live cached object while the request is in
      // flight would corrupt it for every other reader.
      const previous = options.optimistic ? store.get(options.optimistic.key).data : undefined;

      if (options.optimistic) {
        const value =
          typeof options.optimistic.value === "function"
            ? (options.optimistic.value as (a: TArgs) => unknown)(args as TArgs)
            : options.optimistic.value;
        store.set(options.optimistic.key, value);
      }

      try {
        const result = await method(args);

        for (const key of options.invalidates ?? []) store.invalidate(key);

        options.onSuccess?.(result, args as TArgs);
        return result;
      } catch (err) {
        if (options.optimistic && previous !== undefined) {
          store.set(options.optimistic.key, previous);
        }

        setError(err as Error);
        options.onError?.(err as Error, args as TArgs);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [store, method, options],
  );

  return { call: run, pending, error };
}

/**
 * The store a call reads and writes.
 *
 * Throws rather than returning null, because a component that quietly keeps no
 * results is much harder to diagnose than one that says why.
 */
export function useRequiredStore(): CallStore {
  const store = useContext(CallStoreContext);
  if (!store) {
    throw new Error(
      "No call store in context. Wrap the tree in <CallStoreProvider store={…}>.",
    );
  }
  return store;
}

/** Provides a store to everything below it. */
export function CallStoreProvider({
  store,
  children,
}: {
  store: CallStore;
  children?: React.ReactNode;
}): React.ReactNode {
  return <CallStoreContext.Provider value={store}>{children}</CallStoreContext.Provider>;
}

/**
 * The whole app's routes, ready to call.
 *
 * Derived from the app, so this is the same set of methods whether it runs in a
 * Server Component (calling in process) or in the browser (calling over HTTP).
 */
export function useRoutes<R extends RouteTable>(app: App<R> & DirectMethods<R>): DirectMethods<R> {
  // Bound once per app. Returning the app itself would be simpler, but callers
  // destructure, and an unbound method loses the services.
  return useMemo(() => app, [app]);
}
