import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, col, type TypedDatabase } from "../types/db";
import {
  recordOutbox,
  readChangeLog,
  listPending,
  getOutboxByEventId,
  republishDead,
  purgePublished,
  outboxCounts,
  OutboxRelay,
  toJobPublish,
  toEventPublish,
  type OutboxEntry,
} from "../types/outbox";

const schema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    name: col.text(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
};

type TestDb = TypedDatabase<typeof schema>;

const dbs: TestDb[] = [];
const tmpDirs: string[] = [];

function memDb(): TestDb {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true });
  dbs.push(db);
  return db;
}

function fileDb(): { db: TestDb; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-outbox-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  const db = createDatabase({ path: dbPath, schema, forceNew: true });
  dbs.push(db);
  return { db, dir };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("outbox — same-transaction atomicity", () => {
  it("commits the user write and the outbox entry together", () => {
    const db = memDb();
    const user = db.transaction((tx) => {
      const created = tx.users.insert({ email: "ada@example.com", name: "Ada" });
      const entry = tx.recordOutbox({
        eventType: "user.registered",
        aggregateType: "user",
        aggregateId: created.id,
        payload: { userId: created.id, email: created.email },
      });
      return { created, entry };
    });
    expect(db.users.findById(user.created.id)?.email).toBe("ada@example.com");
    expect(user.entry.eventType).toBe("user.registered");
    expect(user.entry.status).toBe("pending");
    expect(listPending(db)).toHaveLength(1);
    // The standalone helper works inside a transaction too.
    db.transaction((tx) => {
      recordOutbox(tx as any, { eventType: "user.updated", payload: { id: user.created.id } });
    });
    expect(listPending(db)).toHaveLength(2);
  });

  it("rolls back the outbox entry when the transaction throws", () => {
    const db = memDb();
    expect(() =>
      db.transaction((tx) => {
        tx.users.insert({ email: "ada@example.com", name: "Ada" });
        tx.recordOutbox({ eventType: "user.registered", payload: {} });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.users.count()).toBe(0);
    expect(listPending(db)).toHaveLength(0);
    expect(readChangeLog(db)).toHaveLength(0);
  });

  it("rejects a duplicate event_id and a duplicate dedupe_key at record time", () => {
    const db = memDb();
    recordOutbox(db as any, { eventType: "a", payload: {}, eventId: "evt-1" });
    expect(() => recordOutbox(db as any, { eventType: "a", payload: {}, eventId: "evt-1" })).toThrow();
    recordOutbox(db as any, { eventType: "b", payload: {}, dedupeKey: "welcome:1" });
    expect(() => recordOutbox(db as any, { eventType: "b", payload: {}, dedupeKey: "welcome:1" })).toThrow();
  });

  it("rejects an empty event type and a non-JSON payload at record time", () => {
    const db = memDb();
    expect(() => recordOutbox(db as any, { eventType: "  ", payload: {} })).toThrow();
    expect(() => recordOutbox(db as any, { eventType: "a", payload: undefined })).toThrow();
    const circular: any = {};
    circular.self = circular;
    expect(() => recordOutbox(db as any, { eventType: "a", payload: circular })).toThrow();
  });
});

describe("outbox — opt-in and lazy: zero cost when unconfigured", () => {
  it("plain writes create no outbox table and do no log work", () => {
    const db = memDb();
    // Creating the database alone creates nothing for the outbox.
    expect(
      db.rawAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_yatta_outbox';"),
    ).toHaveLength(0);
    db.transaction((tx) => {
      tx.users.insert({ email: "ada@example.com", name: "Ada" });
      tx.users.insert({ email: "grace@example.com", name: "Grace" });
    });
    db.users.insert({ email: "linus@example.com", name: "Linus" });
    expect(db.users.count()).toBe(3);
    // Still nothing: no table, no row, no extra statement on the write path.
    expect(
      db.rawAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_yatta_outbox';"),
    ).toHaveLength(0);
    // The first recordOutbox call is what creates the table — and only then.
    db.recordOutbox({ eventType: "user.registered", payload: {} });
    expect(
      db.rawAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_yatta_outbox';"),
    ).toHaveLength(1);
  });

  it("constructing a relay is what starts relay work; nothing runs before that", async () => {
    const db = memDb();
    db.users.insert({ email: "ada@example.com", name: "Ada" });
    // No relay exists yet, so nothing has been published or marked, and
    // the outbox table does not even exist until something opts in.
    expect(
      db.rawAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_yatta_outbox';"),
    ).toHaveLength(0);
    await sleep(30);
    expect(
      db.rawAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_yatta_outbox';"),
    ).toHaveLength(0);
  });
});

describe("outbox — relay publish and mark-done-after-ack", () => {
  it("publishes in seq order and marks rows published only after ack", async () => {
    const db = memDb();
    const first = recordOutbox(db as any, { eventType: "a", payload: { n: 1 } });
    const second = recordOutbox(db as any, { eventType: "b", payload: { n: 2 } });
    expect(second.seq).toBeGreaterThan(first.seq);

    const delivered: OutboxEntry[] = [];
    const relay = new OutboxRelay(db as any, async (entry) => {
      delivered.push(entry);
    });
    const result = await relay.runOnce();
    expect(result).toEqual({ published: 2, failed: 0, dead: 0 });
    expect(delivered.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    expect(getOutboxByEventId(db as any, first.eventId)?.status).toBe("published");
    expect(getOutboxByEventId(db as any, first.eventId)?.publishedAt).not.toBeNull();
    // A second scan publishes nothing: published rows are not redelivered.
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, dead: 0 });
    expect(delivered).toHaveLength(2);
  });

  it("leaves a row pending with backoff when publish rejects, then retries when due", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "a", payload: {} });
    let t = Date.now();
    let shouldFail = true;
    const delivered: string[] = [];
    const relay = new OutboxRelay(
      db as any,
      async (e) => {
        if (shouldFail) throw new Error("downstream down");
        delivered.push(e.eventId);
      },
      { retryBaseMs: 1000, retryMaxMs: 60000, now: () => t },
    );
    const failed = await relay.runOnce();
    expect(failed).toEqual({ published: 0, failed: 1, dead: 0 });
    const row = getOutboxByEventId(db as any, entry.eventId)!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBeGreaterThan(t);
    expect(row.lastError).toBe("downstream down");

    // Not due yet: no redelivery.
    t = row.nextAttemptAt - 1;
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, dead: 0 });
    // Due now: retry succeeds and marks published.
    t = row.nextAttemptAt;
    shouldFail = false;
    expect(await relay.runOnce()).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(delivered).toEqual([entry.eventId]);
  });

  it("dead-letters after maxAttempts and allows manual replay", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "a", payload: {} });
    let t = Date.now();
    const relay = new OutboxRelay(db as any, async () => {
      throw new Error("always down");
    }, { maxAttempts: 2, retryBaseMs: 1, now: () => t });
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1, dead: 0 });
    t += 10;
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1, dead: 1 });
    expect(getOutboxByEventId(db as any, entry.eventId)?.status).toBe("dead");
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, dead: 0 });
    expect(republishDead(db as any, entry.eventId)).toBe(true);
    const revived = getOutboxByEventId(db as any, entry.eventId)!;
    expect(revived.status).toBe("pending");
    expect(revived.attempts).toBe(0);
    expect(republishDead(db as any, entry.eventId)).toBe(false);
  });

  it("picks up unprocessed rows on start, including after a restart", async () => {
    // In-memory: a second relay instance on the same file picks rows up.
    const db = memDb();
    recordOutbox(db as any, { eventType: "a", payload: {} });
    const delivered: string[] = [];
    const relay = new OutboxRelay(db as any, async (e) => {
      delivered.push(e.eventId);
    }, { pollIntervalMs: 10 });
    relay.start();
    await sleep(80);
    relay.stop();
    expect(relay.running).toBe(false);
    expect(delivered).toHaveLength(1);

    // File-backed: close the database, reopen it, and a fresh relay delivers.
    const { db: file, dir } = fileDb();
    const entry = recordOutbox(file as any, { eventType: "restarted", payload: { x: 1 } });
    file.close();
    dbs.splice(dbs.indexOf(file), 1);
    const reopened = createDatabase({ path: path.join(dir, "app.db"), schema, forceNew: true });
    dbs.push(reopened);
    const redelivered: string[] = [];
    const relay2 = new OutboxRelay(reopened as any, async (e) => {
      redelivered.push(e.eventId);
    });
    expect(await relay2.runOnce()).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(redelivered).toEqual([entry.eventId]);
  });
});

describe("outbox — dedupe on redelivery", () => {
  it("job delivery uses uniqueKey outbox:<event_id> so an active job is not duplicated", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "user.registered", payload: { userId: "u1" } });
    // Fake job sink with the real store's rule: an active unique key returns
    // the existing job instead of creating a second one.
    const active = new Map<string, string>();
    const jobs: Array<{ name: string; data: unknown; uniqueKey?: string }> = [];
    const sink = {
      enqueue: async (name: string, data: unknown, options?: { uniqueKey?: string }) => {
        if (options?.uniqueKey && active.has(options.uniqueKey)) return { id: active.get(options.uniqueKey) };
        const id = `job-${jobs.length + 1}`;
        jobs.push({ name, data, uniqueKey: options?.uniqueKey });
        if (options?.uniqueKey) active.set(options.uniqueKey, id);
        return { id };
      },
    };
    const publish = toJobPublish(sink, "send-email");
    // First delivery.
    await publish(entry);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.uniqueKey).toBe(`outbox:${entry.eventId}`);
    // Simulated crash after publish but before the mark: the row is still
    // pending, so the relay publishes again. The sink dedupes it.
    const relay = new OutboxRelay(db as any, publish);
    expect(await relay.runOnce()).toEqual({ published: 1, failed: 0, dead: 0 });
    expect(jobs).toHaveLength(1);
  });

  it("a hanging publish counts as a failure, not a stalled scan", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "a", payload: {} });
    const relay = new OutboxRelay(db as any, async () => {
      await new Promise(() => {});
    }, { publishTimeoutMs: 10, retryBaseMs: 60000 });
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1, dead: 0 });
    expect(getOutboxByEventId(db as any, entry.eventId)?.status).toBe("pending");
    expect(getOutboxByEventId(db as any, entry.eventId)?.lastError).toContain("timed out");
  });

  it("a caller-supplied uniqueKey cannot replace the outbox dedupe key", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "a", payload: {} });
    const seen: Array<{ uniqueKey?: string }> = [];
    const sink = {
      enqueue: async (_name: string, _data: unknown, options?: { uniqueKey?: string }) => {
        seen.push(options ?? {});
        return { id: "job-1" };
      },
    };
    await toJobPublish(sink, "some-job", () => ({ options: { uniqueKey: "attacker-chosen" } }))(entry);
    expect(seen[0]!.uniqueKey).toBe(`outbox:${entry.eventId}`);
  });

  it("event delivery treats a listener failure as a publish failure, not a success", async () => {
    const db = memDb();
    const entry = recordOutbox(db as any, { eventType: "user.registered", payload: {} });
    const seenOptions: Array<{ throwOnError?: boolean } | undefined> = [];
    const failingBus = {
      emit: async (_event: string, _data: unknown, options?: { throwOnError?: boolean }) => {
        seenOptions.push(options);
        if (options?.throwOnError) throw new Error("listener blew up");
      },
    };
    const relay = new OutboxRelay(db as any, toEventPublish(failingBus), { retryBaseMs: 60000 });
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1, dead: 0 });
    expect(seenOptions[0]?.throwOnError).toBe(true);
    expect(getOutboxByEventId(db as any, entry.eventId)?.status).toBe("pending");
  });
});

describe("outbox — shared change log reads", () => {
  it("reads in seq order from a checkpoint, filtered by aggregate", () => {
    const db = memDb();
    const a1 = recordOutbox(db as any, { eventType: "user.created", aggregateType: "user", aggregateId: "u1", payload: {} });
    recordOutbox(db as any, { eventType: "user.created", aggregateType: "user", aggregateId: "u2", payload: {} });
    const a2 = recordOutbox(db as any, { eventType: "user.updated", aggregateType: "user", aggregateId: "u1", payload: {} });
    const all = readChangeLog(db as any);
    expect(all.map((e) => e.seq)).toEqual([a1.seq, a1.seq + 1, a2.seq]);
    expect(readChangeLog(db as any, { afterSeq: a1.seq }).map((e) => e.seq)).toEqual([a1.seq + 1, a2.seq]);
    expect(
      readChangeLog(db as any, { aggregateType: "user", aggregateId: "u1" }).map((e) => e.seq),
    ).toEqual([a1.seq, a2.seq]);
    expect(readChangeLog(db as any, { limit: 1 })).toHaveLength(1);
  });

  it("purges only published rows and counts by status", async () => {
    const db = memDb();
    const published = recordOutbox(db as any, { eventType: "a", payload: {} });
    const pending = recordOutbox(db as any, { eventType: "b", payload: {} });
    await new OutboxRelay(db as any, async (e) => {
      if (e.eventId === published.eventId) return;
      throw new Error("no");
    }, { retryBaseMs: 60000 }).runOnce();
    expect(outboxCounts(db as any)).toEqual({ pending: 1, published: 1, dead: 0 });
    expect(purgePublished(db as any)).toBe(1);
    expect(getOutboxByEventId(db as any, published.eventId)).toBeNull();
    expect(getOutboxByEventId(db as any, pending.eventId)?.status).toBe("pending");
  });
});
