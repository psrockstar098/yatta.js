/**
 * Consumer-style import of the `yatta.js/outbox` subpath.
 *
 * The docs promise this import, so a consumer — not just a relative
 * in-repo import — must be able to use it. This guards the package.json
 * `exports` entry: if the subpath is missing, this file fails to load.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  recordOutbox,
  readChangeLog,
  listPending,
  getOutboxByEventId,
  republishDead,
  purgePublished,
  outboxCounts,
  createOutboxRelay,
  toJobPublish,
  toEventPublish,
  OUTBOX_TABLE,
  type OutboxEntry,
} from "yatta.js/outbox";
import { createDatabase, col, type TypedDatabase } from "../types/db";

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

function memDb(): TestDb {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
});

describe("yatta.js/outbox subpath export", () => {
  it("resolves and exposes the documented helpers", () => {
    for (const fn of [
      recordOutbox,
      readChangeLog,
      listPending,
      getOutboxByEventId,
      republishDead,
      purgePublished,
      outboxCounts,
      createOutboxRelay,
      toJobPublish,
      toEventPublish,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(OUTBOX_TABLE).toBe("_yatta_outbox");
  });

  it("records and reads back through the subpath import", () => {
    const db = memDb();
    const entry: OutboxEntry = recordOutbox(db, {
      eventType: "user.registered",
      aggregateType: "user",
      aggregateId: "u-1",
      payload: { userId: "u-1" },
    });
    expect(entry.status).toBe("pending");
    expect(readChangeLog(db)).toHaveLength(1);
    expect(getOutboxByEventId(db, entry.eventId)?.eventType).toBe("user.registered");
    expect(listPending(db)).toHaveLength(1);
    expect(outboxCounts(db).pending).toBe(1);
  });

  it("exposes no denylisted surface", async () => {
    const ns = await import("yatta.js/outbox");
    // The MCP denylist: these collections are never exposed over any
    // public surface, including this subpath.
    for (const name of [
      "users",
      "sessions",
      "identities",
      "verificationTokens",
      "passkeys",
      "apiKeys",
    ]) {
      expect(name in ns).toBe(false);
    }
  });
});
