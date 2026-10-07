// yatta migrate — database migration commands.
//
// Commands:
//   yatta migrate          Run pending migrations from ./migrations/
//   yatta migrate:make <name>  Create a new migration file
//   yatta migrate:status   Show applied/pending migrations

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
