# Cloud backups — scheduled, encrypted snapshots

Your app's databases are its memory. A disk failure, a bad deploy, or a
deleted volume takes all of it, and the local `yatta db:backup` file is on
the same disk that just failed. Cloud backups fix that: on a schedule, the
whole database set is snapshotted, encrypted, and uploaded to an
S3-compatible bucket, and old snapshots are pruned automatically.

```ts
import { createCron } from "yatta.js/jobs";
import {
  createS3BackupBucket,
  loadCloudBackupConfigFromEnv,
  scheduleCloudBackups,
} from "yatta.js/cloud-backups";

const config = loadCloudBackupConfigFromEnv();
if (config) {
  scheduleCloudBackups(createCron(), config, createS3BackupBucket({
    driver: "s3",
    bucket: config.bucket,
    ...config.s3,
  }));
}
```

In practice you do not wire this by hand: the framework's cron subsystem
already does it. Set the environment variables below and the schedule arms
itself on the leader worker. Nothing else is needed.

## Opt-in and lazy — zero cost when unconfigured

Backups are fully opt-in. With no `YATTA_BACKUP_BUCKET` and no
`YATTA_BACKUP_KEY` in the environment, no schedule is armed, no S3 client
is built, and no backup work runs at startup. The scheduler check reads
two strings and returns; that is the entire cost of the feature for apps
that do not use it.

## Configuration file (JSON5)

Non-secret settings can also live in a hand-edited file, pointed to by
`YATTA_BACKUP_CONFIG_FILE`. The file is JSON5, so comments and trailing
commas work:

```json5
{
  // Nightly snapshots to the archive bucket.
  bucket: "my-backups",
  prefix: "nightly",
  schedule: "0 3 * * *",
  keepCount: 3,
  keepDays: 14,
}
```

Environment variables win over the file for every field, so a deploy can
override the file without editing it. The file may set `bucket`,
`prefix`, `schedule`, `interval`, `keepCount`, `keepDays`, `endpoint`,
`region`, and `databases` — and nothing else. The encryption key and
bucket credentials are environment-only, and a file that tries to set
them (`key`, `secretAccessKey`, and friends) is rejected outright, as is
an unknown field, so a typo fails loudly instead of silently doing
nothing. A file database set must still keep a required entry
(`app.db`); a set with no required file is a configuration error.

## Configuration

Secrets come from the environment only. The encryption key in particular
comes from the environment — never from a file, never from code, never
from a default. Non-secret settings may also come from a JSON5 file (see
above); the variables below win over the file for every field.

```sh
# Destination bucket (S3, MinIO, or R2 through the existing S3 driver).
YATTA_BACKUP_BUCKET=my-backups
# S3 endpoint for MinIO/R2. Omit for AWS S3.
S3_ENDPOINT=https://my-account.r2.cloudflarestorage.com
# Credentials follow Bun's S3 lookup: S3_* first, then the AWS_* fallbacks.
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
# Encryption key: 32 bytes, as 64 hex characters or base64. Required.
YATTA_BACKUP_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
# Optional: schedule, retention, prefix.
YATTA_BACKUP_SCHEDULE="0 2 * * *"   # daily at 02:00 UTC (the default)
YATTA_BACKUP_INTERVAL=24h           # when set, wins over the schedule
YATTA_BACKUP_KEEP_COUNT=7           # keep the newest 7 snapshots (default)
YATTA_BACKUP_KEEP_DAYS=30           # prune snapshots older than 30 days (default, 0 disables)
YATTA_BACKUP_PREFIX=yatta-backups   # object prefix (default)
```

A half-configured setup is an error, not a silent skip: a bucket without
a key, or a malformed key, logs once and schedules nothing. That is
deliberate — it almost certainly means someone meant to have backups and
does not. A malformed key is never guessed at: a short passphrase is not
quietly stretched into a key, because a backup made with the wrong key is
only discovered on restore day.

```ts
import { loadCloudBackupConfigFromEnv } from "yatta.js/cloud-backups";

// Returns null when unconfigured, throws on a half-configured setup.
const config = loadCloudBackupConfigFromEnv();
```

## What is backed up

The backup set is explicit, and it is one encrypted object per run:

- `app.db` — REQUIRED. The main database (`DATABASE_URL`, else
  `DATABASE_PATH`, else `Database/app.db`). Users, sessions, passkeys,
  and application tables all live here, so there is no separate auth file
  to back up: the auth store is inside `app.db`. A run with `app.db`
  missing fails outright — nothing is uploaded and nothing is pruned —
  because a backup without the main database would look complete while
  missing everything that matters.
- `jobs.db` — OPTIONAL. The job queue file. Absent, it is skipped and
  noted in the manifest; the run still succeeds.
- `cache.db` — OPTIONAL. The L2 cache file. Absent, it is skipped the
  same way. A cache is rebuildable, so it is included when present for a
  complete restore, never required.
- A custom SQLite file (for example an app that keeps auth in its own
  file) can be added through `databases` in the config, required or
  optional.

Each file is snapshotted with `VACUUM INTO`, the same online-safe
mechanism `db.backup()` uses: a fresh, self-contained database written in
one transaction, including anything still in the WAL. Live files are
never copied directly, so a snapshot taken while writers are active is
still consistent. The snapshot runs on the scheduler tick, never on a
request path, and the upload that follows is async.

```ts
import { CloudBackupRunner, createS3BackupBucket } from "yatta.js/cloud-backups";

const runner = new CloudBackupRunner({ config, bucket: createS3BackupBucket({
  driver: "s3",
  bucket: config.bucket,
  ...config.s3,
}) });
const result = await runner.run();
// { key: "yatta-backups/2026-11-05T02-00-00-000Z-<rand>.ybk",
//   files: [{ name: "app.db", size: 12345 }], skipped: ["cache.db"], pruned: [...] }
```

## Encryption

Every object is encrypted with AES-256-GCM under `YATTA_BACKUP_KEY`
before upload. The manifest — file names, sizes, hashes — lives INSIDE
the encrypted payload, so even the file list is not visible to anyone
holding the object but not the key. The key is never written to disk
beside a backup, never put in backup metadata, and never logged. Bucket
credentials are scrubbed from log lines the same way, even when they
appear inside an error message from the storage driver.

Without the key, an object is opaque: it does not open as SQLite, and
decryption fails rather than producing partial data. A flipped byte or a
truncated upload fails the same way, because the GCM authentication tag
covers the whole payload.

## Restore

Restore is the reverse, and it never touches a live database on its own.
It downloads, decrypts, hash-verifies every file, and integrity-checks
each SQLite file (`quick_check`, plus a schema check for required files,
so an empty file cannot restore as a wiped database). The verified files
are staged in a directory you choose; from there, move the staged
`app.db` into place with `db.restore()`, which runs its own integrity
check and atomic swap.

```ts
import { restoreCloudBackup } from "yatta.js/cloud-backups";

const restored = await restoreCloudBackup({
  bucket,
  key: "yatta-backups/2026-11-05T02-00-00-000Z-<rand>.ybk",
  keyMaterial: parseBackupKey(process.env.YATTA_BACKUP_KEY!),
  outDir: "./restore-staging",
});
// Then, for the live database:
db.restore(restored.files.find((f) => f.name === "app.db")!.path);
```

A tampered or wrong-key object fails here, before any live file is
touched. A restore with the wrong key and a restore of a tampered object
produce the same generic error on purpose: distinguishing them would
tell an attacker holding the object whether a guessed key was close.

## Retention

After each successful upload, old snapshots are pruned: anything past
`YATTA_BACKUP_KEEP_COUNT`, or older than `YATTA_BACKUP_KEEP_DAYS`, goes.
Three rules keep pruning safe:

- The newest snapshot is never deleted, even when it is older than the
  age limit. An old newest snapshot is still the only snapshot.
- The snapshot this run just uploaded is never deleted.
- Keys the pruner cannot parse, and objects outside the prefix directory,
  are kept. Pruning deletes only snapshots it can positively identify as
  its own and old.

A failed upload prunes nothing, and a failed listing skips pruning
entirely rather than guessing. A failed delete leaves that object for the
next run.

## Gotchas

- **Snapshots are FULL, every time.** Each run uploads every database
  file again, encrypted. There is no incremental backup here, on purpose:
  true incremental backup rides the replication WAL transport from the
  future replication feature, and a second, half-correct incremental
  scheme would be worse than full snapshots. Size your bucket and your
  schedule with that in mind.
- **Lose the key, lose the backups.** There is no recovery path: no key
  escrow, no alternate decryption, no plaintext copy anywhere. Rotate
  keys by taking a fresh backup under the new key and keeping at least
  one snapshot under the old key until the new one is verified.
- **Plaintext exists briefly, twice.** Snapshot files sit unencrypted in
  the OS temp directory while a run packs them (each is deleted as soon
  as its bytes are read, and the scratch directory is removed when the
  run ends, but a crash mid-run can leave one behind). Restored files
  are plaintext by definition — delete the staging directory once the
  restore is done, and do not stage restores in a shared directory.
- **Restore needs the owners stopped for jobs and cache.** `db.restore()`
  handles the live app database safely. For `jobs.db` and `cache.db`,
  put the staged files back while their owners are stopped, or the live
  process keeps writing to the file you just replaced.
- **The scheduler is leader-only.** In a cluster, only the leader worker
  runs the backup schedule, like every other schedule in the cron
  subsystem. A single-worker app is its own leader.
- **Provider behavior is not covered by tests.** Tests run against a
  fake in-memory bucket, which proves the runner's logic but not Bun's
  S3Client against a real provider. Verify the first real upload and the
  first real restore against your actual bucket before relying on it.

## Bun runtime notes

- **Compiled binaries (AOT).** Backups use nothing a compiled binary
  cannot do: no dynamic code loading, no `eval`, no runtime `require`
  of user paths — just `bun:sqlite`, `node:crypto`, and the S3 client.
  If backups ever run from a `bun compile` binary and feel slow, run
  `bun compile --explain` and fix the slow paths it lists worst-first;
  typed code runs faster compiled, untyped code can run slower than JIT,
  so the typed engine code here is the right shape already. A
  compiled-binary backup run has not been verified in this round.
- **Runtime flags.** The feature sets no runtime flags and needs none.
  `--smol` trades speed for memory and is an explicit knob only, never
  a default — it is not recommended here, since a run already holds the
  snapshot bundle in memory while it encrypts and hashes. The feature
  uses no FFI and no native addons, so `--no-ffi-cc` / `--no-addons`
  are compatible with it.
- **String-to-code paths.** There are none in the backup path, so the
  feature is compatible with `--disallow-code-generation-from-strings`
  (including `=strict`, which blocks every string-to-code path). Note
  the distinction: the `VACUUM INTO '...'` statement is a SQL string
  with its single quotes doubled for escaping — it is not JavaScript
  code generation, and the flag does not affect it.
- **Bundler.** `Bun.build()` and its in-memory `files` map were
  considered for avoiding temp files and rejected: SQLite's
  `VACUUM INTO` needs real file paths, so database snapshots cannot be
  built from memory. Temp snapshot files are the honest mechanism, and
  each is deleted as soon as its bytes are read.
- **C under Bun.** `bun:ffi` `cc()` via TinyCC was considered and
  rejected: there is no profiler-proven hot path here. Encryption,
  hashing, and SQLite are already native; TinyCC compiles fast but does
  not optimize, so dropping to C would add FFI surface for no measured
  gain. Revisit only if a profile says otherwise.
