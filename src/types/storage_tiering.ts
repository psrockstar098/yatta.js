/**
 * Storage tiering — move stale files from a local disk to an S3 disk.
 *
 * The problem this solves: a local disk fills up with files nobody opens
 * any more, while an S3 disk sits configured and unused. Tiering moves the
 * files nobody has touched for a while to the S3 disk, and keeps serving
 * them from there, so callers never need to know where a file lives.
 *
 * This module is opt-in and lazy. Nothing here runs, and no access is
 * recorded, unless the app builds a TieredStorage — which itself requires
 * both a local disk and an S3 disk. A single-disk app gets nothing from
 * it: `createTieredStorageFromManager` returns null, and no mover, timer,
 * or tracker is created. The plain `createStorage` path is untouched.
 *
 * Safety rules, in order:
 * - Copy, then verify, then delete. The local file is deleted only after
 *   the S3 copy is proven identical (same size and same content hash).
 *   A failed or interrupted move leaves the local file intact.
 * - Reads fall through. A read tries the local disk first, then the S3
 *   disk, so a file serves while it is being moved and after it moved.
 * - One tenant's file never becomes another's. Every key goes through the
 *   same sanitiser the storage layer already uses, so a key cannot escape
 *   its disk or reach a sibling file.
 * - S3 credentials come from the disk configuration (which the app fills
 *   from the environment before Bun starts). Tiering never reads, logs,
 *   or prints a credential.
 *
 * Two Bun S3 facts shape this code, both from bun.sh/docs/runtime/s3:
 * - `S3Client.file()` is a lazy reference that makes no network request
 *   until a method needs one, so constructing the S3 disk is cheap and
 *   tiering never probes S3 just to decide whether it is active.
 * - Bun reads S3 credentials from the environment at startup, and falls
 *   back from `S3_*` names to `AWS_*` names. Setting them after the
 *   process starts does not take effect, so pass them explicitly in the
 *   disk config instead of relying on late environment changes.
 * - An S3 etag is not comparable to a local etag (different formats for
 *   the same bytes), so verification compares size plus a content hash,
 *   never etags across disks.
 */

import crypto from "node:crypto";
import {
  FileNotFoundError,
  StorageError,
  StorageSecurityError,
  parseDuration,
  sanitizeKey,
  type FileMetadata,
  type HumanTime,
  type IStorageDriver,
  type StorageDisk,
  type StorageFile,
  type StorageManager,
  type UploadInput,
  type UploadOptions,
} from "./storage";

/** Where a file currently lives, as far as tiering can tell. */
export type Tier = "hot" | "cold" | "moving" | "missing";

/** One entry of the per-file access record. */
export interface AccessRecord {
  /** Milliseconds since epoch of the last read or write. */
  lastAccessMs: number;
  /** Total reads and writes since tracking started. */
  accesses: number;
  /** Start of the current promote-counting window, in milliseconds. */
  windowStartMs: number;
  /** Reads inside the current window. */
  readsInWindow: number;
}

/**
 * Smallest tracker surface tiering needs. The in-memory tracker below
 * satisfies it; an app that wants records to survive a restart can swap
 * in its own store behind this interface.
 */
export interface AccessTracker {
  record(key: string, atMs: number, windowMs: number): AccessRecord;
  get(key: string): AccessRecord | undefined;
  forget(key: string): void;
}

/**
 * In-memory access tracker. Records are keyed by sanitised key, so two
 * spellings of the same file share one record and a traversal spelling
 * never creates a second one.
 */
export class InMemoryAccessTracker implements AccessTracker {
  private records = new Map<string, AccessRecord>();

  record(key: string, atMs: number, windowMs: number): AccessRecord {
    const clean = cleanTierKey(key);
    const existing = this.records.get(clean);
    if (!existing) {
      const record: AccessRecord = {
        lastAccessMs: atMs,
        accesses: 1,
        windowStartMs: atMs,
        readsInWindow: 1,
      };
      this.records.set(clean, record);
      return record;
    }
    existing.lastAccessMs = atMs;
    existing.accesses += 1;
    if (atMs - existing.windowStartMs > windowMs) {
      existing.windowStartMs = atMs;
      existing.readsInWindow = 1;
    } else {
      existing.readsInWindow += 1;
    }
    return existing;
  }

  get(key: string): AccessRecord | undefined {
    return this.records.get(cleanTierKey(key));
  }

  forget(key: string): void {
    this.records.delete(cleanTierKey(key));
  }

  /** Snapshot for tests and diagnostics. Keys are sanitised keys. */
  entries(): ReadonlyMap<string, AccessRecord> {
    return this.records;
  }
}

/** How a copy is proven identical before the source is deleted. */
export type TierVerify = (input: {
  key: string;
  source: StorageDisk;
  dest: StorageDisk;
  sourceHead: FileMetadata;
  destHead: FileMetadata;
}) => Promise<boolean>;

/** Options for building a TieredStorage. */
export interface TieringConfig {
  /**
   * How long a file must go untouched before it is a move candidate.
   * A HumanTime value is seconds ("30d" is 30 days); a plain number is
   * also seconds, matching `parseDuration`. Defaults to "30d".
   */
  staleAfter?: HumanTime;
  /** Same threshold in milliseconds. Wins over `staleAfter` when set. */
  staleAfterMs?: number;
  /**
   * Copy a file back to the local disk when it gets hot again.
   * Off by default: a cold file stays cold no matter how often it is
   * read, until the app opts in.
   */
  promoteBack?: boolean;
  /** Cold reads inside one window that trigger a promote. Defaults to 3. */
  promoteAfterReads?: number;
  /** Promote-counting window in milliseconds. Defaults to one day. */
  promoteWindowMs?: number;
  /**
   * Custom verification for a move. Defaults to size plus content-hash
   * comparison. A test can pass a function that returns false to prove
   * a failed verification never deletes the source.
   */
  verify?: TierVerify;
  /** Clock, in milliseconds since epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Test hook: runs after verification, before the source is deleted. */
  onBeforeDelete?: (key: string) => void | Promise<void>;
  /** Called with each move result; failures are reported, not thrown. */
  onMove?: (result: TierMoveResult) => void;
  /** Called when a single file's move fails inside `runOnce`. */
  onError?: (key: string, error: unknown) => void;
  /** Tracker to use. Defaults to a fresh in-memory tracker. */
  tracker?: AccessTracker;
}

/** Outcome of moving one file, in one direction. */
export interface TierMoveResult {
  key: string;
  /** "cold" means local to S3; "hot" means S3 back to local. */
  direction: "cold" | "hot";
  moved: boolean;
  /** Set when `moved` is false and the file was skipped, not failed. */
  skipped?: string;
  /** Set when the move failed. The source file is left intact. */
  error?: unknown;
}

/** Outcome of one mover run. Per-file failures never abort the run. */
export interface TierRunResult {
  moved: string[];
  promoted: string[];
  skipped: string[];
  failed: Array<{ key: string; error: unknown }>;
}

/**
 * Smallest scheduler surface tiering needs (the cron scheduler has it).
 * The interval type is the scheduler's own ("1h" for the cron scheduler,
 * a number for others) — `any` here is deliberate, so this interface
 * accepts any scheduler without forcing its interval format on callers.
 */
export interface TieringScheduler {
  every(
    interval: any,
    task: () => Promise<void> | void,
  ): unknown;
}

/**
 * Tiering's key check, stricter than the storage layer's.
 *
 * The base sanitiser normalises a key and only rejects escapes from the
 * disk root, so `tenant-a/../tenant-b/report.txt` quietly becomes
 * `tenant-b/report.txt` — a caller addressing one tenant's prefix reads
 * another tenant's file. Tiering treats prefixes as namespaces, so any
 * `..` segment is rejected outright instead of normalised away. Keys
 * that reach a disk through tiering can never cross a prefix boundary.
 */
export function cleanTierKey(key: string): string {
  if (typeof key !== "string" || key.split("/").some((part) => part === "..")) {
    throw new StorageSecurityError(
      `Tiering keys must not contain ".." segments: "${key}"`,
    );
  }
  return sanitizeKey(key);
}

/** Hash a file's bytes without loading the whole file into memory. */
async function hashFile(file: StorageFile): Promise<string> {
  const hash = crypto.createHash("sha256");
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}

/** Default verification: same size and same content hash. */
async function defaultVerify(input: {
  source: StorageDisk;
  dest: StorageDisk;
  key: string;
  sourceHead: FileMetadata;
  destHead: FileMetadata;
}): Promise<boolean> {
  if (input.destHead.size !== input.sourceHead.size) return false;
  const [sourceHash, destHash] = await Promise.all([
    hashFile(await input.source.download(input.key)),
    hashFile(await input.dest.download(input.key)),
  ]);
  return sourceHash === destHash;
}

/**
 * Storage that serves files from a hot (local) disk and a cold (S3) disk
 * as if they were one disk, and moves stale files between them.
 *
 * Writes always land on the hot disk. Reads try hot first, then cold.
 * The mover only ever runs when the app calls `runOnce`, a schedule, or
 * `start` — constructing this class starts nothing.
 */
export class TieredStorage {
  readonly hot: StorageDisk;
  readonly cold: StorageDisk;
  readonly staleAfterMs: number;
  readonly promoteBack: boolean;
  readonly promoteAfterReads: number;
  readonly promoteWindowMs: number;
  readonly tracker: AccessTracker;

  private readonly verify: TierVerify;
  private readonly now: () => number;
  private readonly onBeforeDelete?: TieringConfig["onBeforeDelete"];
  private readonly onMove?: TieringConfig["onMove"];
  private readonly onError?: TieringConfig["onError"];
  private readonly moving = new Set<string>();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(hot: StorageDisk, cold: StorageDisk, config: TieringConfig = {}) {
    this.hot = hot;
    this.cold = cold;
    this.staleAfterMs =
      config.staleAfterMs ?? parseDuration(config.staleAfter ?? "30d") * 1000;
    this.promoteBack = config.promoteBack ?? false;
    this.promoteAfterReads = config.promoteAfterReads ?? 3;
    this.promoteWindowMs = config.promoteWindowMs ?? 24 * 60 * 60 * 1000;
    this.tracker = config.tracker ?? new InMemoryAccessTracker();
    this.verify = config.verify ?? defaultVerify;
    this.now = config.now ?? Date.now;
    this.onBeforeDelete = config.onBeforeDelete;
    this.onMove = config.onMove;
    this.onError = config.onError;
  }

  /**
   * Runs `fn` after any earlier mutation for the same key finishes, so a
   * move, a save, a delete, and a promote for one file never overlap.
   * Reads do not take the lock: they fall through from hot to cold, which
   * is what keeps a file serving during a move.
   */
  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const clean = cleanTierKey(key);
    const previous = this.keyLocks.get(clean) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.keyLocks.set(clean, chained);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.keyLocks.get(clean) === chained) this.keyLocks.delete(clean);
    }
  }

  /**
   * Copy from one disk to the other, verify the copy, then delete the
   * source. Delete is the last step, and it only runs after verification
   * passes. Any failure before it leaves the source file intact; a
   * leftover destination copy is removed on the failure path so a later
   * read cannot pick up an unverified copy once the source is gone.
   */
  private async copyVerifyDelete(
    source: StorageDisk,
    dest: StorageDisk,
    key: string,
  ): Promise<void> {
    const clean = cleanTierKey(key);
    const sourceHead = await source.head(clean);
    const sourceFile = await source.download(clean);
    await dest.upload(clean, sourceFile.stream(), {
      contentType: sourceHead.contentType,
      metadata: sourceHead.metadata,
    });
    let verified = false;
    try {
      const destHead = await dest.head(clean);
      verified = await this.verify({
        key: clean,
        source,
        dest,
        sourceHead,
        destHead,
      });
    } catch {
      verified = false;
    }
    if (!verified) {
      // Best effort only: the move has already failed, and a failed
      // cleanup must not mask that failure or delete the source.
      await dest.delete(clean).catch(() => {});
      throw new StorageError(
        `Tiering verification failed for "${clean}": copy does not match the source, source left intact`,
      );
    }
    if (this.onBeforeDelete) await this.onBeforeDelete(clean);
    await source.delete(clean);
  }

  /** Last time a file was touched, or its last-modified time as fallback. */
  private lastActivityMs(key: string, head: FileMetadata): number {
    const tracked = this.tracker.get(key)?.lastAccessMs ?? 0;
    return Math.max(tracked, head.lastModified.getTime());
  }

  /** Save a file. Always writes to the hot disk, never straight to cold. */
  async save(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const clean = cleanTierKey(key);
    return this.withKeyLock(clean, async () => {
      const meta = await this.hot.upload(clean, data, options);
      this.tracker.record(clean, this.now(), this.promoteWindowMs);
      // A fresh version on hot makes any cold copy stale. Removing it is
      // best effort: reads prefer hot, so a leftover cold copy is
      // shadowed, and the next mover run overwrites it anyway.
      await this.cold.delete(clean).catch(() => {});
      return meta;
    });
  }

  /** Fluent file handle on the tiered storage (same shape as a disk's). */
  file(key: string): TieredFileRef {
    return new TieredFileRef(cleanTierKey(key), this);
  }

  /** Fluent upload builder target: same as `file(key).put(...)`. */
  put(key: string): TieredFileRef {
    return this.file(key);
  }

  /** The plain manager's disk, for callers that need one disk directly. */
  disk(name?: string): StorageDisk {
    if (name === undefined) return this.hot;
    if (name === "hot") return this.hot;
    if (name === "cold") return this.cold;
    throw new StorageError(`Tiered storage has no disk named "${name}"`);
  }

  /**
   * Read a file from wherever it lives. Hot first, then cold, so a file
   * serves during a move (still on hot) and after a move (on cold).
   * A cold read that crosses the promote threshold promotes the file
   * first, so the returned handle already points at the hot copy.
   */
  async read(key: string): Promise<StorageFile> {
    return this.download(key);
  }

  /** Alias for `read`, matching the disk's naming. */
  async download(key: string): Promise<StorageFile> {
    const clean = cleanTierKey(key);
    if (await this.hot.exists(clean)) {
      this.tracker.record(clean, this.now(), this.promoteWindowMs);
      return this.hot.download(clean);
    }
    if (await this.cold.exists(clean)) {
      const record = this.tracker.record(clean, this.now(), this.promoteWindowMs);
      if (
        this.promoteBack &&
        record.readsInWindow >= this.promoteAfterReads
      ) {
        await this.promoteToHot(clean);
        return this.hot.download(clean);
      }
      return this.cold.download(clean);
    }
    throw new FileNotFoundError(clean);
  }

  /** Metadata from wherever the file lives. A head is not an access. */
  async head(key: string): Promise<FileMetadata> {
    const clean = cleanTierKey(key);
    if (await this.hot.exists(clean)) return this.hot.head(clean);
    return this.cold.head(clean);
  }

  /** True when the file is on either disk. */
  async exists(key: string): Promise<boolean> {
    const clean = cleanTierKey(key);
    return (await this.hot.exists(clean)) || (await this.cold.exists(clean));
  }

  /** Delete from both disks, after any in-flight move for the key. */
  async delete(key: string): Promise<void> {
    const clean = cleanTierKey(key);
    await this.withKeyLock(clean, async () => {
      await this.hot.delete(clean);
      await this.cold.delete(clean);
      this.tracker.forget(clean);
    });
  }

  /** List hot and cold files merged, with the hot copy winning a clash. */
  async list(options?: { prefix?: string; limit?: number }): Promise<FileMetadata[]> {
    const limit = options?.limit ?? 1000;
    const [hotFiles, coldFiles] = await Promise.all([
      this.hot.list({ prefix: options?.prefix, limit }),
      this.cold.list({ prefix: options?.prefix, limit }),
    ]);
    const merged = new Map<string, FileMetadata>();
    for (const file of coldFiles) merged.set(file.path, file);
    for (const file of hotFiles) merged.set(file.path, file);
    return [...merged.values()].slice(0, limit);
  }

  /**
   * Where a file lives right now. "moving" is reported while a move for
   * the key is between copy and delete; the file still serves then.
   */
  async tierOf(key: string): Promise<Tier> {
    const clean = cleanTierKey(key);
    if (this.moving.has(clean)) return "moving";
    if (await this.hot.exists(clean)) return "hot";
    if (await this.cold.exists(clean)) return "cold";
    return "missing";
  }

  /** Move one file from the hot disk to the cold disk, verified. */
  async moveToCold(key: string): Promise<TierMoveResult> {
    const clean = cleanTierKey(key);
    return this.withKeyLock(clean, async () => {
      if (!(await this.hot.exists(clean))) {
        return { key: clean, direction: "cold", moved: false, skipped: "not-on-hot" };
      }
      this.moving.add(clean);
      try {
        await this.copyVerifyDelete(this.hot, this.cold, clean);
        const result: TierMoveResult = { key: clean, direction: "cold", moved: true };
        this.onMove?.(result);
        return result;
      } catch (error) {
        const result: TierMoveResult = { key: clean, direction: "cold", moved: false, error };
        this.onMove?.(result);
        return result;
      } finally {
        this.moving.delete(clean);
      }
    });
  }

  /** Copy one cold file back to the hot disk, verified, then drop cold. */
  async promoteToHot(key: string): Promise<TierMoveResult> {
    const clean = cleanTierKey(key);
    return this.withKeyLock(clean, async () => {
      if (!(await this.cold.exists(clean))) {
        return { key: clean, direction: "hot", moved: false, skipped: "not-on-cold" };
      }
      if (await this.hot.exists(clean)) {
        await this.cold.delete(clean).catch(() => {});
        return { key: clean, direction: "hot", moved: false, skipped: "already-hot" };
      }
      this.moving.add(clean);
      try {
        await this.copyVerifyDelete(this.cold, this.hot, clean);
        const result: TierMoveResult = { key: clean, direction: "hot", moved: true };
        this.onMove?.(result);
        return result;
      } catch (error) {
        const result: TierMoveResult = { key: clean, direction: "hot", moved: false, error };
        this.onMove?.(result);
        return result;
      } finally {
        this.moving.delete(clean);
      }
    });
  }

  /**
   * One mover run: every hot file untouched for at least `staleAfter`
   * moves to cold. A file with no access record uses its last-modified
   * time, so files written before tiering started still age out. One
   * file's failure is recorded and the run continues with the rest.
   */
  async runOnce(nowMs?: number): Promise<TierRunResult> {
    const now = nowMs ?? this.now();
    const result: TierRunResult = { moved: [], promoted: [], skipped: [], failed: [] };
    const hotFiles = await this.hot.list({ limit: 10_000 });
    for (const file of hotFiles) {
      // A listed key with a ".." segment is never moved: normalising it
      // would move a different file than the listing named.
      if (file.path.split("/").some((part) => part === "..")) {
        result.skipped.push(file.path);
        continue;
      }
      const key = sanitizeKey(file.path);
      if (this.moving.has(key)) {
        result.skipped.push(key);
        continue;
      }
      const lastActivity = this.lastActivityMs(key, file);
      if (now - lastActivity < this.staleAfterMs) {
        result.skipped.push(key);
        continue;
      }
      const move = await this.moveToCold(key);
      if (move.moved) {
        result.moved.push(key);
      } else if (move.error) {
        result.failed.push({ key, error: move.error });
        this.onError?.(key, move.error);
      } else {
        result.skipped.push(key);
      }
    }
    return result;
  }

  /**
   * Run the mover on an interval. Prefer the app's cron scheduler and
   * `scheduleTiering` instead — this is only for standalone scripts.
   * The timer never keeps the process alive on its own.
   */
  start(intervalMs: number): this {
    this.stop();
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.onError?.("runOnce", err));
    }, intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    return this;
  }

  /** Stop an interval started with `start`. */
  stop(): this {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this;
  }
}

/**
 * Fluent file handle on tiered storage. Mirrors the disk's FileRef, but
 * reads fall through from hot to cold and writes always land on hot.
 */
export class TieredFileRef {
  constructor(
    readonly key: string,
    private readonly tiered: TieredStorage,
  ) {}

  async write(data: UploadInput, options?: UploadOptions): Promise<FileMetadata> {
    return this.tiered.save(this.key, data, options);
  }

  async put(data: UploadInput, options?: UploadOptions): Promise<FileMetadata> {
    return this.write(data, options);
  }

  async read(): Promise<StorageFile> {
    return this.tiered.download(this.key);
  }

  async get(): Promise<StorageFile> {
    return this.read();
  }

  async head(): Promise<FileMetadata> {
    return this.tiered.head(this.key);
  }

  async stat(): Promise<FileMetadata> {
    return this.head();
  }

  async exists(): Promise<boolean> {
    return this.tiered.exists(this.key);
  }

  async delete(): Promise<void> {
    return this.tiered.delete(this.key);
  }

  /**
   * Read as text, falling through to cold if the hot copy vanishes
   * between the existence check and the read — the race a move creates.
   */
  async text(): Promise<string> {
    try {
      return await (await this.read()).text();
    } catch (err) {
      if (err instanceof FileNotFoundError) throw err;
      const cold = await this.tiered.cold.download(this.key).catch(() => null);
      if (cold) return cold.text();
      throw err;
    }
  }

  async json<T = unknown>(): Promise<T> {
    return (await this.read()).json<T>();
  }

  async buffer(): Promise<Buffer> {
    return (await this.read()).buffer();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.read()).arrayBuffer();
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    return (await this.read()).stream();
  }

  async blob(): Promise<Blob> {
    return (await this.read()).blob();
  }

  async serve(request?: Request | null, options?: Parameters<StorageFile["serve"]>[1]): Promise<Response> {
    return (await this.read()).serve(request, options);
  }

  async download(options?: { filename?: string }): Promise<Response> {
    const file = await this.read();
    const name = options?.filename ?? this.key.split("/").pop() ?? this.key;
    return file.serve(null, { disposition: "attachment", downloadName: name });
  }

  async copyTo(destinationKey: string): Promise<FileMetadata> {
    const clean = cleanTierKey(destinationKey);
    const source = await this.read();
    return this.tiered.save(clean, source.stream(), {
      contentType: source.contentType,
    });
  }

  async moveTo(destinationKey: string): Promise<FileMetadata> {
    const meta = await this.copyTo(destinationKey);
    await this.delete();
    return meta;
  }

  url(): string {
    return this.tiered.hot.publicUrl(this.key);
  }
}

/**
 * Build tiered storage from two disks directly. Use this in tests and
 * in apps that already hold their disks.
 */
export function createTieredStorage(
  hot: StorageDisk,
  cold: StorageDisk,
  config: TieringConfig = {},
): TieredStorage {
  return new TieredStorage(hot, cold, config);
}

export interface TieredFromManagerConfig extends TieringConfig {
  /** Name of the hot disk. Defaults to the manager's default disk. */
  hotDisk?: string;
  /** Name of the cold disk. Defaults to the first S3 disk found. */
  coldDisk?: string;
}

/**
 * Build tiered storage from a manager, or null when tiering cannot
 * activate: no local disk, no S3 disk, or the named disks are missing
 * or of the wrong kind. Null is the single-disk answer — the caller
 * keeps using the plain manager, and no mover or tracker is created.
 * A hot disk that is not local, or a cold disk that is not S3, is also
 * null rather than a silent misconfiguration.
 */
export function createTieredStorageFromManager(
  manager: StorageManager,
  config: TieredFromManagerConfig = {},
): TieredStorage | null {
  const names = manager.diskNames();
  const hotName = config.hotDisk ?? names.find((n) => manager.driverKind(n) === "local");
  const coldName =
    config.coldDisk ?? names.find((n) => manager.driverKind(n) === "s3");
  if (!hotName || !coldName) return null;
  if (manager.driverKind(hotName) !== "local") return null;
  if (manager.driverKind(coldName) !== "s3") return null;
  // The names are runtime strings, but `disk()` is generic over the
  // app's registered disk names, which a global augmentation narrows.
  // The driverKind checks above are the real validation; the cast only
  // bridges the static narrowing.
  const diskByName = (name: string) => manager.disk(name as never);
  return new TieredStorage(diskByName(hotName), diskByName(coldName), config);
}

/**
 * Register the mover on the app's cron scheduler. The scheduler owns
 * the timing; this only hands it a task that runs the mover and reports
 * a failure without taking the scheduler down. Leader-only scheduling
 * is the app's job, exactly as its other cron tasks do it.
 */
export function scheduleTiering(
  scheduler: TieringScheduler,
  tiered: TieredStorage,
  interval = "1h",
): unknown {
  return scheduler.every(interval, async () => {
    try {
      await tiered.runOnce();
    } catch (err) {
      // No credential or key material ever reaches this log line: the
      // error is a move failure, and its message names only the key.
      console.error("[tiering] mover run failed:", err);
    }
  });
}

/**
 * A job-queue handler for the mover, for apps that run tiering as a job
 * instead of a cron task. Returns the run result so the job can record it.
 */
export function createTieringJobHandler(tiered: TieredStorage) {
  return async (): Promise<TierRunResult> => tiered.runOnce();
}

// Re-exported so tiering tests and apps can build a fake S3-shaped disk
// without importing the whole storage module for one type.
export type { IStorageDriver };
