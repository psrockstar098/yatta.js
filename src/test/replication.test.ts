import { describe, it, expect, afterEach } from "bun:test";
import {
  createDatabase,
  col,
  type TypedDatabase,
} from "../types/db";
import { recordOutbox, type OutboxStore } from "../types/outbox";
import {
  ReplicationPublisher,
  ReplicationApplier,
  ReplicationRunner,
  ReplicationError,
  ReplicaWriteError,
  createNodeToken,
  verifyNodeToken,
  signBatch,
  verifyBatchSignature,
  validateReplicatedEntry,
  createHttpReplicationTransport,
  createReplicationHttpHandler,
  createReadOnlyStore,
  assertPrimaryWrite,
  replicationLag,
  replicationConfigFromEnv,
  type ReplicationBatch,
  type ReplicationTransport,
} from "../types/replication";

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
const SECRET = "test-secret-that-is-not-real";
const PRIMARY_ID = "primary-1";
const REPLICA_ID = "replica-1";

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

let seedCounter = 0;

function seed(db: TestDb, count: number, prefix = "user"): void {
  for (let i = 0; i < count; i += 1) {
    const n = seedCounter++;
    db.transaction((tx) => {
      const created = tx.users.insert({ email: `${prefix}${n}@example.com`, name: `${prefix} ${n}` });
      tx.recordOutbox({
        eventType: "user.registered",
        aggregateType: "user",
        aggregateId: created.id,
        payload: { userId: created.id, email: created.email },
      });
    });
  }
}

function publisherFor(db: TestDb, opts: Partial<{ allowedReplicaIds: string[] }> = {}): ReplicationPublisher {
  return new ReplicationPublisher({ app: db as unknown as OutboxStore }, {
    nodeId: PRIMARY_ID,
    secret: SECRET,
    allowedReplicaIds: opts.allowedReplicaIds,
  });
}

function tokenFor(replicaId = REPLICA_ID): string {
  return createNodeToken(SECRET, replicaId);
}

describe("replication — node tokens", () => {
  it("round-trips a token and rejects a forged one", () => {
    const token = tokenFor();
    expect(verifyNodeToken(SECRET, token)).toBe(REPLICA_ID);
    expect(verifyNodeToken(SECRET, `${REPLICA_ID}.` + "0".repeat(64))).toBeNull();
    expect(verifyNodeToken("wrong-secret", token)).toBeNull();
    expect(verifyNodeToken(SECRET, "not-a-token")).toBeNull();
    expect(verifyNodeToken(SECRET, "")).toBeNull();
  });

  it("refuses an empty secret and a dotted node id", () => {
    expect(() => createNodeToken("", "a")).toThrow(ReplicationError);
    expect(() => createNodeToken(SECRET, "a.b")).toThrow(ReplicationError);
  });
});

describe("replication — publisher", () => {
  it("pulls pending rows too: no status filter on the change log", () => {
    const db = memDb();
    seed(db, 2);
    const pub = publisherFor(db);
    const batch = pub.pull("app", 0, 100);
    expect(batch.entries.length).toBe(2);
    expect(batch.entries[0]!.seq).toBeLessThan(batch.entries[1]!.seq);
    expect(batch.latestSeq).toBe(batch.entries[1]!.seq);
    expect(verifyBatchSignature(SECRET, batch)).toBe(true);
    expect(batch.nodeId).toBe(PRIMARY_ID);
    // Rows are still pending: replication never marks them published.
    expect(batch.entries.every((e) => e.status === "pending")).toBe(true);
  });

  it("rejects unauthenticated pulls and non-allowlisted replicas with no data", () => {
    const db = memDb();
    seed(db, 1);
    const pub = publisherFor(db, { allowedReplicaIds: [REPLICA_ID] });
    expect(() => pub.pullFor("bogus-token", "app", 0)).toThrow(ReplicationError);
    expect(() => pub.pullFor(tokenFor("stranger-9"), "app", 0)).toThrow(ReplicationError);
    expect(() => pub.pullFor(tokenFor(), "nope", 0)).toThrow(ReplicationError);
    expect(() => pub.pullFor(tokenFor(), "app", -1)).toThrow(ReplicationError);
    expect(() => pub.pullFor(tokenFor(), "app", 0, 0)).toThrow(ReplicationError);
    expect(() => pub.pullFor(tokenFor(), "app", 0, 1001)).toThrow(ReplicationError);
    // The valid replica still pulls fine.
    expect(pub.pullFor(tokenFor(), "app", 0).entries.length).toBe(1);
  });

  it("resumes from a cursor and reports the latest seq for lag", () => {
    const db = memDb();
    seed(db, 3);
    const pub = publisherFor(db);
    const batch = pub.pull("app", 1, 100);
    expect(batch.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(replicationLag(batch.latestSeq, 1)).toBe(2);
    expect(replicationLag(batch.latestSeq, 3)).toBe(0);
    expect(replicationLag(2, 5)).toBe(0);
  });
});

describe("replication — applier", () => {
  it("applies a batch, advances the checkpoint, and serves replicated reads", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 2);
    const pub = publisherFor(primary);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    const batch = pub.pullFor(tokenFor(), "app", 0);
    const result = await applier.applyBatch(batch);
    expect(result).toEqual({ applied: 2, skipped: 0, checkpoint: 2 });
    expect(applier.checkpoint("app", "app")).toBe(2);
    const rows = applier.replicatedEntries("app", "app");
    expect(rows.length).toBe(2);
    expect(rows[0]!.eventType).toBe("user.registered");
    // The original relay status survives the trip, for inspection only.
    expect(rows[0]!.status).toBe("pending");
  });

  it("is idempotent: redelivery of the same batch applies nothing twice", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 2);
    const pub = publisherFor(primary);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    const batch = pub.pullFor(tokenFor(), "app", 0);
    await applier.applyBatch(batch);
    const again = await applier.applyBatch(batch);
    expect(again).toEqual({ applied: 0, skipped: 2, checkpoint: 2 });
    expect(applier.replicatedEntries("app", "app").length).toBe(2);
  });

  it("converges across a restart: pull from checkpoint skips applied rows only", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 1);
    const pub = publisherFor(primary);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    await applier.applyBatch(pub.pullFor(tokenFor(), "app", 0));
    seed(primary, 1);
    const next = pub.pullFor(tokenFor(), "app", applier.checkpoint("app", "app"));
    const result = await applier.applyBatch(next);
    expect(result.applied).toBe(1);
    expect(applier.checkpoint("app", "app")).toBe(next.entries[0]!.seq);
  });

  it("tolerates gaps: a missing seq is skipped, not waited on", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 3);
    // Delete the middle log row outright: the remaining seqs now have
    // a gap, and the applier must still converge instead of stalling.
    // (In production, never purge above a replica's checkpoint.)
    primary.rawRun(`DELETE FROM "_yatta_outbox" WHERE seq = 2;`);
    const pub = publisherFor(primary);
    const batch = pub.pullFor(tokenFor(), "app", 0);
    expect(batch.entries.length).toBe(2);
    expect(batch.entries[1]!.seq - batch.entries[0]!.seq).toBeGreaterThan(1);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    const result = await applier.applyBatch(batch);
    expect(result.applied).toBe(2);
  });

  it("rejects an out-of-order batch and applies nothing from it", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 2);
    const pub = publisherFor(primary);
    const good = pub.pullFor(tokenFor(), "app", 0);
    const reversed: ReplicationBatch = {
      ...good,
      entries: [...good.entries].reverse(),
      signature: "",
    };
    reversed.signature = signBatch(SECRET, reversed);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    await expect(applier.applyBatch(reversed)).rejects.toThrow(ReplicationError);
    expect(applier.checkpoint("app", "app")).toBe(0);
    expect(applier.replicatedEntries("app", "app").length).toBe(0);
  });

  it("rejects a mis-signed batch and a batch from the wrong primary", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 1);
    const pub = publisherFor(primary);
    const batch = pub.pullFor(tokenFor(), "app", 0);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, {
      secret: SECRET,
      expectedNodeId: PRIMARY_ID,
    });
    const tampered = { ...batch, entries: [{ ...batch.entries[0]!, eventType: "evil.pwned" }] };
    await expect(applier.applyBatch(tampered)).rejects.toThrow(ReplicationError);
    const wrongNode = { ...batch, nodeId: "impostor", signature: "" };
    wrongNode.signature = signBatch(SECRET, wrongNode);
    await expect(applier.applyBatch(wrongNode)).rejects.toThrow(ReplicationError);
    expect(applier.checkpoint("app", "app")).toBe(0);
  });

  it("rejects malformed entries even when the batch is correctly signed", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 1);
    const pub = publisherFor(primary);
    const batch = pub.pullFor(tokenFor(), "app", 0);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    const badSeq = { ...batch, entries: [{ ...batch.entries[0]!, seq: -5 }], signature: "" };
    badSeq.signature = signBatch(SECRET, badSeq);
    await expect(applier.applyBatch(badSeq)).rejects.toThrow(ReplicationError);
    // A payload key missing from the wire shape: JSON cannot carry
    // undefined, so a dropped key is what a real transport delivers.
    const { payload: _dropped, ...entryWithoutPayload } = batch.entries[0]!;
    const badPayload = { ...batch, entries: [entryWithoutPayload], signature: "" };
    badPayload.signature = signBatch(SECRET, badPayload as unknown as Omit<ReplicationBatch, "signature">);
    await expect(applier.applyBatch(badPayload)).rejects.toThrow(ReplicationError);
    expect(validateReplicatedEntry).toBeDefined();
    expect(applier.replicatedEntries("app", "app").length).toBe(0);
  });

  it("rejects an oversized payload before applying it", async () => {
    const primary = memDb();
    const replica = memDb();
    primary.transaction((tx) => {
      tx.recordOutbox({ eventType: "big.event", payload: { blob: "x".repeat(5000) } });
    });
    const pub = publisherFor(primary);
    const batch = pub.pullFor(tokenFor(), "app", 0);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, {
      secret: SECRET,
      maxPayloadChars: 100,
    });
    await expect(applier.applyBatch(batch)).rejects.toThrow(ReplicationError);
    expect(applier.checkpoint("app", "app")).toBe(0);
  });

  it("stops a batch at a failing apply handler and resumes after the good entries", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 2);
    const pub = publisherFor(primary);
    let calls = 0;
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, {
      secret: SECRET,
      onEntry: () => {
        calls += 1;
        if (calls === 2) throw new Error("read model down");
      },
    });
    const batch = pub.pullFor(tokenFor(), "app", 0);
    await expect(applier.applyBatch(batch)).rejects.toThrow("read model down");
    // First entry stored, checkpoint at it; the failed one is not stored.
    expect(applier.checkpoint("app", "app")).toBe(batch.entries[0]!.seq);
    expect(applier.replicatedEntries("app", "app").length).toBe(1);
  });
});

describe("replication — runner over multiple files", () => {
  it("pulls app and jobs independently, and a second pass is a no-op", async () => {
    const appDb = memDb();
    const jobsDb = memDb();
    seed(appDb, 2, "appuser");
    seed(jobsDb, 1, "jobuser");
    const pub = new ReplicationPublisher(
      { app: appDb as unknown as OutboxStore, jobs: jobsDb as unknown as OutboxStore },
      { nodeId: PRIMARY_ID, secret: SECRET },
    );
    const token = tokenFor();
    const transport: ReplicationTransport = {
      pull: async (file, afterSeq, limit) => pub.pullFor(token, file, afterSeq, limit),
    };
    const replicaApp = memDb();
    const replicaJobs = memDb();
    const appliers = new Map([
      ["app", new ReplicationApplier(replicaApp as unknown as OutboxStore, { secret: SECRET })],
      ["jobs", new ReplicationApplier(replicaJobs as unknown as OutboxStore, { secret: SECRET })],
    ]);
    const runner = new ReplicationRunner(transport, appliers);
    const first = await runner.runOnce();
    expect(first["app"]!.applied).toBe(2);
    expect(first["jobs"]!.applied).toBe(1);
    const second = await runner.runOnce();
    expect(second["app"]!.applied).toBe(0);
    expect(second["jobs"]!.applied).toBe(0);
    // A failed pull for one file never advances its checkpoint.
    const failing: ReplicationTransport = {
      pull: async (file, afterSeq, limit) => {
        if (file === "jobs") throw new Error("primary unreachable");
        return pub.pullFor(token, file, afterSeq, limit);
      },
    };
    const runner2 = new ReplicationRunner(failing, appliers);
    const third = await runner2.runOnce();
    expect(third["jobs"]!.error).toMatch("primary unreachable");
    expect(third["jobs"]!.checkpoint).toBe(first["jobs"]!.checkpoint);
    expect(runner2.lastFailure).toMatch("primary unreachable");
  });
});

describe("replication — HTTP handler and transport", () => {
  it("serves pulls over HTTP with auth, and rejects strangers with 401", async () => {
    const db = memDb();
    seed(db, 1);
    const pub = publisherFor(db);
    const handler = createReplicationHttpHandler(pub);
    const noAuth = await handler(new Request("http://x/_yatta/replication/pull?file=app&afterSeq=0&limit=10"));
    expect(noAuth.status).toBe(401);
    const wrongPath = await handler(new Request("http://x/other"));
    expect(wrongPath.status).toBe(404);
    const badCursor = await handler(new Request("http://x/_yatta/replication/pull?file=app&afterSeq=-1", {
      headers: { authorization: `Bearer ${tokenFor()}` },
    }));
    expect(badCursor.status).toBe(400);
    const unknown = await handler(new Request("http://x/_yatta/replication/pull?file=nope&afterSeq=0", {
      headers: { authorization: `Bearer ${tokenFor()}` },
    }));
    expect(unknown.status).toBe(404);
    // The fetch transport talks to the handler with no real network.
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      return handler(req);
    }) as typeof fetch;
    const transport = createHttpReplicationTransport("http://x", tokenFor(), fetchFn);
    const batch = await transport.pull("app", 0, 10);
    expect(batch.entries.length).toBe(1);
    expect(verifyBatchSignature(SECRET, batch)).toBe(true);
    const badTransport = createHttpReplicationTransport("http://x", "bogus", fetchFn);
    await expect(badTransport.pull("app", 0, 10)).rejects.toThrow(ReplicationError);
  });
});

describe("replication — replica is read-only, never a shadow primary", () => {
  it("blocks writes through the read-only store but allows reads", () => {
    const db = memDb();
    seed(db, 1);
    const readOnly = createReadOnlyStore(db as unknown as OutboxStore);
    expect(() => readOnly.rawRun("INSERT INTO x VALUES (1);")).toThrow(ReplicaWriteError);
    expect(readOnly.rawAll("SELECT 1 as n;").length).toBeGreaterThan(0);
  });

  it("assertPrimaryWrite throws for replicas and passes for primaries", () => {
    expect(() => assertPrimaryWrite("replica")).toThrow(ReplicaWriteError);
    expect(() => assertPrimaryWrite("primary")).not.toThrow();
    expect(() => assertPrimaryWrite(null)).not.toThrow();
  });

  it("has no promote step: a partitioned replica just stalls, it never writes", async () => {
    const primary = memDb();
    const replica = memDb();
    seed(primary, 1);
    const pub = publisherFor(primary);
    const applier = new ReplicationApplier(replica as unknown as OutboxStore, { secret: SECRET });
    await applier.applyBatch(pub.pullFor(tokenFor(), "app", 0));
    // Partition: transport now fails. The replica keeps its old checkpoint
    // and serves old reads; nothing here promotes it or accepts writes.
    const dead: ReplicationTransport = {
      pull: async () => {
        throw new Error("partition");
      },
    };
    const runner = new ReplicationRunner(dead, new Map([["app", applier]]));
    const result = await runner.runOnce();
    expect(result["app"]!.error).toMatch("partition");
    expect(applier.checkpoint("app", "app")).toBe(1);
    expect(() => createReadOnlyStore(replica as unknown as OutboxStore).rawRun("DELETE FROM users;")).toThrow(ReplicaWriteError);
  });
});

describe("replication — env config is opt-in and fails closed", () => {
  it("returns null when unconfigured, so nothing starts", () => {
    expect(replicationConfigFromEnv({})).toBeNull();
    expect(replicationConfigFromEnv({ YATTA_REPLICATION_ROLE: "  " })).toBeNull();
  });

  it("requires a secret when configured and a primary URL for replicas", () => {
    expect(() => replicationConfigFromEnv({ YATTA_REPLICATION_ROLE: "primary" })).toThrow(ReplicationError);
    expect(() => replicationConfigFromEnv({
      YATTA_REPLICATION_ROLE: "replica",
      YATTA_REPLICATION_SECRET: "s",
    })).toThrow(ReplicationError);
    expect(() => replicationConfigFromEnv({
      YATTA_REPLICATION_ROLE: "sideways",
      YATTA_REPLICATION_SECRET: "s",
    })).toThrow(ReplicationError);
    const cfg = replicationConfigFromEnv({
      YATTA_REPLICATION_ROLE: "replica",
      YATTA_REPLICATION_SECRET: "s",
      YATTA_REPLICATION_PRIMARY_URL: "https://primary.example",
      YATTA_REPLICATION_ALLOWED_REPLICAS: "replica-1, replica-2",
      YATTA_REPLICATION_POLL_MS: "500",
    });
    expect(cfg!.role).toBe("replica");
    expect(cfg!.primaryUrl).toBe("https://primary.example");
    expect(cfg!.allowedReplicaIds).toBeUndefined();
    expect(cfg!.pollIntervalMs).toBe(500);
    const primaryCfg = replicationConfigFromEnv({
      YATTA_REPLICATION_ROLE: "primary",
      YATTA_REPLICATION_SECRET: "s",
      YATTA_REPLICATION_ALLOWED_REPLICAS: "replica-1, replica-2",
    });
    expect(primaryCfg!.allowedReplicaIds).toEqual(["replica-1", "replica-2"]);
  });
});

describe("replication — direct entry validation", () => {
  it("accepts a well-formed entry and rejects bad shapes", () => {
    const good = {
      seq: 1,
      eventId: "e1",
      eventType: "user.registered",
      aggregateType: null,
      aggregateId: null,
      payload: { a: 1 },
      occurredAt: 1000,
      dedupeKey: null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 1000,
      publishedAt: null,
      lastError: null,
      createdAt: 1000,
    };
    expect(validateReplicatedEntry(good).eventId).toBe("e1");
    expect(() => validateReplicatedEntry({ ...good, seq: 0 })).toThrow(ReplicationError);
    expect(() => validateReplicatedEntry({ ...good, eventType: "  " })).toThrow(ReplicationError);
    expect(() => validateReplicatedEntry({ ...good, status: "weird" })).toThrow(ReplicationError);
    expect(() => validateReplicatedEntry(null)).toThrow(ReplicationError);
  });
});
