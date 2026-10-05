// Bindings for the reactive frameworks.
//
// Every file here is short because the work is not here. Loading, de-duplicating
// in-flight requests, sharing one value between readers, keeping the old value on
// failure and bounding the cache all live in the binding layer, once. What a
// framework adds is the connection between "the store changed" and that
// framework's idea of re-rendering — a signal write, a ref assignment, a resource.
//
// So the pattern is the same in each: take the call, subscribe to the store, and
// write the new value into whatever the framework re-renders on. Only that line
// differs.
//
// Grouped in one file rather than a package each: a framework-specific package
// means a version to publish and keep in step for about twenty lines.

/*
 * Framework modules are imported statically, not resolved at runtime.
 *
 * `require` was used so the frameworks would not sit in the core. That is right in
 * principle and wrong in practice: `require` is not defined in an ESM bundle, so a
 * Vite, Rollup or Webpack-ESM build threw a ReferenceError the first time a
 * component rendered. A module nothing else imports is tree-shaken, which gets the
 * same result with no runtime cost — and these are dev dependencies, so a Bun app
 * that never imports this file never resolves them at all.
 */
import { shallowRef, onScopeDispose, getCurrentScope } from "vue";
import * as solid from "solid-js";
import * as angularCore from "@angular/core";
import * as qwik from "@builder.io/qwik";

import { bind, watchCall, methodName, stableStringify } from "../types/binding";

export { makeBinding } from "../types/binding";
import type { CallStore, CallState } from "../react/universal-hooks";
import type { DirectMethods } from "../types/universal";

/**
 * What a mutation can invalidate.
 *
 * A route method, so `api.getUser` invalidates every `getUser` key whatever its
 * arguments. A mutation on a user has to invalidate `getUser` for every id, and
 * listing each id means writing down every id that was ever fetched — which is
 * wrong the moment a component asks for an id nobody predicted.
 *
 * A string is accepted too, read as a prefix when it ends in ":".
 */
export type InvalidationTarget = string | ((...args: never[]) => unknown);

/**
 * The prefix a target's cache keys start with.
 *
 * `getUser` and `getUser:` both become `getUser:`. A plain string with no colon is
 * treated as a route name rather than as a literal key, because "invalidate this
 * exact key" is almost never what a caller means when they are naming a route.
 */
export function routePrefix(target: InvalidationTarget): string {
  const name = methodName(target);

  /*
   * Refused rather than turned into a prefix.
   *
   * "anonymous" and "unknown" are what methodName reports when it cannot identify
   * something. A prefix of "anonymous:" matches no key, so the invalidation
   * silently does nothing and the stale value stays on screen — which looks exactly
   * like a cache that is working.
   */
  if (name === "unknown" || name === "anonymous") {
    throw new Error(
      "invalidates: pass a route method (api.getUser) or a route name string. " +
        `This target has no usable name (${name}), so it cannot identify which keys to invalidate.`,
    );
  }

  return name.endsWith(":") ? name : `${name}:`;
}

/** Keys an optimistic write and rollback operate on. */
export interface OptimisticWrite<TArgs> {
  key: string;
  value: unknown | ((args: TArgs) => unknown);
}

/** The options every mutation binding accepts. */
export interface MutationOptions<TArgs, T> {
  optimistic?: OptimisticWrite<TArgs>;
  /** Route methods, or key prefixes. */
  invalidates?: InvalidationTarget[];
  onSuccess?: (result: T, args: TArgs) => void;
  onError?: (error: Error, args: TArgs) => void;
}

// ── Shared ─────────────────────────────────────────────────────────────────

/**
 * The key a call is stored under.
 *
 * Both the route and the arguments, so two calls cannot share a value by accident
 * and the same call always does.
 */
export function callKey<TArgs>(method: unknown, args: TArgs | undefined): string {
  return `${methodName(method)}:${stableStringify(args)}`;
}

/**
 * Subscribes a callback to a bound call.
 *
 * Returned rather than done inside the constructor of the holder, because a
 * binding is created during a framework's render and doing work there is what
 * causes a request per render.
 */
export interface Subscribable<T> {
  readonly state: CallState<T>;
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  destroy(): void;
}

/**
 * Binds a call and hands back a start/stop pair.
 *
 * The store's subscription is established here so no adapter has to remember to.
 */
export function bindSubscribable<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args: TArgs | undefined,
  onChange: () => void,
  options: { enabled?: boolean; key?: string; signal?: AbortSignal } = {},
): Subscribable<T> {
  const bound = bind<TArgs, T>(store, method, args, options);

  const call: Subscribable<T> = {
    get state() {
      return bound.state;
    },
    reload: () => bound.refetch(),
    set: (updater) => bound.set(updater),
    destroy: () => stop(),
  };

  /*
   * Subscribed to the store, not to a copy of the value. `bound.state` reads
   * through, so a notification that arrives late or out of order still cannot
   * leave the caller reading something stale.
   *
   * `onChange` is deliberately NOT called here. Every adapter's callback closes
   * over the object this function is about to return, so firing it inline would
   * run it while that object was still in its temporal dead zone.
   *
   * So the contract is "told on change", and each adapter seeds its own holder
   * from `call.state` once it has one.
   */
  const stop = store.subscribe(onChange);

  // Started here, not by the adapter, so every adapter loads by default. Forgetting
  // it is silent — the call simply never arrives and nothing reports a reason.
  bound.start();

  return call;
}

/** The optimistic-write-then-request sequence, shared so rollback cannot differ. */
export async function runMutation<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args: TArgs | undefined,
  options: {
    optimistic?: { key: string; value: unknown | ((args: TArgs) => unknown) };
    /** Route methods, or key prefixes. */
    invalidates?: InvalidationTarget[];
  },
  hooks: {
    onPending: (pending: boolean) => void;
    onSuccess: (result: T) => void;
    onError: (error: Error) => void;
  },
): Promise<T | undefined> {
  hooks.onPending(true);

  // Copied before the write. A copy rather than the same reference, because
  // mutating the live cached object in place would corrupt it for every other
  // reader while the request is in flight.
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

    /*
     * Invalidated by prefix, so one mutation invalidates every call to that route.
     * Invalidating one exact key meant the other twenty ids a component had ever
     * fetched kept showing the old user until a reload.
     */
    for (const target of options.invalidates ?? []) store.invalidate(routePrefix(target));

    hooks.onSuccess(result);
    return result;
  } catch (err) {
    /*
     * Rolled back unconditionally, including when there was nothing there before.
     *
     * The old guard was `previous !== undefined`, so a call whose key had no value
     * yet — the common case for a create, or anything on a cold cache — skipped
     * the rollback and the optimistic placeholder stayed in the cache forever,
     * showing an item that was never created. "There was nothing" is a value worth
     * restoring.
     */
    if (options.optimistic) {
      store.set(options.optimistic.key, previous as never);
    }

    hooks.onError(err as Error);
    return undefined;
  } finally {
    hooks.onPending(false);
  }
}

/*
 * Framework modules are imported statically in `vue.ts`, `solid.ts` and
 * `angular.ts`, not resolved here.
 *
 * `require` was used to keep the framework out of the core, which is right in
 * principle and wrong in practice: `require` is not defined in an ESM bundle, so a
 * Vite or Rollup build threw a ReferenceError the first time a component rendered.
 * A static import in a module nothing else imports is tree-shaken, which achieves
 * the same thing without the runtime cost.
 */

// ── Vue ────────────────────────────────────────────────────────────────────

export interface VueCall<T> {
  /** A `ShallowRef`. Read `.value`. */
  readonly state: { value: CallState<T> };
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  destroy(): void;
}

/**
 * Vue 3.
 *
 * `shallowRef` rather than `ref`. A response is a plain object, and a deep
 * reactive proxy around it means every read goes through a proxy — and an
 * optimistic rollback would then mutate the proxy instead of restoring what was
 * there.
 *
 * ```vue
 * <script setup lang="ts">
 * const { state, reload } = useCall(api.getUser, { params: { id: props.id } });
 * const user = computed(() => state.value.data);
 * </script>
 * ```
 */
export function useCall<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args?: TArgs,
  options: { enabled?: boolean } = {},
): VueCall<T> {

  const state = shallowRef<CallState<T>>({
    data: undefined,
    error: undefined,
    fetching: true,
    stale: false,
  });

  const call = bindSubscribable<TArgs, T>(store, method, args, () => {
    // A whole-object assignment, so the ref's identity changes and every reader
    // re-renders. Mutating `.value.data` in place would not.
    state.value = { ...call!.state };
  }, options);

  state.value = { ...call.state };

  // A component that unmounts with a request in flight would otherwise keep
  // writing to a ref nobody reads, and re-render on every update.
  //
  // Guarded on an active scope: outside a component Vue warns, and a warning on
  // every call trains people to ignore the ones that matter. A caller with no
  // scope has no teardown point and must call `destroy` itself.
  if (getCurrentScope() && typeof onScopeDispose === "function") {
    onScopeDispose(() => call.destroy());
  }

  return {
    state: state as never,
    reload: call.reload,
    set: call.set,
    destroy: call.destroy,
  };
}

export interface VueMutation<T> {
  readonly pending: { value: boolean };
  readonly error: { value: Error | undefined };
  call(args: unknown): Promise<T | undefined>;
}

export function useMutation<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  options: {
    optimistic?: { key: string; value: unknown | ((args: TArgs) => unknown) };
    invalidates?: string[];
    onSuccess?: (result: T, args: TArgs) => void;
    onError?: (error: Error, args: TArgs) => void;
  } = {},
): VueMutation<T> {

  const pending = shallowRef(false);
  const error = shallowRef<Error | undefined>(undefined);

  return {
    pending: pending as never,
    error: error as never,
    async call(args: TArgs) {
      return runMutation<TArgs, T>(store, method, args, options, {
        onPending: (value) => {
          pending.value = value;
        },
        onSuccess: (result) => options.onSuccess?.(result, args),
        onError: (err) => {
          error.value = err;
          options.onError?.(err, args);
        },
      });
    },
  };
}

// ── Solid ──────────────────────────────────────────────────────────────────

export interface SolidCall<T> {
  /** A signal accessor. Call it in JSX and Solid tracks it. */
  (): CallState<T>;
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  destroy(): void;
}

/**
 * Solid.
 *
 * The closest fit of the group: Solid's reactivity is push-based, which is what
 * the store's subscription already is, so a signal write is the whole adapter.
 *
 * ```tsx
 * const user = useCall(api.getUser, { params: { id } });
 * return <Show when={user().data}>{u => <span>{u().name}</span>}</Show>;
 * ```
 */
export function useSolidCall<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args?: TArgs,
  options: { enabled?: boolean } = {},
): SolidCall<T> {
  const { createSignal, onCleanup, getOwner } = solid;

  const [read, write] = createSignal<CallState<T>>({
    data: undefined,
    error: undefined,
    fetching: true,
    stale: false,
  });

  const call = bindSubscribable<TArgs, T>(
    store,
    method,
    args,
    () => write({ ...call!.state }),
    options,
  );

  write({ ...call.state });

  // Solid's owner is the scope, so a signal outlives its component unless the
  // owner is cleaned up. Guarded the same way Vue's is: outside an owner there is
  // nothing to clean up and registering one is an error.
  if (getOwner() && typeof onCleanup === "function") onCleanup(() => call.destroy());

  const accessor = (() => read()) as SolidCall<T>;
  accessor.reload = call.reload;
  accessor.set = call.set;
  accessor.destroy = call.destroy;

  return accessor;
}

// ── Svelte ─────────────────────────────────────────────────────────────────

/**
 * Svelte.
 *
 * Returns a **Svelte store**, not an object with getters.
 *
 * Getters on a plain object are not reactive in Svelte. It compiles components and
 * only tracks reads of `$state` or a store's `subscribe`; a getter on a plain
 * object is invisible to it, so the earlier version here — getters plus an empty
 * change callback — would render once and then never update again. The store
 * contract is the one thing Svelte actually subscribes to, and `$user` works on it
 * directly.
 *
 * ```svelte
 * <script lang="ts">
 *   import { useSvelteCall } from "yatta.js/frameworks";
 *   const user = useSvelteCall(store, api.getUser, { params: { id: data.id } });
 * </script>
 *
 * {$user.data?.name}
 * ```
 *
 * Also usable outside a component: `user.subscribe(fn)` works in plain TypeScript.
 */
export interface SvelteCall<T> extends SvelteReadable<CallState<T>> {
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  destroy(): void;
}

/**
 * Reads a Svelte call from plain TypeScript, with no template.
 *
 * Provided because the store contract needs a subscription to be read from outside
 * a component, and without this there is no non-template way to do it. Inside a
 * component, use <code>$user</code> instead.
 */
export function readSvelte<T>(call: SvelteReadable<T>): T {
  let value!: T;

  const stop = call.subscribe((next) => {
    value = next;
  });

  // A synchronous read is all a snapshot needs, so the subscription is released
  // immediately rather than left open.
  stop();

  return value;
}

/** The Svelte store contract, declared here so Svelte is not a build-time dependency. */
export interface SvelteReadable<T> {
  subscribe(run: (value: T) => void): () => void;
}

export function useSvelteCall<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args?: TArgs,
  options: { enabled?: boolean; key?: string } = {},
): SvelteCall<T> {
  const key = options.key ?? callKey(method, args);
  const bound = bind<TArgs, T>(store, method, args, options);

  const subscribers = new Set<(value: CallState<T>) => void>();

  const stopStore = store.subscribe(() => {
    if (subscribers.size === 0) return;
    const state = bound.state;
    for (const subscriber of [...subscribers]) subscriber(state);
  }, key);

  bound.start();

  return {
    subscribe(run) {
      subscribers.add(run);
      // Told immediately, the contract every Svelte store honours. Without it a
      // subscriber renders against an empty cache for one frame.
      run(bound.state);

      return () => {
        subscribers.delete(run);
      };
    },
    reload: () => bound.refetch(),
    set: (updater) => bound.set(updater),
    destroy: () => {
      subscribers.clear();
      stopStore();
    },
  };
}

// ── Angular ────────────────────────────────────────────────────────────────

export interface AngularCall<T> {
  /** An Angular signal of the call's state. */
  state(): CallState<T>;
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  /** Call from `ngOnDestroy`. */
  destroy(): void;
}

/**
 * Angular.
 *
 * A plain class rather than a service decorator, so it can be constructed in a
 * factory provider or built by hand in a test. Angular's own `signal` is used, not
 * an RxJS subject: a signal is readable straight from a template with no async
 * pipe, and this keeps RxJS out of the dependency list.
 *
 * ```ts
 * @Component({
 *   providers: [provideYatta(() => api, () => new QueryCache())],
 *   template: `@if (user.state().data; as u) { {{ u.name }} }`,
 * })
 * export class Profile {
 *   private readonly yatta = inject(YattaClient);
 *   readonly user = this.yatta.call(api.getUser, { params: { id: this.id } });
 * }
 * ```
 */
export class YattaAngularClient {
  constructor(
    readonly api: DirectMethods<never>,
    readonly store: CallStore,
    private readonly bump: () => void,
  ) {}

  call<TArgs, T>(
    method: (args?: TArgs) => Promise<T>,
    args?: TArgs,
    options: { enabled?: boolean } = {},
  ): AngularCall<T> {
    const { signal } = angularCore;

    const version = signal(0);
    const read = () => {
      // The version is read so the signal recomputes when the store changes. The
      // value comes from the store, so the signal only has to be a change signal.
      void version();
      return call.state;
    };

    const call = bindSubscribable<TArgs, T>(
      this.store,
      method,
      args,
      () => version.update((n) => n + 1),
      options,
    );

    return {
      state: read,
      reload: call.reload,
      set: call.set,
      destroy: call.destroy,
    };
  }

  useRoutes(): DirectMethods<never> {
    return this.api;
  }
}

/** Builds an Angular client whose calls drive Angular signals. */
export function createAngularClient(
  api: DirectMethods<never>,
  store: CallStore,
): YattaAngularClient {
  return new YattaAngularClient(api, store, () => {});
}

// ── Qwik ───────────────────────────────────────────────────────────────────

/**
 * Qwik.
 *
 * A signal and a resource, rather than a subscription. Qwik containers are
 * rendered on the server, serialized, and *resumed* in the browser without
 * re-running the component — so anything held in a closure is gone, and the only
 * thing that survives is serialized state. A resource is exactly that.
 *
 * Must be called during a component's render. That is a Qwik requirement rather
 * than one this binding adds.
 */
export function useQwikCall<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args: TArgs | undefined,
  options: { enabled?: boolean } = {},
): QwikCall<T> {
  const { useSignal, useResource$ } = qwik;

  const key = callKey(method, args);
  const state = useSignal<CallState<T>>({
    data: undefined,
    error: undefined,
    fetching: true,
    stale: false,
  });

  useResource$(async ({ track, cleanup }) => {
    // Tracked so the resource re-runs when the key changes — Qwik's serializable
    // equivalent of a dependency array.
    track(() => key);

    const teardown = store.subscribe(() => {
      state.value = { ...store.get<T>(key) };
    });
    cleanup(() => teardown());

    if (options.enabled === false) {
      state.value = { ...store.get<T>(key), fetching: false };
      return;
    }

    state.value = { ...store.get<T>(key), fetching: true };
    await store.resolve(key, () => method(args));
    state.value = { ...store.get<T>(key), fetching: false };
  });

  return {
    key,
    state,
    reload: () => {
      void store.resolve(key, () => method(args), { force: true });
    },
  };
}

export interface QwikCall<T> {
  /** The cache key, which is also how the call is tracked across a resume. */
  readonly key: string;
  /** A Qwik signal of the call's state. */
  readonly state: { value: CallState<T> };
  reload(): void;
}

// ── Raw DOM ────────────────────────────────────────────────────────────────

export interface DomCall<T> {
  readonly state: CallState<T>;
  /** Told on every change. The whole of a no-framework re-render. */
  subscribe(onChange: (state: CallState<T>) => void): () => void;
  reload(): void;
  set(updater: T | ((previous: T | undefined) => T)): void;
  destroy(): void;
}

/**
 * No framework at all — a plain page, a script tag, a worker, a Web Component.
 *
 * The same contract the other adapters implement, so a page with no framework
 * behaves identically to one inside a component tree: same caching, same
 * de-duplication, same rollback.
 *
 * ```ts
 * const call = createDomCall(store, api.getUser, { params: { id } });
 * const off = call.subscribe((state) => render(state.data));
 * ```
 */
export function createDomCall<TArgs, T>(
  store: CallStore,
  method: (args?: TArgs) => Promise<T>,
  args?: TArgs,
  options: { enabled?: boolean } = {},
): DomCall<T> {
  const key = callKey(method, args);
  const bound = bind<TArgs, T>(store, method, args, options);

  const subscribers = new Set<(state: CallState<T>) => void>();

  // One store subscription for all subscribers, rather than one each. The
  // alternative is a callback per reader on the same key.
  const stopStore = store.subscribe(() => {
    // A fresh object per notification, so a subscriber that keeps the value cannot
    // see it change underfoot.
    const state = bound.state;
    for (const subscriber of [...subscribers]) subscriber(state);
  }, key);

  bound.start();

  return {
    get state() {
      return bound.state;
    },
    subscribe(onChange) {
      subscribers.add(onChange);
      // Told the current value straight away, so a subscriber never renders one
      // frame against an empty cache.
      onChange(bound.state);

      return () => {
        subscribers.delete(onChange);
      };
    },
    reload: () => bound.refetch(),
    set: (updater) => bound.set(updater),
    destroy: () => {
      subscribers.clear();
      stopStore();
    },
  };
}

export { bind, watchCall, methodName, stableStringify };