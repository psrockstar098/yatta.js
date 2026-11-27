// Session contract tests (Phase 2).
//
// Exercises the PGliteAdapter/PGliteSession directly, without YattaDB or
// Table — the contract the engine will delegate to. Mirrors
// db.sqlite-adapter.test.ts, adapted for Postgres semantics:
//   - everything is async (createAdapter("pglite") returns an async adapter)
//   - search is tsvector (+ GIN) with an ILIKE fallback for tables with no
//     searchable columns, rank is -ts_rank (smaller is better, like bm25)
//   - backup/restore is dumpDataDir/loadDataDir, not a file copy
//   - one PGlite instance costs ~3-6s to start (WASM + initdb), so tests
//     share one in-memory adapter per describe block and pass explicit
//     timeouts; a fresh adapter per test would make the file take minutes.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { col } from "../types/db/schema";
import { createAdapter } from "../types/db/adapter";
import type { DatabaseAdapter } from "../types/db/adapter";
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
  // No searchable columns: search falls back to ILIKE across TEXT columns.
  notes: {
    id: col.id(),
    note: col.text(),
    tag: col.text(),
  },
  // Searchable but keyless: search must refuse it plainly.
  keyless: {
    note: col.text().searchable(),
  },
};

const usersSchema = schema.users;
const postsSchema = schema.posts;
const notesSchema = schema.notes;
const keylessSchema = schema.keyless;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-pglite-"));
  tmpDirs.push(dir);
  return dir;
}

async function cleanAll(adapter: DatabaseAdapter<"async">): Promise<void> {
  await adapter.executeRaw(`TRUNCATE "users", "posts", "notes", "keyless" RESTART IDENTITY CASCADE;`);
}

describe("createAdapter (pglite)", () => {
  it("creates an async pglite adapter with honest capabilities", async () => {
    const adapter = createAdapter("pglite", {});
    expect(adapter.driver).toBe("pglite");
    expect(adapter.capabilities.mode).toBe("async");
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.foreignKeys).toBe(true);
    expect(adapter.capabilities.returningClause).toBe(true);
    expect(adapter.capabilities.fullTextSearch).toBe("pg_fts");
    expect(adapter.capabilities.multiProcessSafe).toBe(false);
    expect(adapter.capabilities.backupRestore).toBe("pglite-tar");
    expect(adapter.capabilities.maxBindParams).toBe(65535);
    await adapter.close();
  }, 30000);

  it("refuses pool.min > 1 and clamps pool.max to 1", async () => {
    expect(() => createAdapter("pglite", { pool: { min: 2 } })).toThrow(YattaError);
    expect(() => createAdapter("pglite", { pool: { min: 2 } })).toThrow(/single-connection/);
    const adapter = createAdapter("pglite", { pool: { max: 5, min: 1 } });
    await adapter.ready();
    await adapter.close();
  }, 30000);

  it("throws for unknown drivers and for a dataDir that is a file", () => {
    expect(() => createAdapter("turso" as any)).toThrow(YattaError);
    expect(() => createAdapter("duckdb" as any)).toThrow(YattaError);
    const dir = tmpDir();
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x");
    expect(() => createAdapter("pglite", { dataDir: file })).toThrow(/not a directory/);
  });

  it("ready() initializes lazily and listTables/listColumns describe the schema", async () => {
    const adapter = createAdapter("pglite", {});
    await adapter.ready();
    await adapter.syncSchema(schema as any);
    expect(await adapter.listTables()).toEqual(["keyless", "notes", "posts", "users"]);
    const cols = await adapter.listColumns("users");
    expect(cols.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(cols.find((c) => c.name === "name")?.nullable).toBe(false);
    expect(cols.find((c) => c.name === "name")?.type).toBe("text");
    expect(cols.find((c) => c.name === "age")?.type).toBe("bigint");
    await adapter.close();
  }, 30000);
});

describe("session CRUD", () => {
  let s: DatabaseAdapter<"async">;
  beforeAll(async () => {
    s = createAdapter("pglite", {});
    await s.syncSchema(schema as any);
  }, 60000);
  afterAll(async () => {
    await s.close();
  });
  beforeEach(async () => {
    await cleanAll(s);
  });

  it("insert/find/count/update/delete round-trip with decoding", async () => {
    const row = await s.insert("users", usersSchema as any, {
      name: "Ada", bio: "writes code", age: 36, active: true, tags: ["a", "b"],
    });
    expect(row.id).toBe(1);
    expect(row.active).toBe(true);
    expect(row.tags).toEqual(["a", "b"]);
    expect(typeof row.createdAt).toBe("string");
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The generated search column is an index, not data: it must not leak into rows.
    expect("__yatta_tsv" in row).toBe(false);

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
  }, 30000);

  it("insertMany loops in one transaction; upsert finds first then updates or inserts", async () => {
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
  }, 30000);

  it("explicit-id inserts move the identity sequence past the explicit id", async () => {
    const explicit = await s.insert("users", usersSchema as any, {
      id: 10, name: "Explicit", bio: "", age: 30, active: true, tags: [],
    });
    expect(explicit.id).toBe(10);
    const next = await s.insert("users", usersSchema as any, {
      name: "Next", bio: "", age: 31, active: true, tags: [],
    });
    expect(next.id).toBe(11);
  }, 30000);

  it("executeRaw reads rows and reports changes; executeBatch runs DDL", async () => {
    const inserted = await s.executeRaw(
      `INSERT INTO "users" ("name", "bio", "age", "active", "tags") VALUES ($1, $2, $3, $4, $5)`,
      ["Ada", "", 36, true, "[]"],
    );
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);
    const read = await s.executeRaw(`SELECT "name" FROM "users"`);
    expect(read.rows).toEqual([{ name: "Ada" }]);
    expect(read.affectedRows).toBe(1);
    await s.executeBatch(`CREATE TABLE "extra" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);`);
    expect(await s.listTables()).toContain("extra");
    await s.executeBatch(`DROP TABLE "extra";`);
  }, 30000);
});

describe("session transactions", () => {
  let s: DatabaseAdapter<"async">;
  beforeAll(async () => {
    s = createAdapter("pglite", {});
    await s.syncSchema(schema as any);
  }, 60000);
  afterAll(async () => {
    await s.close();
  });
  beforeEach(async () => {
    await cleanAll(s);
  });

  it("commits, rolls back on throw, and nests via savepoints", async () => {
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
  }, 30000);

  it("querying the root db inside a transaction throws immediately instead of deadlocking", async () => {
    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
        // The root handle, not tx: must fail fast, never wait on the gate.
        await s.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
      }),
    ).rejects.toThrow(/Deadlock prevented/);
    expect(await s.count("users", usersSchema as any)).toBe(0);
  }, 30000);

  it("withMigrationLock runs fn and returns its value", async () => {
    const out = await s.withMigrationLock(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      return 42;
    });
    expect(out).toBe(42);
    expect(await s.count("users", usersSchema as any)).toBe(1);
  }, 30000);
});

describe("session search (tsvector + ILIKE fallback)", () => {
  let s: DatabaseAdapter<"async">;
  beforeAll(async () => {
    s = createAdapter("pglite", {});
    await s.syncSchema(schema as any);
  }, 60000);
  afterAll(async () => {
    await s.close();
  });
  beforeEach(async () => {
    await cleanAll(s);
  });

  it("searches ranked by -ts_rank, honours where/limit/offset, and the vocabulary feeds typo work", async () => {
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

    // Column restriction: "laptop" is in bio, not in name.
    const byBio = await s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["bio"],
      typoCorrection: false,
    });
    expect(byBio.length).toBe(1);
    const byName = await s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["name"],
      typoCorrection: false,
    });
    expect(byName).toEqual([]);

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
  }, 30000);

  it("syncSearchRow is a no-op (the generated column maintains itself) and rebuild repairs a dropped column", async () => {
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

    await s.delete("users", usersSchema as any, { id: a.id } as any);
    await s.syncSearchRow("users", usersSchema as any, updated, "delete");
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["reads"], expandedGroups: [[["reads"]]], columns: [], typoCorrection: false })).length,
    ).toBe(0);

    // Drop the generated column by hand: search() repairs it on first use.
    await s.insert("users", usersSchema as any, { name: "Zed", bio: "writes code", age: 30, active: true, tags: [] });
    await s.executeBatch(`ALTER TABLE "users" DROP COLUMN "__yatta_tsv";`);
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(1);

    // Drop it again and rebuild explicitly instead.
    await s.executeBatch(`ALTER TABLE "users" DROP COLUMN "__yatta_tsv";`);
    await s.rebuildSearchIndex("users", usersSchema as any);
    expect(
      (await s.search("users", usersSchema as any, { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false })).length,
    ).toBe(1);
  }, 30000);

  it("search on a table with no searchable columns falls back to ILIKE", async () => {
    await s.insert("notes", notesSchema as any, { note: "buy a new laptop", tag: "todo" });
    await s.insert("notes", notesSchema as any, { note: "water the plants", tag: "home" });
    const hits = await s.search("notes", notesSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: [],
      typoCorrection: false,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.note).toBe("buy a new laptop");
    expect(typeof hits[0]!.rank).toBe("number");
    expect(hits[0]!.rank).toBeLessThan(0);
  }, 30000);

  it("search on a keyless table throws plainly; an empty index returns no hits", async () => {
    await expect(
      s.search("keyless", keylessSchema as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).rejects.toThrow(YattaError);
    expect(
      await s.search("posts", postsSchema as any, { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false }),
    ).toEqual([]);
  }, 30000);
});

describe("adapter backup / restore", () => {
  let adapter: DatabaseAdapter<"async">;
  let dir: string;
  beforeAll(async () => {
    dir = tmpDir();
    adapter = createAdapter("pglite", { dataDir: path.join(dir, "pgdata") });
    await adapter.syncSchema(schema as any);
  }, 60000);
  afterAll(async () => {
    await adapter.close();
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it("backs up with dumpDataDir and restores a persistent database", async () => {
    await adapter.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const backupPath = path.join(dir, "backups", "b.tgz");
    await adapter.backup(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);

    await adapter.insert("users", usersSchema as any, { name: "Bob", bio: "", age: 41, active: false, tags: [] });
    expect(await adapter.count("users", usersSchema as any)).toBe(2);
    await adapter.restore(backupPath);
    expect(await adapter.count("users", usersSchema as any)).toBe(1);
    expect((await adapter.find("users", usersSchema as any, {}))[0]!.name).toBe("Ada");
  }, 60000);

  it("restore refuses a missing file and an empty file", async () => {
    await expect(adapter.restore(path.join(dir, "nope.tgz"))).rejects.toThrow(/not found/);
    const empty = path.join(dir, "empty.tgz");
    fs.writeFileSync(empty, "");
    await expect(adapter.restore(empty)).rejects.toThrow(/corrupt|empty/);
  }, 30000);

  it("a second process cannot open the same dataDir while the lock is held", async () => {
    const second = createAdapter("pglite", { dataDir: path.join(dir, "pgdata") });
    await expect(second.ready()).rejects.toThrow(/already in use/);
    await adapter.close();
    // Lock released: the second adapter can now initialize.
    await second.ready();
    expect(await second.count("users", usersSchema as any)).toBe(1);
    await second.close();
    // Reopen the original adapter for afterAll's close (no-op if closed).
    adapter = createAdapter("pglite", { dataDir: path.join(dir, "pgdata") });
    await adapter.ready();
  }, 60000);
});

describe("adapter schema sync", () => {
  it("creates tables, adds a missing column on reopen, and preserves rows", async () => {
    const dir = tmpDir();
    const dataDir = path.join(dir, "pgdata");
    const a1 = createAdapter("pglite", { dataDir });
    await a1.syncSchema({ users: usersSchema } as any);
    await a1.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    await a1.close();

    const extended = {
      users: { ...usersSchema, nickname: col.text().nullable() },
    };
    const a2 = createAdapter("pglite", { dataDir });
    await a2.syncSchema(extended as any);
    const cols = (await a2.listColumns("users")).map((c) => c.name);
    expect(cols).toContain("nickname");
    expect(await a2.count("users", usersSchema as any)).toBe(1);
    await a2.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }, 60000);
});
