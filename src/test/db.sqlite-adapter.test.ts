// Session contract tests (Phase 1, Step 3).
//
// Exercises the SqliteAdapter/SqliteSession directly, without YattaDB or
// Table — the contract the engine will delegate to. Behaviour here must
// match the engine's: these tests pin the port, the full suite pins the
// engine.
import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { col } from "../types/db/schema";
import { createAdapter } from "../types/db/adapter";
import { YattaError } from "../types/db/errors";

const schema = {
  users: {
    id: col.id(),
    name: col.text().searchable(),
    bio: col.text().searchable(),
    age: col.integer(),
    active: col.boolean(),
    tags: col.json<string[]>(),
    createdAt: col.createdAt(),
  },
  posts: {
    id: col.id(),
    title: col.text().searchable(),
    authorId: col.integer().references("users.id", { onDelete: "CASCADE" }),
  },
};

const usersSchema = schema.users;
const postsSchema = schema.posts;

function memAdapter() {
  const adapter = createAdapter("sqlite", { path: ":memory:" });
  adapter.syncSchema(schema as any);
  return adapter;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-adapter-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("createAdapter", () => {
  it("creates a sync sqlite adapter with honest capabilities", () => {
    const adapter = memAdapter();
    expect(adapter.driver).toBe("sqlite");
    expect(adapter.capabilities.mode).toBe("sync");
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.foreignKeys).toBe(true);
    expect(adapter.capabilities.returningClause).toBe(true);
    expect(adapter.capabilities.fullTextSearch).toBe("fts5");
    expect(adapter.capabilities.multiProcessSafe).toBe(true);
    adapter.close();
  });

  it("throws for not-yet-landed drivers (turso, duckdb)", () => {
    expect(() => createAdapter("turso" as any)).toThrow(YattaError);
    expect(() => createAdapter("duckdb" as any)).toThrow(YattaError);
  });

  it("ready() is a no-op and listTables/listColumns describe the schema", () => {
    const adapter = memAdapter();
    adapter.ready();
    expect(adapter.listTables()).toEqual(["posts", "users"]);
    const cols = adapter.listColumns("users");
    expect(cols.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(cols.find((c) => c.name === "name")?.nullable).toBe(false);
    expect(cols.find((c) => c.name === "name")?.type).toBe("TEXT");
    adapter.close();
  });
});

describe("session CRUD", () => {
  it("insert/find/count/update/delete round-trip with decoding", () => {
    const s = memAdapter();
    const row = s.insert("users", usersSchema as any, {
      name: "Ada", bio: "writes code", age: 36, active: true, tags: ["a", "b"],
    });
    expect(row.id).toBe(1);
    expect(row.active).toBe(true);
    expect(row.tags).toEqual(["a", "b"]);
    expect(typeof row.createdAt).toBe("string");
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    s.insert("users", usersSchema as any, { name: "Bob", bio: "reads code", age: 41, active: false, tags: [] });
    expect(s.count("users", usersSchema as any)).toBe(2);
    expect(s.count("users", usersSchema as any, { active: true } as any)).toBe(1);

    const found = s.find("users", usersSchema as any, {
      where: { age: { gte: 40 } } as any,
      orderBy: [{ age: "desc" }] as any,
    });
    expect(found.map((r) => r.name)).toEqual(["Bob"]);

    const updated = s.update("users", usersSchema as any, { name: "Ada" } as any, { age: 37 });
    expect(updated.length).toBe(1);
    expect(updated[0]!.age).toBe(37);
    expect(s.update("users", usersSchema as any, { name: "Ada" } as any, {})).toEqual([]);

    expect(s.delete("users", usersSchema as any, { name: "Bob" } as any)).toBe(1);
    expect(s.count("users", usersSchema as any)).toBe(1);
    s.close();
  });

  it("insertMany loops in one transaction; upsert finds first then updates or inserts", () => {
    const s = memAdapter();
    const rows = s.insertMany("users", usersSchema as any, [
      { name: "Ada", bio: "", age: 36, active: true, tags: [] },
      { name: "Bob", bio: "", age: 41, active: false, tags: [] },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);

    const updated = s.upsert("users", usersSchema as any, {
      where: { name: "Ada" } as any,
      conflictColumns: ["name"],
      createRow: { name: "Ada", bio: "new", age: 1, active: true, tags: [] },
      updateRow: { age: 37 },
    });
    expect(updated.id).toBe(1);
    expect(updated.age).toBe(37);
    expect(s.count("users", usersSchema as any)).toBe(2);

    const created = s.upsert("users", usersSchema as any, {
      where: { name: "Cid" } as any,
      conflictColumns: ["name"],
      createRow: { name: "Cid", bio: "", age: 20, active: true, tags: [] },
      updateRow: { age: 21 },
    });
    expect(created.id).toBe(3);
    expect(created.age).toBe(20);
    s.close();
  });

  it("executeRaw reads rows and reports changes; executeBatch runs DDL", () => {
    const s = memAdapter();
    const inserted = s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES (?, ?, ?, ?, ?)`, [
      "Ada", "", 36, 1, "[]",
    ]);
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);
    const read = s.executeRaw(`SELECT "name" FROM "users"`);
    expect(read.rows).toEqual([{ name: "Ada" }]);
    expect(read.affectedRows).toBe(1);
    const pragma = s.executeRaw(`PRAGMA table_info("users")`);
    expect(pragma.rows.length).toBeGreaterThan(0);
    s.executeBatch(`CREATE TABLE "extra" ("id" INTEGER PRIMARY KEY);`);
    expect(s.listTables()).toContain("extra");
    s.close();
  });
});

describe("session transactions", () => {
  it("commits, rolls back on throw, and nests via savepoints", () => {
    const s = memAdapter();
    s.transaction(() => {
      s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      s.transaction(() => {
        s.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
      });
    });
    expect(s.count("users", usersSchema as any)).toBe(2);

    expect(() =>
      s.transaction(() => {
        s.insert("users", usersSchema as any, { name: "Cid", bio: "", age: 20, active: true, tags: [] });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.count("users", usersSchema as any)).toBe(2);

    // Nested rollback: the inner failure rolls back only the inner work.
    s.transaction(() => {
      s.insert("users", usersSchema as any, { name: "Dee", bio: "", age: 25, active: true, tags: [] });
      expect(() =>
        s.transaction(() => {
          s.insert("users", usersSchema as any, { name: "Eli", bio: "", age: 30, active: true, tags: [] });
          throw new Error("inner boom");
        }),
      ).toThrow("inner boom");
    });
    expect(s.find("users", usersSchema as any, {}).map((r) => r.name).sort()).toEqual(["Ada", "Bob", "Dee"]);
    s.close();
  });

  it("refuses a thenable return (async callbacks commit early)", () => {
    const s = memAdapter();
    expect(() =>
      s.transaction(() => Promise.resolve(1) as any),
    ).toThrow(/sync function/);
    expect(s.count("users", usersSchema as any)).toBe(0);
    s.close();
  });

  it("immediate mode takes the write lock up front", () => {
    const s = memAdapter();
    const out = s.transaction(
      () => {
        s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
        return "done";
      },
      { mode: "immediate" },
    );
    expect(out).toBe("done");
    expect(s.count("users", usersSchema as any)).toBe(1);
    s.close();
  });

  it("withMigrationLock runs fn and restores foreign keys", () => {
    const s = memAdapter();
    const out = s.withMigrationLock(() => {
      s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      return 42;
    });
    expect(out).toBe(42);
    expect(s.count("users", usersSchema as any)).toBe(1);
    const fk = s.executeRaw(`PRAGMA foreign_keys`);
    expect(fk.rows[0]).toEqual({ foreign_keys: 1 });
    s.close();
  });
});

describe("session search (FTS5)", () => {
  it("searches ranked by bm25, honours where/limit/offset, and the vocabulary feeds typo work", () => {
    const s = memAdapter();
    const a = s.insert("users", usersSchema as any, { name: "Ada Lovelace", bio: "writes analytical engines", age: 36, active: true, tags: [] });
    s.insert("users", usersSchema as any, { name: "Bob Builder", bio: "builds laptop computers", age: 41, active: false, tags: [] });
    s.syncSearchRow("users", usersSchema as any, a, "insert");

    const hits = s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.name).toBe("Bob Builder");
    expect(typeof hits[0]!.rank).toBe("number");
    expect(hits[0]!.rank).toBeLessThan(0);

    // Synonym-expanded groups OR inside the group.
    const syn = s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"], ["notebook"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(syn.length).toBe(1);

    // where filters the hits; limit/offset page them.
    const filtered = s.search("users", usersSchema as any, {
      tokens: ["writes"],
      expandedGroups: [[["writes"]]],
      columns: [],
      where: { active: false } as any,
      typoCorrection: false,
    });
    expect(filtered).toEqual([]);

    const vocab = s.searchVocabulary("users", usersSchema as any);
    expect(vocab.has("laptop")).toBe(true);
    expect(vocab.has("analytical")).toBe(true);
    s.close();
  });

  it("syncSearchRow update/delete and rebuildSearchIndex repair the index", () => {
    const s = memAdapter();
    const a = s.insert("users", usersSchema as any, { name: "Ada", bio: "writes code", age: 36, active: true, tags: [] });
    s.syncSearchRow("users", usersSchema as any, a, "insert");
    expect(
      s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false }).length,
    ).toBe(1);

    const updated = s.update("users", usersSchema as any, { id: a.id } as any, { bio: "reads code" })[0]!;
    s.syncSearchRow("users", usersSchema as any, updated, "update");
    expect(
      s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false }).length,
    ).toBe(0);
    expect(
      s.search("users", usersSchema as any, { tokens: ["reads"], expandedGroups: [[["reads"]]], columns: [], typoCorrection: false }).length,
    ).toBe(1);

    // The base row is deleted too (the real Table.delete does both); the
    // FTS entry must go with it.
    s.delete("users", usersSchema as any, { id: a.id } as any);
    s.syncSearchRow("users", usersSchema as any, updated, "delete");
    expect(
      s.search("users", usersSchema as any, { tokens: ["reads"], expandedGroups: [[["reads"]]], columns: [], typoCorrection: false }).length,
    ).toBe(0);

    // Rows written outside the session (raw SQL) are invisible until a rebuild.
    s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ('Zed', 'writes code', 30, 1, '[]')`);
    expect(
      s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false }).length,
    ).toBe(0);
    s.rebuildSearchIndex("users", usersSchema as any);
    expect(
      s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false }).length,
    ).toBe(1);
    s.close();
  });

  it("search on a table with no searchable columns throws plainly", () => {
    const plain = createAdapter("sqlite", { path: ":memory:" });
    plain.syncSchema({ plain: { id: col.id(), note: col.text() } } as any);
    expect(() =>
      plain.search("plain", { id: col.id(), note: col.text() } as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).toThrow(YattaError);
    plain.close();

    // posts.title IS searchable — but only after a row exists; an empty index returns no hits.
    const s = memAdapter();
    expect(
      s.search("posts", postsSchema as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).toEqual([]);
    s.close();
  });
});

describe("adapter backup / restore", () => {
  it("backs up with VACUUM INTO and restores a file database", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const adapter = createAdapter("sqlite", { path: dbPath });
    adapter.syncSchema(schema as any);
    adapter.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const backupPath = path.join(dir, "backups", "b.db");
    adapter.backup(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);

    adapter.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
    expect(adapter.count("users", usersSchema as any)).toBe(2);
    adapter.restore(backupPath);
    expect(adapter.count("users", usersSchema as any)).toBe(1);
    expect(adapter.find("users", usersSchema as any, {})[0]!.name).toBe("Ada");
    adapter.close();
  });

  it("restore refuses a missing file and an empty file", () => {
    const dir = tmpDir();
    const adapter = createAdapter("sqlite", { path: path.join(dir, "app.db") });
    adapter.syncSchema(schema as any);
    expect(() => adapter.restore(path.join(dir, "nope.db"))).toThrow(/not found/);
    const empty = path.join(dir, "empty.db");
    fs.writeFileSync(empty, "");
    expect(() => adapter.restore(empty)).toThrow(/corrupt|empty/);
    adapter.close();
  });
});

describe("adapter schema sync", () => {
  it("creates tables, adds a missing column on reopen, and records ALTER markers", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const a1 = createAdapter("sqlite", { path: dbPath });
    a1.syncSchema({ users: usersSchema } as any);
    a1.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    a1.close();

    // Reopen with an extra column: the ALTER path adds it to the live table.
    // (A NOT NULL column with no default cannot be added to a populated
    // table — SQLite has nothing to fill existing rows with — so the new
    // column is nullable here, matching the engine's guard.)
    const extended = {
      users: { ...usersSchema, nickname: col.text().nullable() },
    };
    const a2 = createAdapter("sqlite", { path: dbPath });
    a2.syncSchema(extended as any);
    const cols = a2.listColumns("users").map((c) => c.name);
    expect(cols).toContain("nickname");
    expect(a2.count("users", usersSchema as any)).toBe(1);
    a2.close();
  });
});
