import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdMigrate, cmdMigrateMake } from "../cli_migrate";

/*
 * `yatta migrate:make` and `yatta migrate` exit-code promises:
 * - two `migrate:make` runs in the same second must not overwrite each
 *   other (same-second timestamp collision);
 * - a migration file that is skipped (missing name/up) must fail the run,
 *   not exit 0 while CI believes the migrate succeeded;
 * - a migration that throws must fail with a clean message, not a raw
 *   stack trace.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yatta-migrate-cli-"));
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Silence the command's console output while keeping it readable on failure. */
async function quiet<T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg = "") => void lines.push(String(msg));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original;
  }
}

function migrationFiles(): string[] {
  const migrations = join(dir, "migrations");
  if (!existsSync(migrations)) return [];
  return readdirSync(migrations).filter((f) => f.endsWith(".ts")).sort();
}

describe("migrate:make", () => {
  it("does not overwrite when run twice in the same second with the same name", () => {
    expect(cmdMigrateMake("add_users", dir)).toBe(0);
    expect(cmdMigrateMake("add_users", dir)).toBe(0);
    const files = migrationFiles();
    expect(files).toHaveLength(2);
    expect(files[0]).not.toBe(files[1]);
    // The second file is the _2 suffix, and its migration name matches
    // its filename — status matches applied migrations by filename.
    expect(files[1]).toMatch(/_2\.ts$/);
    expect(files[1]).not.toBe(files[0]);
  });
});

describe("migrate exit codes", () => {
  it("exits 1 when a migration file is skipped, after running the valid ones", async () => {
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(
      join(dir, "migrations", "20260101000000_good.ts"),
      `export default { name: "20260101000000_good", up(db: any) { db.run("CREATE TABLE t (id INTEGER)"); } };\n`,
    );
    writeFileSync(
      join(dir, "migrations", "20260101000001_broken.ts"),
      `export default { up(db: any) {} };\n`,
    );
    const { result, lines } = await quiet(() => cmdMigrate(dir));
    expect(result).toBe(1);
    expect(lines.join("\n")).toMatch(/Skipping 20260101000001_broken\.ts/);
    expect(lines.join("\n")).toMatch(/1 migration file\(s\) skipped/);
    // The valid migration still ran.
    expect(lines.join("\n")).toMatch(/Applied: 20260101000000_good/);
  });

  it("exits 1 with a clean message when a migration throws", async () => {
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(
      join(dir, "migrations", "20260101000000_boom.ts"),
      `export default { name: "20260101000000_boom", up(db: any) { throw new Error("boom in up"); } };\n`,
    );
    const { result, lines } = await quiet(() => cmdMigrate(dir));
    expect(result).toBe(1);
    expect(lines.join("\n")).toMatch(/Migration failed: boom in up/);
    expect(lines.join("\n")).not.toContain("at ");
  });
});
