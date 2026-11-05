import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDatabase,
  col,
  type TypedDatabase,
} from "../types/db";
import { type OutboxStore } from "../types/outbox";
import {
  RaftNode,
  InMemoryRaftLog,
  InMemoryRaftTransport,
  PersistentRaftState,
  ChangeLogRaftLog,
  RaftError,
  randomizedElectionTimeout,
  raftConfigFromEnv,
  signAppendEntries,
  verifyAppendEntriesSignature,
  createSignedHttpRaftTransport,
  createRaftHttpHandler,
  type RaftLogEntry,
  type RaftNodeOptions,
} from "../types/raft";
import { createNodeToken } from "../types/replication";

const SECRET = "test-raft-secret-that-is-not-real";

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
const tmpFiles: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const f of tmpFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(f + suffix)) unlinkSync(f + suffix);
      } catch {}
    }
  }
});

function memDb(): TestDb {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true });
  dbs.push(db);
  return db;
}

function entry(seq: number, term: number, eventId = `evt-${seq}-${term}`): RaftLogEntry {
  return {
    seq,
    term,
    eventId,
    eventType: "user.registered",
    payload: { n: seq },
    occurredAt: 1000 + seq,
    createdAt: 1000 + seq,
  };
}

// A small controllable cluster: shared clock, per-node memory DB for
// durable state, in-memory transports wired to every node.
function cluster(
  ids: string[],
  opts: {
    logs?: Record<string, RaftLogEntry[]>;
    commits?: Record<string, number>;
  } = {},
) {
  let now = 1_000_000;
  const nodes = new Map<string, RaftNode>();
  const logs = new Map<string, InMemoryRaftLog>();
  const transports = new Map<string, InMemoryRaftTransport>();
  for (const id of ids) {
    const log = new InMemoryRaftLog(opts.logs?.[id] ?? [], opts.commits?.[id] ?? 0);
    logs.set(id, log);
    const state = new PersistentRaftState(memDb() as unknown as OutboxStore);
    const node = new RaftNode({
      nodeId: id,
      peers: ids.filter((p) => p !== id),
      secret: SECRET,
      log,
      persistentState: state,
      timers: false,
      now: () => now,
    });
    nodes.set(id, node);
  }
  for (const id of ids) {
    const t = new InMemoryRaftTransport(id, SECRET);
    for (const node of nodes.values()) t.addNode(node);
    transports.set(id, t);
    nodes.get(id)!.setTransport(t);
  }
  return {
    nodes,
    logs,
    transports,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    node(id: string): RaftNode {
      return nodes.get(id)!;
    },
    leaders(): RaftNode[] {
      return [...nodes.values()].filter((n) => n.currentRole === "leader");
    },
  };
}

describe("raft — one leader per term", () => {
  it("two candidates in one term produce exactly one winner", async () => {
    const c = cluster(["a", "b", "c"]);
    // a runs first but cannot reach anyone: it stays a term-1 candidate.
    c.transports.get("a")!.partition("b");
    c.transports.get("a")!.partition("c");
    await c.node("a").startElection();
    expect(c.node("a").currentRole).toBe("candidate");
    expect(c.node("a").term).toBe(1);
    // b runs in the same term 1 (it never saw a's term): b + c is a majority.
    await c.node("b").startElection();
    expect(c.node("b").currentRole).toBe("leader");
    expect(c.node("b").term).toBe(1);
    // a's own vote went to itself, so b won on b + c, not on a.
    expect(c.node("c").votedForId).toBe("b");
    // When a hears b's heartbeat for the same term, a steps down.
    c.transports.get("a")!.unpartition("b");
    c.transports.get("a")!.unpartition("c");
    await c.node("b").sendHeartbeats();
    expect(c.node("a").currentRole).toBe("follower");
    expect(c.leaders().map((n) => n.nodeId)).toEqual(["b"]);
  });

  it("a voter grants at most one vote per term", () => {
    const c = cluster(["voter", "x", "y"]);
    const voter = c.node("voter");
    expect(voter.handleRequestVote({ term: 2, candidateId: "x", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
    expect(voter.handleRequestVote({ term: 2, candidateId: "y", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(false);
    // Re-asking for the same candidate in the same term is still a grant, not a second vote.
    expect(voter.handleRequestVote({ term: 2, candidateId: "x", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
    expect(voter.votedForId).toBe("x");
    // A higher term clears the vote.
    expect(voter.handleRequestVote({ term: 3, candidateId: "y", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
    expect(voter.votedForId).toBe("y");
  });

  it("a stale candidate behind the voter's log is refused", () => {
    const c = cluster(["voter", "x"], {
      logs: { voter: [entry(1, 1), entry(2, 2), entry(3, 2)] },
    });
    const voter = c.node("voter");
    // Behind on term.
    expect(voter.handleRequestVote({ term: 5, candidateId: "x", lastLogSeq: 9, lastLogTerm: 1 }).voteGranted).toBe(false);
    // Same term, shorter log.
    expect(voter.handleRequestVote({ term: 5, candidateId: "x", lastLogSeq: 2, lastLogTerm: 2 }).voteGranted).toBe(false);
    // At least as up-to-date: same term, same length.
    expect(voter.handleRequestVote({ term: 5, candidateId: "x", lastLogSeq: 3, lastLogTerm: 2 }).voteGranted).toBe(true);
  });
});

describe("raft — terms and step-down", () => {
  it("a higher term steps down the old leader", async () => {
    const c = cluster(["a", "b", "c"]);
    await c.node("a").startElection();
    expect(c.node("a").currentRole).toBe("leader");
    const res = c.node("a").handleAppendEntries({
      term: 2,
      leaderId: "b",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    });
    expect(res.success).toBe(true);
    expect(c.node("a").currentRole).toBe("follower");
    expect(c.node("a").term).toBe(2);
    expect(c.node("a").currentLeaderId).toBe("b");
  });

  it("a stale leader's AppendEntries are rejected and change nothing", () => {
    const c = cluster(["a", "b"]);
    const follower = c.node("b");
    // b is at term 2 (voted in an election that a missed).
    follower.handleRequestVote({ term: 2, candidateId: "a", lastLogSeq: 0, lastLogTerm: 0 });
    const res = follower.handleAppendEntries({
      term: 1,
      leaderId: "a",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [entry(1, 1)],
      leaderCommit: 0,
    });
    expect(res.success).toBe(false);
    expect(res.term).toBe(2);
    expect(c.logs.get("b")!.lastSeq()).toBe(0);
  });

  it("a leader that loses quorum steps down instead of serving split-brain writes", async () => {
    const c = cluster(["a", "b", "c"]);
    await c.node("a").startElection();
    expect(c.node("a").currentRole).toBe("leader");
    // No peer has acked since election, and the clock moves past the
    // election timeout window: the leader no longer holds a majority.
    c.advance(1000);
    expect(c.node("a").checkLeaderQuorum()).toBe(false);
    expect(c.node("a").currentRole).toBe("follower");
    expect(() => c.node("a").appendAsLeader({
      eventId: "evt-x",
      eventType: "user.registered",
      payload: {},
      occurredAt: 1,
      createdAt: 1,
    })).toThrow(RaftError);
  });

  it("a single-node leader trivially holds quorum", async () => {
    const log = new InMemoryRaftLog();
    const node = new RaftNode({
      nodeId: "solo",
      peers: [],
      singleNode: true,
      secret: SECRET,
      log,
      persistentState: new PersistentRaftState(memDb() as unknown as OutboxStore),
      timers: false,
    });
    node.start();
    expect(node.currentRole).toBe("leader");
    expect(node.checkLeaderQuorum()).toBe(true);
  });
});

describe("raft — elections and promotion", () => {
  it("a single-node cluster elects itself on start (explicit dev mode)", () => {
    const log = new InMemoryRaftLog();
    const node = new RaftNode({
      nodeId: "solo",
      peers: [],
      singleNode: true,
      secret: SECRET,
      log,
      persistentState: new PersistentRaftState(memDb() as unknown as OutboxStore),
      timers: false,
    });
    expect(node.currentRole).toBe("follower");
    node.start();
    expect(node.currentRole).toBe("leader");
    expect(node.quorum).toBe(1);
  });

  it("a node without quorum config never claims leadership", () => {
    expect(() => new RaftNode({
      nodeId: "lonely",
      peers: [],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      timers: false,
    })).toThrow(RaftError);
  });

  it("a follower never self-promotes without an election", () => {
    const c = cluster(["a", "b", "c"]);
    const follower = c.node("a");
    follower.start();
    expect(follower.currentRole).toBe("follower");
    // Heartbeats are a leader duty: a follower sends none.
    expect(follower.currentLeaderId).toBeNull();
    expect(() => follower.appendAsLeader({
      eventId: "evt-x",
      eventType: "user.registered",
      payload: {},
      occurredAt: 1,
      createdAt: 1,
    })).toThrow(RaftError);
    // Receiving a heartbeat does not promote it either.
    follower.handleAppendEntries({
      term: 1,
      leaderId: "b",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    });
    expect(follower.currentRole).toBe("follower");
    expect(follower.currentLeaderId).toBe("b");
  });

  it("an election timeout on a follower starts an election, not a promotion", async () => {
    const c = cluster(["a", "b", "c"]);
    const a = c.node("a");
    a.start();
    await a.triggerElectionTimeout();
    expect(a.term).toBe(1);
    // a won b + c, so it is leader BY election — the legitimate path.
    expect(a.currentRole).toBe("leader");
    expect(c.node("b").votedForId).toBe("a");
  });
});

describe("raft — log consistency and leader completeness", () => {
  it("a follower converges to the leader's log, truncating a conflicting suffix", () => {
    const c = cluster(["leader", "follower"], {
      logs: {
        leader: [entry(1, 1), entry(2, 1), entry(3, 1)],
        follower: [entry(1, 1), entry(2, 1, "evt-conflict")],
      },
    });
    const follower = c.node("follower");
    const res = follower.handleAppendEntries({
      term: 1,
      leaderId: "leader",
      prevLogSeq: 1,
      prevLogTerm: 1,
      entries: [
        { seq: 2, term: 1, eventId: "evt-2-1", eventType: "user.registered", payload: { n: 2 }, occurredAt: 1002, createdAt: 1002 },
        { seq: 3, term: 1, eventId: "evt-3-1", eventType: "user.registered", payload: { n: 3 }, occurredAt: 1003, createdAt: 1003 },
      ],
      leaderCommit: 0,
    });
    expect(res.success).toBe(true);
    expect(c.logs.get("follower")!.snapshot().map((e) => e.eventId)).toEqual(["evt-1-1", "evt-2-1", "evt-3-1"]);
  });

  it("a follower never truncates at or below its commit index, even for a higher-term leader", () => {
    const c = cluster(["leader", "follower"], {
      logs: {
        leader: [entry(1, 1), entry(2, 2, "evt-other")],
        follower: [entry(1, 1), entry(2, 1)],
      },
      commits: { follower: 2 },
    });
    const follower = c.node("follower");
    const res = follower.handleAppendEntries({
      term: 2,
      leaderId: "leader",
      prevLogSeq: 1,
      prevLogTerm: 1,
      entries: [
        { seq: 2, term: 2, eventId: "evt-other", eventType: "user.registered", payload: { n: 2 }, occurredAt: 1002, createdAt: 1002 },
      ],
      leaderCommit: 0,
    });
    expect(res.success).toBe(false);
    expect(c.logs.get("follower")!.snapshot().map((e) => e.eventId)).toEqual(["evt-1-1", "evt-2-1"]);
    expect(c.logs.get("follower")!.commitIndex()).toBe(2);
    // The log implementation itself refuses the truncation too.
    expect(() => c.logs.get("follower")!.truncateFrom(2)).toThrow(RaftError);
  });

  it("a committed entry survives a leader change (leader completeness)", async () => {
    const c = cluster(["a", "b", "c"]);
    await c.node("a").startElection();
    const leader = c.node("a");
    expect(leader.currentRole).toBe("leader");
    const appended = leader.appendAsLeader({
      eventId: "evt-committed",
      eventType: "user.registered",
      payload: { user: "ada" },
      occurredAt: 2000,
      createdAt: 2000,
    });
    expect(appended.seq).toBe(1);
    expect(appended.term).toBe(1);
    // Replicate to b only: a + b is a majority, so the entry commits.
    await leader.syncPeer("b");
    expect(leader.commitIndex).toBe(1);
    expect(c.logs.get("b")!.entryAt(1)?.eventId).toBe("evt-committed");
    // c never saw the entry. a goes away; b must win the next
    // election precisely because it holds the committed entry, and c
    // (stale, empty log) must not be able to beat it.
    c.transports.get("b")!.partition("a");
    c.transports.get("c")!.partition("a");
    await c.node("b").startElection();
    expect(c.node("b").currentRole).toBe("leader");
    expect(c.logs.get("b")!.entryAt(1)?.eventId).toBe("evt-committed");
    // The new leader commits a fresh entry, which commits the old one
    // with it (commit index 2 covers seq 1). The first sync to c
    // fails the prev-log check (c lacks seq 1) and backs nextIndex
    // up; the second sync sends both entries.
    c.node("b").appendAsLeader({
      eventId: "evt-after",
      eventType: "user.registered",
      payload: { user: "bob" },
      occurredAt: 3000,
      createdAt: 3000,
    });
    await c.node("b").syncPeer("c");
    await c.node("b").syncPeer("c");
    expect(c.node("b").commitIndex).toBe(2);
    expect(c.logs.get("c")!.snapshot().map((e) => e.eventId)).toEqual(["evt-committed", "evt-after"]);
    // A heartbeat propagates the commit index to c.
    await c.node("b").sendHeartbeats();
    expect(c.logs.get("c")!.commitIndex()).toBe(2);
    // The stale node cannot win against the holder of committed history.
    const staleVote = c.node("b").handleRequestVote({
      term: 99,
      candidateId: "c",
      lastLogSeq: 0,
      lastLogTerm: 0,
    });
    expect(staleVote.voteGranted).toBe(false);
  });

  it("a leader only commits current-term entries by counting", async () => {
    // Log from an old term, replicated but never committed by its
    // leader; a new leader must not commit it merely by counting
    // acks — it commits only once a current-term entry commits.
    const c = cluster(["a", "b", "c"], {
      logs: {
        a: [entry(1, 1)],
        b: [entry(1, 1)],
        c: [],
      },
    });
    // Move every node to term 5 first (votes granted to an
    // up-to-date candidate), so a's election lands on term 6 while
    // the held entry stays a term-1 entry.
    for (const id of ["a", "b"]) {
      expect(c.node(id).handleRequestVote({ term: 5, candidateId: "z", lastLogSeq: 1, lastLogTerm: 1 }).voteGranted).toBe(true);
    }
    expect(c.node("c").handleRequestVote({ term: 5, candidateId: "z", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
    await c.node("a").startElection();
    expect(c.node("a").term).toBe(6);
    expect(c.node("a").currentRole).toBe("leader");
    // Syncing the old entry to c must NOT advance the commit index:
    // the entry is from term 1, not the leader's current term 6.
    // (First sync backs nextIndex up past c's missing prefix.)
    await c.node("a").syncPeer("c");
    await c.node("a").syncPeer("c");
    expect(c.logs.get("c")!.entryAt(1)?.eventId).toBe("evt-1-1");
    expect(c.node("a").commitIndex).toBe(0);
    // Once the leader appends and replicates a term-6 entry, both commit.
    c.node("a").appendAsLeader({
      eventId: "evt-t6",
      eventType: "user.registered",
      payload: {},
      occurredAt: 4000,
      createdAt: 4000,
    });
    await c.node("a").syncPeer("b");
    expect(c.node("a").commitIndex).toBe(2);
  });
});

describe("raft — durable state across restarts", () => {
  it("restart preserves term and vote: a double vote after restart is refused", () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", "raft-restart");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `node-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(path);
    const db1 = createDatabase({ path, schema, forceNew: true });
    dbs.push(db1);
    const state1 = new PersistentRaftState(db1 as unknown as OutboxStore);
    const node1 = new RaftNode({
      nodeId: "voter",
      peers: ["x", "y"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      persistentState: state1,
      timers: false,
    });
    expect(node1.handleRequestVote({ term: 4, candidateId: "x", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
    db1.close();
    dbs.splice(dbs.indexOf(db1), 1);
    // "Restart": a fresh node object over the same database file.
    const db2 = createDatabase({ path, schema });
    dbs.push(db2);
    const state2 = new PersistentRaftState(db2 as unknown as OutboxStore);
    const node2 = new RaftNode({
      nodeId: "voter",
      peers: ["x", "y"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      persistentState: state2,
      timers: false,
    });
    expect(node2.term).toBe(4);
    expect(node2.votedForId).toBe("x");
    expect(node2.handleRequestVote({ term: 4, candidateId: "y", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(false);
    expect(node2.handleRequestVote({ term: 4, candidateId: "x", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(true);
  });

  it("a node without durable state refuses to grant votes (fail closed)", () => {
    const node = new RaftNode({
      nodeId: "memory-only",
      peers: ["x"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      timers: false,
    });
    expect(node.handleRequestVote({ term: 1, candidateId: "x", lastLogSeq: 0, lastLogTerm: 0 }).voteGranted).toBe(false);
  });
});

describe("raft — change-log adapter", () => {
  it("ChangeLogRaftLog appends, truncates above commit, and refuses at commit", () => {
    const db = memDb();
    const store = db as unknown as OutboxStore;
    const log = new ChangeLogRaftLog(store);
    const e1 = log.appendOriginated({ eventType: "user.registered", eventId: "e1", payload: { n: 1 }, term: 1 });
    const e2 = log.appendOriginated({ eventType: "user.registered", eventId: "e2", payload: { n: 2 }, term: 1 });
    expect(log.lastSeq()).toBe(e2.seq);
    expect(log.lastTerm()).toBe(1);
    expect(log.termAt(e1.seq)).toBe(1);
    log.setCommitIndex(e1.seq);
    expect(log.commitIndex()).toBe(e1.seq);
    expect(() => log.truncateFrom(e1.seq)).toThrow(RaftError);
    log.truncateFrom(e2.seq);
    expect(log.lastSeq()).toBe(e1.seq);
    // The outbox row is still history; only the Raft view truncated.
    expect(log.entryAt(e2.seq)).toBeNull();
  });

  it("follower entries applied through the adapter converge and are idempotent", () => {
    const db = memDb();
    const log = new ChangeLogRaftLog(db as unknown as OutboxStore);
    const res = log.append([entry(1, 1), entry(2, 1)]);
    expect(res).toEqual({ appended: 2, skipped: 0 });
    const again = log.append([entry(1, 1)]);
    expect(again).toEqual({ appended: 0, skipped: 1 });
    expect(log.entriesAfter(0, 10).map((e) => e.eventId)).toEqual(["evt-1-1", "evt-2-1"]);
  });
});

describe("raft — auth, signatures, and config", () => {
  it("a forged node token gets no vote over the in-memory transport", async () => {
    const c = cluster(["a", "b"]);
    const evil = new InMemoryRaftTransport("a", "wrong-secret");
    evil.addNode(c.node("b"));
    const res = await evil.sendRequestVote("b", { term: 9, candidateId: "a", lastLogSeq: 0, lastLogTerm: 0 });
    expect(res.voteGranted).toBe(false);
    expect(c.node("b").term).toBe(0);
  });

  it("AppendEntries signatures verify only for their own domain and body", () => {
    const req = {
      term: 1,
      leaderId: "a",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    };
    const sig = signAppendEntries(SECRET, req);
    expect(verifyAppendEntriesSignature(SECRET, req, sig)).toBe(true);
    expect(verifyAppendEntriesSignature(SECRET, { ...req, term: 2 }, sig)).toBe(false);
    expect(verifyAppendEntriesSignature("wrong-secret", req, sig)).toBe(false);
    expect(verifyAppendEntriesSignature(SECRET, req, "0".repeat(64))).toBe(false);
  });

  it("the HTTP handler enforces token + signature and applies signed entries", async () => {
    const db = memDb();
    const state = new PersistentRaftState(db as unknown as OutboxStore);
    const log = new InMemoryRaftLog();
    const node = new RaftNode({
      nodeId: "b",
      peers: ["a"],
      secret: SECRET,
      log,
      persistentState: state,
      timers: false,
    });
    const handler = createRaftHttpHandler(node, SECRET);
    const token = createNodeToken(SECRET, "a");
    const appendReq = {
      term: 1,
      leaderId: "a",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [
        { seq: 1, term: 1, eventId: "evt-1", eventType: "user.registered", payload: { n: 1 }, occurredAt: 1, createdAt: 1 },
      ],
      leaderCommit: 0,
    };
    // No token: 401, nothing applied.
    const noAuth = await handler(new Request("http://x/_yatta/raft/append-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...appendReq, signature: signAppendEntries(SECRET, appendReq) }),
    }));
    expect(noAuth.status).toBe(401);
    expect(log.lastSeq()).toBe(0);
    // Token but no signature: 401.
    const noSig = await handler(new Request("http://x/_yatta/raft/append-entries", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(appendReq),
    }));
    expect(noSig.status).toBe(401);
    // Token + valid signature: applied.
    const ok = await handler(new Request("http://x/_yatta/raft/append-entries", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...appendReq, signature: signAppendEntries(SECRET, appendReq) }),
    }));
    expect(ok.status).toBe(200);
    expect(log.lastSeq()).toBe(1);
    // Vote path with a valid token.
    const vote = await handler(new Request("http://x/_yatta/raft/request-vote", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ term: 2, candidateId: "a", lastLogSeq: 1, lastLogTerm: 1 }),
    }));
    expect(vote.status).toBe(200);
    expect((await vote.json() as { voteGranted: boolean }).voteGranted).toBe(true);
  });

  it("signed HTTP transport round-trips through the handler", async () => {
    const db = memDb();
    const node = new RaftNode({
      nodeId: "b",
      peers: ["a"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      persistentState: new PersistentRaftState(db as unknown as OutboxStore),
      timers: false,
    });
    const handler = createRaftHttpHandler(node, SECRET);
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      return handler(req);
    }) as typeof fetch;
    const transport = createSignedHttpRaftTransport("http://peer", createNodeToken(SECRET, "a"), SECRET, fetchFn);
    const res = await transport.sendAppendEntries("b", {
      term: 1,
      leaderId: "a",
      prevLogSeq: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: 0,
    });
    expect(res.success).toBe(true);
  });

  it("env config is fail-closed: unset is off, enabled without secret or quorum throws", () => {
    expect(raftConfigFromEnv({})).toBeNull();
    expect(raftConfigFromEnv({ YATTA_RAFT_ENABLED: "true", YATTA_RAFT_NODE_ID: "a" })).toThrow(RaftError);
    expect(raftConfigFromEnv({
      YATTA_RAFT_ENABLED: "true",
      YATTA_RAFT_NODE_ID: "a",
      YATTA_RAFT_SECRET: SECRET,
    })).toThrow(RaftError);
    const single = raftConfigFromEnv({
      YATTA_RAFT_ENABLED: "true",
      YATTA_RAFT_NODE_ID: "a",
      YATTA_RAFT_SECRET: SECRET,
      YATTA_RAFT_SINGLE_NODE: "true",
    });
    expect(single?.singleNode).toBe(true);
    expect(single?.peers).toEqual([]);
  });

  it("election timeout randomization stays in bounds and rejects bad bounds", () => {
    for (let i = 0; i < 50; i += 1) {
      const t = randomizedElectionTimeout(150, 300);
      expect(t).toBeGreaterThanOrEqual(150);
      expect(t).toBeLessThan(300);
    }
    expect(() => randomizedElectionTimeout(300, 150)).toThrow(RaftError);
    expect(() => randomizedElectionTimeout(0, 100)).toThrow(RaftError);
    expect(() => new RaftNode({
      nodeId: "a",
      peers: ["b"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      electionTimeoutMinMs: 100,
      electionTimeoutMaxMs: 100,
      timers: false,
    })).toThrow(RaftError);
    expect(() => new RaftNode({
      nodeId: "a",
      peers: ["b"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
      heartbeatIntervalMs: 200,
      timers: false,
    })).toThrow(RaftError);
  });

  it("no framework entry point imports the Raft module (lazy, zero cost when unconfigured)", () => {
    for (const rel of ["src/main.ts", "src/types/index.ts", "core_runtime/index.ts"]) {
      const text = readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, "utf8");
      expect(text).not.toContain("types/raft");
      expect(text).not.toContain("from \"./raft\"");
    }
  });
});

describe("raft — options used in tests", () => {
  it("RaftNodeOptions shape is exported for embedders", () => {
    const opts: RaftNodeOptions = {
      nodeId: "a",
      peers: ["b"],
      secret: SECRET,
      log: new InMemoryRaftLog(),
    };
    expect(opts.nodeId).toBe("a");
  });
});
