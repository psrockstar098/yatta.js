// Scheduled, encrypted cloud backups.
//
// What exists already, and is reused rather than rebuilt:
// - `db.backup()` / `db.restore()` (src/types/db.ts): VACUUM INTO snapshots and
//   integrity-checked restores for a single database file.
// - The S3 storage driver (src/types/storage.ts): Bun's S3Client against AWS,
//   MinIO, or R2. Backups upload through it, not through a second S3 client.
// - The cron scheduler (src/types/job.ts): `createCron()` arms timers and skips
//   a tick while the previous run is still going.
//
// What this module adds: the missing pieces between those three. A config block,
// a scheduler that only runs when configured, one encrypted object per run that
// holds the whole database set, and retention pruning that never deletes the
// newest good snapshot.
//
// The database set, stated explicitly:
// - app.db — REQUIRED. The main database: `DATABASE_URL`, else `DATABASE_PATH`,
//   else `Database/app.db`. This is where the users, sessions, passkeys, and
//   application tables live, so there is no separate auth file to back up: the
//   auth store is inside app.db. A run with app.db missing fails outright, and
//   nothing is uploaded or pruned, because a backup without the main database
//   would look complete while missing everything that matters.
// - jobs.db — OPTIONAL. The job queue file (`Database/jobs.db` by default).
//   Absent, it is skipped and noted in the manifest; the run still succeeds.
//   Queued work is worth keeping, but losing it is not losing the app.
// - cache.db — OPTIONAL. The L2 cache file (`Database/cache.db` by default).
//   Absent, it is skipped the same way. A cache is rebuildable by definition,
//   so it is included when present for a complete restore, never required.
// - A custom SQLite file (for example an app that keeps auth in its own file)
//   can be added through `databases` in the config, required or optional.
//
// Honest limit, stated in code as well as docs: every snapshot is FULL. Each
// run uploads every database file again, encrypted. There is no incremental
// engine here on purpose — true incremental backup rides the replication WAL
// transport from the future replication feature, and a second, half-correct
// incremental scheme built now would be worse than full snapshots.
//
// Encryption key: environment variable ONLY (`YATTA_BACKUP_KEY`). It is never
// read from a config file, never written to disk beside a backup, never put
// in backup metadata, and never logged. The key is 32 bytes, given as 64 hex
// characters or base64. The object in the bucket is opaque without it: the
// manifest (file names, sizes, hashes) lives INSIDE the encrypted payload, so
// even the file list is not visible to anyone holding the object but not the
// key. AES-256-GCM authenticates the whole payload, so a flipped byte fails
// decryption instead of restoring corrupt data.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { S3StorageDriver, type S3DriverConfig } from "./storage";
import type { CronScheduler, Duration } from "./job";

/** Thrown for every backup failure. Messages never contain key material. */
export class CloudBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudBackupError";
  }
}

/** One database file in the backup set. */
export interface BackupDatabaseFile {
  /** Name used inside the bundle, e.g. `"app.db"`. */
  name: string;
  /** Filesystem path to the live file. */
  path: string;
  /** A missing required file fails the run; a missing optional one is skipped. */
  required: boolean;
}

/**
 * Full configuration for scheduled cloud backups.
 *
 * `key` is held in memory only, for as long as the scheduler lives. It is
 * never serialized: `JSON.stringify` of a config would show the key bytes, so
 * callers must never log a config object whole. Log lines in this module log
 * object keys and sizes, never the config.
 */
export interface CloudBackupConfig {
  /** Destination bucket, S3-compatible through the existing S3 driver. */
  bucket: string;
  /** Object prefix, e.g. `"yatta-backups"`. Keys are `<prefix>/<stamp>-<rand>.ybk`. */
  prefix: string;
  /** 5-field cron expression in UTC. Ignored when `interval` is set. */
  schedule: string;
  /** Fixed interval like `"24h"` or `"1h"`. When set, it wins over `schedule`. */
  interval?: string;
  /** How many recent snapshots to keep. The newest is always kept regardless. */
  keepCount: number;
  /** Prune snapshots older than this many days. 0 disables age pruning. */
  keepDays: number;
  /** The database set. Defaults cover app.db, jobs.db, and cache.db. */
  databases: BackupDatabaseFile[];
  /** 32-byte encryption key, from the environment only. */
  key: Buffer;
  /** S3 connection settings for the bucket. Credentials stay inside the driver. */
  s3: Omit<S3DriverConfig, "driver" | "bucket">;
  /** Scratch directory for snapshots. Defaults to the OS temp directory. */
  workDir?: string;
}

/** Minimal bucket surface the runner needs. The S3 driver satisfies it. */
export interface BackupBucket {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** Wraps the existing S3 storage driver as a backup bucket. */
export function createS3BackupBucket(config: S3DriverConfig): BackupBucket {
  const driver = new S3StorageDriver(config);
  return {
    async put(key: string, data: Buffer): Promise<void> {
      // The driver uploads through Bun's S3Client, which handles multipart
      // uploads for large files on its own.
      await driver.upload(key, data as unknown as Uint8Array, {
        contentType: "application/octet-stream",
      });
    },
    async get(key: string): Promise<Buffer> {
      const file = await driver.download(key);
      return file.buffer();
    },
    async list(prefix: string): Promise<string[]> {
      // The driver paginates through the bucket, so retention sees every
      // object under the prefix, not just the first page of them.
      const items = await driver.list({ prefix });
      return items.map((item) => item.path);
    },
    async delete(key: string): Promise<void> {
      await driver.delete(key);
    },
  };
}

/**
 * Default database set for a project rooted at the working directory.
 *
 * `appDbPath` overrides the main database location; the jobs and cache paths
 * keep their framework defaults. Relative paths resolve against the working
 * directory, matching how the framework opens these files.
 */
export function defaultBackupDatabases(appDbPath?: string): BackupDatabaseFile[] {
  const app = appDbPath
    ?? process.env.DATABASE_URL
    ?? process.env.DATABASE_PATH
    ?? "Database/app.db";
  return [
    { name: "app.db", path: resolve(app), required: true },
    { name: "jobs.db", path: resolve("Database/jobs.db"), required: false },
    { name: "cache.db", path: resolve("Database/cache.db"), required: false },
  ];
}

/**
 * Parses an encryption key from its environment value.
 *
 * Accepts 64 hex characters or base64 that decodes to exactly 32 bytes.
 * Anything else is an error, not a guess: silently deriving a key from a
 * short passphrase would produce backups nobody can distinguish from ones
 * made with the right key until restore day.
 */
export function parseBackupKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const key = hex
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new CloudBackupError(
      "YATTA_BACKUP_KEY must be 32 bytes, as 64 hex characters or base64",
    );
  }
  return key;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CloudBackupError(`${name} must be a whole number`);
  }
  return Number(raw);
}

/**
 * Loads backup configuration from the environment.
 *
 * Returns null when unconfigured: no bucket or no key means no scheduler, no
 * S3 client, and no backup work at startup. A half-configured setup (bucket
 * without a key, or a malformed key) is an error rather than a silent skip,
 * because it almost certainly means someone meant to have backups and does
 * not. The caller decides whether that error stops boot; the scheduler wiring
 * logs it and carries on without backups.
 *
 * Bucket credentials follow the same lookup Bun's S3Client documents: the
 * `S3_*` variables first, then the `AWS_*` fallbacks. The existing storage
 * wiring only reads the `AWS_*` names, so both are accepted here.
 */
export function loadCloudBackupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudBackupConfig | null {
  const bucket = env.YATTA_BACKUP_BUCKET ?? env.S3_BUCKET ?? "";
  const keyRaw = env.YATTA_BACKUP_KEY ?? "";
  if (!bucket && !keyRaw) return null;
  if (!bucket) {
    throw new CloudBackupError(
      "YATTA_BACKUP_KEY is set but no backup bucket is configured (YATTA_BACKUP_BUCKET)",
    );
  }
  if (!keyRaw) {
    throw new CloudBackupError(
      "YATTA_BACKUP_BUCKET is set but YATTA_BACKUP_KEY is not — backups stay disabled without an encryption key",
    );
  }
  const keepCount = parsePositiveInt(env.YATTA_BACKUP_KEEP_COUNT, "YATTA_BACKUP_KEEP_COUNT", 7);
  if (keepCount < 1) {
    throw new CloudBackupError("YATTA_BACKUP_KEEP_COUNT must be at least 1");
  }
  const keepDays = parsePositiveInt(env.YATTA_BACKUP_KEEP_DAYS, "YATTA_BACKUP_KEEP_DAYS", 30);
  const databases = defaultBackupDatabases();
  // Per-file overrides, for apps that moved the jobs or cache files.
  if (env.YATTA_BACKUP_JOBS_DB) {
    databases[1] = { name: "jobs.db", path: resolve(env.YATTA_BACKUP_JOBS_DB), required: false };
  }
  if (env.YATTA_BACKUP_CACHE_DB) {
    databases[2] = { name: "cache.db", path: resolve(env.YATTA_BACKUP_CACHE_DB), required: false };
  }
  return {
    bucket,
    prefix: env.YATTA_BACKUP_PREFIX ?? "yatta-backups",
    schedule: env.YATTA_BACKUP_SCHEDULE ?? "0 2 * * *",
    interval: env.YATTA_BACKUP_INTERVAL || undefined,
    keepCount,
    keepDays,
    databases,
    key: parseBackupKey(keyRaw),
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? env.AWS_REGION ?? "us-east-1",
      accessKeyId: env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN,
    },
  };
}

// ── Encryption ──────────────────────────────────────────────────────────────
// Envelope, all inside the uploaded object, nothing beside it:
//   magic "YBK1" (4 bytes) | nonce (12 bytes) | auth tag (16 bytes) | ciphertext
// The tag covers the whole ciphertext, so decryption fails on any tampering,
// on a wrong key, and on a truncated object — all with the same generic error,
// which deliberately does not say which of the three it was.

const ENVELOPE_MAGIC = "YBK1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts a plaintext bundle. The key never leaves this call's arguments. */
export function encryptBackup(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new CloudBackupError("Backup encryption key must be 32 bytes");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(ENVELOPE_MAGIC), nonce, tag, ciphertext]);
}

/** Decrypts an envelope. Throws on tampering, truncation, or a wrong key. */
export function decryptBackup(envelope: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new CloudBackupError("Backup encryption key must be 32 bytes");
  }
  const header = ENVELOPE_MAGIC.length + NONCE_BYTES + TAG_BYTES;
  if (
    envelope.length <= header
    || envelope.subarray(0, ENVELOPE_MAGIC.length).toString() !== ENVELOPE_MAGIC
  ) {
    throw new CloudBackupError("Backup object is not a Yatta encrypted backup");
  }
  const nonce = envelope.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + NONCE_BYTES);
  const tag = envelope.subarray(
    ENVELOPE_MAGIC.length + NONCE_BYTES,
    header,
  );
  const ciphertext = envelope.subarray(header);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // One message for tamper, wrong key, and corruption alike: distinguishing
    // them would tell an attacker holding the object whether a guessed key
    // was close, and the operator's next step is the same in all three cases.
    throw new CloudBackupError(
      "Backup decryption failed: object is tampered, corrupt, or the key is wrong",
    );
  }
}

// ── Bundle ──────────────────────────────────────────────────────────────────
// Binary framing, kept inside the encrypted payload:
//   magic "YBND" (4 bytes) | manifest length, big-endian u32 | manifest JSON
//   | file bytes, concatenated in manifest order
// The manifest carries each file's size and SHA-256, so unpacking verifies
// every file even if decryption somehow succeeded on altered plaintext.

const BUNDLE_MAGIC = "YBND";

export interface BundleFileEntry {
  name: string;
  size: number;
  sha256: string;
  /** Files present in the set but absent on disk at snapshot time. */
  skipped?: boolean;
}

export interface SnapshotFile {
  name: string;
  bytes: Buffer;
}

export function packSnapshot(
  files: SnapshotFile[],
  skipped: string[],
  createdAt: string,
): Buffer {
  const manifest = {
    version: 1,
    createdAt,
    files: [
      ...files.map((file) => ({
        name: file.name,
        size: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      })),
      ...skipped.map((name) => ({ name, size: 0, sha256: "", skipped: true })),
    ] as BundleFileEntry[],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length, 0);
  return Buffer.concat([
    Buffer.from(BUNDLE_MAGIC),
    length,
    manifestBytes,
    ...files.map((file) => file.bytes),
  ]);
}

export interface UnpackedSnapshot {
  createdAt: string;
  files: SnapshotFile[];
  skipped: string[];
}

export function unpackSnapshot(bundle: Buffer): UnpackedSnapshot {
  const header = BUNDLE_MAGIC.length + 4;
  if (
    bundle.length < header
    || bundle.subarray(0, BUNDLE_MAGIC.length).toString() !== BUNDLE_MAGIC
  ) {
    throw new CloudBackupError("Backup bundle is corrupt or not a Yatta snapshot");
  }
  const manifestLength = bundle.readUInt32BE(BUNDLE_MAGIC.length);
  if (bundle.length < header + manifestLength) {
    throw new CloudBackupError("Backup bundle is truncated");
  }
  let manifest: { version: number; createdAt: string; files: BundleFileEntry[] };
  try {
    manifest = JSON.parse(
      bundle.subarray(header, header + manifestLength).toString("utf8"),
    );
  } catch {
    throw new CloudBackupError("Backup bundle manifest is corrupt");
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new CloudBackupError("Backup bundle manifest is corrupt");
  }
  const files: SnapshotFile[] = [];
  const skipped: string[] = [];
  let offset = header + manifestLength;
  for (const entry of manifest.files) {
    if (entry.skipped) {
      skipped.push(entry.name);
      continue;
    }
    if (offset + entry.size > bundle.length) {
      throw new CloudBackupError(`Backup bundle is truncated at ${entry.name}`);
    }
    const bytes = bundle.subarray(offset, offset + entry.size);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.sha256) {
      throw new CloudBackupError(`Backup bundle hash mismatch for ${entry.name}`);
    }
    files.push({ name: entry.name, bytes: Buffer.from(bytes) });
    offset += entry.size;
  }
  return { createdAt: manifest.createdAt, files, skipped };
}

// ── Snapshotting ────────────────────────────────────────────────────────────
// Every file is snapshotted with VACUUM INTO, the same online-safe mechanism
// `db.backup()` uses: a fresh, self-contained database written in one
// transaction, including anything still in the WAL. Copying the live file
// would risk a torn snapshot while writers are active, so no file is copied
// directly. The snapshot runs on the scheduler tick, never on a request path,
// and the upload that follows is async; neither blocks request handling
// beyond the snapshot transaction itself.

export function snapshotSqliteFile(sourcePath: string, destPath: string): void {
  if (sourcePath === ":memory:") {
    throw new CloudBackupError("Cannot back up an in-memory database");
  }
  const parent = dirname(destPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const tempPath = `${destPath}.tmp.${Date.now()}`;
  let db: Database | null = null;
  try {
    // Read-write, because SQLite refuses VACUUM INTO on a read-only
    // connection. The statement only reads the source and writes the
    // destination, and Bun requires `create: true` to open an existing file.
    db = new Database(sourcePath, { create: true });
    const escaped = tempPath.replace(/'/g, "''");
    db.run(`VACUUM INTO '${escaped}';`);
    renameSync(tempPath, destPath);
  } catch (err) {
    if (existsSync(tempPath)) {
      try { rmSync(tempPath, { force: true }); } catch {}
    }
    throw new CloudBackupError(
      `Snapshot failed for ${basename(sourcePath)}: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Integrity check for one restored snapshot file, mirroring `db.restore()`:
 * `quick_check` must pass, and a required database must hold a schema. A
 * zero-length file passes `quick_check` on its own, so the schema check is
 * what stops an empty file from restoring as a wiped database.
 */
export function verifySqliteSnapshotFile(
  filePath: string,
  requireSchema: boolean,
): void {
  let db: Database | null = null;
  try {
    db = new Database(filePath, { readonly: true });
    const check = db.query("PRAGMA quick_check;").get() as { quick_check: string } | null;
    if (check?.quick_check !== "ok") {
      throw new Error("integrity check failed");
    }
    if (requireSchema) {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table';")
        .all() as { name: string }[];
      if (tables.length === 0) {
        throw new Error("file holds no schema");
      }
    }
  } catch (err) {
    throw new CloudBackupError(
      `Restored file ${basename(filePath)} failed verification: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  } finally {
    try { db?.close(true); } catch {}
  }
}

// ── Retention ───────────────────────────────────────────────────────────────
// Keys look like `<prefix>/2026-11-05T02-00-00-000Z-<rand>.ybk`. The timestamp
// is parsed back out of the key, because object listing order is not a
// reliable sort and the bucket gives no creation-time guarantee across
// providers. Keys that do not parse are KEPT: deleting an object the pruner
// cannot identify would risk deleting something it does not own.

const SNAPSHOT_KEY_PATTERN = /^(.+)\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]+\.ybk$/;

export function snapshotTimestampFromKey(key: string): number | null {
  const match = SNAPSHOT_KEY_PATTERN.exec(key);
  if (!match || !match[2]) return null;
  // The stamp uses dashes where ISO uses colons, so it stays a safe object
  // key on every provider. Rebuild ISO form before parsing.
  const stamp = match[2];
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/**
 * Which snapshot keys to prune, given the full listing.
 *
 * Rules, in order: the newest snapshot is never pruned, and neither is the
 * snapshot this run just uploaded. After that, a snapshot goes when it is
 * past the count limit or past the age limit. Unparsable keys are kept.
 * Pruning is best-effort in the runner: a listing failure skips pruning
 * entirely rather than guessing, and a delete failure leaves that object
 * for the next run.
 */
export function selectSnapshotsToPrune(
  keys: string[],
  options: { keepCount: number; keepDays: number; justUploadedKey: string; now?: number },
): string[] {
  const now = options.now ?? Date.now();
  const ageCutoff = options.keepDays > 0
    ? now - options.keepDays * 24 * 60 * 60 * 1000
    : null;
  const dated = keys
    .map((key) => ({ key, time: snapshotTimestampFromKey(key) }))
    .filter((entry) => entry.time !== null)
    .sort((a, b) => (b.time as number) - (a.time as number));
  if (dated.length === 0) return [];
  const newest = dated[0]?.key;
  if (!newest) return [];
  const prune: string[] = [];
  dated.forEach((entry, index) => {
    if (entry.key === newest) return;
    if (entry.key === options.justUploadedKey) return;
    const overCount = index >= options.keepCount;
    const overAge = ageCutoff !== null && (entry.time as number) < ageCutoff;
    if (overCount || overAge) prune.push(entry.key);
  });
  return prune;
}

export function makeSnapshotKey(prefix: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
  // ISO already ends in Z; the replaces above turn "02:00:00.000Z" into
  // "02-00-00-000Z", which is safe in an object key.
  const cleanPrefix = prefix.replace(/\/+$/, "");
  // 8 random bytes: two runs in the same millisecond must not share a key,
  // or the second upload would silently overwrite the first snapshot.
  return `${cleanPrefix}/${stamp}-${randomBytes(8).toString("hex")}.ybk`;
}

/**
 * Removes bucket credential values from a log line, if they ever appear in
 * one. Error messages from a storage driver are not expected to carry them,
 * but a log line is the wrong place to find out otherwise: the runner and
 * the scheduler both log through this, so no failure path can print a
 * credential even when the underlying error text does contain one.
 */
export function scrubBackupSecrets(message: string, config: CloudBackupConfig): string {
  let scrubbed = message;
  for (const value of [
    config.s3.accessKeyId,
    config.s3.secretAccessKey,
    config.s3.sessionToken,
  ]) {
    if (value && value.length >= 4) {
      scrubbed = scrubbed.split(value).join("[redacted]");
    }
  }
  return scrubbed;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface CloudBackupRunResult {
  key: string;
  /** Files snapshotted and uploaded, with their snapshot sizes. */
  files: { name: string; size: number }[];
  /** Optional files absent on disk at snapshot time. */
  skipped: string[];
  /** Older snapshots deleted by retention in this run. */
  pruned: string[];
}

export interface CloudBackupRunnerOptions {
  config: CloudBackupConfig;
  bucket: BackupBucket;
  /** Log lines go here; defaults to console. Never receives key material. */
  log?: (message: string) => void;
}

export class CloudBackupRunner {
  private readonly config: CloudBackupConfig;
  private readonly bucket: BackupBucket;
  private readonly log: (message: string) => void;
  private running = false;

  constructor(options: CloudBackupRunnerOptions) {
    this.config = options.config;
    this.bucket = options.bucket;
    const rawLog = options.log ?? ((message: string) => console.log(message));
    // Every log line the runner emits passes through the scrubber, so a
    // credential that slips into an error message never reaches the logs.
    this.log = (message: string) => rawLog(scrubBackupSecrets(message, this.config));
  }

  /** True while a run is in flight. The cron scheduler also skips overlaps. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Takes a full snapshot of the database set, encrypts it, uploads it, and
   * then prunes old snapshots. A failure before upload uploads nothing and
   * prunes nothing. A failure after upload leaves the new snapshot in place
   * and reports the error, so a failed prune never destroys a good backup.
   */
  async run(now: Date = new Date()): Promise<CloudBackupRunResult> {
    if (this.running) {
      throw new CloudBackupError("A cloud backup run is already in progress");
    }
    this.running = true;
    const workDir = mkdtempSync(join(this.config.workDir ?? tmpdir(), "yatta-cloud-backup-"));
    try {
      const files: SnapshotFile[] = [];
      const skipped: string[] = [];
      for (const entry of this.config.databases) {
        if (!existsSync(entry.path)) {
          if (entry.required) {
            throw new CloudBackupError(
              `Required database file is missing: ${entry.name} (no backup uploaded, nothing pruned)`,
            );
          }
          skipped.push(entry.name);
          continue;
        }
        const dest = join(workDir, entry.name);
        snapshotSqliteFile(entry.path, dest);
        const bytes = readFileSync(dest);
        // Plaintext snapshots live on disk only until they are read: delete
        // each one as soon as its bytes are in memory, instead of leaving
        // the whole set lying in the scratch directory until the run ends.
        // A crash mid-run can still leave a snapshot behind in the OS temp
        // directory — that is the residual risk, noted in the docs.
        unlinkSync(dest);
        files.push({ name: entry.name, bytes });
      }
      if (files.length === 0) {
        throw new CloudBackupError("No database files found to back up");
      }
      const createdAt = now.toISOString();
      const bundle = packSnapshot(files, skipped, createdAt);
      const encrypted = encryptBackup(bundle, this.config.key);
      const key = makeSnapshotKey(this.config.prefix, now);
      // The upload is async and off the request path; the snapshot files are
      // local by now, so a slow bucket cannot stall request handling.
      await this.bucket.put(key, encrypted);
      this.log(
        `[cloud-backup] uploaded ${key} (${encrypted.length} bytes, ${files.length} database file(s))`,
      );
      const pruned = await this.prune(key);
      return {
        key,
        files: files.map((file) => ({ name: file.name, size: file.bytes.length })),
        skipped,
        pruned,
      };
    } finally {
      this.running = false;
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async prune(justUploadedKey: string): Promise<string[]> {
    let keys: string[];
    try {
      // List under `<prefix>/`, not `<prefix>`: a bare prefix would also
      // match a neighbour like `backups2/`, and the pruner must never delete
      // objects outside its own prefix directory.
      const dirPrefix = `${this.config.prefix.replace(/\/+$/, "")}/`;
      keys = await this.bucket.list(dirPrefix);
    } catch (err) {
      // Listing failed, so pruning cannot know what is safe to delete. Skip
      // it and keep every snapshot; the next run retries. The message is
      // scrubbed by the runner's log wrapper before it is emitted.
      this.log(
        `[cloud-backup] retention skipped: could not list snapshots (${err instanceof Error ? err.message : "error"})`,
      );
      return [];
    }
    const toPrune = selectSnapshotsToPrune(keys, {
      keepCount: this.config.keepCount,
      keepDays: this.config.keepDays,
      justUploadedKey,
    });
    const pruned: string[] = [];
    for (const key of toPrune) {
      try {
        await this.bucket.delete(key);
        pruned.push(key);
      } catch {
        // One failed delete must not abort the rest, and must never touch
        // the newest snapshot, which selectSnapshotsToPrune already excluded.
        this.log(`[cloud-backup] retention kept ${key}: delete failed, retrying next run`);
      }
    }
    if (pruned.length > 0) {
      this.log(`[cloud-backup] retention pruned ${pruned.length} old snapshot(s)`);
    }
    return pruned;
  }
}

export interface RestoredSnapshot {
  /** Directory holding the verified, decrypted database files. */
  outDir: string;
  /** One entry per file in the snapshot, with its staged path. */
  files: { name: string; path: string }[];
  /** Optional files that were absent when the snapshot was taken. */
  skipped: string[];
  /** Creation time recorded in the snapshot manifest. */
  createdAt: string;
}

/**
 * Downloads, decrypts, hash-verifies, and integrity-checks a snapshot, and
 * stages the files in `outDir` (created if needed).
 *
 * This deliberately does NOT overwrite the live databases. The caller moves
 * the staged app.db into place with `db.restore(stagedPath)`, which runs
 * its own integrity check and atomic swap; jobs.db and cache.db can be put
 * back while their owners are stopped, or left staged for inspection. A
 * tampered or wrong-key object fails here, before any live file is touched.
 * The staged files are PLAINTEXT databases: the caller owns deleting them
 * once the restore is done, and must not leave them in a shared directory.
 */
export async function restoreCloudBackup(options: {
  bucket: BackupBucket;
  key: string;
  keyMaterial: Buffer;
  outDir: string;
  /** Names that must hold a schema; defaults to every file except cache.db. */
  requireSchemaFor?: (name: string) => boolean;
}): Promise<RestoredSnapshot> {
  const encrypted = await options.bucket.get(options.key);
  const bundle = decryptBackup(encrypted, options.keyMaterial);
  const unpacked = unpackSnapshot(bundle);
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });
  const requireSchema = options.requireSchemaFor ?? ((name: string) => name !== "cache.db");
  const files: { name: string; path: string }[] = [];
  for (const file of unpacked.files) {
    const staged = join(options.outDir, file.name);
    writeFileSync(staged, file.bytes);
    verifySqliteSnapshotFile(staged, requireSchema(file.name));
    files.push({ name: file.name, path: staged });
  }
  return { outDir: options.outDir, files, skipped: unpacked.skipped, createdAt: unpacked.createdAt };
}

/**
 * Arms the backup schedule on a cron scheduler. Returns false and arms
 * nothing when unconfigured, so importing this module never starts backup
 * work on its own. Handler errors are logged, never thrown, so a failed
 * backup tick cannot take the scheduler down with it.
 */
export function scheduleCloudBackups(
  cron: CronScheduler,
  config: CloudBackupConfig,
  bucket: BackupBucket,
  log: (message: string) => void = (message: string) => console.log(message),
): boolean {
  const runner = new CloudBackupRunner({ config, bucket, log });
  const handler = async (): Promise<void> => {
    try {
      await runner.run();
    } catch (err) {
      // Log the message only, never the error object: a driver error object
      // can carry request details, and this path must never become a place
      // where credentials or key material reach the logs. The message is
      // scrubbed the same way the runner scrubs its own lines.
      log(scrubBackupSecrets(
        `[cloud-backup] scheduled run failed: ${err instanceof Error ? err.message : "unknown error"}`,
        config,
      ));
    }
  };
  if (config.interval) {
    cron.every(config.interval as Duration, handler, "cloud-backups");
  } else {
    cron.schedule("cloud-backups", config.schedule, handler, { timezone: "UTC", concurrency: "skip" });
  }
  return true;
}
