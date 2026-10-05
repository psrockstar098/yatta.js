import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

import { createApp, defineRoute, type RouteTable } from "../types/universal";
import { QueryCache } from "../types/frontend";
import {
  callKey,
  methodName,
  CallStoreProvider,
  useCall,
  useRoutes,
  type CallStore,
} from "../react/universal-hooks";

/*
 * Scope, stated plainly: this file renders with `react-dom/server`.
 *
 * That covers the render phase — a hook is called, a snapshot is read, the tree
 * produces markup — and it covers the thing most likely to be wrong, which is
 * whether reading state during a render can be done safely at all.
 *
 * It does NOT cover effects. No DOM is available here, so mount, unmount,
 * refetch-on-mount, subscription teardown and optimistic rollback are all
 * unverified here and need a browser or a DOM environment. Nothing below claims
 * otherwise.
 */

const User = z.object({ id: z.string(), email: z.string(), name: z.string() });

function makeStore(): CallStore {
  // The framework's own cache satisfies the store shape, so the React layer is
  // tested against the real thing rather than a lookalike.
  return new QueryCache() as unknown as CallStore;
}

function makeApp(store: ReturnType<typeof makeStore>) {
  return createApp(
    {
      getUser: defineRoute(
        { method: "get", path: "/users/:id", params: z.object({ id: z.string() }), response: User },
        async ({ params, services }) => {
          const rows = services.rows as Map<string, z.infer<typeof User>>;
          return rows.get(params.id) ?? { id: params.id, email: "a@t.dev", name: "Ada" };
        },
      ),
    },
    { services: { rows: new Map() } },
  );
}

describe("React bindings — call keys", () => {
  it("gives the same key for the same question, whatever the reference", () => {
    const app = makeApp(makeStore());

    // Two objects with the same content but different key order are the same
    // question. Without the sort, every re-render with a reordered literal looks
    // like new data and refetches.
    expect(callKey(app.getUser, { params: { id: "u1" } })).toBe(
      callKey(app.getUser, { params: { id: "u1" } }),
    );

    expect(callKey(app.getUser, { params: { id: "u1" }, query: { a: 1, b: 2 } })).toBe(
      callKey(app.getUser, { query: { b: 2, a: 1 }, params: { id: "u1" } }),
    );
  });

  it("gives a different key for a different question", () => {
    const app = makeApp(makeStore());

    expect(callKey(app.getUser, { params: { id: "u1" } })).not.toBe(
      callKey(app.getUser, { params: { id: "u2" } }),
    );
  });

  it("ignores an argument that was left out", () => {
    const app = makeApp(makeStore());

    // `{ query: undefined }` and `{}` are the same call. Counting them as two is
    // how a component refetches forever because its parent passes an optional
    // argument through.
    expect(callKey(app.getUser, { params: { id: "u1" }, query: undefined })).toBe(
      callKey(app.getUser, { params: { id: "u1" } }),
    );

    expect(callKey(app.getUser, undefined)).toBe(callKey(app.getUser, {}));
  });

  it("tells two methods apart", () => {
    const app = createApp({
      a: defineRoute({ method: "get", path: "/a" }, async () => 1),
      b: defineRoute({ method: "get", path: "/b" }, async () => 2),
    });

    // Same arguments, different routes. A key built only from the arguments would
    // have these collide and one would read the other's cached value.
    expect(callKey(app.a, { x: 1 })).not.toBe(callKey(app.b, { x: 1 }));
  });

  it("names a method for the key", () => {
    const app = createApp({
      getUser: defineRoute({ method: "get", path: "/users/:id" }, async () => 1),
    });

    expect(methodName(app.getUser)).toBe("getUser");
    expect(callKey(app.getUser, {})).toStartWith("getUser:");
  });
});

describe("React bindings — rendering", () => {
  function render(ui: ReactNode, store: CallStore): string {
    return renderToString(createElement(CallStoreProvider, { store }, ui));
  }

  it("reads a cached value during render instead of blanking", () => {
    const store = makeStore();
    const app = makeApp(store);

    // Warm the cache the way a previous render would have.
    store.set(callKey(app.getUser, { params: { id: "u1" } }), {
      id: "u1",
      email: "ada@t.dev",
      name: "Ada",
    });

    function Profile() {
      const { data } = useCall(app.getUser, { params: { id: "u1" } });
      return createElement("span", null, data?.name ?? "loading");
    }

    // The point of `useSyncExternalStore` over a snapshot: a value already in the
    // store is present in the very first render. A useState version would render
    // "loading" and correct itself, which is a visible flash and a hydration
    // mismatch on the server.
    expect(render(createElement(Profile), store)).toContain("Ada");
  });

  it("renders a placeholder rather than throwing on an empty store", () => {
    const store = makeStore();
    const app = makeApp(store);

    function Profile() {
      const { data } = useCall(app.getUser, { params: { id: "u1" } });
      return createElement("span", null, data?.name ?? "none");
    }

    // Nothing cached and no effect has run, so a server render shows the empty
    // state. It must not crash, and it must not claim to have data it never
    // loaded. Note `fetching` is false here: no request was ever started, and
    // reporting it as in-flight would be a claim about work nobody is doing.
    const html = render(createElement(Profile), store);
    expect(html).toContain("none");
    expect(html).not.toContain("Ada");
  });

  it("does not call the route during a server render", () => {
    const store = makeStore();
    let calls = 0;

    const app = createApp({
      count: defineRoute({ method: "get", path: "/count" }, async () => {
        calls++;
        return 1;
      }),
    });

    function Counter() {
      const { data } = useCall(app.count);
      return createElement("span", null, String(data ?? "none"));
    }

    render(createElement(Counter), store);

    // A server render must not start work. Effects do not run, so the route is
    // not called — which is what makes a Server Component safe to render many
    // times without multiplying the requests.
    expect(calls).toBe(0);
  });

  it("says which store is missing rather than failing quietly", () => {
    function Orphan() {
      useCall(makeApp(makeStore()).getUser, { params: { id: "u1" } });
      return null;
    }

    // A hook that silently keeps no results is far harder to diagnose than one
    // that names the missing provider.
    expect(() => renderToString(createElement(Orphan))).toThrow(/CallStoreProvider/);
  });

  it("skips the call when it is told to", () => {
    const store = makeStore();
    let calls = 0;

    const app = createApp({
      count: defineRoute({ method: "get", path: "/count" }, async () => {
        calls++;
        return 1;
      }),
    });

    function Counter() {
      const { data } = useCall(app.count, undefined, { enabled: false });
      return createElement("span", null, String(data ?? "none"));
    }

    const html = render(createElement(Counter), store);

    expect(html).toContain("none");
    expect(calls).toBe(0);
  });

  it("returns the app's methods, unchanged", () => {
    const store = makeStore();
    const app = makeApp(store);
    let seen: unknown;

    function Probe() {
      const methods = useRoutes(app);
      seen = methods;
      return null;
    }

    render(createElement(Probe), store);

    // Same object, not a copy: a copy would let the store and the caller drift
    // apart, and would need its own key space.
    expect(seen).toBe(app);
  });
});

// ── Types ──────────────────────────────────────────────────────────────────

describe("React bindings — types hold at compile time", () => {
  it("takes the arguments from the route and gives back its result", () => {
    const app = makeApp(makeStore());

    const check = async () => {
      const user = await useCall(app.getUser, { params: { id: "u1" } });
      // Read off the route's declared response.
      const name: string = user.data?.name ?? "";

      // @ts-expect-error id must be a string
      await useCall(app.getUser, { params: { id: 1 } });

      // @ts-expect-error params are required
      await useCall(app.getUser, {});

      return name;
    };

    expect(typeof check).toBe("function");
  });

  it("keeps the store generic over any route table", () => {
    // A store is not tied to one app's routes, so a component can be handed a
    // different app and still work.
    const table: RouteTable = {
      anything: defineRoute({ method: "get", path: "/x" }, async () => "ok"),
    };

    const store: CallStore = makeStore();
    void table;
    void store;

    expect(true).toBe(true);
  });
});