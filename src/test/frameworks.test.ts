import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { createApp, defineRoute } from "../types/universal";
import { QueryCache } from "../types/frontend";
import type { CallStore } from "../react/universal-hooks";
import {
  bind,
  makeBinding,
  serverBinding,
  methodName,
  stableStringify,
} from "../types/binding";
import {
  callKey,
  bindSubscribable,
  runMutation,
  useCall as vueUseCall,
  useMutation as vueUseMutation,
  useSolidCall,
  useSvelteCall,
  YattaAngularClient,
  createAngularClient,
  createDomCall,
} from "../frameworks/index";

/*
 * Scope, stated up front.
 *
 * Tested here: the binding layer, the DOM binding, Vue, and the mutation sequence
 * all the frameworks share.
 *
 * Verified by rendering: Vue, with a real SSR render.
 *
 * Verified as logic but not as rendering: Solid. Its binding is a signal write and
 * an accessor, and both are asserted here — but Solid compiles JSX at build time,
 * so producing markup would need its compiler. The rendering step is unverified.
 *
 * Not verified at runtime: Angular, Svelte, Qwik. Each needs a browser, a compiler
 * or a container lifecycle this environment does not have. Their code is
 * typechecked and is a thin layer over the binding functions tested below — but
 * "typechecks" is not "works", and nothing here should be read as evidence that
 * they do.
 */

const User = z.object({ id: z.string(), email: z.string(), name: z.string() });

function setup(rows: Map<string, z.infer<typeof User>>) {
  const store = new QueryCache({ staleTime: 0 }) as unknown as CallStore;

  const app = createApp(
    {
      getUser: defineRoute(
        { method: "get", path: "/users/:id", params: z.object({ id: z.string() }), response: User },
        async ({ params }) => {
          const found = rows.get(params.id);
          if (!found) throw new Error("no such user");
          return found;
        },
      ),
      listUsers: defineRoute(
        { method: "get", path: "/users", response: z.array(User) },
        async () => [...rows.values()],
      ),
    },
    { services: { rows } },
  );

  return { store, app, rows };
}

const ada: z.infer<typeof User> = { id: "u1", email: "ada@t.dev", name: "Ada" };
const grace: z.infer<typeof User> = { id: "u2", email: "grace@t.dev", name: "Grace" };

describe("Binding layer", () => {
  it("names a method after its route", () => {
    const { app } = setup(new Map());
    expect(methodName(app.getUser)).toBe("getUser");
  });

  it("serialises arguments so key order does not matter", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify(undefined)).toBe(stableStringify({}));
    expect(stableStringify([1, 2])).toBe("[1,2]");
  });

  it("gives two routes different keys for the same arguments", () => {
    const { app } = setup(new Map());

    // A key built from arguments alone would collide here and serve one route's
    // value under the other's key.
    expect(callKey(app.getUser, { x: 1 })).not.toBe(callKey(app.listUsers, { x: 1 }));
  });

  it("shares one request between two readers of the same call", async () => {
    const { store, app, rows } = setup(new Map([["u1", ada]]));
    rows.set("u1", ada);

    let calls = 0;
    const counted = createApp(
      {
        getUser: defineRoute({ method: "get", path: "/users/:id" }, async ({ params }) => {
          calls++;
          return rows.get(params.id);
        }),
      },
      { services: { rows } },
    );

    const a = bindSubscribable(store, counted.getUser, { params: { id: "u1" } }, () => {});
    const b = bindSubscribable(store, counted.getUser, { params: { id: "u1" } }, () => {});

    await Bun.sleep(20);

    expect(a.state.data).toEqual(ada);
    expect(b.state.data).toEqual(ada);
    // One route, two readers, one request.
    expect(calls).toBe(1);

    a.destroy();
    b.destroy();
    void app;
  });

  it("tells subscribers when a value arrives", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);
    const seen: unknown[] = [];

    const call = createDomCall(store, app.getUser, { params: { id: "u1" } });
    const off = call.subscribe((state) => seen.push(state));

    await Bun.sleep(20);

    // Told the current value on subscribe, then again when it loaded.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect((seen[seen.length - 1] as { data?: unknown }).data).toEqual(ada);

    off();
    call.destroy();
  });

  it("stops notifying after teardown", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);
    let changes = 0;

    const call = createDomCall(store, app.getUser, { params: { id: "u1" } });
    const off = call.subscribe(() => changes++);

    await Bun.sleep(20);
    const before = changes;

    call.destroy();

    store.set(callKey(app.getUser, { params: { id: "u1" } }), grace);
    await Bun.sleep(10);

    // A teardown that leaves the subscription in place means a closed component
    // keeps re-rendering for the rest of the page's life.
    expect(changes).toBe(before);
    void off;
  });

  it("never notifies on a server binding", () => {
    const binding = serverBinding();
    let notified = false;

    binding.subscribe(() => {
      notified = true;
    });

    expect(notified).toBe(false);
  });

  it("shares one framework subscription across many subscribers", () => {
    let trackCalls = 0;
    let teardowns = 0;

    const binding = makeBinding(() => {
      trackCalls++;
      return () => {
        teardowns++;
      };
    });

    const a = binding.subscribe(() => {});
    const b = binding.subscribe(() => {});
    const c = binding.subscribe(() => {});

    // One subscription per component for the same store is the thing this avoids.
    expect(trackCalls).toBe(1);

    a();
    b();
    expect(teardowns).toBe(0);

    c();
    expect(teardowns).toBe(1);
  });

  it("reads current state without a framework re-render", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);
    const call = createDomCall(store, app.getUser, { params: { id: "u1" } });

    await Bun.sleep(20);
    expect(call.state.data).toEqual(ada);

    // The getter is always current, whether or not anyone was notified.
    store.set(callKey(app.getUser, { params: { id: "u1" } }), grace);
    expect(call.state.data).toEqual(grace);

    call.destroy();
  });
});

describe("No-framework binding", () => {
  it("does not start a call until it is asked to", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);
    let calls = 0;

    const counted = createApp(
      {
        getUser: defineRoute({ method: "get", path: "/users/:id" }, async ({ params }) => {
          calls++;
          return rows.get(params.id);
        }),
      },
      { services: { rows } },
    );

    bind(store, counted.getUser, { params: { id: "u1" } });

    await Bun.sleep(10);
    expect(calls).toBe(0);
    void app;
    void store;
  });

  it("skips a disabled call", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);

    const call = createDomCall(store, app.getUser, { params: { id: "u1" } }, { enabled: false });
    await Bun.sleep(20);

    // A call that cannot succeed yet should not fire — a missing id would hit an
    // endpoint that cannot answer.
    expect(call.state.data).toBeUndefined();
    expect(call.state.fetching).toBe(false);

    call.destroy();
  });

  it("reloads on demand", async () => {
    const { store, rows } = setup(new Map([["u1", ada]]));

    const { app } = setup(rows);
    let calls = 0;

    const counted = createApp(
      {
        getUser: defineRoute({ method: "get", path: "/users/:id" }, async ({ params }) => {
          calls++;
          return rows.get(params.id);
        }),
      },
      { services: { rows } },
    );

    const call = createDomCall(store, counted.getUser, { params: { id: "u1" } });
    await Bun.sleep(20);
    expect(calls).toBe(1);

    call.reload();
    await Bun.sleep(20);
    expect(calls).toBe(2);

    call.destroy();
    void app;
  });
});

describe("Vue binding", () => {
  it("wraps the state in a ref a template can read", async () => {
    const { store, rows } = setup(new Map([["u1", ada]]));

    const { app } = setup(rows);
    const call = vueUseCall(store, app.getUser, { params: { id: "u1" } });

    await Bun.sleep(20);

    // `.value` is what a Vue template reads, and the whole object is replaced on
    // change so the ref's identity changes and readers re-render.
    expect(call.state.value.data).toEqual(ada);

    store.set(callKey(app.getUser, { params: { id: "u1" } }), grace);
    await Bun.sleep(10);

    expect(call.state.value.data).toEqual(grace);
    expect(call.state.value.fetching).toBe(false);

    call.destroy();
  });

  it("does not need a component scope", async () => {
    const { store, rows } = setup(new Map([["u2", grace]]));

    const { app } = setup(rows);

    // Called outside a component, where `onScopeDispose` has nothing to attach to.
    // A binding that assumed a scope would throw here, which is how a helper used
    // from a plain module ends up unusable.
    const call = vueUseCall(store, app.getUser, { params: { id: "u2" } });
    await Bun.sleep(20);

    expect(call.state.value.data).toEqual(grace);
    call.destroy();
  });

  it("exposes pending and error for a mutation", async () => {
    const { store, rows } = setup(new Map());

    const { app } = setup(rows);
    const mutation = vueUseMutation(store, app.listUsers);

    const result = await mutation.call(undefined);
    expect(result).toEqual([]);
    expect(mutation.error.value).toBeUndefined();
  });
});

describe("Shared mutation sequence", () => {
  it("writes optimistically and rolls back when the request fails", async () => {
    const { store, rows } = setup(new Map());
    rows.set("u1", ada);

    const { app } = setup(rows);
    const key = callKey(app.getUser, { params: { id: "u1" } });
    store.set(key, ada);

    const failing = createApp(
      {
        save: defineRoute({ method: "post", path: "/save" }, async () => {
          throw new Error("server said no");
        }),
      },
      { services: { rows } },
    );

    const pending: boolean[] = [];
    let reported: Error | undefined;

    await runMutation(store, failing.save, undefined, { optimistic: { key, value: grace } }, {
      onPending: (value) => pending.push(value),
      onSuccess: () => {
        throw new Error("should not succeed");
      },
      onError: (err) => {
        reported = err;
      },
    });

    expect(pending).toEqual([true, false]);
    expect(reported?.message).toBe("server said no");
    // The old value is back. Leaving the optimistic one in place would show a
    // change that never happened.
    expect(store.get(key).data).toEqual(ada);
    void app;
  });

  it("keeps the optimistic value when it succeeds", async () => {
    const { store, rows } = setup(new Map());
    const key = "list";

    const saving = createApp(
      { save: defineRoute({ method: "post", path: "/save" }, async () => "ok") },
      { services: { rows } },
    );

    await runMutation(store, saving.save, undefined, { optimistic: { key, value: [grace] } }, {
      onPending: () => {},
      onSuccess: () => {},
      onError: () => {},
    });

    expect(store.get(key).data).toEqual([grace]);
  });

  it("invalidates every call to a route, not just one key", async () => {
    const { store, rows } = setup(new Map());
    const key = callKey("list", undefined);
    store.set(key, [ada]);
    store.set(callKey("list", { limit: 10 }), [grace]);

    const saving = createApp(
      { save: defineRoute({ method: "post", path: "/save" }, async () => "ok") },
      { services: { rows } },
    );

    // Naming the route invalidates every call to it whatever its arguments. Listing
    // each key means writing down every argument a component ever fetched, which is
    // wrong the moment one asks for an id nobody predicted.
    await runMutation(store, saving.save, undefined, { invalidates: ["list"] }, {
      onPending: () => {},
      onSuccess: () => {},
      onError: () => {},
    });

    expect(store.get(key).stale).toBe(true);
    expect(store.get(callKey("list", { limit: 10 })).stale).toBe(true);
  });
});

describe("Untested-at-runtime bindings", () => {
  it("exposes the Solid, Svelte, Angular and Qwik surfaces", () => {
    // Typechecked, not exercised. This records that the entry points exist and
    // have the shape a component expects, and nothing more.
    const solid: unknown = useSolidCall;
    const svelte: unknown = useSvelteCall;
    const angular: unknown = YattaAngularClient;
    const factory: unknown = createAngularClient;

    expect(typeof solid).toBe("function");
    expect(typeof svelte).toBe("function");
    expect(typeof angular).toBe("function");
    expect(typeof factory).toBe("function");
  });

  it("builds an Angular client whose calls report state", async () => {
    // The one part of the Angular path that can run without a renderer: the
    // binding is driven by a callback, so a fake signal proves the wiring.
    const { store, rows } = setup(new Map([["u1", ada]]));
    rows.set("u1", ada);

    const { app } = setup(rows);

    let bumps = 0;
    const client = new YattaAngularClient(app as never, store, () => {
      bumps++;
    });

    const call = client.call(app.getUser, { params: { id: "u1" } });
    await Bun.sleep(20);

    // `state()` reads through Angular's signal, which needs the renderer, so what
    // is verified here is that the call loaded and the store is wired in.
    expect(store.get(callKey(app.getUser, { params: { id: "u1" } })).data).toEqual(ada);
    void bumps;

    call.destroy();
  });
});
describe("Vue — rendered", () => {
  it("renders a component that reads a route, over a real SSR render", async () => {
    const { createSSRApp, h } = await import("vue");
    const { renderToString } = await import("@vue/server-renderer");

    const { store, rows } = setup(new Map([["u1", ada]]));
    const { app } = setup(rows);

    // Seeded, because a render is synchronous and cannot await a fetch. This is
    // the realistic server-render shape anyway: the data is loaded, then rendered.
    store.set(callKey(app.getUser, { params: { id: "u1" } }), ada);

    function Profile() {
      const { state } = vueUseCall(store, app.getUser, { params: { id: "u1" } });
      return h("h1", state.value.data?.name ?? "loading");
    }

    // A real Vue render, not a stub. The value is already in the store, so it
    // appears in the first markup — which is the point: a ref written in an effect
    // would render "loading" and correct itself afterwards, which is a visible
    // flash and a hydration mismatch.
    const html = await renderToString(createSSRApp(Profile));
    expect(html).toContain("Ada");
    expect(html).not.toContain("loading");
  });
});

describe("Solid — signal logic, rendering unverified", () => {
  it("reads through to the store and updates when it changes", async () => {
    const { store, rows } = setup(new Map([["u1", ada]]));
    const { app } = setup(rows);
    store.set(callKey(app.getUser, { params: { id: "u1" } }), ada);

    // Solid's binding is a `createSignal` plus a store subscription. Both work
    // without a renderer, so both are asserted here. Turning that into markup
    // needs Solid's compiler, which this environment does not run.
    const accessor = useSolidCall(store, app.getUser, { params: { id: "u1" } });

    expect(accessor().data).toEqual(ada);

    store.set(callKey(app.getUser, { params: { id: "u1" } }), grace);

    // Read through on every call, so a notification that has not propagated yet
    // cannot hand back the previous value.
    expect(accessor().data).toEqual(grace);

    accessor.destroy();
  });

  it("reports fetching before the value arrives", async () => {
    const { store, rows } = setup(new Map());
    const { app } = setup(rows);

    const accessor = useSolidCall(store, app.getUser, { params: { id: "missing" } });

    // The store holds no value and no error yet: the request has not finished.
    expect(accessor().fetching).toBe(true);
    expect(accessor().data).toBeUndefined();

    accessor.destroy();
  });
});
