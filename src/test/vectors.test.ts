import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, type TypedDatabase } from "../types/db";
import type { VectorEmbedder } from "../types/vectors";
import { createLocalEmbedder } from "../types/vectors_embed";

/**
 * Vector search tests for the plain-SQLite backend (forced via
 * YATTA_VECTORS_BACKEND=sqlite, so these pass with no vec0 binary
 * anywhere) plus the lazy/auto behaviour that does not need vec0.
 * The sqlite-vec backend itself is covered in vectors_vec.test.ts,
 * which runs only where a vec0 binary is loadable at process start.
 */

const schema = {};
type Schema = typeof schema;
const dbs: TypedDatabase<Schema>[] = [];
let savedBackend: string | undefined;
let savedModel: string | undefined;

beforeEach(() => {
  savedBackend = process.env.YATTA_VECTORS_BACKEND;
  savedModel = process.env.YATTA_EMBEDDING_MODEL;
  process.env.YATTA_VECTORS_BACKEND = "sqlite";
  delete process.env.YATTA_EMBEDDING_MODEL;
});

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch {}
  }
  if (savedBackend === undefined) delete process.env.YATTA_VECTORS_BACKEND;
  else process.env.YATTA_VECTORS_BACKEND = savedBackend;
  if (savedModel === undefined) delete process.env.YATTA_EMBEDDING_MODEL;
  else process.env.YATTA_EMBEDDING_MODEL = savedModel;
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

/** Small deterministic embedder behind the same interface production models use. */
class FakeEmbedder implements VectorEmbedder {
  readonly dimensions = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (lower.includes("cat")) return [1, 0, 0];
      if (lower.includes("dog")) return [0, 1, 0];
      if (lower.includes("bird")) return [0, 0, 1];
      return [0.5, 0.5, 0];
    });
  }
}

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

describe("vectors: lazy loading", () => {
  it("creates no tables and loads nothing before first vector use", () => {
    const db = fresh();
    const tables = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '_vec%' OR name = '_yatta_vector_collections';`,
    );
    expect(tables).toEqual([]);
    expect(db.vectors.backend).toBe("undecided");
  });

  it("opening a database and writing normal rows never touches vectors", () => {
    process.env.YATTA_VECTORS_BACKEND = "sqlite-vec";
    const db = fresh();
    // With no vec0 binary this would throw on first vector use — but a
    // plain database open must not throw, proving the load is lazy.
    const tables = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '_vec%';`,
    );
    expect(tables).toEqual([]);
    expect(db.vectors.backend).toBe("undecided");
  });

  it("explicit sqlite-vec mode fails only on first vector use, with a clear error", () => {
    if (vecAvailable) {
      // Where vec0 loads, this failure cannot happen; the vec file covers it.
      expect(true).toBe(true);
      return;
    }
    process.env.YATTA_VECTORS_BACKEND = "sqlite-vec";
    const db = fresh();
    expect(() => db.vectors.upsert("x", { id: "1", embedding: [1, 0] })).toThrow(
      /YATTA_VECTORS_BACKEND=sqlite-vec, but the vec0 extension could not be loaded/,
    );
  });

  it("an unknown backend mode is refused, not silently reinterpreted", () => {
    process.env.YATTA_VECTORS_BACKEND = "vec0.so";
    const db = fresh();
    expect(() => db.vectors.upsert("x", { id: "1", embedding: [1, 0] })).toThrow(
      /Invalid YATTA_VECTORS_BACKEND/,
    );
  });
});

describe("vectors: store and search ranking (plain-SQLite backend)", () => {
  it("ranks by cosine similarity, most similar first", () => {
    const db = fresh();
    seed(db);
    expect(db.vectors.backend).toBe("sqlite");
    const hits = db.vectors.search("docs", [1, 0, 0]);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits[0].score).toBeCloseTo(1, 10);
    expect(hits[1].score).toBeCloseTo(0.6, 10);
    expect(hits[2].score).toBeCloseTo(0, 10);
  });

  it("orders ties by id so ranking is deterministic", () => {
    const db = fresh();
    db.vectors.upsert("docs", { id: "z", embedding: [1, 0, 0] });
    db.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
    db.vectors.upsert("docs", { id: "m", embedding: [1, 0, 0] });
    expect(db.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a", "m", "z"]);
  });

  it("respects limit, threshold, and includeEmbedding", () => {
    const db = fresh();
    seed(db);
    expect(db.vectors.search("docs", [1, 0, 0], { limit: 2 }).map((h) => h.id)).toEqual(["a", "b"]);
    expect(db.vectors.search("docs", [1, 0, 0], { threshold: 0.7 }).map((h) => h.id)).toEqual(["a"]);
    const withVec = db.vectors.search("docs", [1, 0, 0], { limit: 1, includeEmbedding: true });
    expect(withVec[0].embedding).toEqual([1, 0, 0]);
    expect(db.vectors.search("docs", [1, 0, 0])[0].embedding).toBeUndefined();
  });

  it("upsert replaces the previous vector for the same id", () => {
    const db = fresh();
    seed(db);
    db.vectors.upsert("docs", { id: "c", embedding: [1, 0, 0], metadata: { title: "now cats" } });
    const hits = db.vectors.search("docs", [1, 0, 0]);
    expect(hits[0].id).toBe("a"); // tie with c, id order
    expect(hits.map((h) => h.id)).toEqual(["a", "c", "b"]);
    expect(db.vectors.get("docs", "c")).toEqual({ id: "c", embedding: [1, 0, 0], metadata: { title: "now cats" } });
  });

  it("get, count, remove, and drop behave plainly", () => {
    const db = fresh();
    seed(db);
    expect(db.vectors.count("docs")).toBe(3);
    expect(db.vectors.get("docs", "missing")).toBeNull();
    expect(db.vectors.remove("docs", "missing")).toBe(false);
    expect(db.vectors.remove("docs", "c")).toBe(true);
    expect(db.vectors.count("docs")).toBe(2);
    expect(db.vectors.listCollections()).toEqual([{ name: "docs", dimensions: 3, backend: "sqlite" }]);
    expect(db.vectors.dropCollection("docs")).toBe(true);
    expect(db.vectors.dropCollection("docs")).toBe(false);
    expect(db.vectors.listCollections()).toEqual([]);
  });

  it("vector writes roll back with the surrounding transaction", () => {
    const db = fresh();
    expect(() =>
      db.transaction(() => {
        db.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
        throw new Error("rollback please");
      }),
    ).toThrow("rollback please");
    expect(() => db.vectors.count("docs")).toThrow(/Unknown vector collection/);
  });

  it("collections survive reopening the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-vectors-"));
    const file = path.join(dir, "app.db");
    const first = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    dbs.push(first);
    first.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
    first.close();
    dbs.splice(dbs.indexOf(first), 1);
    const second = createDatabase({ path: file, schema, forceNew: true }) as TypedDatabase<Schema>;
    dbs.push(second);
    // Reading or writing an existing plain-SQLite collection needs no
    // backend resolution, so it works while the store is still undecided;
    // creating a new collection is what resolves the backend.
    expect(second.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a"]);
    second.vectors.upsert("docs", { id: "b", embedding: [0, 1, 0] });
    expect(second.vectors.backend).toBe("undecided");
    expect(second.vectors.listCollections()).toEqual([{ name: "docs", dimensions: 3, backend: "sqlite" }]);
    second.vectors.ensureCollection("more", 2);
    expect(second.vectors.backend).toBe("sqlite");
    expect(second.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("vectors: validation", () => {
  it("refuses dimension mismatches, zero vectors, and non-finite values", () => {
    const db = fresh();
    seed(db);
    expect(() => db.vectors.upsert("docs", { id: "d", embedding: [1, 0] })).toThrow(/dimensional/);
    expect(() => db.vectors.upsert("docs", { id: "d", embedding: [0, 0, 0] })).toThrow(/Zero vectors/);
    expect(() => db.vectors.upsert("docs", { id: "d", embedding: [1, NaN, 0] })).toThrow(/finite/);
    expect(() => db.vectors.search("docs", [1, 0])).toThrow(/dimensions/);
    expect(() => db.vectors.search("docs", [0, 0, 0])).toThrow(/Zero query vectors/);
    expect(() => db.vectors.search("docs", [1, 0, 0], { limit: 0 })).toThrow(/limit/);
    expect(() => db.vectors.search("docs", [1, 0, 0], { threshold: 2 })).toThrow(/threshold/);
  });

  it("refuses a dimension mismatch on the collection itself", () => {
    const db = fresh();
    db.vectors.ensureCollection("docs", 3);
    expect(() => db.vectors.ensureCollection("docs", 4)).toThrow(/already holds 3-dimensional/);
    expect(db.vectors.ensureCollection("docs", 3).dimensions).toBe(3);
  });

  it("refuses unknown collections for read operations", () => {
    const db = fresh();
    expect(() => db.vectors.search("nope", [1, 0, 0])).toThrow(/Unknown vector collection/);
    expect(() => db.vectors.get("nope", "a")).toThrow(/Unknown vector collection/);
    expect(() => db.vectors.count("nope")).toThrow(/Unknown vector collection/);
  });
});

describe("vectors: search-input safety", () => {
  it("collection names are validated, never interpolated as raw SQL", () => {
    const db = fresh();
    expect(() =>
      db.vectors.upsert('docs"; DROP TABLE "docs"; --', { id: "x", embedding: [1, 0, 0] }),
    ).toThrow(/Invalid vector collection name/);
    expect(() => db.vectors.search("docs' OR '1'='1", [1, 0, 0])).toThrow(/Invalid vector collection name/);
  });

  it("hostile ids and metadata are stored as data, not executed", () => {
    const db = fresh();
    const nasty = `a"; DROP TABLE "_vec_docs"; --`;
    db.vectors.upsert("docs", { id: nasty, embedding: [1, 0, 0], metadata: { note: `x'); DROP TABLE docs; --` } });
    db.vectors.upsert("docs", { id: "b", embedding: [0, 1, 0] });
    expect(db.vectors.get("docs", nasty)?.embedding).toEqual([1, 0, 0]);
    expect(db.vectors.count("docs")).toBe(2);
    expect(db.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual([nasty, "b"]);
  });

  it("non-array query values are refused before any SQL runs", () => {
    const db = fresh();
    seed(db);
    expect(() => db.vectors.search("docs", "1,0,0" as unknown as number[])).toThrow(/non-empty array/);
    expect(() => db.vectors.search("docs", [1, "0", 0] as unknown as number[])).toThrow(/finite/);
  });
});

describe("vectors: text embeddings", () => {
  it("searchText and upsertText rank through a fake embedder end to end", async () => {
    const db = fresh();
    const embedder = new FakeEmbedder();
    await db.vectors.upsertText("docs", { id: "cat-doc", text: "cats are great", metadata: { kind: "cat" } }, { embedder });
    await db.vectors.upsertText("docs", { id: "dog-doc", text: "dogs are great" }, { embedder });
    await db.vectors.upsertText("docs", { id: "bird-doc", text: "birds are great" }, { embedder });
    const hits = await db.vectors.searchText("docs", "a cat", { embedder });
    // Cat doc scores 1; dog and bird docs score 0 and tie-break by id.
    expect(hits.map((h) => h.id)).toEqual(["cat-doc", "bird-doc", "dog-doc"]);
    expect(hits[0].id).toBe("cat-doc");
    expect(hits[0].score).toBeCloseTo(1, 10);
    // A store-level default embedder works without passing one per call.
    db.vectors.setEmbedder(embedder);
    const again = await db.vectors.searchText("docs", "the cat");
    expect(again[0].id).toBe("cat-doc");
    db.vectors.setEmbedder(null);
  });

  it("text calls refuse plainly with no embedder and no model configured", async () => {
    const db = fresh();
    await expect(db.vectors.searchText("docs", "hello")).rejects.toThrow(/No embedder configured/);
    await expect(db.vectors.upsertText("docs", { id: "x", text: "hello" })).rejects.toThrow(/No embedder configured/);
  });

  it("an embedder returning the wrong shape is refused, not stored", async () => {
    const db = fresh();
    // Two texts in, one vector out: embedText itself refuses.
    const short: VectorEmbedder = { async embed() { return [[1, 0, 0]]; } };
    await expect(db.vectors.embedText(["one", "two"], short)).rejects.toThrow(/for 2 texts/);
    const nan: VectorEmbedder = { async embed(texts) { return texts.map(() => [1, NaN, 0]); } };
    await expect(db.vectors.embedText(["one"], nan)).rejects.toThrow(/finite/);
    await expect(db.vectors.upsertText("docs", { id: "x", text: "one" }, { embedder: nan })).rejects.toThrow(/finite/);
    expect(() => db.vectors.count("docs")).toThrow(/Unknown vector collection/);
  });

  it("the local embedder refuses without a model, and refuses path-like model ids", async () => {
    await expect(createLocalEmbedder()).rejects.toThrow(/YATTA_EMBEDDING_MODEL is not set/);
    process.env.YATTA_EMBEDDING_MODEL = "../evil/model";
    await expect(createLocalEmbedder()).rejects.toThrow(/Invalid YATTA_EMBEDDING_MODEL/);
    process.env.YATTA_EMBEDDING_MODEL = "/abs/model";
    await expect(createLocalEmbedder()).rejects.toThrow(/Invalid YATTA_EMBEDDING_MODEL/);
  });

  it("the local embedder reports a missing optional runtime instead of crashing on import", async () => {
    process.env.YATTA_EMBEDDING_MODEL = "vendor/tiny-model";
    await expect(createLocalEmbedder()).rejects.toThrow(/not installed/);
  });
});

// Auto mode without vec0 present must take the plain-SQLite path. Where
// vec0 loads at process start this test cannot observe a fallback, so it
// is skipped there and the vec file covers the extension path instead.
(vecAvailable ? it.skip : it)("auto mode falls back to plain SQLite when vec0 is absent", () => {
  delete process.env.YATTA_VECTORS_BACKEND;
  const db = fresh();
  db.vectors.upsert("docs", { id: "a", embedding: [1, 0, 0] });
  expect(db.vectors.backend).toBe("sqlite");
  expect(db.vectors.search("docs", [1, 0, 0]).map((h) => h.id)).toEqual(["a"]);
});
