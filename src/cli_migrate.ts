// yatta migrate — database migration commands.
//
// Commands:
//   yatta migrate          Run pending migrations from ./migrations/
//   yatta migrate:make <name>  Create a new migration file
//   yatta migrate:status   Show applied/pending migrations
//   yatta migrate:generate [options]  Generate a migration from model changes

import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  diffSchemas,
  migrationFileName,
  normalizeModelSchema,
  readLiveSchema,
  renderMigrationFile,
  renderStatements,
} from "./migrate_generate";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function migrationsDir(projectRoot: string): string {
  return join(projectRoot, "migrations");
}

function dbPath(projectRoot: string): string {
  // `DATABASE_URL` first, because that is what the server reads. `DATABASE_PATH` is
  // accepted as an alias so a project cannot configure its tools and its server against
  // two different databases.
  return process.env.DATABASE_URL || process.env.DATABASE_PATH || join(projectRoot, "Database", "yatta.db");
}

export async function cmdMigrate(projectRoot: string = process.cwd()): Promise<number> {
  const dir = migrationsDir(projectRoot);
  if (!existsSync(dir)) {
    console.log(`  ${c.yellow("No migrations directory found at ./migrations/")}`);
    console.log(`  ${c.dim("Run `yatta migrate:make <name>` to create your first migration.")}`);
    return 0;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .sort();

  if (files.length === 0) {
    console.log(`  ${c.dim("No migration files found.")}`);
    return 0;
  }

  // Dynamically import the YattaDB class
  const { YattaDB } = await import("./types/db");
  const db = new YattaDB({ path: dbPath(projectRoot) });

  const migrations = [];
  for (const file of files) {
    const mod = await import(join(dir, file));
    const migration = mod.default ?? mod;
    if (!migration.name || !migration.up) {
      console.log(`  ${c.yellow(`Skipping ${file}: missing name or up() function`)}`);
      continue;
    }
    migrations.push(migration);
  }

  console.log(`  ${c.bold(`Running ${migrations.length} migration(s)...`)}`);
  const result = await db.migrate(migrations);

  if (result.applied.length === 0) {
    console.log(`  ${c.green("Already up to date — no pending migrations.")}`);
  } else {
    for (const name of result.applied) {
      console.log(`  ${c.green("✓")} Applied: ${name}`);
    }
  }

  return 0;
}

export function cmdMigrateMake(name: string, projectRoot: string = process.cwd()): number {
  if (!name) {
    console.log(`  ${c.red("Usage: yatta migrate:make <name>")}`);
    return 1;
  }

  const dir = migrationsDir(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").split(".")[0];
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const filename = `${timestamp}_${safeName}.ts`;
  const filepath = join(dir, filename);

  const template = `// Migration: ${name}
// Created: ${new Date().toISOString()}

export default {
  name: "${timestamp}_${safeName}",

  up(db: any) {
    // TODO: Implement forward migration
    // Example:
    // db.run(\`
    //   CREATE TABLE users (
    //     id TEXT PRIMARY KEY,
    //     email TEXT UNIQUE NOT NULL,
    //     created_at TEXT DEFAULT CURRENT_TIMESTAMP
    //   )
    // \`);
  },

  down(db: any) {
    // TODO: Implement rollback (optional)
    // Example:
    // db.run("DROP TABLE users");
  },
};
`;

  writeFileSync(filepath, template);
  console.log(`  ${c.green("✓")} Created: ${c.dim(`migrations/${filename}`)}`);
  return 0;
}

export async function cmdMigrateStatus(projectRoot: string = process.cwd()): Promise<number> {
  const dir = migrationsDir(projectRoot);
  if (!existsSync(dir)) {
    console.log(`  ${c.dim("No migrations directory found.")}`);
    return 0;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .sort();

  const dbPathStr = dbPath(projectRoot);

  if (!existsSync(dbPathStr)) {
    console.log(`  ${c.dim("Database not found — no migrations applied yet.")}`);
    console.log(`  ${c.dim(`Pending files: ${files.length}`)}`);
    return 0;
  }

  // Use bun:sqlite directly for the status check
  const { Database } = await import("bun:sqlite");
  const sqlite = new Database(dbPathStr, { readonly: true });
  let applied: { name: string }[] = [];
  try {
    applied = sqlite.prepare("SELECT name FROM _yatta_migrations ORDER BY name").all() as { name: string }[];
  } catch {
    // Table doesn't exist yet — no migrations applied
  }
  sqlite.close();
  const appliedSet = new Set(applied.map((r) => r.name));

  console.log(`  ${c.bold("Migration status:")}`);
  console.log("");
  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, "");
    const isApplied = appliedSet.has(name);
    const icon = isApplied ? c.green("✓") : c.yellow("○");
    const status = isApplied ? c.dim("applied") : c.yellow("pending");
    console.log(`  ${icon} ${name} ${c.dim(`(${status})`)}`);
  }
  console.log("");

  return 0;
}

export interface MigrateGenerateOptions {
  schemaPath?: string;
  name?: string;
  allowDestructive?: boolean;
  dryRun?: boolean;
}

/** Parse migrate:generate flags, or return an error string for main() to print. */
export function parseMigrateGenerateArgs(rest: string[]): { opts: MigrateGenerateOptions; error?: string } {
  const opts: MigrateGenerateOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--schema" || arg === "--name") {
      const value = rest[++i];
      if (value === undefined) return { opts, error: `${arg} needs a value.` };
      if (arg === "--schema") opts.schemaPath = value;
      else opts.name = value;
    } else if (arg === "--allow-destructive" || arg === "--yes") opts.allowDestructive = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else return { opts, error: `Unknown option "${arg}". Options: --schema <path>, --name <name>, --allow-destructive, --dry-run.` };
  }
  return { opts };
}

/** Files tried for the models when --schema is not given, in order. */
const SCHEMA_CANDIDATES = [
  "db.ts",
  "yatta/db.ts",
  "src/db.ts",
  "database.ts",
  "yatta/database.ts",
  "db.js",
  "src/db.js",
];

/** Pull a models schema out of an imported module, or null when it has none. */
function schemaFromModule(mod: any): unknown {
  if (!mod || typeof mod !== "object") return null;
  if (mod.schema) return mod.schema;
  if (mod.default?.schema) return mod.default.schema;
  if (mod.default && typeof mod.default === "object") return mod.default;
  return null;
}

async function loadModelSchema(
  opts: MigrateGenerateOptions,
  projectRoot: string,
): Promise<{ schema: unknown; source: string } | null> {
  const candidates = opts.schemaPath ? [opts.schemaPath] : SCHEMA_CANDIDATES;
  const tried: string[] = [];
  for (const candidate of candidates) {
    const path = resolve(projectRoot, candidate);
    if (!existsSync(path)) {
      tried.push(candidate);
      continue;
    }
    let mod: any;
    try {
      mod = await import(path);
    } catch (err: any) {
      console.log(`  ${c.red(`Could not import schema file ${candidate}: ${err?.message ?? String(err)}`)}`);
      return null;
    }
    const schema = schemaFromModule(mod);
    if (schema === null) {
      tried.push(`${candidate} (no schema export)`);
      continue;
    }
    try {
      normalizeModelSchema(schema);
    } catch (err: any) {
      console.log(`  ${c.red(`Schema in ${candidate} is not a models schema: ${err?.message ?? String(err)}`)}`);
      return null;
    }
    return { schema, source: candidate };
  }
  if (opts.schemaPath) {
    console.log(`  ${c.red(`Schema file not found: ${opts.schemaPath}`)}`);
  } else {
    console.log(`  ${c.red("No models schema found.")}`);
    console.log(`  ${c.dim(`Looked for: ${tried.join(", ")}`)}`);
    console.log(`  ${c.dim("Point at the file with --schema <path>. It must export a `schema` object of col.* builders.")}`);
    console.log(`  ${c.dim("Note: a schema file that calls createDatabase on import will sync the database first —")}`);
    console.log(`  ${c.dim("point --schema at a models-only module when you want a diff against the live database.")}`);
  }
  return null;
}

/** Read one line from stdin, only when stdin is a terminal. */
function readInteractiveLine(prompt: string): string | null {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1);
  let line = "";
  try {
    for (;;) {
      const read = readSync(0, buf, 0, 1, null);
      if (read === 0) break;
      const char = buf.toString("utf8");
      if (char === "\n") break;
      line += char;
    }
  } catch {
    return null;
  }
  return line;
}

export async function cmdMigrateGenerate(
  opts: MigrateGenerateOptions = {},
  projectRoot: string = process.cwd(),
): Promise<number> {
  const path = dbPath(projectRoot);
  if (!existsSync(path)) {
    console.log(`  ${c.dim("No live database found.")}`);
    console.log(`  ${c.dim(`Expected at: ${path}`)}`);
    console.log(`  ${c.dim("Nothing to compare against yet — start the server or run `yatta migrate` once to create it, then generate again.")}`);
    return 0;
  }

  const loaded = await loadModelSchema(opts, projectRoot);
  if (!loaded) return 1;
  const desired = normalizeModelSchema(loaded.schema);
  let live;
  try {
    live = readLiveSchema(path);
  } catch (err: any) {
    console.log(`  ${c.red(`Could not read the live database at ${path}: ${err?.message ?? String(err)}`)}`);
    return 1;
  }
  const diff = diffSchemas(live, desired);

  if (diff.changes.length === 0) {
    console.log(`  ${c.green("✓")} Database schema is already in sync with the models — nothing to generate.`);
    return 0;
  }

  // A new primary key or NOT NULL column without a default cannot be filled
  // for rows that already exist: there is no value the generator could
  // honestly invent. Refuse rather than emit a migration that fails (or
  // worse, backfills a guessed value) on apply.
  const impossible: string[] = [];
  for (const [tableName, table] of Object.entries(desired.tables)) {
    const liveTable = live.tables[tableName];
    if (!liveTable || liveTable.rowCount === 0) continue;
    for (const col of table.columns) {
      if (liveTable.columns.some((l) => l.name === col.name)) continue;
      if ((col.pk && !col.autoIncrement) || (col.notNull && col.defaultCanonical === null && !col.autoIncrement)) {
        impossible.push(`${tableName}.${col.name}`);
      }
    }
  }
  if (impossible.length > 0) {
    console.log(`  ${c.red("Cannot generate: no value exists for these new columns on rows already in the database:")}`);
    for (const name of impossible) console.log(`    ${c.red("-")} ${name}`);
    console.log(`  ${c.dim("Give the column .default(...) or .nullable() first, then generate again.")}`);
    return 1;
  }

  console.log(`  ${c.bold(`Found ${diff.changes.length} change(s) between the live database and the models:`)}`);
  for (const change of diff.changes) {
    const marker = change.destructive ? c.red("!") : c.green("+");
    console.log(`    ${marker} ${change.detail}`);
  }
  console.log("");

  if (diff.destructive.length > 0) {
    console.log(`  ${c.red(c.bold(`DESTRUCTIVE: ${diff.destructive.length} change(s) will delete data:`))}`);
    for (const change of diff.destructive) console.log(`    ${c.red("-")} ${change.detail}`);
    console.log("");
  }

  if (opts.dryRun) {
    const rendered = renderStatements(diff, live, desired);
    console.log(`  ${c.dim("Dry run — no file written. Up would run:")}`);
    for (const stmt of rendered.up) console.log(`    ${c.dim(stmt)}`);
    return 0;
  }

  if (diff.destructive.length > 0 && !opts.allowDestructive) {
    const answer = readInteractiveLine(`  Type ${c.bold("yes")} to write a migration containing destructive changes, anything else to stop: `);
    if (answer === null) {
      console.log(`  ${c.red("Refused: destructive changes need explicit confirmation.")}`);
      console.log(`  ${c.dim("Re-run with --allow-destructive, or run interactively and type yes.")}`);
      return 1;
    }
    if (answer.trim().toLowerCase() !== "yes") {
      console.log(`  ${c.dim("Stopped — no file written.")}`);
      return 1;
    }
  }

  const { filename: baseFilename, migrationName: baseName } = migrationFileName(opts.name ?? "auto_generated");
  const rendered = renderStatements(diff, live, desired);
  const dir = migrationsDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Two generates in the same second share a timestamp, and overwriting the
  // first file would lose it. Suffix both the filename and the migration
  // name: status matches applied migrations by filename, so the two must
  // stay identical.
  let filename = baseFilename;
  let migrationName = baseName;
  for (let n = 2; existsSync(join(dir, filename)); n++) {
    filename = `${baseName}_${n}.ts`;
    migrationName = `${baseName}_${n}`;
  }
  const filepath = join(dir, filename);
  writeFileSync(filepath, renderMigrationFile(migrationName, diff, rendered));
  console.log(`  ${c.green("✓")} Created: ${c.dim(`migrations/${filename}`)}`);
  if (diff.destructive.length > 0) {
    console.log(`  ${c.yellow("This migration deletes data. Review it before running `yatta migrate`.")}`);
  } else {
    console.log(`  ${c.dim("Review it, then run `yatta migrate` to apply it.")}`);
  }
  return 0;
}
