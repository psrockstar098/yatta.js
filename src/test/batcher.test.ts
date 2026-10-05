import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { DataLoader, batchBy, withLoaders, loaderFor, hasLoaderScope } from "../types/batcher";
import { createApp, defineRoute } from "../types/universal";

/*
 * Batching turns fifty queries into one.
 *
 * The N+1 this prevents is not visible in the source: there is no repeated call in
 * a loop body, there is just `Promise.all` over a list, and every individual call
 * is correct. Nothing catches it, because nothing is wrong until the database is
 * asked fifty times.
 */

describe("DataLoader — batching", () => {
  it("turns concurrent calls into one", async () => {
    let batches = 0;

    const loader = new DataLoader<string, { id: string }>(async (keys) => {
      batches++;
      return new Map(keys.map((key) => [key, { id: key }]));
    });

    const ids = ["1", "2", "3", "4", "5"];
    const results = await Promise.all(ids.map((id) => loader.load(id)));

    // Five concurrent loads, one query. Sequentially these would be five.
    expect(batches).toBe(1);
    expect(results.map((r) => r.id)).toEqual(ids);
  });

  it("gives two loads of one key the same request", async () => {
    let asked = 0;

    const loader = new DataLoader<string, number>(async (keys) => {
      asked += keys.length;
      return new Map(keys.map((key) => [key, Number(key)]));
    });

    const [a, b] = await Promise.all([loader.load("7"), loader.load("7")]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    // Without the per-window dedupe, the second load would queue "7" again and the
    // batch would carry a key twice.
    expect(asked).toBe(1);
  });

  it("caches across windows", async () => {
    let batches = 0;

    const loader = new DataLoader<string, number>(async (keys) => {
      batches++;
      return new Map(keys.map((key) => [key, Number(key)]));
    });

    await loader.load("1");
    await loader.load("1");
    await loader.load("1");

    // Sequential calls are separate ticks, so this is only one query because of the
    // cache — batching cannot help here, and pretending otherwise would mean holding
    // the first result open until the last arrived.
    expect(batches).toBe(1);
  });

  it("can cache nothing, for values that go stale fast", async () => {
    let batches = 0;

    const loader = new DataLoader<string, number>(
      async (keys) => {
        batches++;
        return new Map(keys.map((key) => [key, Number(key)]));
      },
      { cache: false },
    );

    await loader.load("1");
    await loader.load("1");

    // A stock price or a queue depth is worth a second query and not a stale value.
    expect(batches).toBe(2);
  });

  it("accepts a plain array back, which is what a query returns", async () => {
    const loader = new DataLoader<string, number>(async (keys) =>
      keys.map((key) => Number(key)),
    );

    // Requiring every caller to build a Map would be a tax for one that buys
    // nothing; an array from `findMany` is the shape they already have.
    expect(await loader.load("3")).toBe(3);
  });

  it("rejects only the keys the batch did not answer", async () => {
    const loader = new DataLoader<string, number>(async (keys) =>
      new Map(keys.filter((key) => key !== "bad").map((key) => [key, 1])),
    );

    const results = await Promise.allSettled([loader.load("good"), loader.load("bad")]);

    expect(results[0].status).toBe("fulfilled");
    // A silent miss would hand the caller `undefined` and the failure would appear
    // three components away as a blank field.
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/did not return a result/);
  });

  it("fails every key when the batch itself throws", async () => {
    const loader = new DataLoader<string, number>(async () => {
      throw new Error("connection refused");
    });

    const results = await Promise.allSettled([loader.load("1"), loader.load("2")]);

    // One bad query rejects all of them, which is the truth: none were answered.
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("allows a retry after a failure", async () => {
    let attempts = 0;

    const loader = new DataLoader<string, number>(async (keys) => {
      attempts++;
      if (attempts === 1) throw new Error("first attempt fails");
      return new Map(keys.map((key) => [key, Number(key)]));
    });

    await loader.load("1").catch(() => undefined);
    // A poisoned key would be rejected forever, which a long-lived loader cannot
    // afford.
    expect(await loader.load("1")).toBe(1);
  });

  it("joins by a key when rows come back unordered", async () => {
    // A join or an aggregation returns rows in the database's order, so a
    // positional zip would attach values to the wrong keys.
    const rows = [
      { id: "c", score: 3 },
      { id: "a", score: 1 },
      { id: "b", score: 2 },
    ];

    const loader = batchBy<string, { id: string; score: number }>(
      async () => rows,
      (row) => row.id,
    );

    const [a, b, c] = await Promise.all([loader.load("a"), loader.load("b"), loader.load("c")]);

    expect(a?.score).toBe(1);
    expect(b?.score).toBe(2);
    expect(c?.score).toBe(3);
  });

  it("honours a batching window", async () => {
    let batches = 0;

    const loader = new DataLoader<string, number>(
      async (keys) => {
        batches++;
        return new Map(keys.map((key) => [key, Number(key)]));
      },
      { maxBatchMs: 30 },
    );

    // Started in separate ticks but inside the window, so they batch together.
    const first = loader.load("1");
    await Bun.sleep(5);
    const second = loader.load("2");

    await Promise.all([first, second]);
    expect(batches).toBe(1);
  });
});

describe("Loader scope", () => {
  it("shares one loader within a scope", () => {
    let scopeA!: DataLoader<string, number>;
    let scopeB!: DataLoader<string, number>;

    withLoaders(() => {
      const make = () => loaderFor<string, number>("users", async () => new Map());
      scopeA = make();
      scopeB = make();
    });

    // Two components asking for the same loader get the same one, so their keys
    // dedupe against each other.
    expect(scopeA).toBe(scopeB);
  });

  it("does not share between scopes", () => {
    const seen: DataLoader<string, number>[] = [];

    for (let i = 0; i < 2; i++) {
      withLoaders(() => {
        seen.push(loaderFor<string, number>("users", async () => new Map()));
      });
    }

    // A loader cached on the app would be shared by every concurrent request — a
    // cache of one user's data inside another user's response.
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("reports whether it is inside a scope", () => {
    expect(hasLoaderScope()).toBe(false);
    withLoaders(() => {
      expect(hasLoaderScope()).toBe(true);
    });
  });

  it("still works outside a scope, sharing nothing", () => {
    // Correct for a script. A server route that forgets to wrap itself loses the
    // batching but not the results, which is the safer failure.
    const a = loaderFor<string, number>("users", async () => new Map());
    const b = loaderFor<string, number>("users", async () => new Map());

    expect(a).not.toBe(b);
  });

  it("keeps concurrent requests apart", async () => {
    // The case that matters: two requests in flight at once, each with its own
    // loader. Sharing one would let one request's keys be answered from the other's
    // cached rows.
    const userId = { current: "a" };

    const loadFor = (user: string) =>
      withLoaders(async () => {
        const loader = loaderFor<string, string>(`user:${user}`, async (keys) =>
          new Map(keys.map((key) => [key, `${user}:${key}`])),
        );

        const [one, two] = await Promise.all([loader.load("1"), loader.load("2")]);
        void userId.current;
        return [one, two];
      });

    const [a, b] = await Promise.all([loadFor("alice"), loadFor("bob")]);

    expect(a).toEqual(["alice:1", "alice:2"]);
    expect(b).toEqual(["bob:1", "bob:2"]);
  });
});

describe("Batching through the app", () => {
  it("collapses the N+1 a Server Component would otherwise cause", async () => {
    let queries = 0;

    const rows = new Map(
      Array.from({ length: 50 }, (_, i) => [`u${i}`, { id: `u${i}`, name: `User ${i}` }]),
    );

    const app = createApp(
      {
        users: defineRoute({ method: "get", path: "/users", response: z.array(z.object({ id: z.string(), name: z.string() })) }, async () => {
          queries++;
          return [...rows.values()];
        }),
      },
      { services: { rows } },
    );

    // Fifty sequential awaits are fifty queries, and batching cannot help: they are
    // fifty ticks. The fix for that shape is one route that returns a list.
    for (let i = 0; i < 50; i++) await app.users();
    expect(queries).toBe(50);

    // Fifty concurrent ones are one query, which is where the loader earns its keep.
    queries = 0;

    await withLoaders(async () => {
      const loader = loaderFor<string, { id: string; name: string }>(
        "users",
        async (keys) => {
          // One query with an IN clause, rather than one per key. The counter is
          // incremented by the route itself, not here — counting in both places
          // double-counts every batch and made a correct loader look wrong.
          await app.users();
          return new Map(keys.map((key) => [key, rows.get(key)!]));
        },
      );

      const found = await Promise.all(
        Array.from({ length: 50 }, (_, i) => loader.load(`u${i}`)),
      );

      expect(found).toHaveLength(50);
      expect(found[49]?.name).toBe("User 49");
    });

    expect(queries).toBe(1);
  });

  it("makes a handler that uses a loader batch its own calls", async () => {
    let queries = 0;

    const app = createApp({
      dashboard: defineRoute(
        { method: "get", path: "/dashboard" },
        async () => {
          const loader = loaderFor<string, number>("stats", async (keys) => {
            queries++;
            return new Map(keys.map((key) => [key, keys.indexOf(key)]));
          });

          // Six concurrent loads inside one handler: one query.
          const counts = await Promise.all(
            ["a", "b", "c", "d", "e", "f"].map((key) => loader.load(key)),
          );

          return counts;
        },
      ),
    });

    await withLoaders(async () => {
      const result = await app.dashboard();
      expect(result).toEqual([0, 1, 2, 3, 4, 5]);
    });

    expect(queries).toBe(1);
  });
});