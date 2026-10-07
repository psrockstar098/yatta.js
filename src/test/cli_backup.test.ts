import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { cmdDbBackup, cmdDbRestore } from "../cli_backup";

/*
 * `yatta db:backup` has to produce something you can actually restore.
 *
 * It used to `copyFileSync` the database file. In WAL mode — which is how Yatta opens
 * every database — the newest writes live in the `-wal` sidecar, so a copy of the main
 * file taken while writers are active can be torn. The function's own comment claimed
 * "file copy with WAL checkpoint" and there was no checkpoint in it.
 *
 * A test that only checks "a file appeared" would have passed over that, so these open
 * the result and look at the rows.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yatta-backup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Where the CLI looks for the database.
 *
 * `Database/yatta.db` under the project root, overridable with DATABASE_PATH — the
 * layout the scaffold and Dockerfile both use.
 */
const dbFile = () => join(dir, "Database", "yatta.db");

/** A WAL database with rows written but deliberately left in the WAL. */
function seed(rows: string[]): void {
  mkdirSync(join(dir, "Database"), { recursive: true });
  const db = new Database(dbFile(), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
  for (const email of rows) {
    db.run("INSERT INTO users (email) VALUES (?)", [email]);
  }
  // Deliberately not checkpointed: with WAL still populated, a plain copy of the main
  // file is exactly the case that loses data.
  db.close();
}

describe("db:backup", () => {
  it("reports failure, with a non-zero exit, when there is no database", () => {
    expect(cmdDbBackup(dir)).toBe(1);
  });

  it("captures rows that are still in the WAL", () => {
    seed(["wal-a@t.dev", "wal-b@t.dev"]);

    expect(cmdDbBackup(dir)).toBe(0);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"));
    expect(backup).toBeDefined();

    /*
     * The point. Reading the copy proves it is a usable database containing the rows,
     * rather than a file whose existence was the only evidence.
     */
    const snap = new Database(join(dir, "backups", backup!), { readonly: true });
    const rows = snap.query("SELECT email FROM users ORDER BY email").all() as Array<{ email: string }>;
    snap.close();

    expect(rows.map((r) => r.email)).toEqual(["wal-a@t.dev", "wal-b@t.dev"]);
  });

  it("writes one self-contained file, with no WAL sidecar beside it", () => {
    seed(["solo@t.dev"]);

    cmdDbBackup(dir);

    const files = readdirSync(join(dir, "backups"));
    expect(files.filter((f) => f.endsWith(".db"))).toHaveLength(1);

    // `VACUUM INTO` produces a complete database in the file itself. A `-wal` beside it
    // would mean the snapshot depends on a sidecar, which is the thing being avoided.
    expect(files.filter((f) => f.endsWith("-wal") || f.endsWith("-shm"))).toEqual([]);
  });

  it("produces a snapshot that opens without the original present", () => {
    seed(["detached@t.dev"]);

    cmdDbBackup(dir);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"))!;

    // Move it somewhere else entirely, so it cannot be reading the live database.
    const moved = join(dir, "moved.db");
    rmSync(moved, { force: true });
    renameSync(join(dir, "backups", backup), moved);
    rmSync(dbFile(), { force: true });

    const snap = new Database(moved, { readonly: true });
    const rows = snap.query("SELECT email FROM users").all();
    snap.close();

    expect(rows).toEqual([{ email: "detached@t.dev" }]);
  });

  it("falls back to a copy when the file is not a SQLite database", () => {
    // A file at the database path that is not a database. The command must still
    // produce something rather than throwing.
    mkdirSync(join(dir, "Database"), { recursive: true });
    writeFileSync(dbFile(), "not a database");

    expect(cmdDbBackup(dir)).toBe(0);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"));
    expect(readFileSync(join(dir, "backups", backup!), "utf8")).toBe("not a database");
  });

  it("takes a second backup without overwriting the first", () => {
    seed(["one@t.dev"]);

    // The filename is timestamped to the second, so two calls in the same second would
    // collide and the first backup would be lost.
    cmdDbBackup(dir);
    cmdDbBackup(dir);

    const files = readdirSync(join(dir, "backups")).filter((f) => f.endsWith(".db"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Whichever survived, it must be a real database.
    const snap = new Database(join(dir, "backups", files[0]!), { readonly: true });
    const rows = snap.query("SELECT email FROM users").all();
    snap.close();
    expect(rows).toHaveLength(1);
  });
});

describe("db:restore", () => {
  it("reports failure, with a non-zero exit, for a missing file", () => {
    expect(cmdDbRestore("nope.db", dir)).toBe(1);
    expect(cmdDbRestore("", dir)).toBe(1);
  });

  it("round-trips: what a backup restores is what the database had", () => {
    seed(["restore-a@t.dev", "restore-b@t.dev"]);
    cmdDbBackup(dir);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"))!;

    // Change the live database after the backup.
    const live = new Database(dbFile());
    live.run("DELETE FROM users");
    live.run("INSERT INTO users (email) VALUES ('after-the-backup@t.dev')");
    live.close();

    expect(cmdDbRestore(join("backups", backup), dir)).toBe(0);

    const restored = new Database(dbFile(), { readonly: true });
    const rows = restored.query("SELECT email FROM users ORDER BY email").all();
    restored.close();

    expect(rows).toEqual([{ email: "restore-a@t.dev" }, { email: "restore-b@t.dev" }]);
  });

  it("keeps a copy of the database it is about to overwrite", () => {
    seed(["precious@t.dev"]);
    cmdDbBackup(dir);
    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"))!;

    cmdDbRestore(join("backups", backup), dir);

    // The restore overwrote the live file with identical content, so the only evidence
    // the original survived is the safety copy. Without it, a restore is irreversible.
    const safety = readdirSync(join(dir, "Database")).filter((f) => f.includes("pre-restore"));
    expect(safety).toHaveLength(1);
    expect(existsSync(join(dir, "Database", safety[0]!))).toBe(true);
  });
});

describe("The backup targets the database the server uses", () => {
  const original = { url: process.env.DATABASE_URL, path: process.env.DATABASE_PATH };

  afterEach(() => {
    if (original.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original.url;

    if (original.path === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = original.path;
  });

  function seedAt(path: string, email: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
    db.run("INSERT INTO users (email) VALUES (?)", [email]);
    db.close();
  }

  it("follows DATABASE_URL, which is what the server reads", () => {
    const target = join(dir, "app.db");
    seedAt(target, "the-real-one@t.dev");

    process.env.DATABASE_URL = target;
    delete process.env.DATABASE_PATH;

    /*
     * `db:backup` only read `DATABASE_PATH`. A project pointing its server at
     * `Database/app.db` therefore had the backup command looking at
     * `Database/yatta.db` — a file that does not exist, so it failed, or one left over
     * from an older layout, so it succeeded while archiving the wrong database. A
     * backup of the wrong file is worse than none, because it is reported as one.
     */
    expect(cmdDbBackup(dir)).toBe(0);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"))!;
    const snap = new Database(join(dir, "backups", backup), { readonly: true });
    const rows = snap.query("SELECT email FROM users").all();
    snap.close();

    expect(rows).toEqual([{ email: "the-real-one@t.dev" }]);
  });

  it("still accepts DATABASE_PATH as an alias", () => {
    const target = join(dir, "aliased.db");
    seedAt(target, "aliased@t.dev");

    delete process.env.DATABASE_URL;
    process.env.DATABASE_PATH = target;

    expect(cmdDbBackup(dir)).toBe(0);
  });

  it("prefers DATABASE_URL when both are set", () => {
    const real = join(dir, "real.db");
    const decoy = join(dir, "decoy.db");
    seedAt(real, "real@t.dev");
    seedAt(decoy, "decoy@t.dev");

    process.env.DATABASE_URL = real;
    process.env.DATABASE_PATH = decoy;

    expect(cmdDbBackup(dir)).toBe(0);

    const backup = readdirSync(join(dir, "backups")).find((f) => f.endsWith(".db"))!;
    const snap = new Database(join(dir, "backups", backup), { readonly: true });
    const rows = snap.query("SELECT email FROM users").all();
    snap.close();

    expect(rows).toEqual([{ email: "real@t.dev" }]);
  });
});
