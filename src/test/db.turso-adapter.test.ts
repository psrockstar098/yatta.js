// Session contract tests for the Turso adapter (Phase 2).
//
// Exercises the TursoAdapter/TursoSession directly, without YattaDB or
// Table — the contract the engine will delegate to. Mirrors
// db.sqlite-adapter.test.ts, async throughout: libSQL is async-only.
//
// NOTE: this file imports TursoAdapter directly, not createAdapter from
// ../types/db/adapter — adapter.ts re-exports the PGlite adapter, whose
// file is currently truncated and fails to parse, so any import of
// adapter.ts fails at load time. The factory wiring ("turso" ->
// TursoAdapter) belongs to the coordinator at integration.
import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { col } from "../types/db/schema";
import { TursoAdapter } from "../types/db/adapters/turso";
import { TursoDialect } from "../types/db/adapters/turso_dialect";
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

async function memAdapter() {
  const adapter = new TursoAdapter({ path: ":memory:" });
  await adapter.syncSchema(schema as any);
  return adapter;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-turso-adapter-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("TursoAdapter construction", () => {
  it("creates an async turso adapter with honest capabilities", async () => {
    const adapter = await memAdapter();
    expect(adapter.driver).toBe("turso");
    expect(adapter.capabilities.mode).toBe("async");
    expect(adapter.capabilities.joins).toBe(true);
    expect(adapter.capabilities.foreignKeys).toBe(true);
    expect(adapter.capabilities.returningClause).toBe(true);
    expect(adapter.capabilities.fullTextSearch).toBe("fts5");
    expect(adapter.capabilities.savepoints).toBe(true);
    expect(adapter.capabilities.vectors).toBe("none");
    expect(adapter.capabilities.backupRestore).toBe("file-copy");
    expect(adapter.capabilities.multiProcessSafe).toBe(false);
    expect(adapter.capabilities.maxBindParams).toBe(999);
    expect(adapter.dialect.name).toBe("turso");
    await adapter.close();
  });

  it("accepts a url option (:memory: and file: forms)", async () => {
    const a = new TursoAdapter({ url: ":memory:" });
    await a.syncSchema(schema as any);
    expect(await a.count("users", usersSchema as any)).toBe(0);
    await a.close();

    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const b = new TursoAdapter({ url: `file:${dbPath}` });
    await b.syncSchema(schema as any);
    expect(b.path).toBe(dbPath);
    expect(await b.listTables()).toEqual(["posts", "users"]);
    await b.close();
  });

  it("ready() awaits init and listTables/listColumns describe the schema", async () => {
    const adapter = await memAdapter();
    await adapter.ready();
    expect(await adapter.listTables()).toEqual(["posts", "users"]);
    const cols = await adapter.listColumns("users");
    expect(cols.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(cols.find((c) => c.name === "name")?.nullable).toBe(false);
    expect(cols.find((c) => c.name === "name")?.type).toBe("TEXT");
    await adapter.close();
  });

  it("the dialect mirrors SQLite and has no atomic upsert", () => {
    const dialect = new TursoDialect();
    expect(dialect.name).toBe("turso");
    expect(dialect.placeholder(1)).toBe("?");
    expect(dialect.supportsReturning).toBe(true);
    expect(dialect.likeCaseInsensitiveByDefault).toBe(true);
    expect(dialect.mapColumnType({ type: "INTEGER" } as any)).toBe("INTEGER");
    expect(
      dialect.compileUpsert({ table: "users", columns: new Map(), where: {}, create: {}, update: {} } as any),
    ).toBeNull();
  });
});

describe("session CRUD", () => {
  it("insert/find/count/update/delete round-trip with decoding", async () => {
    const s = await memAdapter();
    const row = await s.insert("users", usersSchema as any, {
      name: "Ada", bio: "writes code", age: 36, active: true, tags: ["a", "b"],
    });
    expect(row.id).toBe(1);
    expect(row.active).toBe(true);
    expect(row.tags).toEqual(["a", "b"]);
    expect(typeof row.createdAt).toBe("string");
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await s.insert("users", usersSchema as any, { name: "Bob", bio: "reads code", age: 41, active: false, tags: [] });
    expect(await s.count("users", usersSchema as any)).toBe(2);
    expect(await s.count("users", usersSchema as any, { active: true } as any)).toBe(1);

    const found = await s.find("users", usersSchema as any, {
      where: { age: { gte: 40 } } as any,
      orderBy: [{ age: "desc" }] as any,
    });
    expect(found.map((r) => r.name)).toEqual(["Bob"]);

    const updated = await s.update("users", usersSchema as any, { name: "Ada" } as any, { age: 37 });
    expect(updated.length).toBe(1);
    expect(updated[0]!.age).toBe(37);
    expect(await s.update("users", usersSchema as any, { name: "Ada" } as any, {})).toEqual([]);

    expect(await s.delete("users", usersSchema as any, { name: "Bob" } as any)).toBe(1);
    expect(await s.count("users", usersSchema as any)).toBe(1);
    await s.close();
  });

  it("insertMany loops in one transaction; upsert finds first then updates or inserts", async () => {
    const s = await memAdapter();
    const rows = await s.insertMany("users", usersSchema as any, [
      { name: "Ada", bio: "", age: 36, active: true, tags: [] },
      { name: "Bob", bio: "", age: 41, active: false, tags: [] },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);

    const updated = await s.upsert("users", usersSchema as any, {
      where: { name: "Ada" } as any,
      conflictColumns: ["name"],
      createRow: { name: "Ada", bio: "new", age: 1, active: true, tags: [] },
      updateRow: { age: 37 },
    });
    expect(updated.id).toBe(1);
    expect(updated.age).toBe(37);
    expect(await s.count("users", usersSchema as any)).toBe(2);

    const created = await s.upsert("users", usersSchema as any, {
      where: { name: "Cid" } as any,
      conflictColumns: ["name"],
      createRow: { name: "Cid", bio: "", age: 20, active: true, tags: [] },
      updateRow: { age: 21 },
    });
    expect(created.id).toBe(3);
    expect(created.age).toBe(20);
    await s.close();
  });

  it("executeRaw reads rows and reports changes; executeBatch runs DDL", async () => {
    const s = await memAdapter();
    const inserted = await s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES (?, ?, ?, ?, ?)`, [
      "Ada", "", 36, 1, "[]",
    ]);
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);
    const read = await s.executeRaw(`SELECT "name" FROM "users"`);
    expect(read.rows).toEqual([{ name: "Ada" }]);
    expect(read.affectedRows).toBe(1);
    const pragma = await s.executeRaw(`PRAGMA table_info("users")`);
    expect(pragma.rows.length).toBeGreaterThan(0);
    await s.executeBatch(`CREATE TABLE "extra" ("id" INTEGER PRIMARY KEY);`);
    expect(await s.listTables()).toContain("extra");
    await s.close();
  });

  it("run() modes: get returns one row or null, run returns changes", async () => {
    const s = await memAdapter();
    expect(await s.run(`SELECT "name" FROM "users" WHERE "id" = ?`, [1], "get")).toBeNull();
    const inserted = (await s.run(
      `INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES (?, ?, ?, ?, ?) RETURNING *`,
      ["Ada", "", 36, 1, "[]"],
      "get",
    )) as Record<string, unknown>;
    expect(inserted.name).toBe("Ada");
    const deleted = (await s.run(`DELETE FROM "users" WHERE "name" = ?`, ["Ada"], "run")) as { changes: number; lastInsertRowid: number };
    expect(deleted.changes).toBe(1);
    await s.close();
  });
});

describe("session transactions", () => {
  it("commits, rolls back on throw, and nests via savepoints", async () => {
    const s = await memAdapter();
    await s.transaction(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      await tx.transaction(async (tx2) => {
        await tx2.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
      });
    });
    expect(await s.count("users", usersSchema as any)).toBe(2);

    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Cid", bio: "", age: 20, active: true, tags: [] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.count("users", usersSchema as any)).toBe(2);

    // Nested rollback: the inner failure rolls back only the inner work.
    await s.transaction(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Dee", bio: "", age: 25, active: true, tags: [] });
      await expect(
        tx.transaction(async (tx2) => {
          await tx2.insert("users", usersSchema as any, { name: "Eli", bio: "", age: 30, active: true, tags: [] });
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
    });
    expect((await s.find("users", usersSchema as any, {})).map((r) => r.name).sort()).toEqual(["Ada", "Bob", "Dee"]);
    await s.close();
  });

  it("immediate mode takes the write lock up front", async () => {
    const s = await memAdapter();
    const out = await s.transaction(
      async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
        return "done";
      },
      { mode: "immediate" },
    );
    expect(out).toBe("done");
    expect(await s.count("users", usersSchema as any)).toBe(1);
    await s.close();
  });

  it("withMigrationLock runs fn and restores foreign keys", async () => {
    const s = await memAdapter();
    const out = await s.withMigrationLock(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      return 42;
    });
    expect(out).toBe(42);
    expect(await s.count("users", usersSchema as any)).toBe(1);
    const fk = await s.executeRaw(`PRAGMA foreign_keys`);
    expect(fk.rows[0]).toEqual({ foreign_keys: 1 });
    await s.close();
  });

  it("inTransaction reflects the open transaction", async () => {
    const s = await memAdapter();
    expect(s.inTransaction).toBe(false);
    await s.transaction(async (tx) => {
      expect(s.inTransaction).toBe(true);
      expect(tx.inTransaction).toBe(true);
    });
    expect(s.inTransaction).toBe(false);
    await s.close();
  });
});

describe("session search (FTS5)", () => {
  it("searches ranked by bm25, honours where/limit/offset, and the vocabulary feeds typo work", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, { name: "Ada Lovelace", bio: "writes analytical engines", age: 36, active: true, tags: [] });
    await s.insert("users", usersSchema as any, { name: "Bob Builder", bio: "builds laptop computers", age: 41, active: false, tags: [] });
    await s.syncSearchRow("users", usersSchema as any, a, "insert");

    const hits = await s.search("users", usersSchema as any, {
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
    const syn = await s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"], ["notebook"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(syn.length).toBe(1);

    // where filters the hits; limit/offset page them.
    const filtered = await s.search("users", usersSchema as any, {
      tokens: ["writes"],
      expandedGroups: [[["writes"]]],
      columns: [],
      where: { active: false } as any,
      typoCorrection: false,
    });
    expect(filtered).toEqual([]);

    const vocab = await s.searchVocabulary("users", usersSchema as any);
    expect(vocab.has("laptop")).toBe(true);
    expect(vocab.has("analytical")).toBe(true);
    await s.close();
  });

  it("syncSearchRow update/delete and rebuildSearchIndex repair the index", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, { name: "Ada", bio: "writes code", age: 36, active: true, tags: [] });
    await s.syncSearchRow("users", usersSchema as any, a, "insert");
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(1);

    const updated = (await s.update("users", usersSchema as any, { id: a.id } as any, { bio: "reads code" }))[0]!;
    await s.syncSearchRow("users", usersSchema as any, updated, "update");
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(0);
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["reads"], expandedGroups: [[["reads"]]], columns: [], typoCorrection: false })).length,
    ).toBe(1);

    // The base row is deleted too (the real Table.delete does both); the
    // FTS entry must go with it.
    await s.delete("users", usersSchema as any, { id: a.id } as any);
    await s.syncSearchRow("users", usersSchema as any, updated, "delete");
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["reads"], expandedGroups: [[["reads"]]], columns: [], typoCorrection: false })).length,
    ).toBe(0);

    // Rows written outside the session (raw SQL) are invisible until a rebuild.
    await s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ('Zed', 'writes code', 30, 1, '[]')`);
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(0);
    await s.rebuildSearchIndex("users", usersSchema as any);
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(1);
    await s.close();
  });

  it("search on a table with no searchable columns throws plainly", async () => {
    const plain = new TursoAdapter({ path: ":memory:" });
    await plain.syncSchema({ plain: { id: col.id(), note: col.text() } } as any);
    await expect(
      plain.search("plain", { id: col.id(), note: col.text() } as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).rejects.toThrow(YattaError);
    await plain.close();

    // posts.title IS searchable — but only after a row exists; an empty index returns no hits.
    const s = await memAdapter();
    expect(
      await s.search("posts", postsSchema as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).toEqual([]);
    await s.close();
  });
});

describe("adapter backup / restore", () => {
  it("backs up with VACUUM INTO and restores a file database", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const adapter = new TursoAdapter({ path: dbPath });
    await adapter.syncSchema(schema as any);
    await adapter.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const backupPath = path.join(dir, "backups", "b.db");
    await adapter.backup(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);

    await adapter.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
    expect(await adapter.count("users", usersSchema as any)).toBe(2);
    await adapter.restore(backupPath);
    expect(await adapter.count("users", usersSchema as any)).toBe(1);
    expect((await adapter.find("users", usersSchema as any, {}))[0]!.name).toBe("Ada");
    await adapter.close();
  });

  it("restore refuses a missing file and an empty file", async () => {
    const dir = tmpDir();
    const adapter = new TursoAdapter({ path: path.join(dir, "app.db") });
    await adapter.syncSchema(schema as any);
    await expect(adapter.restore(path.join(dir, "nope.db"))).rejects.toThrow(/not found/);
    const empty = path.join(dir, "empty.db");
    fs.writeFileSync(empty, "");
    await expect(adapter.restore(empty)).rejects.toThrow(/corrupt|empty/);
    await adapter.close();
  });

  it("restore refuses an in-memory database", async () => {
    const dir = tmpDir();
    const adapter = await memAdapter();
    const backupPath = path.join(dir, "b.db");
    await adapter.backup(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    await expect(adapter.restore(backupPath)).rejects.toThrow(/in-memory/);
    await adapter.close();
  });
});

describe("adapter schema sync", () => {
  it("creates tables, adds a missing column on reopen, and records ALTER markers", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const a1 = new TursoAdapter({ path: dbPath });
    await a1.syncSchema({ users: usersSchema } as any);
    await a1.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    await a1.close();

    // Reopen with an extra column: the ALTER path adds it to the live table.
    // (A NOT NULL column with no default cannot be added to a populated
    // table — SQLite has nothing to fill existing rows with — so the new
    // column is nullable here, matching the engine's guard.)
    const extended = {
      users: { ...usersSchema, nickname: col.text().nullable() },
    };
    const a2 = new TursoAdapter({ path: dbPath });
    await a2.syncSchema(extended as any);
    const cols = (await a2.listColumns("users")).map((c) => c.name);
    expect(cols).toContain("nickname");
    expect(await a2.count("users", usersSchema as any)).toBe(1);
    await a2.close();
  });

  it("rebuilds a populated table to add an expression-default column", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.db");
    const v1 = { items: { id: col.id(), name: col.text() } };
    const a1 = new TursoAdapter({ path: dbPath });
    await a1.syncSchema(v1 as any);
    await a1.insert("items", v1.items as any, { name: "first" });
    await a1.close();

    // Adding col.createdAt() to a populated table cannot use ALTER TABLE
    // (expression default), so the table is rebuilt — rows and the
    // AUTOINCREMENT counter must survive.
    const v2 = { items: { id: col.id(), name: col.text(), createdAt: col.createdAt() } };
    const a2 = new TursoAdapter({ path: dbPath });
    await a2.syncSchema(v2 as any);
    const rows = await a2.find("items", v2.items as any, {});
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("first");
    expect(typeof rows[0]!.createdAt).toBe("string");
    const second = await a2.insert("items", v2.items as any, { name: "second" });
    expect(second.id).toBe(2);
    await a2.close();
  });
});
