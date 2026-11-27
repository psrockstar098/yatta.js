// Session contract tests (Phase 2).
//
// Exercises the DuckDBAdapter/DuckDBSession directly, without YattaDB or
// Table — the contract the engine will delegate to. Mirrors
// db.sqlite-adapter.test.ts, with the differences DuckDB honestly has:
//   - async everywhere (the driver is Promise-based);
//   - no savepoints: a nested transaction JOINS the outer one, so an
//     inner failure rolls back everything (DuckDB 2.0.1 rejects
//     SAVEPOINT at parse time);
//   - search is a LIKE fallback, not FTS5: it reads the live rows, so
//     no syncSearchRow/rebuild step is needed for visibility, and rank
//     is the negated count of (column, token) matches;
//   - col.integer() is BIGINT, col.boolean() is BOOLEAN, col.json() is
//     JSON, and col.id() is a sequence default;
//   - backup/restore is CHECKPOINT + file copy, and refuses in-memory
//     databases.
import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { col } from "../types/db/schema";
import { DuckDBAdapter } from "../types/db/adapters/duckdb";
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
  const adapter = new DuckDBAdapter({ path: ":memory:" });
  await adapter.syncSchema(schema as any);
  return adapter;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-duckdb-adapter-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("DuckDBAdapter construction", () => {
  it("creates an async duckdb adapter with honest capabilities", async () => {
    const adapter = await memAdapter();
    expect(adapter.driver).toBe("duckdb");
    expect(adapter.capabilities.mode).toBe("async");
    expect(adapter.capabilities.joins).toBe(true);
    expect(adapter.capabilities.foreignKeys).toBe(true);
    expect(adapter.capabilities.savepoints).toBe(false);
    expect(adapter.capabilities.returningClause).toBe(true);
    expect(adapter.capabilities.fullTextSearch).toBe("like_fallback");
    expect(adapter.capabilities.vectors).toBe("none");
    expect(adapter.capabilities.backupRestore).toBe("file-copy");
    expect(adapter.capabilities.multiProcessSafe).toBe(false);
    await adapter.close();
  });

  it("ready() waits for init and listTables/listColumns describe the schema", async () => {
    const adapter = await memAdapter();
    await adapter.ready();
    expect(await adapter.listTables()).toEqual(["posts", "users"]);
    const cols = await adapter.listColumns("users");
    expect(cols.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(cols.find((c) => c.name === "id")?.type).toBe("BIGINT");
    expect(cols.find((c) => c.name === "name")?.nullable).toBe(false);
    expect(cols.find((c) => c.name === "name")?.type).toBe("VARCHAR");
    expect(cols.find((c) => c.name === "active")?.type).toBe("BOOLEAN");
    expect(cols.find((c) => c.name === "tags")?.type).toBe("JSON");
    expect(cols.find((c) => c.name === "age")?.type).toBe("BIGINT");
    await adapter.close();
  });

  it("run() returns one row, all rows, or a change count", async () => {
    const s = await memAdapter();
    const inserted = (await s.run(
      `INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      ["Ada", "writes code", 36, true, "[]"],
      "get",
    )) as Record<string, unknown>;
    // run() returns raw driver rows: BIGINT comes back as a BigInt.
    // Decoding to JS numbers happens in insert/find/update, not here.
    expect(inserted.id).toBe(1n);
    expect(inserted.active).toBe(true);
    const one = (await s.run(`SELECT "name" FROM "users" WHERE "id" = $1`, [1], "get")) as Record<string, unknown>;
    expect(one.name).toBe("Ada");
    const all = (await s.run(`SELECT "name" FROM "users"`, [], "all")) as Record<string, unknown>[];
    expect(all).toEqual([{ name: "Ada" }]);
    const changed = (await s.run(`UPDATE "users" SET "age" = $1 WHERE "id" = $2`, [37, 1], "run")) as { changes: number };
    expect(changed.changes).toBe(1);
    await s.close();
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

  it("an explicit id moves the sequence past it, so the next auto id does not collide", async () => {
    const s = await memAdapter();
    await s.insert("users", usersSchema as any, { id: 100, name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const next = await s.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
    expect(next.id).toBe(101);
    await s.close();
  });

  it("epoch-ms timestamps survive the BIGINT round-trip exactly", async () => {
    const s = await memAdapter();
    const ms = 1795833600000;
    const row = await s.insert("users", usersSchema as any, {
      name: "Ada", bio: "", age: ms, active: true, tags: [],
    });
    expect(row.age).toBe(ms);
    const found = await s.find("users", usersSchema as any, { where: { age: ms } as any });
    expect(found[0]!.age).toBe(ms);
    await s.close();
  });

  it("foreign keys are enforced: orphan child rejected, cascade deletes the child", async () => {
    const s = await memAdapter();
    const user = await s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    await expect(
      s.insert("posts", postsSchema as any, { title: "orphan", authorId: 999 }),
    ).rejects.toThrow(/foreign key/i);
    await s.insert("posts", postsSchema as any, { title: "hello", authorId: user.id });
    expect(await s.count("posts", postsSchema as any)).toBe(1);
    await s.delete("users", usersSchema as any, { id: user.id } as any);
    expect(await s.count("posts", postsSchema as any)).toBe(0);
    await s.close();
  });

  it("ON DELETE SET NULL nulls the child instead of deleting it", async () => {
    const s = new DuckDBAdapter({ path: ":memory:" });
    const sch = {
      posts: { id: col.id(), title: col.text() },
      comments: {
        id: col.id(),
        body: col.text(),
        postId: col.integer().references("posts.id", { onDelete: "SET NULL" }),
      },
    };
    await s.syncSchema(sch as any);
    const post = await s.insert("posts", sch.posts as any, { title: "hi" });
    await s.insert("comments", sch.comments as any, { body: "nice", postId: post.id });
    await s.delete("posts", sch.posts as any, { id: post.id } as any);
    const rows = await s.find("comments", sch.comments as any, {});
    expect(rows.length).toBe(1);
    expect(rows[0]!["postId"]).toBeNull();
    await s.close();
  });

  it("executeRaw reads rows and reports changes; executeBatch runs DDL; BLOB binds round-trip", async () => {
    const s = await memAdapter();
    const inserted = await s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ($1, $2, $3, $4, $5)`, [
      "Ada", "", 36, 1, "[]",
    ]);
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);
    const read = await s.executeRaw(`SELECT "name" FROM "users"`);
    expect(read.rows).toEqual([{ name: "Ada" }]);
    expect(read.affectedRows).toBe(1);
    const info = await s.executeRaw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`,
    );
    expect(info.rows.length).toBeGreaterThan(0);
    await s.executeBatch(`CREATE TABLE "extra" ("id" BIGINT PRIMARY KEY);`);
    expect(await s.listTables()).toContain("extra");

    await s.executeBatch(`CREATE TABLE "blobs" ("id" BIGINT PRIMARY KEY, "data" BLOB);`);
    await s.executeRaw(`INSERT INTO "blobs" ("id", "data") VALUES ($1, $2)`, [1, new Uint8Array([0, 255, 16])]);
    const blob = await s.executeRaw(`SELECT "data" FROM "blobs" WHERE "id" = $1`, [1]);
    expect(blob.rows[0]!["data"]).toBeInstanceOf(Uint8Array);
    expect([...(blob.rows[0]!["data"] as Uint8Array)]).toEqual([0, 255, 16]);
    await s.close();
  });
});

describe("session transactions", () => {
  it("commits, rolls back on throw, and awaits async callbacks before commit", async () => {
    const s = await memAdapter();
    await s.transaction(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      // An awaited pause inside the callback must still be inside the
      // transaction when it resumes (the async-commit bug SQLite's
      // sync guard exists to prevent).
      await new Promise((r) => setTimeout(r, 10));
      await tx.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
    });
    expect(await s.count("users", usersSchema as any)).toBe(2);

    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Cid", bio: "", age: 20, active: true, tags: [] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.count("users", usersSchema as any)).toBe(2);
    await s.close();
  });

  it("nested transactions JOIN the outer one: an inner failure rolls back everything", async () => {
    const s = await memAdapter();
    await s.transaction(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      await tx.transaction(async (inner) => {
        await inner.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
      });
    });
    expect(await s.count("users", usersSchema as any)).toBe(2);

    // No savepoints in DuckDB: the inner work is part of the outer
    // transaction, so when the inner failure propagates, the outer
    // work goes with it.
    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Dee", bio: "", age: 25, active: true, tags: [] });
        await tx.transaction(async (inner) => {
          await inner.insert("users", usersSchema as any, { name: "Eli", bio: "", age: 30, active: true, tags: [] });
          throw new Error("inner boom");
        });
      }),
    ).rejects.toThrow("inner boom");
    expect((await s.find("users", usersSchema as any, {})).map((r) => r.name).sort()).toEqual(["Ada", "Bob"]);
    await s.close();
  });

  it("a failed statement aborts the transaction, and the connection recovers after rollback", async () => {
    const s = await memAdapter();
    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
        // Duplicate primary key: the statement fails, aborting the tx.
        await tx.executeRaw(`INSERT INTO "users" ("id", "name", "bio", "age", "active", "tags") VALUES (1, 'Dup', '', 1, 1, '[]')`);
      }),
    ).rejects.toThrow(/duplicate key|PRIMARY KEY/i);
    expect(await s.count("users", usersSchema as any)).toBe(0);
    // The connection is usable again after the rollback.
    await s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    expect(await s.count("users", usersSchema as any)).toBe(1);
    await s.close();
  });

  it("immediate mode is accepted (DuckDB serializes transactions anyway)", async () => {
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

  it("withMigrationLock runs fn", async () => {
    const s = await memAdapter();
    const out = await s.withMigrationLock(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      return 42;
    });
    expect(out).toBe(42);
    expect(await s.count("users", usersSchema as any)).toBe(1);
    await s.close();
  });
});

describe("session search (LIKE fallback)", () => {
  it("searches ranked by match count, honours where/limit/offset, and the vocabulary feeds typo work", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, { name: "Ada Lovelace", bio: "writes analytical engines", age: 36, active: true, tags: [] });
    await s.insert("users", usersSchema as any, { name: "Bob Builder", bio: "builds laptop computers", age: 41, active: false, tags: [] });
    // syncSearchRow is a no-op for the LIKE fallback, but must not fail.
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

    // LIKE is case-insensitive here (ILIKE): "LAPTOP" matches too.
    const upper = await s.search("users", usersSchema as any, {
      tokens: ["LAPTOP"],
      expandedGroups: [[["LAPTOP"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(upper.length).toBe(1);

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

  it("a row matching in two columns ranks ahead of a row matching in one", async () => {
    const s = await memAdapter();
    await s.insert("users", usersSchema as any, { name: "plain", bio: "writes code", age: 30, active: true, tags: [] });
    await s.insert("users", usersSchema as any, { name: "writes", bio: "writes code", age: 31, active: true, tags: [] });
    const hits = await s.search("users", usersSchema as any, {
      tokens: ["writes"],
      expandedGroups: [[["writes"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(hits.map((h) => h.row.name)).toEqual(["writes", "plain"]);
    expect(hits[0]!.rank).toBeLessThan(hits[1]!.rank);
    await s.close();
  });

  it("search reads live rows: updates and deletes are visible without any index step", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, { name: "Ada", bio: "writes code", age: 36, active: true, tags: [] });
    const q = (t: string) => ({
      tokens: [t],
      expandedGroups: [[[t]]],
      columns: [],
      typoCorrection: false,
    });
    expect((await s.search("users", usersSchema as any, q("writes"))).length).toBe(1);

    const updated = (await s.update("users", usersSchema as any, { id: a.id } as any, { bio: "reads code" }))[0]!;
    await s.syncSearchRow("users", usersSchema as any, updated, "update");
    expect((await s.search("users", usersSchema as any, q("writes"))).length).toBe(0);
    expect((await s.search("users", usersSchema as any, q("reads"))).length).toBe(1);

    await s.delete("users", usersSchema as any, { id: a.id } as any);
    await s.syncSearchRow("users", usersSchema as any, updated, "delete");
    expect((await s.search("users", usersSchema as any, q("reads"))).length).toBe(0);

    // Rows written outside the session (raw SQL) are visible at once:
    // the LIKE fallback has no index to fall behind.
    await s.executeRaw(`INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ('Zed', 'writes code', 30, 1, '[]')`);
    expect((await s.search("users", usersSchema as any, q("writes"))).length).toBe(1);
    await s.rebuildSearchIndex("users", usersSchema as any);
    expect((await s.search("users", usersSchema as any, q("writes"))).length).toBe(1);
    await s.close();
  });

  it("search on a table with no searchable columns throws plainly", async () => {
    const plain = new DuckDBAdapter({ path: ":memory:" });
    await plain.syncSchema({ plain: { id: col.id(), note: col.text() } } as any);
    await expect(
      plain.search("plain", { id: col.id(), note: col.text() } as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).rejects.toThrow(YattaError);
    await plain.close();

    // posts.title IS searchable — but only after a row exists; an empty table returns no hits.
    const s = await memAdapter();
    expect(
      await s.search("posts", postsSchema as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).toEqual([]);
    await s.close();
  });
});

describe("adapter backup / restore", () => {
  it("backs up with CHECKPOINT + file copy and restores a file database", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.duckdb");
    const adapter = new DuckDBAdapter({ path: dbPath });
    await adapter.syncSchema(schema as any);
    await adapter.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const backupPath = path.join(dir, "backups", "b.duckdb");
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
    const adapter = new DuckDBAdapter({ path: path.join(dir, "app.duckdb") });
    await adapter.syncSchema(schema as any);
    await expect(adapter.restore(path.join(dir, "nope.duckdb"))).rejects.toThrow(/not found/);
    const empty = path.join(dir, "empty.duckdb");
    fs.writeFileSync(empty, "");
    await expect(adapter.restore(empty)).rejects.toThrow(/corrupt|valid/);
    await adapter.close();
  });

  it("backup and restore refuse in-memory databases", async () => {
    const adapter = await memAdapter();
    await expect(adapter.backup(path.join(tmpDir(), "b.duckdb"))).rejects.toThrow(/in-memory/);
    await expect(adapter.restore(path.join(tmpDir(), "b.duckdb"))).rejects.toThrow(/in-memory/);
    await adapter.close();
  });
});

describe("adapter schema sync", () => {
  it("creates tables, adds a missing column on reopen, and records ALTER markers", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.duckdb");
    const a1 = new DuckDBAdapter({ path: dbPath });
    await a1.syncSchema({ users: usersSchema } as any);
    await a1.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    await a1.close();

    // Reopen with an extra column: the ALTER path adds it to the live table.
    const extended = {
      users: { ...usersSchema, nickname: col.text().nullable() },
    };
    const a2 = new DuckDBAdapter({ path: dbPath });
    await a2.syncSchema(extended as any);
    const cols = (await a2.listColumns("users")).map((c) => c.name);
    expect(cols).toContain("nickname");
    expect(await a2.count("users", usersSchema as any)).toBe(1);
    const markers = await a2.executeRaw(
      `SELECT "name" FROM "_yatta_migrations" WHERE "name" LIKE 'alter:%'`,
    );
    expect(markers.rows.map((r) => r["name"])).toContain("alter:users.nickname");
    await a2.close();
  });

  it("adds a CURRENT_TIMESTAMP column to a populated table without a rebuild", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "app.duckdb");
    const a1 = new DuckDBAdapter({ path: dbPath });
    await a1.syncSchema({ users: usersSchema } as any);
    await a1.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    await a1.close();

    // SQLite needs a table rebuild for this case; DuckDB's ALTER TABLE
    // accepts an expression default on a populated table directly.
    const extended = {
      users: { ...usersSchema, archivedAt: col.createdAt().nullable() },
    };
    const a2 = new DuckDBAdapter({ path: dbPath });
    await a2.syncSchema(extended as any);
    const rows = await a2.find("users", usersSchema as any, {});
    expect(rows.length).toBe(1);
    await a2.close();
  });
});
