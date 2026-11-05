/**
 * Phase 2 Raft: leader election + log consistency, on top of phase 1
 * replication (docs/roadmap-14/replication.md).
 *
 * What this is: a library-only Raft implementation over the shared
 * change log (docs/roadmap-14/shared-change-log.md). One leader per
 * term is elected by majority vote; the leader's log is authoritative
 * and followers converge to it; an entry counts as committed once a
 * majority holds it. A phase-1 replica NEVER self-promotes: it becomes
 * leader only by winning an election, and a node with no quorum
 * configuration never claims leadership at all.
 *
 * What this is not: it does not copy raw database rows (the log still
 * holds only events recorded with recordOutbox()), it does not shard,
 * and it does not run multiple Raft groups. One group, one log file's
 * worth of entries at a time (see RaftLog). Cross-file ordering does
 * not exist here, exactly as in the shared change log.
 *
 * Cost when not configured: zero. Nothing here runs, listens, polls,
 * or schedules a timer unless the caller constructs a RaftNode from an
 * explicit config and calls start(). No framework entry point imports
 * this module (proved by a test that greps the entry points). No
 * background loop runs unless start() is called, and stop() clears
 * every timer. Raft is pure logic plus SQLite durable state; there is
 * no new native dependency and no sidecar.
 *
 * Auth: Raft RPCs reuse phase-1 node tokens (HMAC-SHA256 over the
 * shared secret, see ./replication). A node without the secret gets
 * refused votes and refused AppendEntries, and learns nothing. An
 * AppendEntries message additionally carries an HMAC over its own
 * canonical body with a Raft-only domain string, so a phase-1 batch
 * signature can never be replayed as a Raft message or vice versa.
 * Secrets and tokens are never logged and never appear in errors.
 *
 * Durable state: currentTerm and votedFor live in the node's own
 * database file (table _yatta_raft_state, one row), never in memory
 * only. A restarted node that forgot its vote could vote twice in one
 * term and break election safety, so every vote and every term change
 * is written through before the node acts on it. The commit index is
 * persisted in the same row, because the truncation guard (never
 * truncate at or below the commit index) must survive a restart too.
 * The log entries themselves are NOT duplicated here: entry payloads
 * live in the shared change log (the leader's _yatta_outbox, the
 * follower's _yatta_replicated_log from phase 1). This module stores
 * only a term annotation per log position (table _yatta_raft_terms),
 * which is what the up-to-date vote rule needs and what the change
 * log itself does not record.
 *
 * Single-node clusters: a node configured with no peers AND
 * singleNode: true elects itself on start(). That is the dev/test
 * mode, and it is explicit: a node with no peers and without
 * singleNode refuses to start an election, because a node without
 * quorum configuration must never claim leadership.
 */

import { randomInt } from "node:crypto";

import {
  canonicalJson,
  createNodeToken,
  REPLICATION_CHECKPOINT_TABLE,
  REPLICATION_LOG_TABLE,
  validateReplicatedEntry,
  verifyNodeToken,
} from "./replication";
import { createHmac, timingSafeEqual } from "node:crypto";
import { recordOutbox, type OutboxStore } from "./outbox";

/** Thrown for every Raft failure. Messages never contain secrets. */
export class RaftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaftError";
  }
}

/** Follower: holds a log, votes, never writes as leader. Candidate: running for election. Leader: serves writes. */
export type RaftRole = "follower" | "candidate" | "leader";

/** One log position, as Raft sees it: the change-log entry plus its Raft term. */
export interface RaftLogEntry {
  /** Position in the log. The only ordering key, same as the change log's seq. */
  seq: number;
  /** Raft term that produced this entry. 0 for pre-Raft entries that carry no term. */
  term: number;
  /** Stable identity of the event (the change log's event_id). The dedupe key. */
  eventId: string;
  eventType: string;
  payload: unknown;
  occurredAt: number;
  createdAt: number;
}

/**
 * Minimal log surface a RaftNode needs. The in-memory implementation
 * is the test fake and the embeddable default; ChangeLogRaftLog adapts
 * the phase-1 replicated log for real nodes. Either way the safety
 * rules live in RaftNode, and this interface carries no policy of its
 * own except one: truncateFrom() refuses to truncate at or below the
 * commit index, in every implementation, so a buggy caller cannot
 * silently rewrite committed history.
 */
export interface RaftLog {
  /** Highest seq held, or 0 when the log is empty. */
  lastSeq(): number;
  /** Term of the last entry, or 0 when the log is empty. */
  lastTerm(): number;
  /** Term of one entry, or null when this node holds no entry at that seq. */
  termAt(seq: number): number | null;
  /** Entries with seq greater than afterSeq, in seq order, up to limit. */
  entriesAfter(afterSeq: number, limit: number): RaftLogEntry[];
  /** Entry at one seq, or null. */
  entryAt(seq: number): RaftLogEntry | null;
  /**
   * Appends entries that must arrive in strict seq order continuing
   * from lastSeq() (or fill a gap the caller has just truncated to).
   * Idempotent on re-delivery: an entry with the same seq and
   * eventId as one already held is skipped, never duplicated.
   */
  append(entries: RaftLogEntry[]): { appended: number; skipped: number };
  /** Deletes this seq and everything after it. Throws at or below the commit index. */
  truncateFrom(seq: number): void;
  /** Highest committed seq. Entries at or below it are never truncated. */
  commitIndex(): number;
  /** Advances the commit index. Never moves backwards. */
  setCommitIndex(seq: number): void;
}

/** In-memory Raft log: the test fake, and usable for embedding without SQLite. */
export class InMemoryRaftLog implements RaftLog {
  private entries: RaftLogEntry[] = [];
  private committed = 0;

  constructor(initial: RaftLogEntry[] = [], commitIndex = 0) {
    const sorted = [...initial].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.seq <= sorted[i - 1]!.seq) {
        throw new RaftError("Raft log entries must be in increasing seq order.");
      }
    }
    this.entries = sorted;
    if (commitIndex > 0) this.setCommitIndex(commitIndex);
  }

  lastSeq(): number {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.seq : 0;
  }

  lastTerm(): number {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.term : 0;
  }

  termAt(seq: number): number | null {
    const found = this.entries.find((e) => e.seq === seq);
    return found ? found.term : null;
  }

  entryAt(seq: number): RaftLogEntry | null {
    return this.entries.find((e) => e.seq === seq) ?? null;
  }

  entriesAfter(afterSeq: number, limit: number): RaftLogEntry[] {
    return this.entries.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  append(entries: RaftLogEntry[]): { appended: number; skipped: number } {
    let appended = 0;
    let skipped = 0;
    for (const entry of entries) {
      const existing = this.entryAt(entry.seq);
      if (existing) {
        if (existing.eventId === entry.eventId && existing.term === entry.term) {
          skipped += 1;
          continue;
        }
        throw new RaftError(
          `Raft log conflict at seq ${entry.seq}: use truncateFrom() before appending a different entry.`,
        );
      }
      if (entry.seq <= this.lastSeq()) {
        throw new RaftError(`Raft log append out of order at seq ${entry.seq}.`);
      }
      this.entries.push({ ...entry });
      appended += 1;
    }
    this.entries.sort((a, b) => a.seq - b.seq);
    return { appended, skipped };
  }

  truncateFrom(seq: number): void {
    if (seq <= this.committed) {
      throw new RaftError(
        `Raft log refuses to truncate at seq ${seq}: it is at or below the commit index ${this.committed}.`,
      );
    }
    this.entries = this.entries.filter((e) => e.seq < seq);
  }

  commitIndex(): number {
    return this.committed;
  }

  setCommitIndex(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) throw new RaftError("Raft commit index must be a non-negative integer.");
    if (seq > this.committed) this.committed = seq;
  }

  /** Test helper: snapshot of held entries, in seq order. */
  snapshot(): RaftLogEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}

export const RAFT_STATE_TABLE = "_yatta_raft_state";
export const RAFT_TERMS_TABLE = "_yatta_raft_terms";

/**
 * Durable Raft state in the node's own database file. One row, id 1:
 * current term, voted-for candidate (null when no vote cast this
 * term), and the commit index. Every mutation is a single upsert, so
 * a crash between the write and the node's next action still leaves
 * the vote/term on disk — which is exactly the point.
 */
export class PersistentRaftState {
  constructor(private readonly store: OutboxStore) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.store.rawRun(`
      CREATE TABLE IF NOT EXISTS "${RAFT_STATE_TABLE}" (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_term INTEGER NOT NULL DEFAULT 0,
        voted_for TEXT,
        commit_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.store.rawRun(`
      CREATE TABLE IF NOT EXISTS "${RAFT_TERMS_TABLE}" (
        seq INTEGER PRIMARY KEY,
        term INTEGER NOT NULL
      );
    `);
  }

  /** { currentTerm, votedFor } — votedFor is null when no vote cast this term. */
  load(): { currentTerm: number; votedFor: string | null; commitSeq: number } {
    this.ensureTables();
    const row = this.store.rawGet<{ current_term: number; voted_for: string | null; commit_seq: number }>(
      `SELECT current_term, voted_for, commit_seq FROM "${RAFT_STATE_TABLE}" WHERE id = 1;`,
    );
    if (!row) return { currentTerm: 0, votedFor: null, commitSeq: 0 };
    return { currentTerm: row.current_term, votedFor: row.voted_for, commitSeq: row.commit_seq };
  }

  /** Persists a term change (and clears the vote when the term advances). */
  saveTerm(term: number, votedFor: string | null): void {
    this.ensureTables();
    this.store.rawRun(
      `INSERT INTO "${RAFT_STATE_TABLE}" (id, current_term, voted_for, commit_seq, updated_at)
       VALUES (1, ?, ?, COALESCE((SELECT commit_seq FROM "${RAFT_STATE_TABLE}" WHERE id = 1), 0), ?)
       ON CONFLICT(id) DO UPDATE SET current_term = excluded.current_term, voted_for = excluded.voted_for, updated_at = excluded.updated_at;`,
      [term, votedFor, Date.now()],
    );
  }

  /** Persists a vote in the current term. */
  saveVote(candidateId: string): void {
    this.ensureTables();
    this.store.rawRun(
      `INSERT INTO "${RAFT_STATE_TABLE}" (id, current_term, voted_for, commit_seq, updated_at)
       VALUES (1, COALESCE((SELECT current_term FROM "${RAFT_STATE_TABLE}" WHERE id = 1), 0), ?, COALESCE((SELECT commit_seq FROM "${RAFT_STATE_TABLE}" WHERE id = 1), 0), ?)
       ON CONFLICT(id) DO UPDATE SET voted_for = excluded.voted_for, updated_at = excluded.updated_at;`,
      [candidateId, Date.now()],
    );
  }

  /** Persists the commit index. Never moves backwards. */
  saveCommit(seq: number): void {
    this.ensureTables();
    this.store.rawRun(
      `INSERT INTO "${RAFT_STATE_TABLE}" (id, current_term, voted_for, commit_seq, updated_at)
       VALUES (1, COALESCE((SELECT current_term FROM "${RAFT_STATE_TABLE}" WHERE id = 1), 0), (SELECT voted_for FROM "${RAFT_STATE_TABLE}" WHERE id = 1), ?, ?)
       ON CONFLICT(id) DO UPDATE SET commit_seq = MAX(commit_seq, excluded.commit_seq), updated_at = excluded.updated_at;`,
      [seq, Date.now()],
    );
  }

  /** Term annotation for one log position. Null when unrecorded (pre-Raft entry). */
  termAt(seq: number): number | null {
    this.ensureTables();
    const row = this.store.rawGet<{ term: number }>(
      `SELECT term FROM "${RAFT_TERMS_TABLE}" WHERE seq = ?;`,
      [seq],
    );
    return row ? row.term : null;
  }

  /** Records the Raft term that produced one log position. */
  saveTermAt(seq: number, term: number): void {
    this.ensureTables();
    this.store.rawRun(
      `INSERT INTO "${RAFT_TERMS_TABLE}" (seq, term) VALUES (?, ?)
       ON CONFLICT(seq) DO UPDATE SET term = excluded.term;`,
      [seq, term],
    );
  }

  /** Drops term annotations at and after seq (used when a suffix is truncated). */
  deleteTermsFrom(seq: number): void {
    this.ensureTables();
    this.store.rawRun(`DELETE FROM "${RAFT_TERMS_TABLE}" WHERE seq >= ?;`, [seq]);
  }
}

// ── RPC shapes ───────────────────────────────────────────────────────────

export interface RequestVoteRequest {
  term: number;
  candidateId: string;
  lastLogSeq: number;
  lastLogTerm: number;
}

export interface RequestVoteResponse {
  term: number;
  voteGranted: boolean;
}

export interface AppendEntriesEntry {
  seq: number;
  term: number;
  eventId: string;
  eventType: string;
  payload: unknown;
  occurredAt: number;
  createdAt: number;
}

export interface AppendEntriesRequest {
  term: number;
  leaderId: string;
  prevLogSeq: number;
  prevLogTerm: number;
  entries: AppendEntriesEntry[];
  leaderCommit: number;
}

export interface AppendEntriesResponse {
  term: number;
  success: boolean;
  /** Follower's last seq, so the leader can back nextIndex up to it on failure. */
  matchSeq: number;
}

/**
 * Minimal transport surface. The HTTP transport and the in-memory
 * test fake both satisfy it. No transport is required to construct a
 * node: without one, sends are no-ops and the node still answers
 * incoming RPCs, which is how unit tests drive handlers directly.
 */
export interface RaftTransport {
  sendRequestVote(peer: string, req: RequestVoteRequest): Promise<RequestVoteResponse>;
  sendAppendEntries(peer: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse>;
}

// ── Message authentication ───────────────────────────────────────────────

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * AppendEntries signature body. The "raft-append-entries:" domain
 * prefix is the point: a phase-1 batch signature covers a different
 * body, so neither signature verifies as the other, and a captured
 * batch can never be replayed as a Raft message. Only the seven
 * named fields are covered: extra wire fields are ignored by the
 * handler, so they cannot affect verification either way.
 */
export function appendEntriesSignBody(body: {
  term: unknown;
  leaderId: unknown;
  prevLogSeq: unknown;
  prevLogTerm: unknown;
  entries: unknown;
  leaderCommit: unknown;
}): string {
  return canonicalJson({
    domain: "raft-append-entries",
    term: body.term,
    leaderId: body.leaderId,
    prevLogSeq: body.prevLogSeq,
    prevLogTerm: body.prevLogTerm,
    entries: body.entries,
    leaderCommit: body.leaderCommit,
  });
}

export function signAppendEntries(secret: string, req: AppendEntriesRequest): string {
  if (!secret) throw new RaftError("Raft secret must not be empty.");
  return hmacHex(secret, appendEntriesSignBody(req));
}

export function verifyAppendEntriesSignature(secret: string, req: AppendEntriesRequest, signature: string): boolean {
  if (!secret || !/^[0-9a-f]{64}$/.test(signature)) return false;
  let expected: string;
  try {
    expected = signAppendEntries(secret, req);
  } catch {
    return false;
  }
  return safeEqualHex(signature, expected);
}

/**
 * Verifies a signature over the RAW wire body (minus the signature
 * field itself), which is what the HTTP handler must do: validation
 * normalizes entries to a subset, and verifying over the normalized
 * subset would reject every legitimately signed message whose wire
 * entries carry the full change-log fields. The signer signs exactly
 * what it sends, so raw-body verification is the consistent check.
 */
export function verifyAppendEntriesSignatureRaw(
  secret: string,
  rawBody: Record<string, unknown>,
  signature: string,
): boolean {
  if (!secret || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const { signature: _ignored, ...body } = rawBody;
  void _ignored;
  let expected: string;
  try {
    expected = hmacHex(secret, appendEntriesSignBody({
      term: body.term,
      leaderId: body.leaderId,
      prevLogSeq: body.prevLogSeq,
      prevLogTerm: body.prevLogTerm,
      entries: body.entries,
      leaderCommit: body.leaderCommit,
    }));
  } catch {
    return false;
  }
  return safeEqualHex(signature, expected);
}

/** Validates one AppendEntries wire entry (shape + term) before anything trusts it. */
export function validateAppendEntriesEntry(value: unknown): AppendEntriesEntry {
  const base = validateReplicatedEntry(value, {});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RaftError("Raft AppendEntries entry must be an object.");
  }
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.term) || (row.term as number) < 0) {
    throw new RaftError("Raft AppendEntries entry term must be a non-negative integer.");
  }
  return {
    seq: base.seq,
    term: row.term as number,
    eventId: base.eventId,
    eventType: base.eventType,
    payload: base.payload,
    occurredAt: base.occurredAt,
    createdAt: base.createdAt,
  };
}

/** Validates an AppendEntries envelope (shape, terms, ordering) before any entry is applied. */
export function validateAppendEntriesRequest(value: unknown): AppendEntriesRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RaftError("Raft AppendEntries request must be an object.");
  }
  const req = value as Record<string, unknown>;
  if (!Number.isInteger(req.term) || (req.term as number) < 0) {
    throw new RaftError("Raft AppendEntries term must be a non-negative integer.");
  }
  if (typeof req.leaderId !== "string" || req.leaderId.length === 0) {
    throw new RaftError("Raft AppendEntries leaderId must be a non-empty string.");
  }
  if (!Number.isInteger(req.prevLogSeq) || (req.prevLogSeq as number) < 0) {
    throw new RaftError("Raft AppendEntries prevLogSeq must be a non-negative integer.");
  }
  if (!Number.isInteger(req.prevLogTerm) || (req.prevLogTerm as number) < 0) {
    throw new RaftError("Raft AppendEntries prevLogTerm must be a non-negative integer.");
  }
  if (!Array.isArray(req.entries) || req.entries.length > 1000) {
    throw new RaftError("Raft AppendEntries entries must be an array of at most 1000 entries.");
  }
  if (!Number.isInteger(req.leaderCommit) || (req.leaderCommit as number) < 0) {
    throw new RaftError("Raft AppendEntries leaderCommit must be a non-negative integer.");
  }
  const entries = req.entries.map((e) => validateAppendEntriesEntry(e));
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i]!.seq <= entries[i - 1]!.seq) {
      throw new RaftError("Raft AppendEntries entries must be in increasing seq order.");
    }
  }
  return {
    term: req.term as number,
    leaderId: req.leaderId as string,
    prevLogSeq: req.prevLogSeq as number,
    prevLogTerm: req.prevLogTerm as number,
    entries,
    leaderCommit: req.leaderCommit as number,
  };
}

// ── Election timing ──────────────────────────────────────────────────────

/** Randomized election timeout in [minMs, maxMs). Bounds are validated: no unbounded or inverted range. */
export function randomizedElectionTimeout(minMs: number, maxMs: number): number {
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 1 || maxMs <= minMs) {
    throw new RaftError("Raft election timeout bounds must be positive integers with max greater than min.");
  }
  return randomInt(minMs, maxMs);
}

// ── Node ─────────────────────────────────────────────────────────────────

export interface RaftNodeOptions {
  /** This node's id. Must not contain a dot (node tokens use dot as separator). */
  nodeId: string;
  /** Ids of the other nodes in the group (not including this node). */
  peers: string[];
  /** Shared secret, from the environment only. Required, always. */
  secret: string;
  /** The log this node holds. Entries' payloads live in the change log; see the header. */
  log: RaftLog;
  /** Durable term/vote/commit store. When omitted, state is memory-only and the node refuses to vote: use PersistentRaftState for any real node. */
  persistentState?: PersistentRaftState;
  /** Transport for outgoing RPCs. Optional: without one the node answers RPCs but sends none. */
  transport?: RaftTransport;
  /** Election timeout window. Defaults 150–300ms. Heartbeat must be below the minimum. */
  electionTimeoutMinMs?: number;
  electionTimeoutMaxMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Single-node dev/test mode. With peers: [] and singleNode: true,
   * start() elects this node immediately. With peers: [] and without
   * this flag, the node never starts an election: no quorum config,
   * no leadership claim. This flag is the quorum config for a
   * one-node group, and it must be explicit.
   */
  singleNode?: boolean;
  /** Clock override, for tests. Defaults to Date.now. */
  now?: () => number;
  /** When false, start() schedules nothing: tests drive timeouts manually. Defaults true. */
  timers?: boolean;
  /** Entries per AppendEntries message. Defaults 100. */
  batchSize?: number;
}

export const RAFT_DEFAULTS = {
  electionTimeoutMinMs: 150,
  electionTimeoutMaxMs: 300,
  heartbeatIntervalMs: 50,
  batchSize: 100,
} as const;

/**
 * One Raft node. All election safety lives here:
 *
 * - One vote per term, persisted before it is granted, so a restart
 *   cannot double-vote (a node without durable state refuses to vote
 *   at all rather than risk it).
 * - A vote only for a candidate whose log is at least as up-to-date
 *   as this node's (higher last term, or equal term and longer log).
 *   That rule plus majority quorum is what guarantees leader
 *   completeness: an elected leader holds every committed entry.
 * - A follower steps down (and a candidate steps down) on seeing a
 *   higher term, and a leader steps down when it can no longer reach
 *   a majority, so a partitioned old leader cannot keep writing.
 * - A follower never truncates at or below its commit index, and a
 *   stale leader's conflicting suffix is truncated only when the
 *   incoming leader's term is current-or-higher and the conflict sits
 *   above the commit index.
 * - A follower never self-promotes: the only path to leader is
 *   startElection() winning a majority (or explicit single-node mode).
 */
export class RaftNode {
  readonly nodeId: string;
  private readonly peers: string[];
  private readonly secret: string;
  private readonly log: RaftLog;
  private readonly persistent: PersistentRaftState | null;
  private transport: RaftTransport | null;
  private readonly electionMin: number;
  private readonly electionMax: number;
  private readonly heartbeatMs: number;
  private readonly singleNode: boolean;
  private readonly useTimers: boolean;
  private readonly batchSize: number;
  private readonly clock: () => number;

  private currentTerm = 0;
  private votedFor: string | null = null;
  private role: RaftRole = "follower";
  private leaderId: string | null = null;
  private votesReceived = new Set<string>();
  private electionDeadline = 0;
  private lastHeartbeatSentAt = 0;
  private lastAckAt = new Map<string, boolean>();
  private lastAckTime = new Map<string, number>();
  private nextIndex = new Map<string, number>();
  private matchIndex = new Map<string, number>();
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: RaftNodeOptions) {
    const nodeId = options.nodeId?.trim();
    if (!nodeId || nodeId.includes(".")) {
      throw new RaftError("Raft node id must be non-empty and contain no dots.");
    }
    if (!options.secret) throw new RaftError("Raft secret must not be empty.");
    if (!options.singleNode && options.peers.length === 0) {
      throw new RaftError(
        "Raft node has no peers and singleNode is not set: without quorum configuration it must never claim leadership.",
      );
    }
    const seen = new Set<string>();
    for (const peer of options.peers) {
      if (!peer || peer.includes(".") || peer === nodeId || seen.has(peer)) {
        throw new RaftError("Raft peer ids must be non-empty, dot-free, unique, and different from this node.");
      }
      seen.add(peer);
    }
    this.nodeId = nodeId;
    this.peers = [...options.peers];
    this.secret = options.secret;
    this.log = options.log;
    this.persistent = options.persistentState ?? null;
    this.transport = options.transport ?? null;
    this.electionMin = options.electionTimeoutMinMs ?? RAFT_DEFAULTS.electionTimeoutMinMs;
    this.electionMax = options.electionTimeoutMaxMs ?? RAFT_DEFAULTS.electionTimeoutMaxMs;
    this.heartbeatMs = options.heartbeatIntervalMs ?? RAFT_DEFAULTS.heartbeatIntervalMs;
    if (this.electionMin < 1 || this.electionMax <= this.electionMin) {
      throw new RaftError("Raft election timeout bounds must be positive integers with max greater than min.");
    }
    if (this.heartbeatMs < 1 || this.heartbeatMs >= this.electionMin) {
      throw new RaftError("Raft heartbeat interval must be positive and below the election timeout minimum.");
    }
    this.singleNode = options.singleNode ?? false;
    this.useTimers = options.timers ?? true;
    this.batchSize = options.batchSize ?? RAFT_DEFAULTS.batchSize;
    this.clock = options.now ?? Date.now;
    // Restore durable state before anything else: a restarted node
    // resumes its term and its vote, never a blank slate.
    if (this.persistent) {
      const saved = this.persistent.load();
      this.currentTerm = saved.currentTerm;
      this.votedFor = saved.votedFor;
      if (saved.commitSeq > 0) this.log.setCommitIndex(saved.commitSeq);
    }
    this.electionDeadline = this.clock() + randomizedElectionTimeout(this.electionMin, this.electionMax);
  }

  /** This node's id. */
  get id(): string {
    return this.nodeId;
  }

  /** Current role. Only "leader" may serve writes. */
  get currentRole(): RaftRole {
    return this.role;
  }

  /** Current term (durable). */
  get term(): number {
    return this.currentTerm;
  }

  /** Id this node voted for this term, or null. */
  get votedForId(): string | null {
    return this.votedFor;
  }

  /** Current leader's id, when known. */
  get currentLeaderId(): string | null {
    return this.leaderId;
  }

  /** Highest committed seq. */
  get commitIndex(): number {
    return this.log.commitIndex();
  }

  /** Number of nodes in the group, including this one. */
  get clusterSize(): number {
    return this.peers.length + 1;
  }

  /** Votes needed to win: floor(size / 2) + 1. */
  get quorum(): number {
    return Math.floor(this.clusterSize / 2) + 1;
  }

  /** Whether the timer loops are running. */
  get running(): boolean {
    return this.started;
  }

  /** Attach or replace the transport (used by test harnesses that wire nodes after construction). */
  setTransport(transport: RaftTransport | null): void {
    this.transport = transport;
  }

  /** Node token for this node, for transports that authenticate RPCs. */
  token(): string {
    return createNodeToken(this.secret, this.nodeId);
  }

  /** Verifies a peer's node token. Returns the peer id, or null. Never throws. */
  verifyToken(token: string): string | null {
    return verifyNodeToken(this.secret, token);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Starts election timing (and, in single-node mode, elects this
   * node at once). No timer runs before start(), and stop() clears
   * every timer. Calling start() twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.singleNode && this.peers.length === 0) {
      this.becomeLeader();
      return;
    }
    this.resetElectionDeadline();
    if (this.useTimers) this.scheduleElectionTimer();
  }

  /** Stops all timers. A scan already in flight finishes; no new RPC is started. */
  stop(): void {
    this.started = false;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.electionTimer !== null) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleElectionTimer(): void {
    if (!this.started || !this.useTimers) return;
    if (this.electionTimer !== null) clearTimeout(this.electionTimer);
    const delay = Math.max(0, this.electionDeadline - this.clock());
    this.electionTimer = setTimeout(() => {
      this.electionTimer = null;
      void this.onElectionTimeout();
    }, delay);
  }

  private scheduleHeartbeatTimer(): void {
    if (!this.started || !this.useTimers || this.role !== "leader") return;
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.sendHeartbeats().then(() => {
        if (this.role === "leader") this.scheduleHeartbeatTimer();
      });
    }, this.heartbeatMs);
  }

  private resetElectionDeadline(): void {
    this.electionDeadline = this.clock() + randomizedElectionTimeout(this.electionMin, this.electionMax);
    if (this.useTimers && this.started && this.role !== "leader") this.scheduleElectionTimer();
  }

  // ── Elections ────────────────────────────────────────────────────────

  /**
   * Fires when the election deadline passes. Leaders do not time out
   * (they check quorum instead); followers and candidates start an
   * election. Tests call this directly with a controlled clock.
   */
  async onElectionTimeout(): Promise<void> {
    if (!this.started) return;
    if (this.role === "leader") {
      this.checkLeaderQuorum();
      return;
    }
    await this.startElection();
  }

  /** Test/manual hook: act as if the election deadline just passed. */
  async triggerElectionTimeout(): Promise<void> {
    await this.onElectionTimeout();
  }

  /**
   * Starts an election: term +1 (persisted), vote for self (persisted),
   * RequestVote to every peer. A node without durable state votes for
   * itself in memory but the election is still safe: the danger is a
   * restart double-voting for someone else, and a self-vote after a
   * restart just restarts the term — but see handleRequestVote, which
   * refuses to grant votes without durable state at all.
   */
  async startElection(): Promise<void> {
    if (this.role === "leader") return;
    this.currentTerm += 1;
    this.votedFor = this.nodeId;
    this.persistTermAndVote();
    this.role = "candidate";
    this.leaderId = null;
    this.votesReceived = new Set([this.nodeId]);
    this.resetElectionDeadline();
    if (this.votesReceived.size >= this.quorum) {
      this.becomeLeader();
      return;
    }
    const req: RequestVoteRequest = {
      term: this.currentTerm,
      candidateId: this.nodeId,
      lastLogSeq: this.log.lastSeq(),
      lastLogTerm: this.log.lastTerm(),
    };
    if (this.transport) {
      const sends = this.peers.map(async (peer) => {
        try {
          const res = await this.transport!.sendRequestVote(peer, req);
          this.receiveVote(peer, res);
        } catch {
          // A peer that cannot be reached simply does not vote. Its
          // silence counts against quorum, never for it.
        }
      });
      await Promise.all(sends);
    }
  }

  private receiveVote(peer: string, res: RequestVoteResponse): void {
    if (this.role !== "candidate") return;
    if (res.term > this.currentTerm) {
      this.stepDown(res.term);
      return;
    }
    if (res.term < this.currentTerm) return; // Stale reply from an old term: ignore.
    if (res.voteGranted) {
      this.votesReceived.add(peer);
      if (this.votesReceived.size >= this.quorum) this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    this.role = "leader";
    this.leaderId = this.nodeId;
    this.votesReceived = new Set();
    const last = this.log.lastSeq();
    for (const peer of this.peers) {
      this.nextIndex.set(peer, last + 1);
      this.matchIndex.set(peer, 0);
      this.lastAckTime.set(peer, this.clock());
    }
    this.lastHeartbeatSentAt = this.clock();
    this.clearTimers();
    if (this.useTimers && this.started) this.scheduleHeartbeatTimer();
  }

  /**
   * Steps down to follower. A higher term always steps a node down
   * and clears its vote for the new term (persisted before any new
   * vote can be granted). Called with the current term for a
   * quorum-loss step-down, which keeps the term.
   */
  stepDown(newTerm?: number): void {
    if (newTerm !== undefined && newTerm > this.currentTerm) {
      this.currentTerm = newTerm;
      this.votedFor = null;
      this.persistTermAndVote();
    }
    this.role = "follower";
    this.leaderId = null;
    this.votesReceived = new Set();
    this.nextIndex.clear();
    this.matchIndex.clear();
    this.resetElectionDeadline();
    if (this.useTimers && this.started) this.scheduleElectionTimer();
  }

  private persistTermAndVote(): void {
    this.persistent?.saveTerm(this.currentTerm, this.votedFor);
  }

  private persistVote(): void {
    this.persistent?.saveVote(this.votedFor!);
  }

  // ── RequestVote handling ─────────────────────────────────────────────

  /**
   * Answers a RequestVote RPC. The caller (transport) authenticates
   * the sender first; a request without a valid token must never reach
   * here. Rules, in order:
   * 1. Stale term: refuse, and report the current term so the
   *    candidate learns it is behind.
   * 2. Higher term: step down to it (vote cleared, persisted), then judge.
   * 3. One vote per term: refuse when already voted for someone else.
   * 4. Up-to-date check: refuse a candidate whose log is behind.
   * 5. No durable state, no vote: a node that cannot persist its vote
   *    must not grant one, or a restart could double-vote.
   * Granting a vote resets the election deadline, so a live candidate
   * is not immediately challenged by its own voter.
   */
  handleRequestVote(req: RequestVoteRequest): RequestVoteResponse {
    if (!Number.isInteger(req.term) || req.term < 0) {
      throw new RaftError("Raft RequestVote term must be a non-negative integer.");
    }
    if (req.term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }
    if (req.term > this.currentTerm) {
      this.stepDown(req.term);
    }
    if (this.votedFor !== null && this.votedFor !== req.candidateId) {
      return { term: this.currentTerm, voteGranted: false };
    }
    const upToDate =
      req.lastLogTerm > this.log.lastTerm() ||
      (req.lastLogTerm === this.log.lastTerm() && req.lastLogSeq >= this.log.lastSeq());
    if (!upToDate) {
      return { term: this.currentTerm, voteGranted: false };
    }
    if (!this.persistent) {
      // Fail closed: granting a vote this node cannot remember across
      // a restart risks a double vote in the same term.
      return { term: this.currentTerm, voteGranted: false };
    }
    this.votedFor = req.candidateId;
    this.persistVote();
    this.resetElectionDeadline();
    return { term: this.currentTerm, voteGranted: true };
  }

  // ── AppendEntries handling ───────────────────────────────────────────

  /**
   * Answers an AppendEntries RPC (heartbeat when entries is empty).
   * Rules, in order:
   * 1. Stale term: refuse. A stale leader's writes never land.
   * 2. Higher term: step down to it, then judge as a follower.
   * 3. Same term, and this node is a candidate or leader: step down.
   *    Election safety says one leader per term; seeing a legitimate
   *    leader for this term means this node lost (or never won).
   * 4. Log consistency: prevLogSeq/prevLogTerm must match this node's
   *    log, or the leader learns where to back up to (matchSeq).
   * 5. Conflicts above the commit index are truncated and replaced;
   *    a conflict at or below the commit index is refused outright —
   *    committed history is never rewritten, not even by a leader.
   * 6. Commit advances to min(leaderCommit, lastSeq).
   * Accepting any AppendEntries from the current leader resets the
   * election deadline: a live leader suppresses elections.
   */
  handleAppendEntries(req: AppendEntriesRequest): AppendEntriesResponse {
    if (req.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
    }
    if (req.term > this.currentTerm) {
      this.stepDown(req.term);
    } else if (this.role !== "follower") {
      // A leader or candidate for this term seeing another leader for
      // the same term steps down: one leader per term, defensively
      // resolved in favour of the node already sending AppendEntries.
      this.stepDown();
    }
    this.leaderId = req.leaderId;
    // Log consistency check: the entry just before the new ones must
    // be one this node holds, at the same term. Seq 0 is the empty
    // prefix every log shares, so it always matches.
    if (req.prevLogSeq > 0) {
      const prevTerm = this.log.termAt(req.prevLogSeq);
      if (prevTerm === null || prevTerm !== req.prevLogTerm) {
        return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
      }
    }
    // Pre-validate the whole message BEFORE mutating anything, so a
    // message that fails late (a gap, or a conflict at/below the
    // commit index) cannot leave a half-truncated log behind. An
    // earlier version truncated during the scan and could return
    // failure after already dropping a suffix; the follower would
    // still converge on retry, but a refused message must not mutate.
    for (let i = 0; i < req.entries.length; i += 1) {
      const e = req.entries[i]!;
      if (e.seq !== req.prevLogSeq + 1 + i) {
        return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
      }
      const existing = this.log.entryAt(e.seq);
      if (existing && (existing.eventId !== e.eventId || existing.term !== e.term)) {
        if (e.seq <= this.log.commitIndex()) {
          return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
        }
      }
    }
    // Apply entries in order. A conflicting entry (same seq, different
    // event) truncates the suffix from that seq — the pre-scan above
    // already proved every conflict sits above the commit index, so
    // no truncation here can touch committed history.
    let firstConflict: number | null = null;
    for (const e of req.entries) {
      const existing = this.log.entryAt(e.seq);
      if (existing) {
        if (existing.eventId === e.eventId && existing.term === e.term) {
          continue; // Idempotent re-delivery: skip, never duplicate.
        }
        if (firstConflict === null) firstConflict = e.seq;
      }
    }
    if (firstConflict !== null) {
      try {
        this.log.truncateFrom(firstConflict);
      } catch {
        return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
      }
    }
    const toAppend = req.entries.filter((e) => this.log.entryAt(e.seq) === null);
    if (toAppend.length > 0) {
      try {
        this.log.append(
          toAppend.map((e) => ({
            seq: e.seq,
            term: e.term,
            eventId: e.eventId,
            eventType: e.eventType,
            payload: e.payload,
            occurredAt: e.occurredAt,
            createdAt: e.createdAt,
          })),
        );
      } catch {
        return { term: this.currentTerm, success: false, matchSeq: this.log.lastSeq() };
      }
    }
    if (req.leaderCommit > this.log.commitIndex()) {
      const nextCommit = Math.min(req.leaderCommit, this.log.lastSeq());
      this.log.setCommitIndex(nextCommit);
      this.persistent?.saveCommit(nextCommit);
    }
    this.resetElectionDeadline();
    return { term: this.currentTerm, success: true, matchSeq: this.log.lastSeq() };
  }

  // ── Leader duties ────────────────────────────────────────────────────

  /**
   * Sends AppendEntries to one peer: the entries it is missing, or an
   * empty heartbeat when it is caught up. On a higher term in the
   * reply the leader steps down at once. On a log-mismatch failure the
   * leader backs nextIndex up (to the follower's last seq + 1, or one
   * less than before, whichever is lower but never below 1) and the
   * next sync retries from there.
   */
  async syncPeer(peer: string): Promise<AppendEntriesResponse | null> {
    if (this.role !== "leader" || !this.transport) return null;
    const next = this.nextIndex.get(peer) ?? this.log.lastSeq() + 1;
    const prevSeq = next - 1;
    const prevTerm = prevSeq > 0 ? (this.log.termAt(prevSeq) ?? 0) : 0;
    const entries = this.log.entriesAfter(prevSeq, this.batchSize).map((e) => ({
      seq: e.seq,
      term: e.term,
      eventId: e.eventId,
      eventType: e.eventType,
      payload: e.payload,
      occurredAt: e.occurredAt,
      createdAt: e.createdAt,
    }));
    const req: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.nodeId,
      prevLogSeq: prevSeq,
      prevLogTerm: prevTerm,
      entries,
      leaderCommit: this.log.commitIndex(),
    };
    let res: AppendEntriesResponse;
    try {
      res = await this.transport.sendAppendEntries(peer, req);
    } catch {
      return null; // Unreachable peer: silence counts against quorum, never for it.
    }
    if (res.term > this.currentTerm) {
      this.stepDown(res.term);
      return res;
    }
    if (this.role !== "leader") return res;
    if (res.success) {
      this.matchIndex.set(peer, res.matchSeq);
      this.nextIndex.set(peer, res.matchSeq + 1);
      this.lastAckTime.set(peer, this.clock());
      this.tryAdvanceCommit();
    } else {
      const backed = Math.max(1, Math.min(next - 1, res.matchSeq + 1));
      this.nextIndex.set(peer, backed);
    }
    return res;
  }

  /** One heartbeat/AppendEntries round to every peer. Returns per-peer results. */
  async sendHeartbeats(): Promise<Record<string, AppendEntriesResponse | null>> {
    const results: Record<string, AppendEntriesResponse | null> = {};
    if (this.role !== "leader") return results;
    this.lastHeartbeatSentAt = this.clock();
    for (const peer of this.peers) {
      results[peer] = await this.syncPeer(peer);
      if (this.role !== "leader") break; // Stepped down mid-round: stop sending as leader.
    }
    this.checkLeaderQuorum();
    return results;
  }

  /**
   * Leader quorum check: a leader that cannot reach a majority
   * (itself plus peers that acked within one election timeout) steps
   * down, so a partitioned leader stops claiming leadership instead
   * of serving split-brain writes. A single-node leader trivially
   * holds quorum (it is the majority). Tests call this directly.
   */
  checkLeaderQuorum(now = this.clock()): boolean {
    if (this.role !== "leader") return false;
    if (this.peers.length === 0) return true;
    let acked = 1; // The leader counts itself.
    for (const peer of this.peers) {
      const at = this.lastAckTime.get(peer);
      if (at !== undefined && now - at <= this.electionMax) acked += 1;
    }
    if (acked < this.quorum) {
      this.stepDown();
      return false;
    }
    return true;
  }

  /**
   * Advances the commit index on the leader: N commits when a majority
   * holds an entry at N or beyond AND that entry is from this leader's
   * current term. Entries from older terms commit only indirectly,
   * when a current-term entry commits above them — the standard Raft
   * rule that keeps a stale leader from committing by counting.
   */
  tryAdvanceCommit(): void {
    if (this.role !== "leader") return;
    const last = this.log.lastSeq();
    for (let n = last; n > this.log.commitIndex(); n -= 1) {
      const entry = this.log.entryAt(n);
      if (!entry || entry.term !== this.currentTerm) continue;
      let holders = 1; // The leader holds its own log.
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= n) holders += 1;
      }
      if (holders >= this.quorum) {
        this.log.setCommitIndex(n);
        this.persistent?.saveCommit(n);
        return;
      }
    }
  }

  /**
   * Leader appends a new entry to its own log at the current term.
   * Only a leader may call this; anything else throws. The caller
   * records the change in the change log first (recordOutbox) and
   * passes the entry here so its Raft term is attached and it is
   * replicated; followers receive it through AppendEntries. Returns
   * the seq the entry holds. Commit still needs a majority ack via
   * syncPeer/sendHeartbeats — append alone never commits.
   */
  appendAsLeader(entry: Omit<RaftLogEntry, "seq" | "term"> & { seq?: number }): RaftLogEntry {
    if (this.role !== "leader") {
      throw new RaftError("Only a leader may append entries: this node is not the leader.");
    }
    const seq = entry.seq ?? this.log.lastSeq() + 1;
    const full: RaftLogEntry = {
      seq,
      term: this.currentTerm,
      eventId: entry.eventId,
      eventType: entry.eventType,
      payload: entry.payload,
      occurredAt: entry.occurredAt,
      createdAt: entry.createdAt,
    };
    this.log.append([full]);
    return full;
  }
}

// ── In-memory transport (tests + embedding without HTTP) ───────────────

/**
 * Routes RPCs directly to other RaftNodes in the same process. Each
 * message carries the sender's node token, and the receiver verifies
 * it before handling — the same auth check the HTTP handler performs,
 * so a test that bypasses the token cannot accidentally prove a
 * property the real transport would not have. Partitions are
 * simulated by listing peer ids in `partitioned`: messages to them
 * are dropped (the promise rejects, exactly like an unreachable peer).
 */
export class InMemoryRaftTransport implements RaftTransport {
  private readonly nodes = new Map<string, RaftNode>();
  readonly partitioned = new Set<string>();

  constructor(
    private readonly selfId: string,
    private readonly secret: string,
  ) {}

  /** Registers a node as reachable. Call for every node in the test cluster. */
  addNode(node: RaftNode): void {
    this.nodes.set(node.nodeId, node);
  }

  /** Drops (rejects) messages to this peer until unpartition() is called. */
  partition(peer: string): void {
    this.partitioned.add(peer);
  }

  unpartition(peer: string): void {
    this.partitioned.delete(peer);
  }

  private target(peer: string): RaftNode {
    const node = this.nodes.get(peer);
    if (!node || this.partitioned.has(peer)) {
      throw new RaftError(`Raft peer "${peer}" is unreachable.`);
    }
    return node;
  }

  private token(): string {
    return createNodeToken(this.secret, this.selfId);
  }

  async sendRequestVote(peer: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
    const node = this.target(peer);
    const sender = node.verifyToken(this.token());
    if (sender !== this.selfId) return { term: node.term, voteGranted: false };
    return node.handleRequestVote(req);
  }

  async sendAppendEntries(peer: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    const node = this.target(peer);
    const sender = node.verifyToken(this.token());
    if (sender !== this.selfId) return { term: node.term, success: false, matchSeq: 0 };
    return node.handleAppendEntries(req);
  }
}

// ── HTTP transport + handler (phase-1 pattern) ─────────────────────────

/**
 * Raft RPCs over HTTP. The token is a node token from
 * createNodeToken(), sent as a Bearer token. AppendEntries bodies
 * additionally carry an HMAC signature (see signAppendEntries) that
 * the handler verifies before any entry is applied. RequestVote
 * relies on the token plus the term and one-vote rules: replaying an
 * old vote request in the same term hits the already-voted check,
 * and in a newer term it is stale.
 */
export function createHttpRaftTransport(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): RaftTransport {
  const base = baseUrl.replace(/\/$/, "");
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    throw new RaftError("Raft peer URL must start with http:// or https://.");
  }
  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RaftError(`Raft RPC failed with HTTP ${res.status}.`);
    return res.json() as Promise<unknown>;
  }
  return {
    async sendRequestVote(_peer: string, req: RequestVoteRequest): Promise<RequestVoteResponse> {
      const body = (await post("/_yatta/raft/request-vote", req)) as Record<string, unknown>;
      if (!Number.isInteger(body.term) || typeof body.voteGranted !== "boolean") {
        throw new RaftError("Raft RequestVote reply was malformed.");
      }
      return { term: body.term as number, voteGranted: body.voteGranted as boolean };
    },
    async sendAppendEntries(_peer: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
      // The transport does not know the secret, so it cannot sign.
      // Signing happens in createSignedHttpRaftTransport; this
      // unsigned path exists for transports that authenticate by
      // token alone and is rejected by the signed handler. Prefer
      // createSignedHttpRaftTransport for real peers.
      const body = (await post("/_yatta/raft/append-entries", req)) as Record<string, unknown>;
      if (!Number.isInteger(body.term) || typeof body.success !== "boolean" || !Number.isInteger(body.matchSeq)) {
        throw new RaftError("Raft AppendEntries reply was malformed.");
      }
      return { term: body.term as number, success: body.success as boolean, matchSeq: body.matchSeq as number };
    },
  };
}

/**
 * HTTP transport that signs every AppendEntries message with the
 * shared secret. Use this one for real peers; the handler below
 * verifies the signature before applying anything.
 */
export function createSignedHttpRaftTransport(
  baseUrl: string,
  token: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): RaftTransport {
  const unsigned = createHttpRaftTransport(baseUrl, token, fetchFn);
  const base = baseUrl.replace(/\/$/, "");
  return {
    sendRequestVote: (peer, req) => unsigned.sendRequestVote(peer, req),
    async sendAppendEntries(_peer: string, req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
      const signature = signAppendEntries(secret, req);
      const res = await fetchFn(`${base}/_yatta/raft/append-entries`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...req, signature }),
      });
      if (!res.ok) throw new RaftError(`Raft RPC failed with HTTP ${res.status}.`);
      const body = (await res.json()) as Record<string, unknown>;
      if (!Number.isInteger(body.term) || typeof body.success !== "boolean" || !Number.isInteger(body.matchSeq)) {
        throw new RaftError("Raft AppendEntries reply was malformed.");
      }
      return { term: body.term as number, success: body.success as boolean, matchSeq: body.matchSeq as number };
    },
  };
}

/**
 * HTTP handler for one Raft node, shaped for Bun.serve's fetch option.
 * Auth failures return 401 with no data; malformed bodies return 400;
 * a bad AppendEntries signature returns 401 and applies nothing.
 * The handler verifies the token before delegating, so handlers never
 * see unauthenticated RPCs.
 */
export function createRaftHttpHandler(
  node: RaftNode,
  secret: string,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (req.method !== "POST") return new Response("Method not allowed.", { status: 405 });
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const sender = node.verifyToken(token);
      if (sender === null || sender === node.nodeId) {
        return new Response("Unauthorized.", { status: 401 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("Bad request.", { status: 400 });
      }
      if (url.pathname === "/_yatta/raft/request-vote") {
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return new Response("Bad request.", { status: 400 });
        }
        const reqBody = body as Record<string, unknown>;
        if (
          !Number.isInteger(reqBody.term) || typeof reqBody.candidateId !== "string" ||
          !Number.isInteger(reqBody.lastLogSeq) || !Number.isInteger(reqBody.lastLogTerm)
        ) {
          return new Response("Bad request.", { status: 400 });
        }
        const res = node.handleRequestVote({
          term: reqBody.term as number,
          candidateId: reqBody.candidateId as string,
          lastLogSeq: reqBody.lastLogSeq as number,
          lastLogTerm: reqBody.lastLogTerm as number,
        });
        return Response.json(res);
      }
      if (url.pathname === "/_yatta/raft/append-entries") {
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return new Response("Bad request.", { status: 400 });
        }
        const reqBody = body as Record<string, unknown>;
        const signature = reqBody.signature;
        if (typeof signature !== "string") return new Response("Unauthorized.", { status: 401 });
        let appendReq: AppendEntriesRequest;
        try {
          appendReq = validateAppendEntriesRequest(reqBody);
        } catch {
          return new Response("Bad request.", { status: 400 });
        }
        // Verify over the raw wire body, not the normalized subset:
        // validation drops the full change-log fields the signer
        // covered, and verifying over the subset would reject every
        // legitimately signed message. See verifyAppendEntriesSignatureRaw.
        if (!verifyAppendEntriesSignatureRaw(secret, reqBody, signature)) {
          return new Response("Unauthorized.", { status: 401 });
        }
        const res = node.handleAppendEntries(appendReq);
        return Response.json(res);
      }
      return new Response("Not found.", { status: 404 });
    } catch {
      return new Response("Raft error.", { status: 500 });
    }
  };
}

// ── Change-log log adapter (real nodes) ────────────────────────────────

/**
 * Raft log view over a node's phase-1 replicated log
 * (_yatta_replicated_log, written by ReplicationApplier) plus the
 * _yatta_raft_terms sidecar. Entry payloads are never copied anywhere
 * new: this adapter reads the table phase 1 already maintains, and
 * the leader's own originated entries reach it the same way a
 * replica's do — through the applier's insert shape, via
 * appendOriginated(). A node that wins an election keeps using this
 * same log; there is no second log to reconcile.
 *
 * Honest limits: seq gaps in the replicated log (legal in the change
 * log contract) mean lastSeq() is the highest held seq, and entries
 * are addressed by seq, never by position. A follower that has never
 * replicated anything has an empty log and votes accordingly.
 */
export class ChangeLogRaftLog implements RaftLog {
  private readonly persistent: PersistentRaftState;

  constructor(
    private readonly store: OutboxStore,
    private readonly source = "app",
    private readonly file = "app",
  ) {
    this.persistent = new PersistentRaftState(store);
    this.ensureTables();
  }

  private ensureTables(): void {
    this.store.rawRun(`
      CREATE TABLE IF NOT EXISTS "${REPLICATION_LOG_TABLE}" (
        source TEXT NOT NULL,
        file TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        aggregate_type TEXT,
        aggregate_id TEXT,
        payload TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (source, file, seq),
        UNIQUE (source, file, event_id)
      );
    `);
    this.store.rawRun(`
      CREATE TABLE IF NOT EXISTS "${REPLICATION_CHECKPOINT_TABLE}" (
        source TEXT NOT NULL,
        file TEXT NOT NULL,
        checkpoint_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, file)
      );
    `);
  }

  private rowsAfter(afterSeq: number, limit: number): any[] {
    this.ensureTables();
    return this.store.rawAll<any>(
      `SELECT seq, event_id, event_type, payload, occurred_at, created_at
       FROM "${REPLICATION_LOG_TABLE}"
       WHERE source = ? AND file = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?;`,
      [this.source, this.file, afterSeq, Math.floor(limit)],
    );
  }

  private rowAt(seq: number): any | null {
    this.ensureTables();
    return this.store.rawGet<any>(
      `SELECT seq, event_id, event_type, payload, occurred_at, created_at
       FROM "${REPLICATION_LOG_TABLE}"
       WHERE source = ? AND file = ? AND seq = ?;`,
      [this.source, this.file, seq],
    );
  }

  private toEntry(row: any): RaftLogEntry {
    return {
      seq: row.seq,
      term: this.persistent.termAt(row.seq) ?? 0,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload),
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    };
  }

  lastSeq(): number {
    this.ensureTables();
    const row = this.store.rawGet<{ maxSeq: number | null }>(
      `SELECT MAX(seq) as maxSeq FROM "${REPLICATION_LOG_TABLE}" WHERE source = ? AND file = ?;`,
      [this.source, this.file],
    );
    return row?.maxSeq ?? 0;
  }

  lastTerm(): number {
    const last = this.lastSeq();
    if (last === 0) return 0;
    return this.termAt(last) ?? 0;
  }

  termAt(seq: number): number | null {
    const row = this.rowAt(seq);
    if (!row) return null;
    return this.persistent.termAt(seq) ?? 0;
  }

  entryAt(seq: number): RaftLogEntry | null {
    const row = this.rowAt(seq);
    return row ? this.toEntry(row) : null;
  }

  entriesAfter(afterSeq: number, limit: number): RaftLogEntry[] {
    return this.rowsAfter(afterSeq, limit).map((row) => this.toEntry(row));
  }

  append(entries: RaftLogEntry[]): { appended: number; skipped: number } {
    this.ensureTables();
    let appended = 0;
    let skipped = 0;
    for (const entry of entries) {
      const existing = this.rowAt(entry.seq);
      if (existing) {
        if (existing.event_id === entry.eventId) {
          skipped += 1;
          continue;
        }
        throw new RaftError(
          `Raft log conflict at seq ${entry.seq}: use truncateFrom() before appending a different entry.`,
        );
      }
      this.store.rawRun(
        `INSERT INTO "${REPLICATION_LOG_TABLE}"
           (source, file, seq, event_id, event_type, aggregate_type, aggregate_id,
            payload, occurred_at, created_at, status)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'pending');`,
        [
          this.source,
          this.file,
          entry.seq,
          entry.eventId,
          entry.eventType,
          JSON.stringify(entry.payload),
          entry.occurredAt,
          entry.createdAt,
        ],
      );
      this.persistent.saveTermAt(entry.seq, entry.term);
      this.store.rawRun(
        `INSERT INTO "${REPLICATION_CHECKPOINT_TABLE}" (source, file, checkpoint_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, file) DO UPDATE SET checkpoint_seq = MAX(checkpoint_seq, excluded.checkpoint_seq), updated_at = excluded.updated_at;`,
        [this.source, this.file, entry.seq, Date.now()],
      );
      appended += 1;
    }
    return { appended, skipped };
  }

  /**
   * Leader-originated entry: records it in the change log (outbox)
   * and mirrors it into this Raft log view. The outbox insert is the
   * durable origin; the mirror is what followers converge to. A crash
   * between the two leaves an outbox row with no Raft term, which
   * votes as term 0 — safe direction only (less up-to-date, never
   * more), and the next AppendEntries round re-mirrors it via
   * append() once the leader re-reads its outbox.
   */
  appendOriginated(input: {
    eventType: string;
    eventId?: string;
    payload: unknown;
    term: number;
  }): RaftLogEntry {
    const recorded = recordOutbox(this.store, {
      eventType: input.eventType,
      eventId: input.eventId,
      payload: input.payload,
    });
    const entry: RaftLogEntry = {
      seq: recorded.seq,
      term: input.term,
      eventId: recorded.eventId,
      eventType: recorded.eventType,
      payload: recorded.payload,
      occurredAt: recorded.occurredAt,
      createdAt: recorded.createdAt,
    };
    this.append([entry]);
    return entry;
  }

  truncateFrom(seq: number): void {
    if (seq <= this.commitIndex()) {
      throw new RaftError(
        `Raft log refuses to truncate at seq ${seq}: it is at or below the commit index ${this.commitIndex()}.`,
      );
    }
    this.ensureTables();
    this.store.rawRun(
      `DELETE FROM "${REPLICATION_LOG_TABLE}" WHERE source = ? AND file = ? AND seq >= ?;`,
      [this.source, this.file, seq],
    );
    this.persistent.deleteTermsFrom(seq);
    this.store.rawRun(
      `INSERT INTO "${REPLICATION_CHECKPOINT_TABLE}" (source, file, checkpoint_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source, file) DO UPDATE SET checkpoint_seq = MIN(checkpoint_seq, ?), updated_at = excluded.updated_at;`,
      [this.source, this.file, seq - 1, Date.now(), seq - 1],
    );
  }

  commitIndex(): number {
    return this.persistent.load().commitSeq;
  }

  setCommitIndex(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) throw new RaftError("Raft commit index must be a non-negative integer.");
    this.persistent.saveCommit(seq);
  }
}

// ── Env config (fail-closed) ─────────────────────────────────────────────

/** Full Raft config, built from code or the environment. */
export interface RaftConfig {
  nodeId: string;
  peers: string[];
  /** Shared secret, from the environment only. Never log this object whole. */
  secret: string;
  singleNode: boolean;
  electionTimeoutMinMs: number;
  electionTimeoutMaxMs: number;
  heartbeatIntervalMs: number;
}

/**
 * Reads Raft config from the environment. Returns null unless
 * YATTA_RAFT_ENABLED is exactly "true": that is the normal
 * unconfigured case, and nothing Raft-related starts. When enabled,
 * the secret and node id are required, and a node with no peers must
 * set YATTA_RAFT_SINGLE_NODE=true explicitly — otherwise it throws
 * instead of ever claiming leadership without quorum config.
 *
 * Variables: YATTA_RAFT_ENABLED (must be "true"), YATTA_RAFT_NODE_ID,
 * YATTA_RAFT_SECRET, YATTA_RAFT_PEERS (comma list),
 * YATTA_RAFT_SINGLE_NODE ("true"), YATTA_RAFT_ELECTION_MIN_MS,
 * YATTA_RAFT_ELECTION_MAX_MS, YATTA_RAFT_HEARTBEAT_MS.
 */
export function raftConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RaftConfig | null {
  if (env.YATTA_RAFT_ENABLED !== "true") return null;
  const secret = env.YATTA_RAFT_SECRET ?? "";
  if (!secret) throw new RaftError("YATTA_RAFT_SECRET is required when Raft is enabled.");
  const nodeId = env.YATTA_RAFT_NODE_ID?.trim() ?? "";
  if (!nodeId) throw new RaftError("YATTA_RAFT_NODE_ID is required when Raft is enabled.");
  const peers = (env.YATTA_RAFT_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const singleNode = env.YATTA_RAFT_SINGLE_NODE === "true";
  if (peers.length === 0 && !singleNode) {
    throw new RaftError(
      "YATTA_RAFT_PEERS is empty and YATTA_RAFT_SINGLE_NODE is not true: a Raft node without quorum config must never claim leadership.",
    );
  }
  const min = Number(env.YATTA_RAFT_ELECTION_MIN_MS ?? "");
  const max = Number(env.YATTA_RAFT_ELECTION_MAX_MS ?? "");
  const heartbeat = Number(env.YATTA_RAFT_HEARTBEAT_MS ?? "");
  return {
    nodeId,
    peers,
    secret,
    singleNode,
    electionTimeoutMinMs: Number.isInteger(min) && min > 0 ? min : RAFT_DEFAULTS.electionTimeoutMinMs,
    electionTimeoutMaxMs: Number.isInteger(max) && max > 0 ? max : RAFT_DEFAULTS.electionTimeoutMaxMs,
    heartbeatIntervalMs: Number.isInteger(heartbeat) && heartbeat > 0 ? heartbeat : RAFT_DEFAULTS.heartbeatIntervalMs,
  };
}
