import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  createDatabase,
  col,
  type TypedDatabase,
} from "../types/db";
import {
  createJobs,
  createEvents,
  createCron,
  SQLiteJobStore,
  MemoryJobStore,
  CronExpression,
  QueueError,
  duration,
  type JobRecord,
} from "../types/job";
import {
  MemoryCacheEngine,
  SQLiteL2CacheStore,
  DoublyLinkedList,
} from "../types/cache_queue";
import {
  parseSize,
  verifyMagicBytes,
  StorageDisk,
  LocalStorageDriver,
  PreconditionFailedError,
  sanitizeKey,
  guessContentType,
  FileNotFoundError,
  StorageFile,
  type UploadInput,
  type UploadOptions,
  type ListOptions,
} from "../types/storage";
import {
  TieredStorage,
  InMemoryAccessTracker,
  type IStorageDriver,
} from "../types/storage_tiering";
import {
  normalizeRollupPolicy,
  runRollupPolicy,
  readRollup,
  type RollupPolicyConfig,
} from "../types/timeseries";
import {
  RaftNode,
  InMemoryRaftLog,
  InMemoryRaftTransport,
  PersistentRaftState,
  createRaftHttpHandler,
  type RaftLogEntry,
} from "../types/raft";
import { createNodeToken } from "../types/replication";
import {
  ReplicationPublisher,
  ReplicationApplier,
  signBatch,
  type ReplicationBatch,
} from "../types/replication";
import {
  recordOutbox,
  OutboxRelay,
  getOutboxByEventId,
  type OutboxStore,
  type OutboxEntry,
} from "../types/outbox";
import { SamplingProfiler } from "../types/profiler";
import { createColumnStore, Batch } from "../types/ds";

// Regression tests for the Yatta JS 1.0.6 runtime hunter findings.
// Each test names the finding it pins; a test that fails on the
// pre-fix code is marked RED-VERIFY in the fix report.

const RAFT_SECRET = "test-raft-secret-that-is-not-real";
const REPL_SECRET = "test-secret-that-is-not-real";

const userSchema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    name: col.text(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
};

type UserDb = TypedDatabase<typeof userSchema>;
const dbs: { close(): void | Promise<void> }[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    try {
      await db.close();
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function memUserDb(): UserDb {
  const db = createDatabase({ path: ":memory:", schema: userSchema, forceNew: true });
  dbs.push(db);
  return db;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function fileUserDb(): { db: UserDb; dir: string; dbPath: string } {
  const dir = tmpDir("yatta-hunter-");
  const dbPath = path.join(dir, "app.db");
  const db = createDatabase({ path: dbPath, schema: userSchema, forceNew: true });
  dbs.push(db);
  return { db, dir, dbPath };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("hunter runtime fixes — jobs", () => {
  it("#17 duration() rejects NaN and negative numbers", () => {
    expect(() => duration(NaN)).toThrow(QueueError);
    expect(() => duration(-1)).toThrow(QueueError);
    expect(() => duration(Number.POSITIVE_INFINITY)).toThrow(QueueError);
    expect(duration("5s")).toBe(5000);
    expect(duration(250)).toBe(250);
    expect(duration(undefined, 1000)).toBe(1000);
  });

  it("#8 EventBus multi-segment wildcards fire", async () => {
    const events = createEvents();
    const seen: string[] = [];
    (events as any).on("order.eu.*", () => seen.push("prefix"));
    (events as any).on("*.eu.paid", () => seen.push("suffix"));
    (events as any).on("order.*", () => seen.push("single"));
    await (events as any).emit("order.eu.paid", {});
    expect(seen.sort()).toEqual(["prefix", "single", "suffix"]);
    // Non-matching events still do not fire.
    seen.length = 0;
    await (events as any).emit("order.us.paid", {});
    expect(seen).toEqual(["single"]);
  });

  it("#11 MemoryJobStore.purgeQueue keeps a newer live job's dedup key", async () => {
    const store = new MemoryJobStore();
    const base = {
      queue: "q",
      name: "task",
      data: {},
      runAt: Date.now(),
      maxAttempts: 3,
      priority: 0,
      retry: { type: "fixed" as const, delay: 100, jitter: false, factor: 2, maxDelay: 60000 },
      progress: 0,
    };
    const j1 = await store.enqueue({ ...base, id: "j1", uniqueKey: "uk1" });
    await store.complete(j1.id);
    const j2 = await store.enqueue({ ...base, id: "j2", uniqueKey: "uk1" });
    expect(j2.id).toBe("j2");
    await store.purgeQueue("q", "completed");
    const j3 = await store.enqueue({ ...base, id: "j3", uniqueKey: "uk1" });
    // The live j2 still owns uk1: the third enqueue must dedup to j2,
    // not create a second live job with the same key.
    expect(j3.id).toBe("j2");
  });

  it("MemoryJobStore.claimNext breaks priority+runAt ties by id", async () => {
    const store = new MemoryJobStore();
    const now = Date.now();
    const base = {
      queue: "q",
      name: "task",
      data: {},
      runAt: now,
      maxAttempts: 3,
      priority: 5,
      retry: { type: "fixed" as const, delay: 100, jitter: false, factor: 2, maxDelay: 60000 },
      progress: 0,
    };
    await store.enqueue({ ...base, id: "b-job" });
    await store.enqueue({ ...base, id: "a-job" });
    const claimed = await store.claimNext("q", "w1", 10_000);
    expect(claimed?.id).toBe("a-job");
  });

  it("#4 concurrent unique-key enqueues dedup instead of throwing", async () => {
    const dir = tmpDir("yatta-hunter-jobs-");
    const dbPath = path.join(dir, "jobs.db");
    const s1 = new SQLiteJobStore(dbPath);
    const s2 = new SQLiteJobStore(dbPath);
    await s1.init();
    await s2.init();
    const base = {
      queue: "q",
      name: "task",
      data: {},
      runAt: Date.now(),
      maxAttempts: 3,
      priority: 0,
      retry: { type: "fixed" as const, delay: 100, jitter: false, factor: 2, maxDelay: 60000 },
      progress: 0,
    };
    const [r1, r2] = await Promise.all([
      s1.enqueue({ ...base, id: "w1", uniqueKey: "uk-race" }),
      s2.enqueue({ ...base, id: "w2", uniqueKey: "uk-race" }),
    ]);
    expect(r1.id).toBe(r2.id);
    // A third enqueue with the same key dedups to the same live row.
    const r3 = await s1.enqueue({ ...base, id: "w3", uniqueKey: "uk-race" });
    expect(r3.id).toBe(r1.id);
    expect((await s1.getJob(r1.id))?.state).toBe("queued");
    await s1.close();
    await s2.close();
  });

  it("#18 re-scheduling a cron name stops the old timer", async () => {
    const cron = createCron();
    let oldCount = 0;
    let newCount = 0;
    cron.every("30ms", () => {
      oldCount++;
    }, "dup");
    await sleep(100);
    expect(oldCount).toBeGreaterThan(0);
    cron.every("30ms", () => {
      newCount++;
    }, "dup");
    const oldAtReschedule = oldCount;
    await sleep(150);
    // The old handler must not have fired again after re-scheduling.
    expect(oldCount).toBe(oldAtReschedule);
    expect(newCount).toBeGreaterThan(0);
    cron.stop("dup");
  });

  it("cron day-of-week 7 stays out of bounds (pinned contract)", () => {
    // The hunter report notes standard cron accepts 7 for Sunday, but
    // the suite pins 0-6 (job.test.ts "should reject out-of-bounds
    // numbers in cron fields") — changing it needs Dominic's call.
    expect(() => new CronExpression("0 9 * * 7")).toThrow(/bounds/);
    expect(new CronExpression("0 9 * * 0").getNextDate(new Date(2026, 10, 21, 10, 0, 0)).getDay()).toBe(0);
  });

  it("#1 (guard) weekly cron does not skip a week", () => {
    // Sunday 2026-11-22 10:00 local -> Monday 2026-11-23 09:00.
    const from = new Date(2026, 10, 22, 10, 0, 0);
    const next = new CronExpression("0 9 * * 1").getNextDate(from);
    expect(next.getDate()).toBe(23);
    expect(next.getMonth()).toBe(10);
  });

  it("#2 pool.stop() releases the slot of a handler that ignores its signal", async () => {
    const store = new SQLiteJobStore(":memory:");
    await store.init();
    const jobs = createJobs({ store });
    jobs.handle("slow-task", async () => {
      // Ignores ctx.signal on purpose: the old runWithTimeout never
      // raced the signal, so stop() waited out the whole handler.
      await sleep(3000);
      return "done";
    });
    jobs.worker("slow-queue", { pollInterval: 10, concurrency: 1 });
    const enqueued = await jobs.enqueue("slow-task", {}, { queue: "slow-queue" });
    await sleep(300); // let the pool claim the job
    expect((await store.getJob(enqueued.id))?.state).toBe("running");
    const start = Date.now();
    await jobs.stopAll();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // The job was released back to queued, not completed.
    expect((await store.getJob(enqueued.id))?.state).toBe("queued");
    await store.close();
  });
});

describe("hunter runtime fixes — database", () => {
  const ftsSchema = {
    products: {
      id: col.id(),
      title: col.text().searchable(),
      description: col.text().searchable(),
      price: col.integer(),
    },
  };
  type FtsDb = TypedDatabase<typeof ftsSchema>;

  function ftsDb(): FtsDb {
    const db = createDatabase({ path: ":memory:", schema: ftsSchema, forceNew: true });
    dbs.push(db);
    return db;
  }

  it("#7 findMany rejects unknown select columns", () => {
    const db = memUserDb();
    db.users.insert({ email: "a@example.com", name: "A" });
    expect(() => (db.users as any).findMany({ select: ["emial"] })).toThrow(/Unknown column/);
    expect(() => (db.users as any).findMany({ select: ["name"] })).not.toThrow();
    const rows = (db.users as any).findMany({ select: ["name"] });
    expect(rows[0].name).toBe("A");
    expect(rows[0].email).toBeUndefined();
  });

  it("#6 a failed row delete leaves the FTS index intact", () => {
    const db = ftsDb();
    const row = db.products.insert({
      title: "Fast laptop",
      description: "A speedy laptop for coding",
      price: 999,
    });
    expect(db.products.search("laptop").map((h: any) => h.row.id)).toContain(row.id);
    // A trigger that aborts every delete: the row delete fails, so with
    // the row+FTS writes in one transaction the FTS entries survive.
    // (Assert on the FTS table itself: search() self-heals a missing
    // entry by re-indexing live rows, so it cannot see this bug.)
    (db as any).rawRun(
      `CREATE TRIGGER block_delete BEFORE DELETE ON "products" BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;`,
    );
    expect(() => db.products.delete({ where: { id: row.id } })).toThrow(/delete blocked/);
    expect(db.products.findById(row.id)?.id).toBe(row.id);
    const ftsRows = (db as any).rawAll(
      `SELECT "__yatta_pk" AS pk FROM "_fts_products"`,
    ) as { pk: string }[];
    expect(ftsRows.map((r) => r.pk)).toContain(String(row.id));
  });

  it("#6 a successful delete removes the row from search and from the FTS table", () => {
    const db = ftsDb();
    const row = db.products.insert({
      title: "Fast laptop",
      description: "A speedy laptop for coding",
      price: 999,
    });
    db.products.delete({ where: { id: row.id } });
    expect(db.products.search("laptop")).toHaveLength(0);
    expect(db.products.findById(row.id)).toBeNull();
    const ftsRows = (db as any).rawAll(
      `SELECT "__yatta_pk" AS pk FROM "_fts_products"`,
    ) as { pk: string }[];
    expect(ftsRows.map((r) => r.pk)).not.toContain(String(row.id));
  });

  it("restore() rejects an empty SQLite file, but accepts a plain SQLite file with tables", () => {
    const { db, dbPath } = fileUserDb();
    db.users.insert({ email: "keep@example.com", name: "Keep" });
    // An empty-but-valid SQLite file must never restore (it would wipe
    // the live database to nothing).
    const emptyPath = path.join(path.dirname(dbPath), "empty.db");
    const empty = new Database(emptyPath);
    empty.close();
    expect(() => db.restore(emptyPath)).toThrow(/holds no schema/);
    // The live database is untouched by the rejected restore.
    expect(db.users.findMany().map((u) => u.email)).toContain("keep@example.com");
    // But a database created by schema sync that never ran migrate() has
    // no `_yatta_migrations` table and is still a real Yatta database —
    // its backup must restore.
    const foreignPath = path.join(path.dirname(dbPath), "foreign.db");
    const foreign = new Database(foreignPath);
    foreign.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    foreign.run("INSERT INTO t (v) VALUES ('x');");
    foreign.close();
    expect(() => db.restore(foreignPath)).not.toThrow();
    expect(db.rawAll<{ v: string }>("SELECT v FROM t")).toEqual([{ v: "x" }]);
  });

  it("restore() round-trips a Yatta backup", () => {
    const { db, dbPath } = fileUserDb();
    db.users.insert({ email: "a@example.com", name: "A" });
    const backupPath = path.join(path.dirname(dbPath), "backup.db");
    db.backup(backupPath);
    db.users.insert({ email: "b@example.com", name: "B" });
    db.restore(backupPath);
    expect(db.users.findMany().map((u) => u.email)).toEqual(["a@example.com"]);
  });

  it("cursorPaginate rejects a 1-element cursor when cursor and tie-breaker differ", () => {
    const db = memUserDb();
    for (const name of ["Alice", "Bob", "Carol"]) {
      db.users.insert({ email: `${name.toLowerCase()}@example.com`, name });
    }
    const one = Buffer.from(JSON.stringify(["Bob"])).toString("base64url");
    expect(() =>
      (db.users as any).cursorPaginate({ limit: 2, cursorColumn: "name", cursor: one }),
    ).toThrow(/Invalid cursor/);
    const page1 = (db.users as any).cursorPaginate({ limit: 2, cursorColumn: "name" });
    expect(page1.data.map((r: any) => r.name)).toEqual(["Carol", "Bob"]);
    expect(typeof page1.nextCursor).toBe("string");
    const page2 = (db.users as any).cursorPaginate({
      limit: 2,
      cursorColumn: "name",
      cursor: page1.nextCursor,
    });
    expect(page2.data.map((r: any) => r.name)).toEqual(["Alice"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("rebuildTableWithColumn adds a column to a WITHOUT ROWID table", () => {
    const dir = tmpDir("yatta-hunter-rebuild-");
    const dbPath = path.join(dir, "notes.db");
    // Pre-existing table created outside Yatta, with a trailing clause.
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "body" TEXT) WITHOUT ROWID;`);
    raw.run(`INSERT INTO "notes" ("id", "body") VALUES ('n1', 'hello');`);
    raw.close();
    // Opening with a schema that adds a createdAt (expression default)
    // forces rebuildTableWithColumn on the populated table.
    const schema = {
      notes: {
        id: col.text(),
        body: col.text(),
        createdAt: col.createdAt(),
      },
    };
    const db = createDatabase({ path: dbPath, schema, forceNew: false });
    dbs.push(db);
    const cols = (db as any).rawAll(`PRAGMA table_info("notes")`) as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("createdAt");
    const rows = (db as any).rawAll(`SELECT "id", "body" FROM "notes"`);
    expect(rows).toEqual([{ id: "n1", body: "hello" }]);
  });
});

describe("hunter runtime fixes — cache", () => {
  function memL2(): SQLiteL2CacheStore {
    const store = new SQLiteL2CacheStore(":memory:", undefined, 0);
    dbs.push({ close: () => void store.close() });
    return store;
  }

  it("#9 evicting from L1 stays evicted while the L2 copy lives", async () => {
    const l2 = memL2();
    const cache = new MemoryCacheEngine({ maxItems: 2, l2Storage: l2 });
    await cache.set("a", 1, { consistency: "sync" });
    await cache.set("b", 2, { consistency: "sync" });
    await cache.set("c", 3, { consistency: "sync" }); // evicts "a" from L1
    expect(await cache.get("a")).toBeNull();
    // Other keys are unaffected.
    expect((await cache.get("b")) as unknown).toBe(2);
    expect((await cache.get("c")) as unknown).toBe(3);
  });

  it("#10 re-setting a key with no tags clears its old L2 tag rows", async () => {
    const l2 = memL2();
    const cache = new MemoryCacheEngine({ l2Storage: l2 });
    await cache.set("k1", "v1", { tags: ["users"], consistency: "sync" });
    await cache.set("k1", "v2", { tags: [], consistency: "sync" });
    const cleared = await cache.invalidateTags(["users"]);
    expect(cleared).toBe(0);
    expect((await cache.get("k1")) as unknown).toBe("v2");
    // The stale L2 tag row must not have deleted the live L2 copy: a
    // fresh engine sharing the same L2 still finds it. (On the old code
    // the L2 copy was deleted by the stale tag row, so this is null.)
    const second = new MemoryCacheEngine({ l2Storage: l2 });
    expect((await second.get("k1")) as unknown).toBe("v2");
  });

  it("remember() backfills from L2 instead of re-running the factory", async () => {
    const l2 = memL2();
    const first = new MemoryCacheEngine({ maxItems: 2, l2Storage: l2 });
    await first.set("k", "from-l2", { consistency: "sync" });
    await first.set("x1", 1, { consistency: "sync" });
    await first.set("x2", 2, { consistency: "sync" }); // evicts "k" from first's L1; L2 still has it
    let factoryRuns = 0;
    const second = new MemoryCacheEngine({ maxItems: 2, l2Storage: l2 });
    const value = await second.remember("k", "1h", async () => {
      factoryRuns++;
      return "factory";
    });
    expect(value).toBe("from-l2");
    expect(factoryRuns).toBe(0);
  });

  it("DoublyLinkedList.unlink ignores foreign and double-removed nodes", () => {
    const list = new DoublyLinkedList<string>();
    list.append("a");
    list.append("b");
    const sizeBefore = list.size;
    const foreign = { value: "zzz", prev: null, next: null } as any;
    list.unlink(foreign);
    expect(list.size).toBe(sizeBefore);
    const node = list.append("c");
    list.unlink(node);
    list.unlink(node);
    expect(list.size).toBe(2);
  });
});

describe("hunter runtime fixes — storage", () => {
  it("parseSize() throws on invalid strings but keeps the 100MB default", () => {
    expect(() => parseSize("10XB" as never)).toThrow(/Invalid size/);
    expect(() => parseSize("banana" as never)).toThrow(/Invalid size/);
    expect(parseSize(undefined)).toBe(100 * 1024 * 1024);
    expect(parseSize("0.5MB")).toBe(524288);
    expect(parseSize("1KB")).toBe(1024);
  });

  it("verifyMagicBytes accepts empty and spanned ZIP files", () => {
    const zip = (sig: number[]) => new Uint8Array(sig);
    expect(verifyMagicBytes(zip([0x50, 0x4b, 0x03, 0x04]), "application/zip")).toBe(true);
    expect(verifyMagicBytes(zip([0x50, 0x4b, 0x05, 0x06]), "application/zip")).toBe(true);
    expect(verifyMagicBytes(zip([0x50, 0x4b, 0x07, 0x08]), "application/zip")).toBe(true);
    // A ZIP header on a declared PNG is still a mismatch.
    expect(verifyMagicBytes(zip([0x50, 0x4b, 0x03, 0x04]), "image/png")).toBe(false);
    expect(
      verifyMagicBytes(zip([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"),
    ).toBe(true);
  });

  it("#12 same-key conditional uploads serialize: exactly one wins", async () => {
    const dir = tmpDir("yatta-hunter-toctou-");
    const disk = new StorageDisk(
      new LocalStorageDriver({
        driver: "local",
        baseDir: dir,
        secret: "test-storage-secret-that-is-not-real",
      }),
    );
    const results = await Promise.allSettled([
      disk.upload("doc.txt", "first", { ifNoneMatch: "*" }),
      disk.upload("doc.txt", "second", { ifNoneMatch: "*" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it("local driver list() pages with an opaque cursor", async () => {
    const dir = tmpDir("yatta-hunter-list-");
    const disk = new StorageDisk(
      new LocalStorageDriver({
        driver: "local",
        baseDir: dir,
        secret: "test-storage-secret-that-is-not-real",
      }),
    );
    for (let i = 0; i < 5; i++) {
      await disk.upload(`f${i}.txt`, `file ${i}`, { contentType: "text/plain" });
    }
    const driver = (disk as any).driver as LocalStorageDriver;
    const p1 = await driver.list({ limit: 2 });
    expect(p1.map((f: any) => f.path)).toEqual(["f0.txt", "f1.txt"]);
    const p2 = await driver.list({ limit: 2, cursor: "2" });
    expect(p2.map((f: any) => f.path)).toEqual(["f2.txt", "f3.txt"]);
    const p3 = await driver.list({ limit: 2, cursor: "4" });
    expect(p3.map((f: any) => f.path)).toEqual(["f4.txt"]);
    const p4 = await driver.list({ limit: 2, cursor: "5" });
    expect(p4).toHaveLength(0);
  });
});

describe("hunter runtime fixes — tiering", () => {
  function localDisk(dir: string, security?: any): StorageDisk {
    return new StorageDisk(
      new LocalStorageDriver({
        driver: "local",
        baseDir: dir,
        secret: "test-storage-secret-that-is-not-real",
      }),
      security,
    );
  }

  it("#16 tier moves ignore the cold disk's user-upload caps", async () => {
    const base = tmpDir("yatta-hunter-tiering-");
    const hot = localDisk(path.join(base, "hot"));
    // Cold disk rejects >1KB uploads and non-PNG files for users.
    const cold = localDisk(path.join(base, "cold"), {
      maxUploadSize: "1KB",
      allowedTypes: ["image/png"],
      verifyMime: true,
    });
    await hot.upload("notes.txt", "x".repeat(2048), { contentType: "text/plain" });
    const tiered = new TieredStorage(hot, cold, { staleAfterMs: 0 });
    const moved = await tiered.runOnce();
    expect(moved.moved).toEqual(["notes.txt"]);
    await expect(cold.head("notes.txt")).resolves.toMatchObject({ size: 2048 });
    await expect(hot.head("notes.txt")).rejects.toThrow();
  });

  it("runOnce pages through more keys than one 10,000-item list window", async () => {
    // The mover always lists with limit 10,000, so only a hot set larger
    // than one window exercises the paging loop (10,000 + 5 files).
    const hot = new StorageDisk(new FakeDiskLike(() => 1000, "https://fake-hot.local"));
    const cold = new StorageDisk(new FakeDiskLike(() => 1000, "https://fake-cold.local"));
    const total = 10_005;
    for (let i = 0; i < total; i++) {
      await hot.upload(`f${String(i).padStart(5, "0")}.txt`, "x", {
        contentType: "text/plain",
      });
    }
    const tiered = new TieredStorage(hot, cold, { staleAfterMs: 0 });
    const moved = await tiered.runOnce();
    expect(moved.moved).toHaveLength(total);
    expect(moved.failed).toEqual([]);
    await expect(cold.head("f00000.txt")).resolves.toMatchObject({ size: 1 });
    await expect(cold.head("f10004.txt")).resolves.toMatchObject({ size: 1 });
    expect(await hot.list({ limit: 1 })).toHaveLength(0);
  });

  it("InMemoryAccessTracker caps its records", () => {
    const tracker = new InMemoryAccessTracker(3);
    for (let i = 0; i < 5; i++) tracker.record(`k${i}`, 1000 + i, 60_000);
    expect(tracker.entries().size).toBe(3);
    // The two oldest records were evicted; the newest three survive.
    expect(tracker.get("k0")).toBeUndefined();
    expect(tracker.get("k1")).toBeUndefined();
    expect(tracker.get("k4")).toBeDefined();
  });
});

// Minimal in-memory driver for the tiering tests (same shape as the
// FakeDisk in storage-tiering.test.ts, without the test-only counters).
class FakeDiskLike implements IStorageDriver {
  private files = new Map<string, { bytes: Buffer; contentType: string; lastModified: Date }>();
  constructor(
    private readonly nowMs: () => number,
    private readonly baseUrl: string,
  ) {}

  private async readInput(data: UploadInput): Promise<Buffer> {
    if (typeof data === "string") return Buffer.from(data);
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
    if (data instanceof ReadableStream) {
      return Buffer.from(await new Response(data).arrayBuffer());
    }
    if (typeof data === "object" && data !== null) {
      return Buffer.from(JSON.stringify(data));
    }
    return Buffer.from(String(data));
  }

  async upload(key: string, data: UploadInput, options?: UploadOptions) {
    const clean = sanitizeKey(key);
    const bytes = await this.readInput(data);
    const contentType = options?.contentType ?? guessContentType(clean);
    this.files.set(clean, { bytes, contentType, lastModified: new Date(this.nowMs()) });
    return {
      path: clean,
      size: bytes.length,
      contentType,
      lastModified: new Date(this.nowMs()),
      etag: `"${bytes.length}"`,
      url: this.publicUrl(clean),
      metadata: options?.metadata,
    };
  }

  async download(key: string) {
    const clean = sanitizeKey(key);
    const entry = this.files.get(clean);
    if (!entry) throw new FileNotFoundError(clean);
    const bytes = entry.bytes;
    return new StorageFile(
      clean,
      bytes.length,
      entry.contentType,
      entry.lastModified,
      () => new Blob([new Uint8Array(bytes)]).stream(),
      (start: number, end: number) =>
        new Blob([new Uint8Array(bytes.subarray(start, end))]).stream(),
      `"${bytes.length}"`,
    );
  }

  async head(key: string) {
    const clean = sanitizeKey(key);
    const entry = this.files.get(clean);
    if (!entry) throw new FileNotFoundError(clean);
    return {
      path: clean,
      size: entry.bytes.length,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
      etag: `"${entry.bytes.length}"`,
      url: this.publicUrl(clean),
    };
  }

  async delete(key: string) {
    this.files.delete(sanitizeKey(key));
  }

  async deleteMany(keys: string[]) {
    for (const key of keys) await this.delete(key);
  }

  async copy(sourceKey: string, destKey: string) {
    const src = sanitizeKey(sourceKey);
    const dst = sanitizeKey(destKey);
    if (src === dst) return this.head(src);
    const entry = this.files.get(src);
    if (!entry) throw new FileNotFoundError(src);
    return this.upload(dst, entry.bytes, { contentType: entry.contentType });
  }

  async move(sourceKey: string, destKey: string) {
    const meta = await this.copy(sourceKey, destKey);
    await this.delete(sourceKey);
    return meta;
  }

  async exists(key: string) {
    return this.files.has(sanitizeKey(key));
  }

  async list(options?: ListOptions) {
    const out: any[] = [];
    for (const [key, entry] of this.files) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue;
      out.push({
        path: key,
        size: entry.bytes.length,
        contentType: entry.contentType,
        lastModified: entry.lastModified,
        etag: `"${entry.bytes.length}"`,
        url: this.publicUrl(key),
      });
    }
    // Stable order + cursor-as-offset, the documented ListOptions contract.
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const offset = options?.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    return out.slice(offset, offset + (options?.limit ?? 1000));
  }

  async signedUrl(key: string) {
    return `${this.publicUrl(key)}?sig=test-only`;
  }

  publicUrl(key: string) {
    return `${this.baseUrl}/${sanitizeKey(key)}`;
  }
}

describe("hunter runtime fixes — timeseries", () => {
  const tsSchema = {
    readings: {
      id: col.id(),
      at: col.integer().timeSeries(),
      region: col.text(),
      value: col.real(),
    },
  };
  type TsDb = TypedDatabase<typeof tsSchema>;
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const BASE = Date.UTC(2026, 0, 1);

  function tsDb(): TsDb {
    const db = createDatabase({ path: ":memory:", schema: tsSchema, forceNew: true });
    dbs.push(db);
    return db;
  }

  function seed(db: TsDb) {
    const t = db.table("readings");
    t.insert({ at: BASE + 30 * MIN, region: "north", value: 30 });
    t.insert({ at: BASE + 0, region: "north", value: 10 });
    t.insert({ at: BASE + 10 * MIN, region: "north", value: 20 });
    t.insert({ at: BASE + 70 * MIN, region: "north", value: 5 });
    t.insert({ at: BASE + 80 * MIN, region: "south", value: 15 });
  }

  it("#15 deleteRaw on a non-coarsest tier is rejected at normalize time", () => {
    const db = tsDb();
    const bad: RollupPolicyConfig = {
      source: "readings",
      measures: ["value"],
      groupBy: ["region"],
      tiers: [
        { name: "hourly", window: "hour", olderThan: "1d", deleteRaw: true },
        { name: "daily", window: "day", olderThan: "7d" },
      ],
    };
    expect(() => normalizeRollupPolicy(db as any, bad)).toThrow(/deleteRaw/);
    expect(() => runRollupPolicy(db as any, bad, { now: BASE + 10 * DAY })).toThrow(
      /deleteRaw/,
    );
  });

  it("#15 deleteRaw on the coarsest tier still lets finer tiers roll up", () => {
    const db = tsDb();
    seed(db);
    const policy: RollupPolicyConfig = {
      source: "readings",
      measures: ["value"],
      groupBy: ["region"],
      tiers: [
        // Listed coarsest-first: the fix runs finest-first internally.
        { name: "daily", window: "day", olderThan: "7d", deleteRaw: true },
        { name: "hourly", window: "hour", olderThan: "1d" },
      ],
    };
    const result = runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    // Results come back in config order.
    expect(result.tiers.map((t) => t.tier)).toEqual(["daily", "hourly"]);
    // The hourly tier wrote its summaries before the daily tier deleted raw.
    expect(readRollup(db as any, policy, "hourly")).toHaveLength(3);
    expect(readRollup(db as any, policy, "daily")).toHaveLength(2);
    // All five raw rows were deleted by the coarsest tier.
    expect(db.table("readings").findMany({})).toHaveLength(0);
  });
});

describe("hunter runtime fixes — raft", () => {
  function makeNode(
    id: string,
    peers: string[],
    opts: { now?: () => number } = {},
  ): RaftNode {
    const state = new PersistentRaftState(memUserDb() as unknown as OutboxStore);
    return new RaftNode({
      nodeId: id,
      peers,
      secret: RAFT_SECRET,
      log: new InMemoryRaftLog(),
      persistentState: state,
      timers: false,
      now: opts.now ?? (() => 1000),
    });
  }

  function cluster(ids: string[]) {
    let now = 1000;
    const nodes = new Map<string, RaftNode>();
    for (const id of ids) {
      const state = new PersistentRaftState(memUserDb() as unknown as OutboxStore);
      nodes.set(
        id,
        new RaftNode({
          nodeId: id,
          peers: ids.filter((p) => p !== id),
          secret: RAFT_SECRET,
          log: new InMemoryRaftLog(),
          persistentState: state,
          timers: false,
          now: () => now,
        }),
      );
    }
    for (const id of ids) {
      const t = new InMemoryRaftTransport(id, RAFT_SECRET);
      for (const node of nodes.values()) t.addNode(node);
      nodes.get(id)!.setTransport(t);
    }
    return {
      nodes,
      node: (id: string) => nodes.get(id)!,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("a rejected AppendEntries does not record its leader", () => {
    const follower = makeNode("b", ["a"]);
    const res = follower.handleAppendEntries({
      term: 1,
      leaderId: "a",
      prevLogSeq: 5,
      prevLogTerm: 1,
      entries: [],
      leaderCommit: 0,
    });
    expect(res.success).toBe(false);
    expect(follower.currentLeaderId).toBeNull();
    // A consistent AppendEntries from the same leader is accepted and records it.
    const ok = follower.handleAppendEntries({
      term: 1,
      leaderId: "a",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    });
    expect(ok.success).toBe(true);
    expect(follower.currentLeaderId).toBe("a");
  });

  it("HTTP request-vote binds the candidate to the verified token identity", async () => {
    const node = makeNode("b", ["a"]);
    const handler = createRaftHttpHandler(node, RAFT_SECRET);
    const tokenForA = createNodeToken(RAFT_SECRET, "a");
    const vote = await handler(
      new Request("http://x/_yatta/raft/request-vote", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenForA}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          term: 1,
          candidateId: "evil",
          lastLogSeq: 0,
          lastLogTerm: 0,
        }),
      }),
    );
    expect(vote.status).toBe(200);
    expect(((await vote.json()) as { voteGranted: boolean }).voteGranted).toBe(true);
    // The vote is recorded for "a" (the token holder), not "evil".
    expect(node.votedForId).toBe("a");
  });

  it("#20 a leader with no heartbeat acks steps down after the election window", async () => {
    const c = cluster(["a", "b", "c"]);
    await c.node("a").startElection();
    expect(c.node("a").currentRole).toBe("leader");
    // No heartbeats are sent, so every peer ack goes stale.
    c.advance(60_000);
    expect(c.node("a").checkLeaderQuorum()).toBe(false);
    expect(c.node("a").currentRole).toBe("follower");
  });
});

describe("hunter runtime fixes — replication", () => {
  const REPLICA_ID = "replica-1";

  function seed(db: UserDb, count: number) {
    for (let i = 0; i < count; i++) {
      db.transaction((tx) => {
        const created = tx.users.insert({
          email: `repl${Date.now()}${i}@example.com`,
          name: `user ${i}`,
        });
        tx.recordOutbox({
          eventType: "user.registered",
          aggregateType: "user",
          aggregateId: created.id,
          payload: { userId: created.id, email: created.email },
        });
      });
    }
  }

  it("a skipped redelivery still advances the checkpoint", async () => {
    const primary = memUserDb();
    const replica = memUserDb();
    seed(primary, 2);
    const pub = new ReplicationPublisher(
      { app: primary as unknown as OutboxStore },
      { nodeId: "primary-1", secret: REPL_SECRET, allowedReplicaIds: [REPLICA_ID] },
    );
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, {
      secret: REPL_SECRET,
    });
    const batch = pub.pullFor(createNodeToken(REPL_SECRET, REPLICA_ID), "app", 0);
    expect(await applier.applyBatch(batch)).toEqual({ applied: 2, skipped: 0, checkpoint: 2 });
    // The first entry is redelivered with a HIGHER seq than the checkpoint.
    const redelivered = { ...batch.entries[0]!, seq: 5 };
    const batch2: ReplicationBatch = {
      source: "app",
      file: "app",
      nodeId: "primary-1",
      entries: [redelivered],
      latestSeq: 5,
      signature: "",
    };
    batch2.signature = signBatch(REPL_SECRET, batch2);
    const result = await applier.applyBatch(batch2);
    expect(result).toEqual({ applied: 0, skipped: 1, checkpoint: 5 });
    expect(applier.checkpoint("app", "app")).toBe(5);
    // A later pull from the old checkpoint no longer re-serves it.
    const again = await applier.applyBatch(batch2);
    expect(again).toEqual({ applied: 0, skipped: 1, checkpoint: 5 });
  });
});

describe("hunter runtime fixes — outbox", () => {
  it("a publish that outlives its timeout is not republished while it runs", async () => {
    const db = memUserDb();
    const entry = recordOutbox(db as any, { eventType: "a", payload: {} });
    let publishCalls = 0;
    const relay = new OutboxRelay(
      db as any,
      async () => {
        publishCalls++;
        await sleep(150);
      },
      { publishTimeoutMs: 20 },
    );
    // The timeout is recorded as a failure (attempts + backoff, so a
    // hung publish is retried and eventually dead-lettered) — but the
    // publish is still running, so the row stays pending, not dead.
    const first = await relay.runOnce();
    expect(first).toEqual({ published: 0, failed: 1, dead: 0 });
    expect(publishCalls).toBe(1);
    expect(getOutboxByEventId(db as any, entry.eventId)?.status).toBe("pending");
    expect(getOutboxByEventId(db as any, entry.eventId)?.lastError).toContain("timed out");
    // Once the publish settles, the late success marks the row
    // published, undoing the timeout failure — no second publish.
    await sleep(200);
    expect(getOutboxByEventId(db as any, entry.eventId)?.status).toBe("published");
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, dead: 0 });
    expect(publishCalls).toBe(1);
  });
});

describe("hunter runtime fixes — profiler", () => {
  it("a nested profile() throws without killing the outer capture", async () => {
    const profiler = new SamplingProfiler();
    const { result, profile } = await profiler.profile(async () => {
      await expect(profiler.profile(async () => 1)).rejects.toThrow(/already running/);
      return 42;
    });
    expect(result).toBe(42);
    expect(profile).toBeDefined();
  });
});

describe("hunter runtime fixes — data structures", () => {
  const schema = { id: "u32", score: "f64", name: "string" } as const;

  it("ColumnStore rejects out-of-range and non-finite typed values", () => {
    const rows = createColumnStore(schema);
    expect(() => rows.append({ id: -1, score: 1, name: "a" })).toThrow(RangeError);
    expect(() => rows.append({ id: 1, score: Number.NaN, name: "a" })).toThrow(
      /needs a finite number/,
    );
    expect(() => rows.append({ id: 1.5, score: 1, name: "a" })).toThrow(RangeError);
    rows.append({ id: 1, score: 1.5, name: "a" });
    expect(() => rows.set(0, { id: 4294967296 })).toThrow(RangeError);
    expect(rows.get(0)).toEqual({ id: 1, score: 1.5, name: "a" });
  });

  it("ColumnStore.field() returns a copy for string columns", () => {
    const rows = createColumnStore(schema);
    rows.append({ id: 1, score: 1, name: "a" });
    const names = rows.field("name") as string[];
    names[0] = "mutated";
    expect(rows.get(0).name).toBe("a");
  });

  it("Batch rejects a concurrent run() but allows a sequential re-run", async () => {
    const batch = new Batch();
    let runs = 0;
    batch.op(async () => {
      runs++;
      await sleep(50);
      return "ok";
    });
    const first = batch.run();
    await expect(batch.run()).rejects.toThrow(/already running/);
    await expect(first).resolves.toEqual([{ ok: true, value: "ok" }]);
    expect(runs).toBe(1);
    // Sequential re-run is still allowed.
    await expect(batch.run()).resolves.toEqual([{ ok: true, value: "ok" }]);
    expect(runs).toBe(2);
  });
});
