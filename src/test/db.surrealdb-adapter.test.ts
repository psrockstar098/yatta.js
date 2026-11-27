// Session contract tests (Phase 2).
//
// Exercises the SurrealDBAdapter/SurrealDBSession directly, without
// YattaDB or Table — the contract the engine will delegate to. Behaviour
// here must match the engine's: these tests pin the port, the full suite
// pins the engine.
//
// Differences from the SQLite port, each deliberate:
// - Everything is async (mode "async"); every call is awaited.
// - The adapter is constructed directly: createAdapter() does not know
//   "surrealdb" yet (adapter.ts is owned by the coordinator).
// - Every test gets a fresh embedded mem:// database (one Surreal client
//   per adapter), so there is no shared file to reopen: the schema-sync
//   test adds a column to a live table instead of reopening a file.
// - createdAt comes back as an ISO string from a datetime field; the
//   server emits nanosecond precision, so the assertion is "parses as a
//   date", not SQLite's 3-fraction-digit regex.
// - The full-text index maintains itself on every write, including raw
//   ones, so a row written outside the session IS searchable at once
//   (rebuildSearchIndex is still exercised, and still keeps it so).
// - DELETE returns no rows from the server, so the adapter counts first;
//   a raw DELETE reports 0 affected rows (see the executeRaw test).
// - Nested transactions throw: SurrealDB has no savepoints.
import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { col } from "../types/db/schema";
import { SurrealDBAdapter } from "../types/db/adapters/surrealdb";
import { YattaError } from "../types/db/errors";
import { RecordId } from "surrealdb";

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

const adapters: SurrealDBAdapter[] = [];
async function memAdapter() {
  const adapter = new SurrealDBAdapter();
  adapters.push(adapter);
  await adapter.syncSchema(schema as any);
  return adapter;
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    try {
      await adapter.close();
    } catch {}
  }
});

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-surrealdb-adapter-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("SurrealDBAdapter construction", () => {
  it("creates an async surrealdb adapter with honest capabilities", async () => {
    const adapter = await memAdapter();
    expect(adapter.driver).toBe("surrealdb");
    expect(adapter.path).toBe("mem://");
    expect(adapter.capabilities.mode).toBe("async");
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.foreignKeys).toBe(false);
    expect(adapter.capabilities.acidTransactions).toBe(true);
    expect(adapter.capabilities.savepoints).toBe(false);
    expect(adapter.capabilities.returningClause).toBe(true);
    // Real BM25 index; "pg_fts" is the capabilities union's "real
    // indexed FTS" bucket (it has no SurrealDB member — see the adapter
    // header), not a claim of Postgres.
    expect(adapter.capabilities.fullTextSearch).toBe("pg_fts");
    expect(adapter.capabilities.vectors).toBe("none");
    expect(adapter.capabilities.backupRestore).toBe("snapshot");
    expect(adapter.capabilities.multiProcessSafe).toBe(false);
  });

  it("ready() connects and listTables/listColumns describe the schema", async () => {
    const adapter = await memAdapter();
    await adapter.ready();
    expect(await adapter.listTables()).toEqual(["posts", "users"]);
    const cols = await adapter.listColumns("users");
    expect(cols.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(cols.find((c) => c.name === "id")?.type).toBe("int");
    expect(cols.find((c) => c.name === "name")?.nullable).toBe(false);
    expect(cols.find((c) => c.name === "name")?.type).toBe("string");
    expect(cols.find((c) => c.name === "createdAt")?.type).toBe("datetime");
    expect(await adapter.listColumns("no-such-table")).toEqual([]);
  });

  it("a uuid table generates string ids and an explicit id round-trips", async () => {
    const adapter = new SurrealDBAdapter();
    adapters.push(adapter);
    const uuidSchema = {
      things: { id: col.uuid(), label: col.text() },
    };
    await adapter.syncSchema(uuidSchema as any);
    const made = await adapter.insert("things", uuidSchema.things as any, { label: "one" });
    expect(typeof made.id).toBe("string");
    expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const explicit = await adapter.insert("things", uuidSchema.things as any, {
      id: "custom-id",
      label: "two",
    });
    expect(explicit.id).toBe("custom-id");
    expect(await adapter.count("things", uuidSchema.things as any)).toBe(2);
  });
});

describe("session CRUD", () => {
  it("insert/find/count/update/delete round-trip with decoding", async () => {
    const s = await memAdapter();
    const row = await s.insert("users", usersSchema as any, {
      name: "Ada",
      bio: "writes code",
      age: 36,
      active: true,
      tags: ["a", "b"],
    });
    // Auto-increment ids start at 1, like SQLite.
    expect(row.id).toBe(1);
    expect(row.active).toBe(true);
    expect(row.tags).toEqual(["a", "b"]);
    expect(typeof row.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(row.createdAt as string))).toBe(false);

    await s.insert("users", usersSchema as any, {
      name: "Bob",
      bio: "reads code",
      age: 41,
      active: false,
      tags: [],
    });
    expect(await s.count("users", usersSchema as any)).toBe(2);
    expect(await s.count("users", usersSchema as any, { active: true } as any)).toBe(1);

    const found = await s.find("users", usersSchema as any, {
      where: { age: { gte: 40 } } as any,
      orderBy: [{ age: "desc" }] as any,
    });
    expect(found.map((r) => r.name)).toEqual(["Bob"]);

    // Projection returns exactly the selected columns (no id smuggled in).
    const projected = await s.find("users", usersSchema as any, {
      where: { name: "Ada" } as any,
      select: ["name"],
    });
    expect(projected).toEqual([{ name: "Ada" }]);

    // take/skip page.
    const page = await s.find("users", usersSchema as any, {
      orderBy: [{ age: "asc" }] as any,
      take: 1,
      skip: 1,
    });
    expect(page.map((r) => r.name)).toEqual(["Bob"]);

    const updated = await s.update("users", usersSchema as any, { name: "Ada" } as any, { age: 37 });
    expect(updated.length).toBe(1);
    expect(updated[0]!.age).toBe(37);
    expect(await s.update("users", usersSchema as any, { name: "Ada" } as any, {})).toEqual([]);

    expect(await s.delete("users", usersSchema as any, { name: "Bob" } as any)).toBe(1);
    expect(await s.count("users", usersSchema as any)).toBe(1);
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
  });

  it("where operators: eq/ne/lt/in/like/contains/startsWith/endsWith/isNull/AND/OR", async () => {
    const s = await memAdapter();
    await s.insertMany("users", usersSchema as any, [
      { name: "Ada Lovelace", bio: "writes code", age: 36, active: true, tags: [] },
      { name: "Bob Builder", bio: "reads code", age: 41, active: false, tags: [] },
      { name: "Cid", bio: "writes tests", age: 20, active: true, tags: [] },
    ]);

    expect(
      (await s.find("users", usersSchema as any, { where: { name: { neq: "Ada Lovelace" } } as any })).length,
    ).toBe(2);
    expect(
      (await s.find("users", usersSchema as any, { where: { age: { lt: 30 } } as any })).map((r) => r.name),
    ).toEqual(["Cid"]);
    expect(
      (await s.find("users", usersSchema as any, { where: { age: { in: [36, 41] } } as any })).length,
    ).toBe(2);
    expect(
      (await s.find("users", usersSchema as any, { where: { name: { contains: "LOVE" } } as any })).map(
        (r) => r.name,
      ),
    ).toEqual(["Ada Lovelace"]);
    expect(
      (await s.find("users", usersSchema as any, { where: { name: { startsWith: "bob" } } as any })).map(
        (r) => r.name,
      ),
    ).toEqual(["Bob Builder"]);
    expect(
      (await s.find("users", usersSchema as any, { where: { bio: { endsWith: "TESTS" } } as any })).map(
        (r) => r.name,
      ),
    ).toEqual(["Cid"]);
    expect(
      (await s.find("users", usersSchema as any, { where: { name: { like: "%love%" } } as any })).map(
        (r) => r.name,
      ),
    ).toEqual(["Ada Lovelace"]);
    expect(
      (await s.find("users", usersSchema as any, {
        where: { OR: [{ age: { lt: 25 } }, { name: "Bob Builder" }] } as any,
      })).length,
    ).toBe(2);
    // By primary key (record id).
    expect(
      (await s.find("users", usersSchema as any, { where: { id: 1 } as any })).map((r) => r.name),
    ).toEqual(["Ada Lovelace"]);

    // Unknown columns, unknown operators, and LIKE shapes with no
    // SurrealQL equivalent are loud errors, never silent matches.
    await expect(
      s.find("users", usersSchema as any, { where: { emial: "a@b.c" } as any }),
    ).rejects.toThrow(YattaError);
    await expect(
      s.find("users", usersSchema as any, { where: { name: { statuss: "x" } } as any }),
    ).rejects.toThrow(YattaError);
    await expect(
      s.find("users", usersSchema as any, { where: { name: { like: "a%b%c" } } as any }),
    ).rejects.toThrow(/LIKE pattern/);
    await expect(
      s.find("users", usersSchema as any, { where: { name: { like: "a_c" } } as any }),
    ).rejects.toThrow(/LIKE pattern/);
    // The primary key is immutable: it is the record id.
    const ada = (await s.find("users", usersSchema as any, { where: { id: 1 } as any }))[0]!;
    await expect(
      s.update("users", usersSchema as any, { id: ada.id } as any, { id: 99 }),
    ).rejects.toThrow(/primary key/);
  });

  it("executeRaw reads rows and reports changes; executeBatch runs DDL", async () => {
    const s = await memAdapter();
    const inserted = await s.executeRaw(
      `INSERT INTO users (id, name, bio, age, active, tags) VALUES ($p0, $p1, $p2, $p3, $p4, $p5)`,
      [new RecordId("users", 1), "Ada", "", 36, true, "[]"],
    );
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);
    const read = await s.executeRaw(`SELECT name FROM users`);
    expect(read.rows).toEqual([{ name: "Ada" }]);
    expect(read.affectedRows).toBe(1);
    const info = await s.executeRaw(`INFO FOR TABLE users`);
    expect(Object.keys((info.rows[0] as any).fields).length).toBeGreaterThan(0);
    await s.executeBatch(`DEFINE TABLE extra SCHEMAFULL; DEFINE FIELD id ON TABLE extra TYPE int;`);
    expect(await s.listTables()).toContain("extra");
    // DELETE returns no rows from the server, so a raw DELETE reports 0
    // affected rows even though the row is gone — use session.delete()
    // when the count matters.
    const deleted = await s.executeRaw(`DELETE FROM users WHERE name = $p0`, ["Ada"]);
    expect(deleted.affectedRows).toBe(0);
    expect(await s.count("users", usersSchema as any)).toBe(0);
  });

  it("run() executes SurrealQL and returns raw rows", async () => {
    const s = await memAdapter();
    await s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
    const one = (await s.run(`SELECT * FROM users WHERE name = $p0`, ["Ada"], "get")) as any;
    expect(one.name).toBe("Ada");
    // Raw rows carry the server's own value types (RecordId), not
    // decoded ORM rows.
    expect(String(one.id)).toBe("users:1");
    const all = (await s.run(`SELECT * FROM users`, [], "all")) as any[];
    expect(all.length).toBe(1);
    const written = (await s.run(`CREATE users CONTENT { id: users:2, name: $p0, bio: '', age: 20, active: true, tags: '[]' }`, ["Bob"], "run")) as any;
    expect(written.changes).toBe(1);
    expect(await s.count("users", usersSchema as any)).toBe(2);
  });
});

describe("session transactions", () => {
  it("commits and rolls back on throw; the transaction sees its own writes, the root does not", async () => {
    const s = await memAdapter();
    await s.transaction(async (tx) => {
      await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      // Visible inside the transaction…
      expect(await tx.count("users", usersSchema as any)).toBe(1);
      // …invisible outside it until commit.
      expect(await s.count("users", usersSchema as any)).toBe(0);
    });
    expect(await s.count("users", usersSchema as any)).toBe(1);

    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Cid", bio: "", age: 20, active: true, tags: [] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.count("users", usersSchema as any)).toBe(1);
  });

  it("nested transactions throw instead of pretending (no savepoints)", async () => {
    const s = await memAdapter();
    await expect(
      s.transaction(async (tx) => {
        await tx.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
        await tx.transaction(async () => 1);
      }),
    ).rejects.toThrow(/nested transactions/);
    // The outer transaction rolled back with the throw.
    expect(await s.count("users", usersSchema as any)).toBe(0);
  });

  it("withMigrationLock runs fn and returns its value", async () => {
    const s = await memAdapter();
    const out = await s.withMigrationLock(async () => {
      await s.insert("users", usersSchema as any, { name: "Ada", bio: "", age: 36, active: true, tags: [] });
      return 42;
    });
    expect(out).toBe(42);
    expect(await s.count("users", usersSchema as any)).toBe(1);
  });
});

describe("session search (full-text BM25)", () => {
  it("searches ranked, honours where/limit/offset, and the vocabulary feeds typo work", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, {
      name: "Ada Lovelace",
      bio: "writes analytical engines",
      age: 36,
      active: true,
      tags: [],
    });
    await s.insert("users", usersSchema as any, {
      name: "Bob Builder",
      bio: "builds laptop computers",
      age: 41,
      active: false,
      tags: [],
    });
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
    // rank is -BM25 score: negative, smaller (more negative) = more relevant.
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
  });

  it("syncSearchRow is a no-op and rebuildSearchIndex keeps live rows searchable", async () => {
    const s = await memAdapter();
    const a = await s.insert("users", usersSchema as any, {
      name: "Ada",
      bio: "writes code",
      age: 36,
      active: true,
      tags: [],
    });
    await s.syncSearchRow("users", usersSchema as any, a, "insert");
    const q = { tokens: ["writes"], expandedGroups: [[["writes"]]], columns: [], typoCorrection: false } as any;
    expect((await s.search("users", usersSchema as any, q)).length).toBe(1);

    const updated = (
      await s.update("users", usersSchema as any, { id: a.id } as any, { bio: "reads code" })
    )[0]!;
    await s.syncSearchRow("users", usersSchema as any, updated, "update");
    expect((await s.search("users", usersSchema as any, q)).length).toBe(0);
    expect(
      (await s.search("users", usersSchema as any, {
        tokens: ["reads"],
        expandedGroups: [[["reads"]]],
        columns: [],
        typoCorrection: false,
      })).length,
    ).toBe(1);

    await s.delete("users", usersSchema as any, { id: a.id } as any);
    await s.syncSearchRow("users", usersSchema as any, updated, "delete");
    expect(
      (await s.search("users", usersSchema as any, {
        tokens: ["reads"],
        expandedGroups: [[["reads"]]],
        columns: [],
        typoCorrection: false,
      })).length,
    ).toBe(0);

    // Rows written outside the session are searchable at once: the
    // index lives in the database and maintains itself on every write,
    // unlike SQLite's FTS table. A rebuild keeps them searchable.
    // (A raw CREATE on an int-id table must supply the id — the server
    // cannot auto-generate an int record id.)
    await s.executeRaw(
      `CREATE users CONTENT { id: users:99, name: 'Zed', bio: 'writes code', age: 30, active: true, tags: '[]' }`,
    );
    expect((await s.search("users", usersSchema as any, q)).length).toBe(1);
    await s.rebuildSearchIndex("users", usersSchema as any);
    expect((await s.search("users", usersSchema as any, q)).length).toBe(1);
  });

  it("search on a table with no searchable columns throws plainly", async () => {
    const plain = new SurrealDBAdapter();
    adapters.push(plain);
    await plain.syncSchema({ plain: { id: col.id(), note: col.text() } } as any);
    await expect(
      plain.search(
        "plain",
        { id: col.id(), note: col.text() } as any,
        { tokens: ["x"], expandedGroups: [[["x"]]], columns: [], typoCorrection: false },
      ),
    ).rejects.toThrow(YattaError);

    // posts.title IS searchable — but only after a row exists; an empty index returns no hits.
    const s = await memAdapter();
    expect(
      await s.search("posts", postsSchema as any, {
        tokens: ["x"],
        expandedGroups: [[["x"]]],
        columns: [],
        typoCorrection: false,
      }),
    ).toEqual([]);
  });

  it("search honours a column restriction and rejects a non-searchable one", async () => {
    const s = await memAdapter();
    await s.insert("users", usersSchema as any, {
      name: "Ada Lovelace",
      bio: "writes laptop manuals",
      age: 36,
      active: true,
      tags: [],
    });
    const nameOnly = await s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["name"],
      typoCorrection: false,
    });
    expect(nameOnly).toEqual([]);
    const bioOnly = await s.search("users", usersSchema as any, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["bio"],
      typoCorrection: false,
    });
    expect(bioOnly.length).toBe(1);
    await expect(
      s.search("users", usersSchema as any, {
        tokens: ["laptop"],
        expandedGroups: [[["laptop"]]],
        columns: ["age"],
        typoCorrection: false,
      }),
    ).rejects.toThrow(/not searchable/);
  });
});

describe("adapter backup / restore", () => {
  it("backs up with EXPORT and restores from the file", async () => {
    const dir = tmpDir();
    const adapter = new SurrealDBAdapter();
    adapters.push(adapter);
    await adapter.syncSchema(schema as any);
    await adapter.insert("users", usersSchema as any, {
      name: "Ada",
      bio: "",
      age: 36,
      active: true,
      tags: [],
    });
    const backupPath = path.join(dir, "backups", "b.surql");
    await adapter.backup(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf8")).toContain("DEFINE TABLE users");

    await adapter.insert("users", usersSchema as any, {
      name: "Bob",
      bio: "",
      age: 41,
      active: false,
      tags: [],
    });
    expect(await adapter.count("users", usersSchema as any)).toBe(2);
    await adapter.restore(backupPath);
    expect(await adapter.count("users", usersSchema as any)).toBe(1);
    expect((await adapter.find("users", usersSchema as any, {}))[0]!.name).toBe("Ada");
    // Search still works after a restore (the index came back with the data).
    expect(
      (await adapter.search("users", usersSchema as any, {
        tokens: ["Ada"],
        expandedGroups: [[["Ada"]]],
        columns: ["name"],
        typoCorrection: false,
      })).length,
    ).toBe(1);
  });

  it("restore refuses a missing file and an empty file", async () => {
    const dir = tmpDir();
    const adapter = new SurrealDBAdapter();
    adapters.push(adapter);
    await adapter.syncSchema(schema as any);
    await expect(adapter.restore(path.join(dir, "nope.surql"))).rejects.toThrow(/not found/);
    const empty = path.join(dir, "empty.surql");
    fs.writeFileSync(empty, "");
    await expect(adapter.restore(empty)).rejects.toThrow(/empty/);
  });
});

describe("adapter schema sync", () => {
  it("creates tables, adds a missing column on re-sync, and records ALTER markers", async () => {
    const adapter = new SurrealDBAdapter();
    adapters.push(adapter);
    await adapter.syncSchema({ users: usersSchema } as any);
    await adapter.insert("users", usersSchema as any, {
      name: "Ada",
      bio: "",
      age: 36,
      active: true,
      tags: [],
    });

    // Re-sync with an extra column: the DEFINE FIELD path adds it to
    // the live table. (A NOT NULL column with no default cannot be
    // added to a populated table — the server has nothing to fill
    // existing rows with — so the new column is nullable here, matching
    // the engine's guard.)
    const extended = {
      users: { ...usersSchema, nickname: col.text().nullable() },
    };
    await adapter.syncSchema(extended as any);
    const cols = (await adapter.listColumns("users")).map((c) => c.name);
    expect(cols).toContain("nickname");
    expect(await adapter.count("users", usersSchema as any)).toBe(1);

    // Re-running the same schema is a no-op.
    await adapter.syncSchema(extended as any);
    expect(await adapter.count("users", usersSchema as any)).toBe(1);
  });

  it("enforces enum values and rejects a second time-series column", async () => {
    const adapter = new SurrealDBAdapter();
    adapters.push(adapter);
    await adapter.syncSchema({
      things: {
        id: col.id(),
        role: col.enum(["admin", "user"]),
      },
    } as any);
    await adapter.insert("things", { id: col.id(), role: col.enum(["admin", "user"]) } as any, {
      role: "admin",
    });
    await expect(
      adapter.insert("things", { id: col.id(), role: col.enum(["admin", "user"]) } as any, {
        role: "superuser",
      }),
    ).rejects.toThrow(/superuser/);

    const bad = new SurrealDBAdapter();
    adapters.push(bad);
    await expect(
      bad.syncSchema({
        readings: {
          id: col.id(),
          at: col.integer().timeSeries(),
          at2: col.integer().timeSeries(),
        },
      } as any),
    ).rejects.toThrow(/more than one time-series/);
  });
});
