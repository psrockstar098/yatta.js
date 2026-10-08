import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { col, createDatabase, YattaError } from "../types/db";

/*
 * Schema evolution and backup/restore.
 *
 * `syncSchema`, `backup`, `restore` and `checkIntegrity` are what a deployment depends
 * on when it changes shape or needs to be recoverable, and none of them had coverage.
 * Two of the bugs found here are the kind that only appear after real data exists.
 */

const TEST_DIR = join(import.meta.dir, "fixtures", "db-evolution");

let counter = 0;

function dbPath(name: string): string {
  return join(TEST_DIR, `${name}-${process.pid}-${counter++}.db`);
}

/** Every file SQLite may leave beside the database. */
function sidecars(path: string): string[] {
  return ["", "-wal", "-shm"].map((suffix) => path + suffix);
}

function clean(path: string): void {
  for (const file of sidecars(path)) {
    if (existsSync(file)) unlinkSync(file);
  }
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  for (const entry of readdirSync(TEST_DIR)) {
    rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
  }
});

/**
 * Creates a database with the given schema and rows.
 *
 * Deliberately not `createDatabase`, so the tests control exactly what is on disk: this
 * simulates a deployment that already shipped a version of the schema and later adds a
 * column to it.
 */
function seed(path: string, schema: Record<string, string[]>, rows: Record<string, Record<string, unknown>[]>): void {
  const raw = new Database(path, { create: true });

  for (const [table, columns] of Object.entries(schema)) {
    raw.run(`CREATE TABLE "${table}" (${(columns as string[]).join(", ")});`);
  }

  for (const [table, values] of Object.entries(rows)) {
    for (const row of values) {
      const names = Object.keys(row);
      raw.run(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) ` +
          `VALUES (${names.map(() => "?").join(", ")});`,
        Object.values(row) as any[],
      );
    }
  }

  raw.close();
}

describe("syncSchema adds a timestamp column to a table that already has rows", () => {
  /*
   * SQLite refuses `ALTER TABLE ... ADD COLUMN` with a non-constant default against a
   * table holding rows — "Cannot add a column with non-constant default" — and both
   * `col.createdAt()` and `col.updatedAt()` default to a strftime expression.
   *
   * So adding a timestamp to a table with data in it threw at boot, on every start, and
   * adding one to an empty table worked. That is the first schema change most projects
   * make, and the difference between the two cases is whether anyone has used the
   * product yet.
   */
  it("adds createdAt where SQLite's ALTER cannot", () => {
    const path = dbPath("created-at");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }, { name: "Bob" }],
    });

    const db = createDatabase({
      path,
      schema: {
        users: { id: col.id(), name: col.text(), createdAt: col.createdAt() },
      },
    });

    expect(db.users.count()).toBe(2);
  });

  it("backfills existing rows, because the column is NOT NULL", () => {
    const path = dbPath("backfill");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }, { name: "Bob" }],
    });

    const db = createDatabase({
      path,
      schema: {
        users: { id: col.id(), name: col.text(), createdAt: col.createdAt() },
      },
    });

    const rows = db.users.findMany({ orderBy: { id: "asc" } });

    // Not merely non-null: a NOT NULL column with no value would have been unreachable.
    expect(rows.every((r) => typeof r.createdAt === "string" && r.createdAt.length > 0)).toBe(true);
    // One format, which is why the default is the strftime call rather than SQLite's
    // own CURRENT_TIMESTAMP — see formatDefault.
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("gives later inserts the same format", () => {
    const path = dbPath("later");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }],
    });

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } },
    });

    const added = db.users.insert({ name: "Cy" });

    expect(added.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("keeps the AUTOINCREMENT counter, so ids do not restart", () => {
    const path = dbPath("ids");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }, { name: "Bob" }],
    });

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } },
    });

    // A rebuild that loses the counter hands out id 1 again, and the first insert then
    // collides with a row that is still there.
    const added = db.users.insert({ name: "Cy" });

    expect(added.id).toBe(3);
    expect(db.users.count()).toBe(3);
  });

  it("still uses plain ALTER on an empty table", () => {
    const path = dbPath("empty");

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } },
    });

    expect(db.users.count()).toBe(0);

    const sql = (db as any)._sqlite
      .query("SELECT sql FROM sqlite_master WHERE name = 'users';")
      .get() as { sql: string };

    expect(sql.sql).toContain("createdAt");
  });

  it("is idempotent — a second open changes nothing", () => {
    const path = dbPath("idempotent");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }],
    });

    const schema = { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } };

    createDatabase({ path, schema }).close();
    const second = createDatabase({ path, schema });

    expect(second.users.count()).toBe(1);
  });

  it("adds updatedAt the same way", () => {
    const path = dbPath("updated-at");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }],
    });

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), updatedAt: col.updatedAt() } },
    });

    expect(db.users.count()).toBe(1);
    expect(db.users.findMany({})[0]!.updatedAt).toBeTruthy();
  });

  it("adds a constant default to a populated table without a rebuild", () => {
    const path = dbPath("constant");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }],
    });

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), role: col.text().default("member") } },
    });

    expect(db.users.findMany({})[0]!.role).toBe("member");
  });
});

describe("a rebuild preserves everything the old table carried", () => {
  it("keeps indexes and triggers, which are dropped with the table", () => {
    const path = dbPath("objects");
    seed(path, { users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"] }, {
      users: [{ name: "Ada" }],
    });

    // Written by hand, so they exist only in the database and not in the schema — which
    // is the case a rebuild generated from the schema would silently drop.
    const raw = new Database(path, { create: true });
    raw.run(`CREATE UNIQUE INDEX uniq_users_name ON users(name);`);
    raw.run(
      `CREATE TRIGGER trg_users AFTER UPDATE ON users BEGIN UPDATE users SET name = name WHERE id = NEW.id; END;`,
    );
    raw.close();

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } },
    });

    const names = (db as any)._sqlite
      .query("SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = 'users';")
      .all() as { name: string }[];

    expect(names.map((n) => n.name).sort()).toEqual(["trg_users", "uniq_users_name"]);
  });

  it("keeps a column the schema no longer mentions", () => {
    const path = dbPath("extra-column");
    seed(path, {
      users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL", "legacy TEXT"],
    }, { users: [{ name: "Ada", legacy: "keep me" }] });

    const db = createDatabase({
      path,
      schema: { users: { id: col.id(), name: col.text(), createdAt: col.createdAt() } },
    });

    const raw = new Database(path, { readonly: true });
    const row = raw.query("SELECT legacy FROM users;").get() as { legacy: string } | null;
    raw.close();

    expect(row?.legacy).toBe("keep me");
  });

  it("does not rewrite another table's foreign key", () => {
    const path = dbPath("fk");
    seed(
      path,
      {
        users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"],
        posts: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "authorId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE"],
      },
      { users: [{ name: "Ada" }], posts: [{ authorId: 1 }] },
    );

    const db = createDatabase({
      path,
      schema: {
        users: { id: col.id(), name: col.text(), createdAt: col.createdAt() },
        posts: { id: col.id(), authorId: col.integer().references("users.id", { onDelete: "CASCADE" }) },
      },
    });

    // `legacy_alter_table` matters here: renaming with it off makes SQLite rewrite
    // references to the name in every other table, and the reference would point at the
    // temporary name that no longer exists.
    const child = (db as any)._sqlite
      .query("SELECT sql FROM sqlite_master WHERE name = 'posts';")
      .get() as { sql: string };

    expect(child.sql).toMatch(/REFERENCES\s+"?users"?/);
    expect((db as any)._sqlite.query("PRAGMA foreign_key_check;").all()).toEqual([]);
  });

  it("leaves enforcement working after the rebuild", () => {
    const path = dbPath("cascade");
    seed(
      path,
      {
        users: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "name TEXT NOT NULL"],
        posts: ["id INTEGER PRIMARY KEY AUTOINCREMENT", "authorId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE"],
      },
      { users: [{ name: "Ada" }], posts: [{ authorId: 1 }] },
    );

    const db = createDatabase({
      path,
      schema: {
        users: { id: col.id(), name: col.text(), createdAt: col.createdAt() },
        posts: { id: col.id(), authorId: col.integer().references("users.id", { onDelete: "CASCADE" }) },
      },
    });

    db.users.deleteById(1);

    expect(db.posts.count()).toBe(0);
  });
});

describe("checkIntegrity", () => {
  it("is true for a healthy database", () => {
    const path = dbPath("healthy");
    const db = createDatabase({ path, schema: { users: { id: col.id(), name: col.text() } } });

    db.users.insert({ name: "Ada" });

    expect(db.checkIntegrity()).toBe(true);
  });

  it("is true for a freshly created database with no rows", () => {
    const path = dbPath("no-rows");
    const db = createDatabase({ path, schema: { users: { id: col.id(), name: col.text() } } });

    expect(db.checkIntegrity()).toBe(true);
  });

  it("is true for an empty file, which is why restore cannot rely on it alone", () => {
    const path = dbPath("empty-file");
    writeFileSync(path, "");

    const raw = new Database(path, { readonly: true });
    const result = raw.query("PRAGMA quick_check;").get() as { quick_check: string };
    raw.close();

    // This is the finding: a healthy, completely empty database. `restore` accepted one
    // of these and left the live database with no tables at all.
    expect(result.quick_check).toBe("ok");
  });
});

describe("backup and restore", () => {
  const schema = { users: { id: col.id(), name: col.text() } };

  it("round-trips the rows", () => {
    const path = dbPath("round-trip");
    const backupPath = dbPath("round-trip.bak");
    const db = createDatabase({ path, schema });

    db.users.insert({ name: "Ada" });
    db.backup(backupPath);
    db.users.insert({ name: "Bob" });

    db.restore(backupPath);

    expect(db.users.findMany({})).toHaveLength(1);
    expect(db.users.findMany({})[0]!.name).toBe("Ada");
  });

  it("restores a database that has rows and no schema damage", () => {
    const path = dbPath("schema-intact");
    const backupPath = dbPath("schema-intact.bak");
    const db = createDatabase({ path, schema });

    db.users.insert({ name: "Ada" });
    db.backup(backupPath);
    db.restore(backupPath);

    // The table still exists and is queryable — restore reopens the file, so a schema
    // that did not survive would show up here as "no such table".
    expect(db.users.count()).toBe(1);
  });

  it("refuses a file that is not a database", () => {
    const path = dbPath("not-a-db");
    const junk = dbPath("junk");
    const db = createDatabase({ path, schema });

    db.users.insert({ name: "Ada" });
    writeFileSync(junk, "this is not a database, it is a sentence about one");

    expect(() => db.restore(junk)).toThrow(YattaError);
    expect(db.users.count()).toBe(1);
  });

  it("refuses a truncated database and leaves the live one untouched", () => {
    const path = dbPath("truncated");
    const backupPath = dbPath("truncated.bak");
    const truncated = dbPath("truncated.bad");
    const db = createDatabase({ path, schema });

    for (let i = 0; i < 200; i++) db.users.insert({ name: `user-${i}` });
    db.backup(backupPath);

    const bytes = readFileSync(backupPath);
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 3)));

    expect(() => db.restore(truncated)).toThrow(/corrupt|malformed/i);

    // 200 rows, still there: the failure happened during validation, before anything
    // was renamed.
    expect(db.users.count()).toBe(200);
  });

  it("refuses an empty file instead of wiping the database", () => {
    const path = dbPath("zero-byte");
    const zero = dbPath("zero-byte.src");
    const db = createDatabase({ path, schema });

    db.users.insert({ name: "Ada" });
    writeFileSync(zero, "");

    /*
     * The bug this pins. SQLite reads a zero-length file as a valid, empty database, so
     * `quick_check` answered "ok" and restore reported success — leaving every table
     * gone. `checkIntegrity()` still returned true afterwards, because an empty file
     * really is a healthy database.
     */
    expect(() => db.restore(zero)).toThrow(/empty/i);

    expect(db.users.count()).toBe(1);
    expect(db.users.findMany({})[0]!.name).toBe("Ada");
  });

  it("reports a missing backup file", () => {
    const path = dbPath("missing");
    const db = createDatabase({ path, schema });

    expect(() => db.restore(dbPath("does-not-exist"))).toThrow(/not found/i);
  });

  it("refuses to restore into an in-memory database", () => {
    const db = createDatabase({ path: ":memory:", schema });
    const backupPath = dbPath("in-memory.bak");

    db.backup(backupPath);

    expect(() => db.restore(backupPath)).toThrow(/in-memory/i);
  });

  it("restores a database whose tables exist but hold no rows", () => {
    const path = dbPath("schema-only");
    const backupPath = dbPath("schema-only.bak");

    const source = createDatabase({ path, schema });
    source.backup(backupPath);
    source.close();

    const db = createDatabase({ path, schema });
    db.users.insert({ name: "Ada" });
    db.restore(backupPath);

    // The fix rejects a file with no tables; one with a schema and no rows is a
    // legitimate backup and must still restore.
    expect(db.users.count()).toBe(0);
    expect(db.users.findMany({})).toEqual([]);
  });

  it("writes a snapshot that includes rows still in the write-ahead log", () => {
    const path = dbPath("wal");
    const backupPath = dbPath("wal.bak");
    const db = createDatabase({ path, schema });

    for (let i = 0; i < 300; i++) db.users.insert({ name: `user-${i}` });

    db.backup(backupPath);

    const fromBackup = createDatabase({ path: backupPath, schema, forceNew: false });

    // VACUUM INTO reads through the WAL, so a plain file copy would not.
    expect(fromBackup.users.count()).toBe(300);
  });

  it("does not leave a temporary file behind when the backup fails", () => {
    const path = dbPath("temp");
    const db = createDatabase({ path, schema });
    db.users.insert({ name: "Ada" });

    // A path underneath a regular file cannot be created, whichever directory is
    // missing.
    expect(() => db.backup(join(path, "nested", "out.db"))).toThrow(YattaError);

    const leftovers = readdirSync(TEST_DIR).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});