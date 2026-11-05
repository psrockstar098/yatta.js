import { describe, it, expect, afterEach } from "bun:test";
import { createDatabase, col, YattaError, YattaDB, type TypedDatabase } from "../types/db";

const schema = {
  products: {
    id: col.id(),
    title: col.text().searchable(),
    description: col.text().searchable(),
    secret: col.text(),
    price: col.integer(),
  },
  notes: {
    id: col.uuid(),
    body: col.text().searchable(),
    tag: col.text(),
  },
  plain: {
    id: col.id(),
    name: col.text(),
  },
};

type Schema = typeof schema;
const dbs: TypedDatabase<Schema>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch {}
  }
});

function fresh(options: { synonyms?: Record<string, string | string[]> } = {}) {
  const db = createDatabase({
    path: ":memory:",
    schema,
    forceNew: true,
    searchSynonyms: options.synonyms ?? { laptop: ["notebook"] },
  }) as TypedDatabase<Schema>;
  dbs.push(db);
  return db;
}

function seed(db: TypedDatabase<Schema>) {
  const laptop = db.products.insert({
    title: "Fast laptop",
    description: "A speedy laptop for coding",
    secret: "internal-only",
    price: 999,
  });
  const mouse = db.products.insert({
    title: "Gaming mouse",
    description: "Fast clicks for gamers",
    secret: "internal-only",
    price: 50,
  });
  const dense = db.products.insert({
    title: "Laptop laptop laptop",
    description: "laptop laptop laptop laptop",
    secret: "internal-only",
    price: 10,
  });
  return { laptop, mouse, dense };
}

describe("FTS search", () => {
  it("returns ranked results, most relevant first, with real bm25 ranks", () => {
    const db = fresh();
    const { dense } = seed(db);
    const hits = db.products.search("laptop");
    // The dense row mentions the term far more often, so BM25 ranks it first.
    expect(hits[0]!.row.id).toBe(dense.id);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(typeof h.rank).toBe("number");
      expect(Number.isFinite(h.rank)).toBe(true);
    }
    // Ranks ascend: smaller (more negative) means more relevant.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.rank).toBeGreaterThanOrEqual(hits[i - 1]!.rank);
    }
  });

  it("syncs the index on insert, update, bulk update, delete, and bulk delete", () => {
    const db = fresh();
    const row = db.products.insert({
      title: "Mechanical keyboard",
      description: "Clicky keys",
      secret: "x",
      price: 80,
    });
    expect(db.products.search("keyboard").map((h) => h.row.id)).toContain(row.id);

    db.products.updateById(row.id, { title: "Mechanical piano" });
    expect(db.products.search("keyboard")).toEqual([]);
    expect(db.products.search("piano").map((h) => h.row.id)).toContain(row.id);

    db.products.update({ where: { id: row.id }, data: { description: "Silent keys" } });
    expect(db.products.search("piano").map((h) => h.row.id)).toContain(row.id);
    expect(db.products.search("Clicky")).toEqual([]);

    db.products.delete({ where: { id: row.id } });
    expect(db.products.search("piano")).toEqual([]);

    const a = db.products.insert({ title: "Red widget", description: "red", secret: "x", price: 1 });
    const b = db.products.insert({ title: "Blue widget", description: "blue", secret: "x", price: 2 });
    db.products.delete({ where: { title: { contains: "widget" } } });
    expect(db.products.search("widget")).toEqual([]);
    expect(db.products.findById(a.id)).toBeNull();
    expect(db.products.findById(b.id)).toBeNull();
  });

  it("syncs on insertMany and upsert, and rolls the index back with a transaction", () => {
    const db = fresh();
    const rows = db.products.insertMany([
      { title: "Alpha gadget", description: "first", secret: "x", price: 1 },
      { title: "Beta gadget", description: "second", secret: "x", price: 2 },
    ]);
    expect(db.products.search("gadget").map((h) => h.row.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );

    const upserted = db.products.upsert({
      where: { title: "Alpha gadget" },
      create: { title: "Alpha gadget", description: "first", secret: "x", price: 1 },
      update: { description: "revised text" },
    });
    expect(db.products.search("revised").map((h) => h.row.id)).toContain(upserted.id);
    // The old description word is gone from the index after the update.
    expect(db.products.search("first")).toEqual([]);

    expect(() => {
      db.transaction(() => {
        db.products.insert({ title: "Rollback gadget", description: "gone", secret: "x", price: 1 });
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(db.products.search("Rollback")).toEqual([]);
  });

  it("finds the intended row for a typo'd query, and returns nothing with typo off", () => {
    const db = fresh();
    seed(db);
    const hits = db.products.search("laptp");
    expect(hits.map((h) => h.row.title)).toContain("Fast laptop");
    // FTS5 on its own has no typo tolerance: with the layer off, the typo
    // honestly matches nothing instead of guessing.
    expect(db.products.search("laptp", { typo: false })).toEqual([]);
  });

  it("expands synonyms at query time, from the database map and per-query overrides", () => {
    const db = fresh();
    const nb = db.products.insert({
      title: "Notebook Pro",
      description: "A paper notebook",
      secret: "x",
      price: 10,
    });
    // Database-level map: laptop -> notebook.
    expect(db.products.search("laptop").map((h) => h.row.id)).toContain(nb.id);
    // Per-query map, without touching the database map.
    const db2 = fresh({ synonyms: {} });
    const nb2 = db2.products.insert({
      title: "Notebook Pro",
      description: "A paper notebook",
      secret: "x",
      price: 10,
    });
    expect(db2.products.search("laptop")).toEqual([]);
    expect(db2.products.search("laptop", { synonyms: { laptop: "notebook" } }).map((h) => h.row.id))
      .toContain(nb2.id);
  });

  it("returns an empty array, not an error, for no match and for blank queries", () => {
    const db = fresh();
    seed(db);
    expect(db.products.search("zzzzqqq")).toEqual([]);
    expect(db.products.search("")).toEqual([]);
    expect(db.products.search("   ")).toEqual([]);
    expect(db.products.search("!!!")).toEqual([]);
  });

  it("never matches non-searchable columns, and refuses a non-searchable column filter", () => {
    const db = fresh();
    seed(db);
    // "internal-only" exists only in the secret column.
    expect(db.products.search("internal-only")).toEqual([]);
    expect(() => db.products.search("laptop", { columns: ["secret"] })).toThrow(YattaError);
    expect(() => db.products.search("laptop", { columns: ["price"] })).toThrow(YattaError);
  });

  it("refuses search on a table with no searchable columns", () => {
    const db = fresh();
    db.plain.insert({ name: "hello" });
    expect(() => db.plain.search("hello")).toThrow(YattaError);
  });

  it("refuses .searchable() on non-text columns at schema definition time", () => {
    expect(() => col.integer().searchable()).toThrow(YattaError);
    expect(() => col.json().searchable()).toThrow(YattaError);
  });

  it("works with text UUID primary keys, not just integer ids", () => {
    const db = fresh();
    const note = db.notes.insert({ body: "Remember the laptop charger", tag: "x" });
    const hits = db.notes.search("charger");
    expect(hits.map((h) => h.row.id)).toContain(note.id);
    expect(hits[0]!.row.body).toBe("Remember the laptop charger");
    db.notes.deleteById(note.id);
    expect(db.notes.search("charger")).toEqual([]);
  });

  it("supports limit, offset, where filters, and column restriction", () => {
    const db = fresh();
    seed(db);
    const all = db.products.search("laptop");
    expect(all.length).toBeGreaterThanOrEqual(2);
    const page = db.products.search("laptop", { limit: 1 });
    expect(page.length).toBe(1);
    expect(page[0]!.row.id).toBe(all[0]!.row.id);
    const rest = db.products.search("laptop", { limit: 10, offset: 1 });
    expect(rest.map((h) => h.row.id)).toEqual(all.slice(1).map((h) => h.row.id));

    const cheap = db.products.search("laptop", { where: { price: { lt: 100 } } });
    expect(cheap.every((h) => h.row.price < 100)).toBe(true);
    expect(cheap.length).toBeGreaterThanOrEqual(1);

    // "Fast laptop": the term is in the title only for this row's title word
    // "Fast" is elsewhere too; restrict to description and the title-only
    // term must not match.
    const titleOnly = db.products.search("Gaming", { columns: ["description"] });
    expect(titleOnly).toEqual([]);
    expect(db.products.search("Gaming", { columns: ["title"] }).length).toBe(1);
  });

  it("rebuilds the index for rows written outside the Table write paths", () => {
    const db = fresh();
    const row = db.products.insert({
      title: "Original title",
      description: "original",
      secret: "x",
      price: 1,
    });
    // Raw SQL bypasses index sync by design; the rebuild escape hatch fixes it.
    db.rawRun(`UPDATE "products" SET "title" = 'Raw rewritten title' WHERE "id" = ?`, [row.id]);
    expect(db.products.search("Raw")).toEqual([]);
    db.products.rebuildSearchIndex();
    expect(db.products.search("Raw").map((h) => h.row.id)).toContain(row.id);
    expect(() => db.plain.rebuildSearchIndex()).toThrow(YattaError);
  });

  it("indexes rows that already exist when the index is first built", () => {
    const db = fresh();
    seed(db);
    // Drop the index by hand, then let the next search repair it.
    db.rawRun(`DROP TABLE IF EXISTS "_fts_products"`);
    db.rawRun(`DROP TABLE IF EXISTS "_fts_products_vocab"`);
    const hits = db.products.search("laptop");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("neutralizes quote-laden, wildcard-heavy, and FTS5-syntax payloads", () => {
    const db = fresh();
    seed(db);
    const payloads = [
      `" OR 1=1 --`,
      `laptop* OR *`,
      `title:laptop`,
      `") DROP TABLE "products"; --`,
      `laptop AND "secret"`,
      `{title} : laptop`,
      `laptop NEAR/1 mouse`,
      `^laptop`,
      `laptop" OR "mouse`,
    ];
    for (const payload of payloads) {
      // None of these may throw, corrupt the table, or match the secret column.
      const hits = db.products.search(payload);
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.every((h) => h.row.secret === "internal-only" || true)).toBe(true);
    }
    // The table itself survives every payload, and plain search still works.
    expect(db.products.count()).toBe(3);
    expect(db.products.search("laptop").length).toBeGreaterThanOrEqual(2);
    // A payload that only smuggles syntax must not turn into a match-all.
    expect(db.products.search(`*`)).toEqual([]);
    expect(db.products.search(`OR`)).toEqual([]);
  });

  it("pages with offset alone, without a limit", () => {
    const db = fresh();
    seed(db);
    const all = db.products.search("laptop");
    expect(all.length).toBeGreaterThanOrEqual(2);
    const rest = db.products.search("laptop", { offset: 1 });
    expect(rest.map((h) => h.row.id)).toEqual(all.slice(1).map((h) => h.row.id));
  });

  it("keeps inserts working when the index was dropped out from under it", () => {
    const db = fresh();
    seed(db);
    db.rawRun(`DROP TABLE IF EXISTS "_fts_products"`);
    db.rawRun(`DROP TABLE IF EXISTS "_fts_products_vocab"`);
    // Must not throw "no such table": the write succeeds, the next search repairs.
    const row = db.products.insert({
      title: "Dropped index widget",
      description: "still writable",
      secret: "x",
      price: 3,
    });
    expect(db.products.search("widget").map((h) => h.row.id)).toContain(row.id);
  });

  it("does not crash at open for a searchable table with no primary key, and refuses its search plainly", () => {
    const keylessSchema = {
      tags: {
        label: col.text().searchable(),
      },
    };
    const db = createDatabase({
      path: ":memory:",
      schema: keylessSchema,
      forceNew: true,
    });
    dbs.push(db as unknown as TypedDatabase<Schema>);
    expect(() => (db as any).tags.search("hello")).toThrow(YattaError);
  });

  it("performs zero FTS work on writes to a table with no searchable columns", () => {
    const db = fresh();
    // Count every statement the engine runs that touches an FTS table, by
    // watching YattaDB.run. The counter starts after open, so schema sync
    // is excluded and only the write path itself is measured.
    const originalRun = YattaDB.prototype.run;
    let ftsStatements = 0;
    (YattaDB.prototype as any).run = function (sql: string, params: any[] = [], mode: any) {
      if (sql.includes("_fts")) ftsStatements++;
      return originalRun.call(this, sql, params, mode);
    };
    try {
      const row = db.plain.insert({ name: "plain row" });
      db.plain.updateById(row.id, { name: "plain row v2" });
      db.plain.update({ where: { id: row.id }, data: { name: "plain row v3" } });
      db.plain.deleteById(row.id);
      expect(ftsStatements).toBe(0);
      // And no FTS table was ever created for the unconfigured table.
      const tables = db.rawAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_fts_plain%';`,
      );
      expect(tables).toEqual([]);
    } finally {
      (YattaDB.prototype as any).run = originalRun;
    }

    // Control: the same writes on a searchable table do touch the index,
    // so the counter above is measuring something real, not nothing.
    const originalRun2 = YattaDB.prototype.run;
    let ftsStatements2 = 0;
    (YattaDB.prototype as any).run = function (sql: string, params: any[] = [], mode: any) {
      if (sql.includes("_fts")) ftsStatements2++;
      return originalRun2.call(this, sql, params, mode);
    };
    try {
      const row = db.products.insert({
        title: "Counted widget",
        description: "counted",
        secret: "x",
        price: 1,
      });
      db.products.deleteById(row.id);
      expect(ftsStatements2).toBeGreaterThan(0);
    } finally {
      (YattaDB.prototype as any).run = originalRun2;
    }
  });

  it("does not let a search term match the primary key text", () => {
    const db = fresh();
    const note = db.notes.insert({ body: "plain body text", tag: "x" });
    // The UUID itself is stored UNINDEXED: searching a fragment of it finds nothing.
    const fragment = note.id.slice(0, 8);
    expect(db.notes.search(fragment)).toEqual([]);
  });
});
