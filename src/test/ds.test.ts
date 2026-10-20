import { describe, it, expect } from "bun:test";
import {
  StringMap,
  ColumnStore,
  TaskGroup,
  Batch,
  defaultStringHasher,
  createStringMap,
  createColumnStore,
  createTaskGroup,
  createBatch,
} from "../types/ds";

// ────────────────────────────────────────────────────────────────────────
// StringMap
// ────────────────────────────────────────────────────────────────────────

describe("StringMap", () => {
  it("puts, gets, removes, and reports size", () => {
    const m = createStringMap<number>();
    expect(m.put("a", 1)).toBeUndefined();
    expect(m.put("a", 2)).toBe(1);
    expect(m.get("a")).toBe(2);
    expect(m.has("a")).toBe(true);
    expect(m.size).toBe(1);
    expect(m.remove("a")).toBe(2);
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it("handles many keys across growth and tombstones", () => {
    const m = createStringMap<number>({ capacity: 8 });
    for (let i = 0; i < 500; i++) m.put(`k${i}`, i);
    expect(m.size).toBe(500);
    for (let i = 0; i < 500; i += 2) m.remove(`k${i}`);
    expect(m.size).toBe(250);
    for (let i = 1; i < 500; i += 2) expect(m.get(`k${i}`)).toBe(i);
    for (let i = 0; i < 500; i += 2) expect(m.get(`k${i}`)).toBeUndefined();
    // Re-insert the deleted half (tombstone reuse).
    for (let i = 0; i < 500; i += 2) m.put(`k${i}`, i * 10);
    for (let i = 0; i < 500; i++) {
      expect(m.get(`k${i}`)).toBe(i % 2 === 0 ? i * 10 : i);
    }
  });

  it("putIfAbsent only inserts when absent", () => {
    const m = new StringMap<string>();
    expect(m.putIfAbsent("x", "one")).toBe(true);
    expect(m.putIfAbsent("x", "two")).toBe(false);
    expect(m.get("x")).toBe("one");
  });

  it("iterates every entry exactly once", () => {
    const m = createStringMap<number>();
    for (let i = 0; i < 100; i++) m.put(`key-${i}`, i);
    const seen = new Set<string>();
    for (const [k, v] of m) {
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(v).toBe(Number(k.slice(4)));
    }
    expect(seen.size).toBe(100);
    expect([...m.keys()].length).toBe(100);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(4950);
  });

  it("clear empties the map but keeps capacity", () => {
    const m = createStringMap<number>({ capacity: 64 });
    m.put("a", 1);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.get("a")).toBeUndefined();
    expect(m.capacity).toBe(64);
  });

  it("ensureCapacity preallocates without losing entries", () => {
    const m = createStringMap<number>();
    m.put("a", 1);
    m.ensureCapacity(1000);
    expect(m.capacity).toBeGreaterThanOrEqual(1000);
    expect(m.get("a")).toBe(1);
  });

  it("deterministic hasher gives stable results across instances", () => {
    expect(defaultStringHasher("hello")).toBe(defaultStringHasher("hello"));
    expect(defaultStringHasher("hello")).not.toBe(defaultStringHasher("hellp"));
    const a = createStringMap<number>();
    const b = createStringMap<number>();
    for (let i = 0; i < 50; i++) {
      a.put(`k${i}`, i);
      b.put(`k${i}`, i);
    }
    expect([...a.keys()]).toEqual([...b.keys()]);
  });

  it("accepts a custom hasher", () => {
    const m = createStringMap<number>({ hasher: (s) => s.length });
    m.put("aa", 1);
    m.put("bb", 2); // collides with "aa" under length-hashing
    expect(m.get("aa")).toBe(1);
    expect(m.get("bb")).toBe(2);
    expect(m.size).toBe(2);
  });

  it("rejects invalid loadFactor", () => {
    expect(() => createStringMap({ loadFactor: 0 })).toThrow(RangeError);
    expect(() => createStringMap({ loadFactor: 1 })).toThrow(RangeError);
  });
});

// ────────────────────────────────────────────────────────────────────────
// ColumnStore
// ────────────────────────────────────────────────────────────────────────

describe("ColumnStore", () => {
  const schema = { id: "u32", score: "f64", name: "string" } as const;

  it("appends, gets, and reports len", () => {
    const rows = createColumnStore(schema);
    rows.append({ id: 1, score: 9.5, name: "ada" });
    rows.append({ id: 2, score: 7.25, name: "gus" });
    expect(rows.len).toBe(2);
    expect(rows.get(0)).toEqual({ id: 1, score: 9.5, name: "ada" });
    expect(rows.get(1)).toEqual({ id: 2, score: 7.25, name: "gus" });
  });

  it("grows past initial capacity", () => {
    const rows = createColumnStore(schema, 2);
    for (let i = 0; i < 1000; i++) rows.append({ id: i, score: i / 2, name: `n${i}` });
    expect(rows.len).toBe(1000);
    expect(rows.get(999)).toEqual({ id: 999, score: 499.5, name: "n999" });
  });

  it("field() returns a typed, live view for numeric columns", () => {
    const rows = createColumnStore(schema);
    rows.append({ id: 1, score: 1.5, name: "a" });
    rows.append({ id: 2, score: 2.5, name: "b" });
    const scores = rows.field("score") as unknown as Float64Array;
    expect(scores).toBeInstanceOf(Float64Array);
    expect([...scores]).toEqual([1.5, 2.5]);
    scores[0] = 10;
    expect(rows.get(0).score).toBe(10);
    const ids = rows.field("id") as unknown as Uint32Array;
    expect(ids).toBeInstanceOf(Uint32Array);
  });

  it("set does partial updates and bounds-checks", () => {
    const rows = createColumnStore(schema);
    rows.append({ id: 1, score: 1, name: "a" });
    rows.set(0, { score: 42 });
    expect(rows.get(0)).toEqual({ id: 1, score: 42, name: "a" });
    expect(() => rows.set(5, { score: 1 })).toThrow(RangeError);
    expect(() => rows.get(-1)).toThrow(RangeError);
  });

  it("swapRemove is O(1) and returns the removed row", () => {
    const rows = createColumnStore(schema);
    rows.append({ id: 1, score: 1, name: "a" });
    rows.append({ id: 2, score: 2, name: "b" });
    rows.append({ id: 3, score: 3, name: "c" });
    const removed = rows.swapRemove(0);
    expect(removed).toEqual({ id: 1, score: 1, name: "a" });
    expect(rows.len).toBe(2);
    expect(rows.get(0).id).toBe(3); // last row moved into slot 0
  });

  it("pop and clear work; missing fields default to 0/undefined", () => {
    const rows = createColumnStore({ n: "u32", label: "string" } as const);
    rows.append({ n: 5 });
    const r = rows.get(0);
    expect(r.n).toBe(5);
    expect(r.label).toBeUndefined();
    const popped = rows.pop() as unknown as { n: number; label?: string };
    expect(popped.n).toBe(5);
    expect(popped.label).toBeUndefined();
    expect(rows.pop()).toBeUndefined();
    rows.append({ n: 1, label: "x" });
    rows.clear();
    expect(rows.len).toBe(0);
  });

  it("iterates rows in order", () => {
    const rows = createColumnStore(schema);
    for (let i = 0; i < 5; i++) rows.append({ id: i, score: i, name: `${i}` });
    expect([...rows].map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// TaskGroup
// ────────────────────────────────────────────────────────────────────────

describe("TaskGroup", () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("waitAll returns results in spawn order", async () => {
    const g = createTaskGroup();
    g.spawn(async () => { await delay(30); return "slow"; });
    g.spawn(async () => { await delay(5); return "fast"; });
    const results = await g.waitAll();
    expect(results).toEqual(["slow", "fast"]);
  });

  it("aggregates every failure into one AggregateError", async () => {
    const g = createTaskGroup();
    g.spawn(async () => { throw new Error("boom-1"); });
    g.spawn(async () => "ok");
    g.spawn(async () => { throw new Error("boom-2"); });
    let caught: unknown;
    try {
      await g.waitAll();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const errs = (caught as AggregateError).errors;
    expect(errs.map((e: Error) => e.message).sort()).toEqual(["boom-1", "boom-2"]);
  });

  it("respects the concurrency limit", async () => {
    const g = createTaskGroup({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      g.spawn(async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(15);
        active--;
        return i;
      });
    }
    const results = await g.waitAll();
    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("cancel() propagates to running tasks and blocks queued ones", async () => {
    const g = createTaskGroup({ concurrency: 1 });
    const started: string[] = [];
    let observedAbort = false;
    g.spawn(async (signal) => {
      started.push("first");
      await new Promise<void>((_, rej) => {
        const t = setTimeout(() => rej(new Error("should not finish")), 200);
        signal.addEventListener("abort", () => {
          observedAbort = true;
          clearTimeout(t);
          rej(new Error("aborted"));
        }, { once: true });
      });
    });
    g.spawn(async () => { started.push("second"); return "second"; });
    await delay(10);
    g.cancel("stop it");
    let caught: unknown;
    try {
      await g.waitAll();
    } catch (e) {
      caught = e;
    }
    expect(observedAbort).toBe(true);
    expect(started).toEqual(["first"]); // queued task never started
    expect(caught).toBeInstanceOf(AggregateError);
  });

  it("spawn after cancel returns a rejected handle", async () => {
    const g = createTaskGroup();
    g.cancel();
    const h = g.spawn(async () => 1);
    await expect(h.promise).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Batch
// ────────────────────────────────────────────────────────────────────────

describe("Batch", () => {
  const dir = `/tmp/yatta-ds-batch-${process.pid}`;

  it("runs mixed file ops with ordered, failure-as-data results", async () => {
    // Batch ops run concurrently, so dependent ops go in separate batches.
    const setup = createBatch();
    setup.mkdir(dir).write(`${dir}/a.txt`, "hello");
    await setup.run();

    const b = createBatch();
    b.read(`${dir}/a.txt`)
      .read(`${dir}/missing.txt`)
      .stat(`${dir}/a.txt`);
    const results = await b.run();
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({ ok: true, value: "hello" });
    expect(results[1]!.ok).toBe(false); // missing file is data, not a throw
    expect(results[2]!.ok).toBe(true);
    await createBatch().rm(dir).run();
  });

  it("throwOnError throws the first failing op's error", async () => {
    const b = createBatch();
    b.read("/definitely/not/here.txt");
    await expect(b.run({ throwOnError: true })).rejects.toBeDefined();
  });

  it("respects per-op timeouts", async () => {
    const b = createBatch({ timeoutMs: 20 });
    b.op(() => new Promise((r) => setTimeout(r, 500)));
    const results = await b.run();
    expect(results[0]!.ok).toBe(false);
    expect((results[0] as { ok: false; error: Error }).error.message).toContain("timed out");
  });

  it("listDir and custom ops work", async () => {
    const setup = createBatch();
    setup.mkdir(dir).write(`${dir}/x.txt`, "1").write(`${dir}/y.txt`, "2");
    await setup.run();

    const b = createBatch();
    b.listDir(dir);
    const results = await b.run();
    const listing = (results[0] as { ok: true; value: string[] }).value;
    expect(listing.sort()).toEqual(["x.txt", "y.txt"]);
    const c = createBatch();
    c.op(async () => 40 + 2);
    expect(await c.run()).toEqual([{ ok: true, value: 42 }]);
    await createBatch().rm(dir).run();
  });

  it("empty batch resolves to no results", async () => {
    expect(await new Batch().run()).toEqual([]);
    expect(await new TaskGroup().waitAll()).toEqual([]);
  });
});
