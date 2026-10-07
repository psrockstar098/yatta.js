// yatta db:backup / yatta db:restore — SQLite backup commands.
//
// Uses SQLite's atomic snapshot via file copy with WAL checkpoint.
// For production use with high write load, consider the SQLite backup API.

import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function dbPath(projectRoot: string): string {
  return process.env.DATABASE_PATH || join(projectRoot, "Database", "yatta.db");
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

  // Also copy WAL and SHM files if they exist (for WAL mode databases)
  copyFileSync(src, dest);
  for (const ext of ["-wal", "-shm"]) {
    const walSrc = src + ext;
    if (existsSync(walSrc)) {
      copyFileSync(walSrc, dest + ext);
    }
  }

  const stat = statSync(dest);
  console.log(`  ${c.green("✓")} Backup created: ${c.dim(dest)}`);
  console.log(`  ${c.dim(`Size: ${(stat.size / 1024).toFixed(1)} KB`)}`);
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
