import { describe, it, expect, afterEach } from "bun:test";
import { createDatabase, col, type TypedDatabase } from "../types/db";
import { recordOutbox, type OutboxEntry } from "../types/outbox";
import {
  createReplayRunner,
  replayAggregate,
  replayEntries,
  createSnapshot,
  loadSnapshot,
  verifySnapshot,
  rewindTo,
  assertReplayAllowed,
  type ReplaySnapshot,
} from "../types/replay";

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

// Dev flag used by every allowed call below. Tests never rely on the
// ambient NODE_ENV: the explicit environment pins the gate to dev.
const DEV = { enabled: true, environment: "development" } as const;

type UserState = { email: string | null; name: string | null; events: string[] };

const initial: UserState = { email: null, name: null, events: [] };

function userReducer(state: UserState, entry: OutboxEntry): UserState {
  const payload = entry.payload as Record<string, unknown>;
  if (entry.eventType === "user.registered") {
    return { ...state, email: payload.email as string, name: payload.name as string, events: [...state.events, entry.eventType] };
  }
  if (entry.eventType === "user.renamed") {
    return { ...state, name: payload.name as string, events: [...state.events, entry.eventType] };
  }
  return { ...state, events: [...state.events, entry.eventType] };
}

function recordEvents(db: TestDb, userId: string): [number, number, number] {
  const seqs: number[] = [];
  db.transaction((tx) => {
    seqs.push(tx.recordOutbox({
      eventType: "user.registered",
      aggregateType: "user",
      aggregateId: userId,
      payload: { email: "ada@example.com", name: "Ada" },
    }).seq);
    seqs.push(tx.recordOutbox({
      eventType: "user.renamed",
      aggregateType: "user",
      aggregateId: userId,
      payload: { name: "Ada Lovelace" },
    }).seq);
    seqs.push(tx.recordOutbox({
      eventType: "user.renamed",
      aggregateType: "user",
      aggregateId: userId,
      payload: { name: "Ada King" },
    }).seq);
  });
  if (seqs.length !== 3) throw new Error("expected 3 recorded events");
  return [seqs[0]!, seqs[1]!, seqs[2]!];
}

describe("time-travel replay — dev gate", () => {
  it("refuses when not opted in", () => {
    const db = memDb();
    expect(() =>
      replayAggregate(db, {
        aggregateType: "user", aggregateId: "u1",
        reducer: userReducer, initialState: initial,
      }),
    ).toThrow(/disabled/);
  });

  it("refuses a production environment even when opted in", () => {
    const db = memDb();
    expect(() =>
      replayAggregate(db, {
        aggregateType: "user", aggregateId: "u1",
        reducer: userReducer, initialState: initial,
        enabled: true, environment: "production",
      }),
    ).toThrow(/production/);
    expect(() =>
      createReplayRunner(db, { enabled: true, environment: "prod" }),
    ).toThrow(/production/);
  });

  it("refuses when NODE_ENV says production even if the option says dev", () => {
    const db = memDb();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        assertReplayAllowed({ enabled: true, environment: "development" }),
      ).toThrow(/production/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("refuses when the environment is unknown (fail closed)", () => {
    const db = memDb();
    const prevNode = process.env.NODE_ENV;
    const prevYatta = process.env.YATTA_ENV;
    delete process.env.NODE_ENV;
    delete process.env.YATTA_ENV;
    try {
      expect(() =>
        replayAggregate(db, {
          aggregateType: "user", aggregateId: "u1",
          reducer: userReducer, initialState: initial, enabled: true,
        }),
      ).toThrow(/unknown environment/);
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevYatta === undefined) delete process.env.YATTA_ENV;
      else process.env.YATTA_ENV = prevYatta;
    }
  });

  it("refuses snapshot and rewind calls in production too", () => {
    const db = memDb();
    const prod = { enabled: true, environment: "production" } as const;
    expect(() =>
      createSnapshot(db, { aggregateType: "user", aggregateId: "u1", reducer: userReducer, initialState: initial, ...prod }),
    ).toThrow(/production/);
    expect(() =>
      rewindTo(db, { aggregateType: "user", aggregateId: "u1", reducer: userReducer, initialState: initial, targetSeq: 1, ...prod }),
    ).toThrow(/production/);
    expect(() =>
      loadSnapshot(db, "user", "u1", prod),
    ).toThrow(/production/);
  });
});

describe("time-travel replay — log + snapshot", () => {
  it("reproduces state from the shared log", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const result = replayAggregate(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, ...DEV,
    });
    expect(result.state).toEqual({
      email: "ada@example.com", name: "Ada King",
      events: ["user.registered", "user.renamed", "user.renamed"],
    });
    expect(result.lastSeq).toBe(seqs[2]);
    expect(result.appliedCount).toBe(3);
    expect(result.eventIds).toHaveLength(3);
  });

  it("reads published and dead rows too: relay status is not history", () => {
    const db = memDb();
    recordEvents(db, "u1");
    db.rawRun(`UPDATE "_yatta_outbox" SET status = 'published' WHERE seq = 1;`);
    db.rawRun(`UPDATE "_yatta_outbox" SET status = 'dead' WHERE seq = 2;`);
    const result = replayAggregate(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, ...DEV,
    });
    expect(result.appliedCount).toBe(3);
    expect(result.state.name).toBe("Ada King");
  });

  it("rewinds to a snapshot, then replays forward past it", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const snapshot = createSnapshot(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, upToSeq: seqs[1], ...DEV,
    });
    expect(snapshot.upToSeq).toBe(seqs[1]);
    expect(snapshot.state.name).toBe("Ada Lovelace");

    const rewound = rewindTo(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, targetSeq: seqs[1], ...DEV,
    });
    expect(rewound.state.name).toBe("Ada Lovelace");
    expect(rewound.snapshotUsed?.upToSeq).toBe(seqs[1]);

    const full = rewindTo(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, targetSeq: seqs[2], ...DEV,
    });
    expect(full.state.name).toBe("Ada King");
    expect(full.snapshotUsed?.upToSeq).toBe(seqs[1]);
    expect(full.appliedCount).toBe(1);
  });

  it("rewind without a snapshot replays from the beginning", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const result = rewindTo(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, targetSeq: seqs[0], ...DEV,
    });
    expect(result.state.name).toBe("Ada");
    expect(result.snapshotUsed).toBeNull();
  });

  it("rewind never writes to the application's own tables", () => {
    const db = memDb();
    const user = db.users.insert({ email: "ada@example.com", name: "Ada" });
    recordEvents(db, user.id);
    rewindTo(db, {
      aggregateType: "user", aggregateId: user.id,
      reducer: userReducer, initialState: initial, targetSeq: 1, ...DEV,
    });
    expect(db.users.findById(user.id)?.name).toBe("Ada");
  });

  it("replay up to a seq stops at that position", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const result = replayAggregate(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, upToSeq: seqs[1], ...DEV,
    });
    expect(result.state.name).toBe("Ada Lovelace");
    expect(result.appliedCount).toBe(2);
  });

  it("the runner binds the gate and the store", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const runner = createReplayRunner(db, DEV);
    const snap = runner.snapshot({
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, upToSeq: seqs[0],
    });
    expect(runner.load<UserState>("user", "u1")?.upToSeq).toBe(snap.upToSeq);
    expect(runner.list<UserState>("user", "u1")).toHaveLength(1);
    expect(runner.rewind({
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, targetSeq: seqs[2],
    }).state.name).toBe("Ada King");
  });
});

describe("time-travel replay — integrity and idempotency", () => {
  it("a corrupt snapshot fails loudly, never replays wrong state", () => {
    const db = memDb();
    const seqs = recordEvents(db, "u1");
    const snap = createSnapshot(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, upToSeq: seqs[1], ...DEV,
    });
    // Tamper with the stored state without updating the checksum.
    db.rawRun(
      `UPDATE "_yatta_replay_snapshots" SET state = ? WHERE up_to_seq = ?;`,
      [JSON.stringify({ email: "mallory@example.com", name: "Mallory", events: [] }), snap.upToSeq],
    );
    expect(() => loadSnapshot(db, "user", "u1", DEV)).toThrow(/checksum mismatch/);
    expect(() => rewindTo(db, {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial, targetSeq: seqs[2], ...DEV,
    })).toThrow(/checksum mismatch/);
    // Direct verification also refuses the tampered object.
    const tampered: ReplaySnapshot<UserState> = {
      ...snap, state: { email: "mallory@example.com", name: "Mallory", events: [] },
    };
    expect(() => verifySnapshot(tampered)).toThrow(/checksum mismatch/);
  });

  it("a corrupt log payload fails loudly instead of replaying", () => {
    const db = memDb();
    recordEvents(db, "u1");
    db.rawRun(`UPDATE "_yatta_outbox" SET payload = ? WHERE seq = 2;`, ["{not json"]);
    expect(() =>
      replayAggregate(db, {
        aggregateType: "user", aggregateId: "u1",
        reducer: userReducer, initialState: initial, ...DEV,
      }),
    ).toThrow();
  });

  it("a duplicate event id in the entries refuses replay", () => {
    const entry = {
      seq: 1, eventId: "e1", eventType: "user.registered",
      aggregateType: "user", aggregateId: "u1",
      payload: { email: "a@example.com", name: "A" },
      occurredAt: 1, dedupeKey: null, status: "pending" as const,
      attempts: 0, nextAttemptAt: 1, publishedAt: null, lastError: null, createdAt: 1,
    };
    const twice = [{ ...entry }, { ...entry, seq: 2 }];
    expect(() =>
      replayEntries(twice, { aggregateType: "user", aggregateId: "u1", reducer: userReducer, initialState: initial }, { state: initial, lastSeq: 0 }),
    ).toThrow(/duplicate event id/);
  });

  it("an out-of-order entry refuses replay", () => {
    const base = {
      eventId: "e1", eventType: "user.registered",
      aggregateType: "user", aggregateId: "u1",
      payload: { email: "a@example.com", name: "A" },
      occurredAt: 1, dedupeKey: null, status: "pending" as const,
      attempts: 0, nextAttemptAt: 1, publishedAt: null, lastError: null, createdAt: 1,
    };
    const entries = [
      { ...base, seq: 2, eventId: "e2" },
      { ...base, seq: 1, eventId: "e1" },
    ];
    expect(() =>
      replayEntries(entries, { aggregateType: "user", aggregateId: "u1", reducer: userReducer, initialState: initial }, { state: initial, lastSeq: 0 }),
    ).toThrow(/out-of-order/);
  });

  it("already-applied entries are skipped, never double-applied", () => {
    const db = memDb();
    recordEvents(db, "u1");
    const applied = new Set<string>();
    const target = {
      aggregateType: "user", aggregateId: "u1",
      reducer: userReducer, initialState: initial,
      isApplied: (id: string) => applied.has(id),
      markApplied: (id: string) => applied.add(id),
      ...DEV,
    };
    const first = replayAggregate(db, target);
    expect(first.appliedCount).toBe(3);
    const second = replayAggregate(db, target);
    expect(second.appliedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.state).toEqual(initial);
  });
});
