import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, col, type TypedDatabase } from "../types/db";

/*
 * Regression tests for the FTS performance work (1.0.6 follow-up):
 * inserts skip the full-scan DELETE for the fresh row, search verifies
 * index counts once per process open, and the typo vocabulary is cached
 * (invalidated on every index write). Each test pins behaviour, not
 * timing — the benchmarks in /tmp/perf carry the numbers.
 */

const schema = {
  notes: {
    id: col.id(),
    title: col.text().searchable(),
    body: col.text().searchable(),
  },
};

type Schema = typeof schema;
const dbs: TypedDatabase<Schema>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch {}
  }
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fresh(path = ":memory:") {
  const db = createDatabase({ path, schema, forceNew: true }) as TypedDatabase<Schema>;
  dbs.push(db);
  return db;
}

describe("FTS insert path (skip DELETE for fresh rows)", () => {
  it("finds an inserted row by search", () => {
    const db = fresh();
    db.notes.insert({ title: "Zebra stripes", body: "black and white" });
    const hits = db.notes.search("zebra");
    expect(hits.length).toBe(1);
    expect((hits[0]!.row as any).title).toBe("Zebra stripes");
  });

  it("an update replaces the entry: new text found, old text gone, row returned once", () => {
    const db = fresh();
    const row = db.notes.insert({ title: "Zebra stripes", body: "black and white" });
    db.notes.updateById(row.id, { title: "Giraffe spots" });
    expect(db.notes.search("zebra")).toHaveLength(0);
    const hits = db.notes.search("giraffe");
    expect(hits).toHaveLength(1);
    expect((hits[0]!.row as any).title).toBe("Giraffe spots");
  });

  it("delete then re-insert with the same id leaves exactly one entry", () => {
    const db = fresh();
    const row = db.notes.insert({ id: 7, title: "Zebra stripes", body: "black and white" });
    db.notes.deleteById(row.id);
    expect(db.notes.search("zebra")).toHaveLength(0);
    db.notes.insert({ id: 7, title: "Zebra returns", body: "black and white" });
    const hits = db.notes.search("zebra");
    expect(hits).toHaveLength(1);
    expect((hits[0]!.row as any).title).toBe("Zebra returns");
  });

  it("insertMany rows are all searchable", () => {
    const db = fresh();
    db.notes.insertMany([
      { title: "Alpha one", body: "first" },
      { title: "Beta two", body: "second" },
      { title: "Gamma three", body: "third" },
    ]);
    expect(db.notes.search("alpha")).toHaveLength(1);
    expect(db.notes.search("beta")).toHaveLength(1);
    expect(db.notes.search("gamma")).toHaveLength(1);
  });
});

describe("FTS vocabulary cache", () => {
  it("a typo search finds a term inserted after the first search", () => {
    const db = fresh();
    db.notes.insert({ title: "Zebra stripes", body: "black and white" });
    // First search populates the cached vocabulary.
    expect(db.notes.search("zebra")).toHaveLength(1);
    // A new term afterwards must invalidate the cache, or the typo
    // correction would never learn it.
    db.notes.insert({ title: "Quokka hops", body: "small marsupial" });
    const hits = db.notes.search("quokak");
    expect(hits).toHaveLength(1);
    expect((hits[0]!.row as any).title).toBe("Quokka hops");
  });

  it("a deleted term stops being suggested", () => {
    const db = fresh();
    const row = db.notes.insert({ title: "Zebra stripes", body: "black and white" });
    expect(db.notes.search("zebr")).toHaveLength(1);
    db.notes.deleteById(row.id);
    expect(db.notes.search("zebr")).toHaveLength(0);
  });
});

describe("FTS count verification across opens", () => {
  it("a fresh open detects rows added outside the Table paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "yatta-fts-perf-"));
    dirs.push(dir);
    const path = join(dir, "app.db");
    const first = fresh(path);
    first.notes.insert({ title: "Zebra stripes", body: "black and white" });
    // Verify counts once in this process.
    expect(first.notes.search("zebra")).toHaveLength(1);
    // A row written behind the Table's back.
    const raw = new Database(path);
    raw.run(`INSERT INTO "notes" ("title", "body") VALUES ('Outlaw row', 'written raw');`);
    raw.close();
    first.close();
    dbs.splice(dbs.indexOf(first), 1);
    // A new process open re-verifies and repairs the index.
    const second = fresh(path);
    const hits = second.notes.search("outlaw");
    expect(hits).toHaveLength(1);
    expect((hits[0]!.row as any).title).toBe("Outlaw row");
  });
});
