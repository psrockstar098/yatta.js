import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { cmdMigrate, cmdMigrateGenerate } from "../cli_migrate";
import { col, createDatabase, YattaDB } from "../types/db";
import { diffSchemas, normalizeModelSchema, qIdent, renderMigrationFile, renderStatements } from "../migrate_generate";

/*
 * `yatta migrate:generate` — diff a live database against the models and
 * emit a real migration file, without ever silently destroying data.
 *
 * Each test gets its own project directory: a schema file the command can
 * import, and a Database/yatta.db seeded by hand (never by createDatabase,
 * except for the no-diff test, where the point is that a synced database
 * reports clean). DATABASE_URL/DATABASE_PATH are cleared so the command
 * resolves the database from the project directory, not the environment.
 */

const TEST_DIR = join(import.meta.dir, "fixtures", "migrate-generate");

let counter = 0;

function projectDir(): string {
  const dir = join(TEST_DIR, `mg-${process.pid}-${counter++}`);
  mkdirSync(join(dir, "Database"), { recursive: true });
  return dir;
}

function dbPath(dir: string): string {
  return join(dir, "Database", "yatta.db");
}

function seed(dir: string, tables: Record<string, string[]>, rows: Record<string, Record<string, unknown>[]> = {}): void {
  const db = new Database(dbPath(dir), { create: true });
  for (const [table, columns] of Object.entries(tables)) {
    db.run(`CREATE TABLE ${qIdent(table)} (${columns.join(", ")});`);
  }
  for (const [table, values] of Object.entries(rows)) {
    for (const row of values) {
      const names = Object.keys(row);
      db.run(
        `INSERT INTO ${qIdent(table)} (${names.map((n) => qIdent(n)).join(", ")}) VALUES (${names.map(() => "?").join(", ")});`,
        Object.values(row) as any[],
      );
    }
  }
  db.close();
}

/** Write a schema file the command can import with --schema. */
function writeSchema(dir: string, body: string): string {
  const path = join(dir, "schema.ts");
  writeFileSync(path, `import { col } from "../../../../types/db";\n\nexport const schema = ${body};\n`);
  return "schema.ts";
}

function migrationFiles(dir: string): string[] {
  const migrations = join(dir, "migrations");
  if (!existsSync(migrations)) return [];
  return readdirSync(migrations).filter((f) => f.endsWith(".ts")).sort();
}

/** Silence the command's console output while keeping it readable on failure. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg = "") => void lines.push(String(msg));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_PATH: process.env.DATABASE_PATH,
  };
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  for (const entry of readdirSync(TEST_DIR)) {
    rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
  }
  if (savedEnv.DATABASE_URL !== undefined) process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  if (savedEnv.DATABASE_PATH !== undefined) process.env.DATABASE_PATH = savedEnv.DATABASE_PATH;
});

describe("migrate:generate detects new tables and columns", () => {
  it("emits a CREATE TABLE for a table only in the models", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] });
    const schema = writeSchema(dir, `{
      users: { id: col.id(), name: col.text() },
      posts: { id: col.id(), title: col.text() },
    }`);

    const { result } = await quiet(() => cmdMigrateGenerate({ schemaPath: schema }, dir));
    expect(result).toBe(0);
    const files = migrationFiles(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, "migrations", files[0]!), "utf8");
    expect(content).toContain(`CREATE TABLE "posts"`);
    expect(content).toContain(`DROP TABLE "posts"`);
  });

  it("emits an ADD COLUMN for a column only in the models", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] });
    const schema = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable() },
    }`);

    const { result } = await quiet(() => cmdMigrateGenerate({ schemaPath: schema }, dir));
    expect(result).toBe(0);
    const files = migrationFiles(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, "migrations", files[0]!), "utf8");
    expect(content).toContain(`ADD COLUMN "bio" TEXT`);
    expect(content).toContain(`DROP COLUMN "bio"`);
  });

  it("writes nothing on --dry-run", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] });
    const schema = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable() },
    }`);

    const { result, lines } = await quiet(() => cmdMigrateGenerate({ schemaPath: schema, dryRun: true }, dir));
    expect(result).toBe(0);
    expect(migrationFiles(dir)).toEqual([]);
    expect(lines.join("\n")).toContain("Dry run");
  });
});

describe("migrate:generate no-diff and round-trip", () => {
  it("reports clean and writes no file when the live database matches the models", async () => {
    const dir = projectDir();
    // Synced by the framework itself, including a unique column, an indexed
    // column, and an expression default — the three shapes most likely to
    // false-positive and loop a generate/apply/generate cycle.
    const schema = {
      users: {
        id: col.id(),
        email: col.text().unique(),
        name: col.text().index(),
        createdAt: col.createdAt(),
      },
    };
    const db = createDatabase({ path: dbPath(dir), schema });
    db.close();
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), email: col.text().unique(), name: col.text().index(), createdAt: col.createdAt() },
    }`);

    const { result, lines } = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(result).toBe(0);
    expect(migrationFiles(dir)).toEqual([]);
    expect(lines.join("\n")).toMatch(/already in sync/);
  });

  it("generated migration applies via the existing runner and the next diff is clean", async () => {
    const dir = projectDir();
    seed(
      dir,
      { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] },
      { users: [{ id: 1, name: "Ada" }] },
    );
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable() },
      posts: { id: col.id(), title: col.text() },
    }`);

    const gen = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(gen.result).toBe(0);
    expect(migrationFiles(dir).length).toBe(1);

    const applied = await quiet(() => cmdMigrate(dir));
    expect(applied.result).toBe(0);
    expect(applied.lines.join("\n")).toMatch(/Applied/);

    // Rows survive, and the new shapes are really there.
    const check = new Database(dbPath(dir), { readonly: true });
    const user = check.query(`SELECT * FROM "users"`).get() as any;
    expect(user.name).toBe("Ada");
    expect("bio" in user).toBe(true);
    const tables = (check.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map((r) => r.name);
    expect(tables).toContain("posts");
    check.close();

    // Second generate, same models: nothing left to do. No drift loop.
    const again = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(again.result).toBe(0);
    expect(migrationFiles(dir).length).toBe(1);
    expect(again.lines.join("\n")).toMatch(/already in sync/);
  });

  it("down migration reverses up for a new table and a new column", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] });
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable() },
      posts: { id: col.id(), title: col.text() },
    }`);
    await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    const file = join(dir, "migrations", migrationFiles(dir)[0]!);
    const migration = (await import(file)).default;

    const db = new YattaDB({ path: dbPath(dir), schema: {}, autoMigrate: false });
    await db.migrate([migration]);
    const afterUp = new Database(dbPath(dir), { readonly: true });
    expect((afterUp.query(`PRAGMA table_info("users")`).all() as any[]).map((c) => c.name)).toContain("bio");
    expect((afterUp.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map((r) => r.name)).toContain("posts");
    afterUp.close();

    await migration.down(db);
    const afterDown = new Database(dbPath(dir), { readonly: true });
    expect((afterDown.query(`PRAGMA table_info("users")`).all() as any[]).map((c) => c.name)).not.toContain("bio");
    expect((afterDown.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map((r) => r.name)).not.toContain("posts");
    afterDown.close();
    db.close();
  });
});

describe("migrate:generate destructive changes", () => {
  it("flags a dropped column and refuses without confirmation", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`, `"legacy" TEXT`] });
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text() },
    }`);

    const refused = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(refused.result).toBe(1);
    expect(migrationFiles(dir)).toEqual([]);
    expect(refused.lines.join("\n")).toMatch(/DESTRUCTIVE/);

    const allowed = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile, allowDestructive: true }, dir));
    expect(allowed.result).toBe(0);
    const files = migrationFiles(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, "migrations", files[0]!), "utf8");
    expect(content).toContain(`DROP COLUMN "legacy"`);
    expect(content).toContain("DESTRUCTIVE");
  });

  it("flags a dropped table and refuses without confirmation", async () => {
    const dir = projectDir();
    seed(dir, {
      users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`],
      old_logs: [`"id" INTEGER PRIMARY KEY`, `"line" TEXT`],
    });
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text() },
    }`);

    const refused = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(refused.result).toBe(1);
    expect(migrationFiles(dir)).toEqual([]);
  });
});

describe("migrate:generate edge cases", () => {
  it("exits cleanly with no file when no live database exists yet", async () => {
    const dir = projectDir();
    rmSync(join(dir, "Database"), { recursive: true, force: true });
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text() },
    }`);

    const { result, lines } = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(result).toBe(0);
    expect(migrationFiles(dir)).toEqual([]);
    expect(lines.join("\n")).toMatch(/No live database/);
  });

  it("rebuilds a changed column without losing rows or breaking child foreign keys", async () => {
    const dir = projectDir();
    seed(
      dir,
      {
        parent: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`, `"score" INTEGER NOT NULL DEFAULT 0`],
        child: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"parent_id" INTEGER REFERENCES "parent"("id") ON DELETE CASCADE`],
      },
      { parent: [{ id: 1, name: "Ada", score: 5 }], child: [{ id: 1, parent_id: 1 }] },
    );
    // Only the default changes, so this is a rebuild that must preserve data.
    const schemaFile = writeSchema(dir, `{
      parent: { id: col.id(), name: col.text(), score: col.integer().default(10) },
      child: { id: col.id(), parent_id: col.integer().references("parent.id", { onDelete: "CASCADE" }) },
    }`);

    const gen = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile, name: "score_default" }, dir));
    expect(gen.result).toBe(0);
    const files = migrationFiles(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, "migrations", files[0]!), "utf8");
    expect(content).toContain("async up");

    const applied = await quiet(() => cmdMigrate(dir));
    expect(applied.result).toBe(0);

    const check = new Database(dbPath(dir), { readonly: true });
    const parent = check.query(`SELECT * FROM "parent"`).get() as any;
    expect(parent.score).toBe(5);
    const child = check.query(`SELECT * FROM "child"`).get() as any;
    expect(child.parent_id).toBe(1);
    const fk = check.query(`PRAGMA foreign_key_list("child")`).get() as any;
    expect(fk.table).toBe("parent");
    expect((check.query(`PRAGMA foreign_key_check`).all() as any[])).toEqual([]);
    check.close();

    // The new default took effect for rows written after the rebuild.
    const writable = new Database(dbPath(dir));
    writable.run(`INSERT INTO "parent" ("name") VALUES ('Grace');`);
    const grace = writable.query(`SELECT * FROM "parent" WHERE "name" = 'Grace'`).get() as any;
    expect(grace.score).toBe(10);
    writable.close();

    const again = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(again.result).toBe(0);
    expect(migrationFiles(dir).length).toBe(1);
  });

  it("quotes identifiers so a quoted table name cannot break out of the SQL", async () => {
    expect(qIdent('we"ird')).toBe('"we""ird"');
    const dir = projectDir();
    seed(dir, { 'we"ird': [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`] });
    const schemaFile = writeSchema(dir, `{
      ${JSON.stringify('we"ird')}: { id: col.id(), note: col.text().nullable() },
    }`);

    const gen = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(gen.result).toBe(0);
    const content = readFileSync(join(dir, "migrations", migrationFiles(dir)[0]!), "utf8");
    expect(content).toContain(`ADD COLUMN "note" TEXT`);
    expect(content).toContain(`"we""ird"`);

    const applied = await quiet(() => cmdMigrate(dir));
    expect(applied.result).toBe(0);
    const check = new Database(dbPath(dir), { readonly: true });
    expect((check.query(`PRAGMA table_info("we""ird")`).all() as any[]).map((c) => c.name)).toContain("note");
    check.close();
  });

  it("refuses a new NOT NULL column without a default on a populated table", async () => {
    const dir = projectDir();
    seed(
      dir,
      { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] },
      { users: [{ id: 1, name: "Ada" }] },
    );
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), role: col.text() },
    }`);

    const { result, lines } = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(result).toBe(1);
    expect(migrationFiles(dir)).toEqual([]);
    expect(lines.join("\n")).toMatch(/no value exists/);
  });

  it("does not report a phantom change for an enum value containing a comma", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"role" TEXT NOT NULL CHECK("role" IN ('a,b', 'c'))`] });
    const schemaFile = writeSchema(dir, `{
      users: { id: col.id(), role: col.enum(["a,b", "c"]) },
    }`);

    const { result } = await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    expect(result).toBe(0);
    expect(migrationFiles(dir)).toEqual([]);
  });

  it("never overwrites an earlier migration generated in the same second", async () => {
    const dir = projectDir();
    seed(dir, { users: [`"id" INTEGER PRIMARY KEY AUTOINCREMENT`, `"name" TEXT NOT NULL`] });
    let schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable() },
    }`);
    await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    schemaFile = writeSchema(dir, `{
      users: { id: col.id(), name: col.text(), bio: col.text().nullable(), bio2: col.text().nullable() },
    }`);
    await quiet(() => cmdMigrateGenerate({ schemaPath: schemaFile }, dir));
    const files = migrationFiles(dir);
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  });

  it("keeps a newline-bearing identifier inside its header comment", () => {
    const live = { tables: { users: { name: "users", sql: null, columns: [], indexes: [], savedObjectSql: [], rowCount: 0 } } };
    const desired = normalizeModelSchema({ users: { id: col.id() } });
    const diff = diffSchemas(live as any, desired);
    const rendered = renderStatements(diff, live as any, desired);
    const evil = { ...diff.changes[0]!, detail: "Create table x\n}; evil();//" };
    const content = renderMigrationFile("test_migration", { ...diff, changes: [evil] }, rendered);
    const evilLine = content.split("\n").find((l) => l.includes("evil"));
    expect(evilLine?.trimStart().startsWith("//")).toBe(true);
  });
});
