import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  CloudBackupRunner,
  decryptBackup,
  loadCloudBackupConfigFromEnv,
  makeSnapshotKey,
  parseBackupKey,
  restoreCloudBackup,
  scheduleCloudBackups,
  selectSnapshotsToPrune,
  type BackupBucket,
  type CloudBackupConfig,
} from "../types/cloud_backups";
import { createCron } from "../types/job";
import { createDatabase, col } from "../types/db";
import { maybeScheduleCloudBackups } from "../func/cloud_backups";

/*
 * Cloud backups are tested against a fake bucket, never a real provider.
 *
 * The fake holds objects in a Map, so every test below proves the runner's
 * own logic — snapshot, encrypt, upload, prune, restore — without network.
 * The encryption key is test-only, generated per run, and never a real
 * credential. What the fake cannot prove is provider behavior (Bun's
 * S3Client against AWS, MinIO, or R2); that stays a documented manual step.
 */

// A fresh 32-byte key per test file run. Hex form, as an operator would set it.
const TEST_KEY_HEX = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
).toString("hex");

function fakeBucket(): BackupBucket & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key: string, data: Buffer) {
      objects.set(key, Buffer.from(data));
    },
    async get(key: string) {
      const data = objects.get(key);
      if (!data) throw new Error(`not found: ${key}`);
      return Buffer.from(data);
    },
    async list(prefix: string) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yatta-cloud-backup-"));
  logs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A small SQLite file with rows, in WAL mode like Yatta opens databases. */
function seedDb(filePath: string, emails: string[]): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  const db = new Database(filePath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)");
  for (const email of emails) {
    db.run("INSERT INTO users (email) VALUES (?)", [email]);
  }
  db.close();
}

function readEmails(filePath: string): string[] {
  const db = new Database(filePath, { readonly: true });
  const rows = db.query("SELECT email FROM users ORDER BY email").all() as Array<{ email: string }>;
  db.close();
  return rows.map((row) => row.email);
}

function testConfig(overrides: Partial<CloudBackupConfig> = {}): CloudBackupConfig {
  return {
    bucket: "test-bucket",
    prefix: "backups",
    schedule: "0 2 * * *",
    keepCount: 7,
    keepDays: 30,
    databases: [
      { name: "app.db", path: join(dir, "app.db"), required: true },
      { name: "jobs.db", path: join(dir, "jobs.db"), required: false },
      { name: "cache.db", path: join(dir, "cache.db"), required: false },
    ],
    key: parseBackupKey(TEST_KEY_HEX),
    s3: {},
    workDir: dir,
    ...overrides,
  };
}

describe("cloud backups: scheduled run and restore", () => {
  it("uploads one encrypted object, and the object holds no plaintext rows", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    seedDb(join(dir, "jobs.db"), ["job@example.com"]);
    const bucket = fakeBucket();
    const runner = new CloudBackupRunner({
      config: testConfig(),
      bucket,
      log: (message) => logs.push(message),
    });

    const result = await runner.run(new Date("2026-11-05T02:00:00.000Z"));

    expect(bucket.objects.size).toBe(1);
    expect(result.key).toMatch(/^backups\/2026-11-05T02-00-00-000Z-[0-9a-f]+\.ybk$/);
    expect(result.files.map((file) => file.name)).toEqual(["app.db", "jobs.db"]);
    expect(result.skipped).toEqual(["cache.db"]);

    // The object must be opaque: neither row value may appear anywhere in it.
    const object = bucket.objects.get(result.key)!;
    expect(object.includes("ada@example.com")).toBe(false);
    expect(object.includes("job@example.com")).toBe(false);
    // And the key itself must not be sitting in the object or the logs.
    expect(object.includes(TEST_KEY_HEX)).toBe(false);
    expect(logs.join("\n")).not.toContain(TEST_KEY_HEX);
  });

  it("restores the uploaded object to a valid database, through db.restore()", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com", "grace@example.com"]);
    const bucket = fakeBucket();
    const config = testConfig();
    const runner = new CloudBackupRunner({ config, bucket, log: () => {} });
    const result = await runner.run();

    const restored = await restoreCloudBackup({
      bucket,
      key: result.key,
      keyMaterial: parseBackupKey(TEST_KEY_HEX),
      outDir: join(dir, "staged"),
    });
    const stagedApp = restored.files.find((file) => file.name === "app.db")!;
    expect(stagedApp).toBeDefined();
    expect(readEmails(stagedApp.path)).toEqual(["ada@example.com", "grace@example.com"]);

    // The staged file must also survive Yatta's own restore path, which
    // re-checks integrity and swaps the live file atomically.
    const target = join(dir, "live.db");
    const live = createDatabase({
      path: target,
      schema: {
        users: {
          id: col.id(),
          email: col.text(),
        },
      },
    });
    try {
      live.restore(stagedApp.path);
      const rows = live.rawAll<{ email: string }>("SELECT email FROM users ORDER BY email");
      expect(rows.map((row) => row.email)).toEqual(["ada@example.com", "grace@example.com"]);
    } finally {
      live.close();
    }
  });

  it("decrypt-without-key fails, and the raw object is not a database", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    const runner = new CloudBackupRunner({ config: testConfig(), bucket, log: () => {} });
    const result = await runner.run();
    const object = bucket.objects.get(result.key)!;

    const wrongKey = parseBackupKey(Buffer.alloc(32, 9).toString("hex"));
    expect(() => decryptBackup(object, wrongKey)).toThrow();
    await expect(
      restoreCloudBackup({
        bucket,
        key: result.key,
        keyMaterial: wrongKey,
        outDir: join(dir, "staged-wrong-key"),
      }),
    ).rejects.toThrow();

    // Without decrypting at all, the object must not open as SQLite.
    const rawPath = join(dir, "raw.ybk");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(rawPath, object);
    expect(() => {
      const db = new Database(rawPath, { readonly: true });
      try {
        db.query("PRAGMA quick_check;").get();
      } finally {
        db.close();
      }
    }).toThrow();
  });

  it("a tampered or truncated backup fails restore, never silently loads", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    const runner = new CloudBackupRunner({ config: testConfig(), bucket, log: () => {} });
    const result = await runner.run();
    const original = bucket.objects.get(result.key)!;

    // Flip a byte deep in the ciphertext: GCM authentication must catch it.
    const tampered = Buffer.from(original);
    const flipAt = tampered.length - 5;
    tampered[flipAt] = (tampered[flipAt] ?? 0) ^ 0xff;
    bucket.objects.set(result.key, tampered);
    await expect(
      restoreCloudBackup({
        bucket,
        key: result.key,
        keyMaterial: parseBackupKey(TEST_KEY_HEX),
        outDir: join(dir, "staged-tampered"),
      }),
    ).rejects.toThrow(/decryption failed/);

    // A truncated object must fail too, not restore a partial database.
    bucket.objects.set(result.key, original.subarray(0, 20));
    await expect(
      restoreCloudBackup({
        bucket,
        key: result.key,
        keyMaterial: parseBackupKey(TEST_KEY_HEX),
        outDir: join(dir, "staged-truncated"),
      }),
    ).rejects.toThrow();
  });

  it("retention prunes old snapshots but keeps the newest", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    // Three older snapshots, already in the bucket.
    const old1 = makeSnapshotKey("backups", new Date("2026-10-01T02:00:00.000Z"));
    const old2 = makeSnapshotKey("backups", new Date("2026-10-20T02:00:00.000Z"));
    const old3 = makeSnapshotKey("backups", new Date("2026-11-01T02:00:00.000Z"));
    for (const key of [old1, old2, old3]) bucket.objects.set(key, Buffer.from("old"));
    const runner = new CloudBackupRunner({
      config: testConfig({ keepCount: 2, keepDays: 0 }),
      bucket,
      log: () => {},
    });

    const result = await runner.run(new Date("2026-11-05T02:00:00.000Z"));

    // Newest two survive: today's run and the 1 November snapshot. The
    // October ones are gone, and the run reported what it pruned.
    expect(bucket.objects.has(result.key)).toBe(true);
    expect(bucket.objects.has(old3)).toBe(true);
    expect(bucket.objects.has(old2)).toBe(false);
    expect(bucket.objects.has(old1)).toBe(false);
    expect(result.pruned.sort()).toEqual([old1, old2].sort());
  });

  it("retention never deletes the newest snapshot, even when it is old", () => {
    const onlyOld = makeSnapshotKey("backups", new Date("2026-01-01T02:00:00.000Z"));
    const pruned = selectSnapshotsToPrune([onlyOld], {
      keepCount: 1,
      keepDays: 30,
      justUploadedKey: "backups/some-other-key.ybk",
      now: new Date("2026-11-05T02:00:00.000Z").getTime(),
    });
    expect(pruned).toEqual([]);
  });

  it("a missing required database fails the run and uploads and prunes nothing", async () => {
    const bucket = fakeBucket();
    const stale = makeSnapshotKey("backups", new Date("2026-10-01T02:00:00.000Z"));
    bucket.objects.set(stale, Buffer.from("old"));
    const runner = new CloudBackupRunner({ config: testConfig(), bucket, log: () => {} });

    // No app.db on disk at all: the required file is absent.
    await expect(runner.run()).rejects.toThrow(/Required database file is missing/);
    expect([...bucket.objects.keys()]).toEqual([stale]);
  });

  it("missing optional files are skipped, not fatal", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    const runner = new CloudBackupRunner({ config: testConfig(), bucket, log: () => {} });
    const result = await runner.run();
    expect(result.skipped).toEqual(["jobs.db", "cache.db"]);
    expect(bucket.objects.size).toBe(1);
  });
});

describe("cloud backups: configuration", () => {
  it("unconfigured environment loads no config and schedules nothing", () => {
    expect(loadCloudBackupConfigFromEnv({})).toBeNull();

    // The wiring reads the real process env, so strip backup variables for
    // this check and put them back afterwards.
    const saved: Record<string, string | undefined> = {};
    for (const name of ["YATTA_BACKUP_BUCKET", "YATTA_BACKUP_KEY", "S3_BUCKET"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      const cron = createCron();
      try {
        expect(maybeScheduleCloudBackups(cron)).toBe(false);
      } finally {
        cron.stop();
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("a configured scheduler runs through the cron subsystem", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    const config = testConfig({ interval: "100ms" });
    const cron = createCron();
    try {
      expect(scheduleCloudBackups(cron, config, bucket, () => {})).toBe(true);
      // The 100ms interval fires on its own; waiting proves the schedule,
      // not just a manual run, produces the encrypted object.
      const deadline = Date.now() + 5000;
      while (bucket.objects.size === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(bucket.objects.size).toBeGreaterThan(0);
    } finally {
      cron.stop();
    }
  });

  it("bucket without a key, or a malformed key, is an error, not a silent skip", () => {
    expect(() =>
      loadCloudBackupConfigFromEnv({ YATTA_BACKUP_BUCKET: "b" }),
    ).toThrow(/YATTA_BACKUP_KEY/);
    expect(() =>
      loadCloudBackupConfigFromEnv({ YATTA_BACKUP_BUCKET: "b", YATTA_BACKUP_KEY: "short" }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadCloudBackupConfigFromEnv({ YATTA_BACKUP_KEY: TEST_KEY_HEX }),
    ).toThrow(/bucket/);
  });

  it("accepts a 32-byte key as hex or base64", () => {
    const hex = parseBackupKey(TEST_KEY_HEX);
    expect(hex.length).toBe(32);
    const base64 = parseBackupKey(Buffer.from(TEST_KEY_HEX, "hex").toString("base64"));
    expect(base64.length).toBe(32);
    expect(base64.equals(hex)).toBe(true);
  });

  it("an in-progress run cannot start a second overlapping run", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    const runner = new CloudBackupRunner({ config: testConfig(), bucket, log: () => {} });
    const first = runner.run();
    await expect(runner.run()).rejects.toThrow(/already in progress/);
    await first;
    expect(existsSync(join(dir, "app.db"))).toBe(true);
  });

  it("bucket credentials never reach the logs, even inside an error message", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const secret = "test-secret-value-1234";
    const bucket = fakeBucket();
    // A bucket that fails every upload with an error echoing the secret:
    // the worst case for log leakage, and the runner must still not print it.
    bucket.put = async () => {
      throw new Error(`upload refused for key material ${secret}`);
    };
    const config = testConfig({ s3: { secretAccessKey: secret } });
    const runner = new CloudBackupRunner({ config, bucket, log: (message) => logs.push(message) });
    // The run fails, but the failure must be reported without the secret.
    // The runner rethrows the raw error here; what matters is the logs.
    await expect(runner.run()).rejects.toThrow();
    // The upload failure happens before the runner logs success, so force a
    // log line through the prune path instead: a listing failure is logged.
    const listingBucket = fakeBucket();
    listingBucket.list = async () => {
      throw new Error(`listing refused ${secret}`);
    };
    const listingRunner = new CloudBackupRunner({
      config,
      bucket: listingBucket,
      log: (message) => logs.push(message),
    });
    await listingRunner.run();
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).toContain("[redacted]");
  });

  it("retention never touches a neighbour prefix that shares the name", async () => {
    seedDb(join(dir, "app.db"), ["ada@example.com"]);
    const bucket = fakeBucket();
    // An old snapshot under "backups2/" — a bare "backups" prefix listing
    // would match it, and pruning it would delete another app's backup.
    const neighbour = makeSnapshotKey("backups2", new Date("2026-01-01T02:00:00.000Z"));
    bucket.objects.set(neighbour, Buffer.from("neighbour"));
    const runner = new CloudBackupRunner({
      config: testConfig({ keepCount: 1, keepDays: 0 }),
      bucket,
      log: () => {},
    });
    await runner.run(new Date("2026-11-05T02:00:00.000Z"));
    expect(bucket.objects.has(neighbour)).toBe(true);
  });
});
