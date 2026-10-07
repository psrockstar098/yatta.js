// yatta db:backup / yatta db:restore — SQLite backup commands.
//
// The backup is taken with `VACUUM INTO`, not by copying the file.
//
// Copying was wrong. In WAL mode — the default Yatta opens every database with — the
// most recent writes live in the `-wal` sidecar, and `copyFileSync` on a database with
// active writers can capture a torn main file. The header comment used to claim this
// was "file copy with WAL checkpoint" while there was no checkpoint in it.
//
// `VACUUM INTO` writes a fresh, self-contained database in one transaction and includes
// everything still in the WAL, so the snapshot is consistent by construction and needs
// no `-wal` or `-shm` beside it. The file copy remains as a fallback for a database
// that is not actually SQLite, so the command still produces something to look at.

import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { Database } from "bun:sqlite";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * The database this project is actually using.
 *
 * `DATABASE_URL` first, then the `DATABASE_PATH` alias, then the default.
 *
 * This only read `DATABASE_PATH`, while the server reads `DATABASE_URL`. A project
 * pointing the server at `Database/app.db` therefore had `yatta db:backup` looking at
 * `Database/yatta.db` — a file that does not exist, so the backup failed; or worse, one
 * left over from an older layout, so it succeeded while archiving the wrong database.
 * A backup of the wrong file is worse than no backup, because it is reported as one.
 */
function dbPath(projectRoot: string): string {
  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_PATH ||
    join(projectRoot, "Database", "yatta.db")
  );
}

function backupDir(projectRoot: string): string {
  return process.env.BACKUP_DIR || join(projectRoot, "backups");
}

export function cmdDbBackup(projectRoot: string = process.cwd()): number {
  const src = dbPath(projectRoot);
  if (!existsSync(src)) {
    console.log(`  ${c.red(`Database not found: ${src}`)}`);
    return 1;
  }

  const dir = backupDir(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T").join("_").split("Z")[0];
  const filename = `yatta_${timestamp}.db`;
  const dest = join(dir, filename);

  let method = "";

  try {
    /*
     * Read-write, because SQLite refuses `VACUUM INTO` on a read-only connection. The
     * statement itself only reads the source and writes the destination.
     *
     * `{ create: true }` is required, not incidental: in Bun 1.4.2
     * `new Database(existingPath)` throws "bad parameter or other API misuse" for *any*
     * existing file, WAL or not. Only `create: true` and `readonly: true` open one.
     * Passing `create: false` to mean "do not create" is the same error — the option
     * only accepts `true`.
     *
     * Existence is checked above, so `create: true` cannot manufacture an empty
     * database for a path that is not there.
     */
    const db = new Database(src, { create: true });

    try {
      db.run("VACUUM INTO ?", [dest]);
      method = "consistent snapshot via VACUUM INTO";
    } finally {
      db.close();
    }
  } catch (error) {
    /*
     * Fall back to a plain copy, so a corrupt or non-SQLite file still produces
     * something rather than nothing — but say so loudly.
     *
     * A quiet fallback is worse than a failure here. A copy of the main file in WAL
     * mode can be torn, so a backup that silently became a copy would be reported as a
     * success and be unrestorable, discovered at the moment it was needed.
     */
    copyFileSync(src, dest);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(src + ext)) copyFileSync(src + ext, dest + ext);
    }

    method = "UNSAFE COPY — could not take a consistent snapshot";
    console.log(
      `  ${c.yellow("!")} ${method}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      `  ${c.dim("  A copied file in WAL mode can be torn. Verify this backup before relying on it.")}`,
    );
  }

  const stat = statSync(dest);
  console.log(`  ${c.green("✓")} Backup created: ${c.dim(dest)}`);
  console.log(`  ${c.dim(`Size: ${(stat.size / 1024).toFixed(1)} KB · ${method}`)}`);
  return 0;
}

export function cmdDbRestore(backupFile: string, projectRoot: string = process.cwd()): number {
  if (!backupFile) {
    console.log(`  ${c.red("Usage: yatta db:restore <backup-file>")}`);
    return 1;
  }

  const src = join(projectRoot, backupFile);
  if (!existsSync(src)) {
    console.log(`  ${c.red(`Backup file not found: ${src}`)}`);
    return 1;
  }

  const dest = dbPath(projectRoot);
  const destDir = join(dest, "..");
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  // Safety: backup the current database before overwriting
  if (existsSync(dest)) {
    const safety = dest + `.pre-restore-${Date.now()}.bak`;
    copyFileSync(dest, safety);
    console.log(`  ${c.yellow("Current database backed up to:")} ${c.dim(safety)}`);
  }

  copyFileSync(src, dest);
  // Copy WAL/SHM if present in backup
  for (const ext of ["-wal", "-shm"]) {
    const walSrc = src + ext;
    if (existsSync(walSrc)) {
      copyFileSync(walSrc, dest + ext);
    }
  }

  console.log(`  ${c.green("✓")} Restored from: ${c.dim(backupFile)}`);
  return 0;
}
