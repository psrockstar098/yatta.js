import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, type TypedDatabase } from "../types/db";

/**
 * sqlite-vec backend tests. These run only where a vec0 binary is
 * loadable at process start — that needs the binary on SQLite's library
 * search path, e.g.:
 *
 *   LD_LIBRARY_PATH=/path/to/dir/with/vec0.so bun test src/test/vectors_vec.test.ts
 *
 * Everywhere else the whole file skips, and vectors.test.ts covers the
 * plain-SQLite path that ships by default. Skipping (not failing) is
 * deliberate: vec0 is an operator-installed native binary, not a Yatta
 * dependency, so its absence is a configuration fact, not a bug.
 */

const schema = {};
type Schema = typeof schema;
const dbs: TypedDatabase<Schema>[] = [];
let savedBackend: string | undefined;

function vecAvailableAtStart(): boolean {
  try {
    const probe = new Database(":memory:");
    try {
      probe.loadExtension("vec0");
      probe.query("SELECT vec_version()").get();
      return true;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}
const vecAvailable = vecAvailableAtStart();

beforeEach(() => {
  savedBackend = process.env.YATTA_VECTORS_BACKEND;
  delete process.env.YATTA_VECTORS_BACKEND; // auto: must resolve to sqlite-vec here
});

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch {}
  }
  if (savedBackend === undefined) delete process.env.YATTA_VECTORS_BACKEND;
  else process.env.YATTA_VECTORS_BACKEND = savedBackend;
});

function fresh(): TypedDatabase<Schema> {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true }) as TypedDatabase<Schema>;
  dbs.push(db);
  return db;
}

function seed(db: TypedDatabase<Schema>) {
  db.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0], metadata: { title: "cats" } });
  db.vectors.upsert("docs", { id: "b", embedding: [0.6, 0.8, 0], metadata: { title: "mixed" } });
  db.vectors.upsert("docs", { id: "c", embedding: [0, 1, 0] });
}

// When vec0 is absent, every test below skips with this note instead of
// failing on a missing optional native binary.
const test = vecAvailable ? it : it.skip;
const testDescribe = vecAvailable ? describe : describe.skip;

testDescribe("vectors: sqlite-vec backend", () => {
  test("auto mode resolves to sqlite-vec and ranks by cosine", () => {
    const db = fresh();
    expect(db.vectors.backend).toBe("undecided");
    seed(db);
    expect(db.vectors.backend).toBe("sqlite-vec");
    const hits = db.vectors.search("docs", [1, 0, 0]);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.score).toBeCloseTo(0.6, 5);
    expect(hits[2]!.score).toBeCloseTo(0, 5);
  });

  test("limit, threshold, and includeEmbedding match the SQL backend's contract", () => {
    const db = fresh();
    seed(db);
    expect(db.vectors.search("docs", [1, 0, 0], { limit: 2 }).map((h) => h.id)).toEqual(["a", "b"]);
    // Threshold fetches past k = limit, so qualifying rows are not cut off.
    expect(db.vectors.search("docs", [1, 0, 0], { threshold: 0.7 }).map((h) => h.id)).toEqual(["a"]);
    const withVec = db.vectors.search("docs", [1, 0, 0], { limit: 1, includeEmbedding: true });
    expect(withVec[0]!.embedding).toEqual([1, 0, 0]);
    expect(db.vectors.search("docs", [1, 0, 0])[0]!.embedding).toBeUndefined();
  });

  test("upsert replaces, remove deletes, get returns the stored (raw) vector", () => {
    const db = fresh();
    seed(db);
    db.vectors.upsert("docs", { id: "c", embedding: [1, 0, 0] });
    expect(db.vectors.get("docs", "c")).toEqual({ id: "c", embedding: [1, 0, 0], metadata: null });
    expect(db.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a", "c", "b"]);
    expect(db.vectors.remove("docs", "c")).toBe(true);
    expect(db.vectors.count("docs")).toBe(2);
    expect(db.vectors.get("docs", "c")).toBeNull();
  });

  test("drop removes the virtual table, the meta table, and the registry row", () => {
    const db = fresh();
    seed(db);
    expect(db.vectors.dropCollection("docs")).toBe(true);
    expect(db.vectors.listCollections()).toEqual([]);
    expect(() => db.vectors.count("docs")).toThrow(/Unknown vector collection/);
  });

  test("a vec-backed collection refuses writes from a vec-less process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-vectors-vec-"));
    const file = path.join(dir, "app.db");
    delete process.env.YATTA_VECTORS_BACKEND; // auto -> sqlite-vec here
    const first = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    first.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
    first.close();
    process.env.YATTA_VECTORS_BACKEND = "sqlite";
    const second = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    dbs.push(second);
    expect(() => second.vectors.upsert("docs", { id: "b", embedding: [0, 1, 0] })).toThrow(
      /stored with sqlite-vec/,
    );
    expect(() => second.vectors.search("docs", [1, 0, 0])).toThrow(/stored with sqlite-vec/);
  });

  test("a plain-SQLite collection stays writable from a vec-capable process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-vectors-vec-"));
    const file = path.join(dir, "app.db");
    process.env.YATTA_VECTORS_BACKEND = "sqlite";
    const first = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    first.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
    first.close();
    delete process.env.YATTA_VECTORS_BACKEND; // auto -> sqlite-vec here
    const second = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    dbs.push(second);
    // Per-collection backend governs: SQL rows are served by SQL even
    // where vec0 is available, so old collections keep working.
    second.vectors.upsert("docs", { id: "b", embedding: [0, 1, 0] });
    expect(second.vectors.listCollections()).toEqual([{ name: "docs", dimensions: 3, backend: "sqlite" }]);
    expect(second.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a", "b"]);
  });

  test("dimension mismatches are refused by the vec0 table too", () => {
    const db = fresh();
    seed(db);
    expect(() => db.vectors.upsert("docs", { id: "d", embedding: [1, 0] })).toThrow(/dimensional/);
    expect(() => db.vectors.search("docs", [1, 0])).toThrow(/dimensions/);
  });
});
