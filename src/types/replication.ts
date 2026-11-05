/**
 * Phase 1 replication: primary + async read replicas.
 *
 * What this is: the primary answers pull requests from the shared change
 * log (docs/roadmap-14/shared-change-log.md), one log per database file
 * (app, jobs, cache). A replica pulls in seq order, checks the batch
 * signature, and applies entries idempotently by event_id. Writes go to
 * the primary only. There is no leader election here: that is phase 2
 * (Raft), and a replica never promotes itself.
 *
 * What this is not: it does not copy raw database rows. The change log
 * only holds events the app recorded with recordOutbox(), so a replica
 * gets the log plus whatever its own apply handler builds from it
 * (read models, a replicated log table). An app that wants a row on the
 * replica must record that row's change in the outbox. A replica that
 * starts with no checkpoint pulls the whole log from seq 0, so the log
 * is the bootstrap. Never purge published rows above a replica's
 * checkpoint, or that replica's history is silently rewritten.
 *
 * Cost when not configured: zero. Nothing here runs, listens, or polls
 * unless replicationConfigFromEnv() returns a config and the caller
 * starts it. The publisher is a pull model, so the primary keeps no
 * per-replica state and a lying replica cannot corrupt it: the only
 * thing a replica sends is its cursor and its auth token.
 *
 * Auth: one shared secret, from the environment only. Node tokens and
 * batch signatures are HMAC-SHA256 over that secret. A node without the
 * secret cannot join and cannot receive data: the publisher answers
 * unauthenticated pulls with 401 and no entries. Secrets are never
 * logged and never appear in error messages.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  readChangeLog,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox";

/** Thrown for every replication failure. Messages never contain secrets. */
export class ReplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicationError";
  }
}

/** Thrown when code tries to write through a replica's read-only store. */
export class ReplicaWriteError extends Error {
  constructor(message = "This node is a read replica: writes go to the primary only.") {
    super(message);
    this.name = "ReplicaWriteError";
  }
}

/** One database file's log. Built-ins cover the three Yatta files. */
export type ReplicationFile = "app" | "jobs" | "cache" | (string & {});

export type ReplicationRole = "primary" | "replica";

/** One signed batch, as it travels from primary to replica. */
export interface ReplicationBatch {
  /** Primary node id that produced this batch. */
  nodeId: string;
  /** Which log this batch came from, e.g. "app". */
  source: string;
  /** File key, same as source. Kept separate so a future file rename is safe. */
  file: string;
  /** Highest seq the primary holds in this file at pull time. For lag. */
  latestSeq: number;
  /** Entries in strictly increasing seq order. */
  entries: OutboxEntry[];
  /** HMAC-SHA256 hex over the canonical batch body. See signBatch(). */
  signature: string;
}

/** Minimal pull surface. The HTTP transport and test fakes both satisfy it. */
export interface ReplicationTransport {
  pull(file: string, afterSeq: number, limit: number): Promise<ReplicationBatch>;
}

/** Minimal store surface the applier needs, beyond the outbox surface. */
export interface ReplicationStore extends OutboxStore {
  /** Runs a multi-statement script. YattaDB exposes this as exec(). */
  exec?(sql: string): unknown;
}

export const REPLICATION_CHECKPOINT_TABLE = "_yatta_replication_checkpoints";
export const REPLICATION_LOG_TABLE = "_yatta_replicated_log";

/** Default caps. A batch that breaks one is rejected, never half-applied. */
export const REPLICATION_DEFAULTS = {
  batchSize: 100,
  maxBatchEntries: 1000,
  /** Largest single entry payload, in JSON characters. */
  maxPayloadChars: 1_000_000,
  pollIntervalMs: 1000,
} as const;

// ── Canonical JSON + HMAC ────────────────────────────────────────────────

/** Stable JSON: object keys sorted, so signer and verifier agree. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new ReplicationError("Replication value is not JSON-serializable.");
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Compares two hex digests without leaking length or prefix timing. */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Node token: "<nodeId>.<hmac>". The primary verifies it before it
 * sends anything. A stranger without the secret cannot forge one.
 */
export function createNodeToken(secret: string, nodeId: string): string {
  if (!secret) throw new ReplicationError("Replication secret must not be empty.");
  const id = nodeId.trim();
  if (!id || id.includes(".")) {
    throw new ReplicationError("Replication node id must be non-empty and contain no dots.");
  }
  return `${id}.${hmacHex(secret, `node:${id}`)}`;
}

/** Returns the node id when the token checks out, else null. Never throws. */
export function verifyNodeToken(secret: string, token: string): string | null {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const nodeId = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(given)) return null;
  const expected = hmacHex(secret, `node:${nodeId}`);
  return safeEqualHex(given, expected) ? nodeId : null;
}

/** Body covered by a batch signature. The signature itself is excluded. */
export function batchSignBody(batch: Omit<ReplicationBatch, "signature">): string {
  return canonicalJson({
    nodeId: batch.nodeId,
    source: batch.source,
    file: batch.file,
    latestSeq: batch.latestSeq,
    entries: batch.entries,
  });
}

export function signBatch(secret: string, batch: Omit<ReplicationBatch, "signature">): string {
  if (!secret) throw new ReplicationError("Replication secret must not be empty.");
  return hmacHex(secret, batchSignBody(batch));
}

/** True when the batch signature matches the secret. Never throws. */
export function verifyBatchSignature(secret: string, batch: ReplicationBatch): boolean {
  if (!secret || !batch.signature || !/^[0-9a-f]{64}$/.test(batch.signature)) return false;
  let expected: string;
  try {
    expected = signBatch(secret, batch);
  } catch {
    return false;
  }
  return safeEqualHex(batch.signature, expected);
}

// ── Entry validation ─────────────────────────────────────────────────────

/**
 * Checks one entry from the wire before anything trusts it. A
 * compromised or buggy primary must not corrupt a replica with a bad
 * row, and a bad row must fail the batch, not slip into the log.
 */
export function validateReplicatedEntry(
  value: unknown,
  options: { maxPayloadChars?: number } = {},
): OutboxEntry {
  const maxPayloadChars = options.maxPayloadChars ?? REPLICATION_DEFAULTS.maxPayloadChars;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReplicationError("Replication entry must be an object.");
  }
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.seq) || (row.seq as number) <= 0) {
    throw new ReplicationError("Replication entry seq must be a positive integer.");
  }
  if (typeof row.eventId !== "string" || row.eventId.length < 1 || row.eventId.length > 256) {
    throw new ReplicationError("Replication entry eventId must be a non-empty string.");
  }
  if (typeof row.eventType !== "string" || row.eventType.trim().length === 0 || row.eventType.length > 256) {
    throw new ReplicationError("Replication entry eventType must be a non-empty string.");
  }
  for (const field of ["aggregateType", "aggregateId", "dedupeKey"] as const) {
    const v = row[field];
    if (v !== null && v !== undefined && typeof v !== "string") {
      throw new ReplicationError(`Replication entry ${field} must be a string or null.`);
    }
  }
  if (!Number.isFinite(row.occurredAt) || !Number.isFinite(row.createdAt)) {
    throw new ReplicationError("Replication entry timestamps must be finite numbers.");
  }
  if (row.status !== "pending" && row.status !== "published" && row.status !== "dead") {
    throw new ReplicationError("Replication entry status must be pending, published, or dead.");
  }
  if (!Number.isInteger(row.attempts) || (row.attempts as number) < 0) {
    throw new ReplicationError("Replication entry attempts must be a non-negative integer.");
  }
  if (!Number.isFinite(row.nextAttemptAt)) {
    throw new ReplicationError("Replication entry nextAttemptAt must be a finite number.");
  }
  let payloadJson: string;
  try {
    const json = JSON.stringify(row.payload);
    if (json === undefined) throw new Error("unserializable");
    payloadJson = json;
  } catch {
    throw new ReplicationError("Replication entry payload must be JSON-serializable.");
  }
  if (payloadJson.length > maxPayloadChars) {
    throw new ReplicationError("Replication entry payload exceeds the size cap.");
  }
  return {
    seq: row.seq as number,
    eventId: row.eventId as string,
    eventType: row.eventType as string,
    aggregateType: (row.aggregateType as string | null) ?? null,
    aggregateId: (row.aggregateId as string | null) ?? null,
    payload: row.payload,
    occurredAt: row.occurredAt as number,
    dedupeKey: (row.dedupeKey as string | null) ?? null,
    status: row.status as OutboxEntry["status"],
    attempts: row.attempts as number,
    nextAttemptAt: row.nextAttemptAt as number,
    publishedAt: (row.publishedAt as number | null) ?? null,
    lastError: (row.lastError as string | null) ?? null,
    createdAt: row.createdAt as number,
  };
}

/** Checks a whole batch envelope before any entry is applied. */
export function validateBatchEnvelope(value: unknown): ReplicationBatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReplicationError("Replication batch must be an object.");
  }
  const batch = value as Record<string, unknown>;
  if (typeof batch.nodeId !== "string" || batch.nodeId.length === 0) {
    throw new ReplicationError("Replication batch nodeId must be a non-empty string.");
  }
  if (typeof batch.source !== "string" || batch.source.length === 0) {
    throw new ReplicationError("Replication batch source must be a non-empty string.");
  }
  if (typeof batch.file !== "string" || batch.file.length === 0) {
    throw new ReplicationError("Replication batch file must be a non-empty string.");
  }
  if (!Number.isInteger(batch.latestSeq) || (batch.latestSeq as number) < 0) {
    throw new ReplicationError("Replication batch latestSeq must be a non-negative integer.");
  }
  if (!Array.isArray(batch.entries)) {
    throw new ReplicationError("Replication batch entries must be an array.");
  }
  if (typeof batch.signature !== "string" || batch.signature.length === 0) {
    throw new ReplicationError("Replication batch signature must be a non-empty string.");
  }
  return batch as unknown as ReplicationBatch;
}

// ── Primary side: publisher ──────────────────────────────────────────────

export interface ReplicationPublisherOptions {
  /** This primary's node id, announced in every batch. */
  nodeId: string;
  /** Shared secret, from the environment only. */
  secret: string;
  /** When set, only these replica ids may pull. Empty means any valid token. */
  allowedReplicaIds?: string[];
  /** Rows per pull. Defaults to 100. */
  batchSize?: number;
}

/**
 * Primary side. Stateless: it reads the change log and signs batches.
 * It keeps no per-replica state, so a replica that lies about its
 * cursor can only waste its own time, never corrupt the primary.
 * It never marks rows published: replication and the outbox relay are
 * independent readers of the same log.
 */
export class ReplicationPublisher {
  private readonly stores: Map<string, OutboxStore>;
  private readonly nodeId: string;
  private readonly secret: string;
  private readonly allowed: Set<string> | null;
  private readonly batchSize: number;

  constructor(stores: Map<string, OutboxStore> | Record<string, OutboxStore>, options: ReplicationPublisherOptions) {
    if (!options.secret) throw new ReplicationError("Replication secret must not be empty.");
    if (!options.nodeId?.trim()) throw new ReplicationError("Replication node id must be non-empty.");
    this.stores = stores instanceof Map ? stores : new Map(Object.entries(stores));
    if (this.stores.size === 0) throw new ReplicationError("Replication publisher needs at least one database file.");
    this.nodeId = options.nodeId;
    this.secret = options.secret;
    this.allowed = options.allowedReplicaIds && options.allowedReplicaIds.length > 0
      ? new Set(options.allowedReplicaIds)
      : null;
    this.batchSize = options.batchSize ?? REPLICATION_DEFAULTS.batchSize;
  }

  /** Node id announced in batches. */
  get id(): string {
    return this.nodeId;
  }

  /** Files this publisher serves. */
  files(): string[] {
    return [...this.stores.keys()];
  }

  /** Highest seq in one file's log, or 0 when the log is empty. */
  latestSeq(file: string): number {
    const store = this.stores.get(file);
    if (!store) throw new ReplicationError(`Replication publisher has no file named "${file}".`);
    const row = store.rawGet<{ maxSeq: number | null }>(
      `SELECT MAX(seq) as maxSeq FROM "_yatta_outbox";`,
    );
    return row?.maxSeq ?? 0;
  }

  /**
   * Verifies a replica token and its allowlist, then returns a signed
   * batch. Throws on bad auth, unknown file, or a bad cursor, and
   * returns nothing in those cases: no data leaks to strangers.
   */
  pullFor(token: string, file: string, afterSeq: number, limit?: number): ReplicationBatch {
    const replicaId = verifyNodeToken(this.secret, token);
    if (replicaId === null) {
      throw new ReplicationError("Replication pull rejected: invalid node token.");
    }
    if (this.allowed !== null && !this.allowed.has(replicaId)) {
      throw new ReplicationError("Replication pull rejected: replica is not on the allowlist.");
    }
    return this.pull(file, afterSeq, limit);
  }

  /** Signed batch for one file, reading all rows regardless of status. */
  pull(file: string, afterSeq: number, limit?: number): ReplicationBatch {
    const store = this.stores.get(file);
    if (!store) throw new ReplicationError(`Replication publisher has no file named "${file}".`);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new ReplicationError("Replication pull afterSeq must be a non-negative integer.");
    }
    const wanted = limit ?? this.batchSize;
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > REPLICATION_DEFAULTS.maxBatchEntries) {
      throw new ReplicationError("Replication pull limit must be between 1 and 1000.");
    }
    // No status filter, on purpose: a row can replicate before the relay
    // publishes it, and filtering would stall replication behind relay
    // failures. See docs/roadmap-14/shared-change-log.md.
    const entries = readChangeLog(store, { afterSeq, limit: wanted });
    const body = {
      nodeId: this.nodeId,
      source: file,
      file,
      latestSeq: this.latestSeq(file),
      entries,
    };
    return { ...body, signature: signBatch(this.secret, body) };
  }
}

export function createReplicationPublisher(
  stores: Map<string, OutboxStore> | Record<string, OutboxStore>,
  options: ReplicationPublisherOptions,
): ReplicationPublisher {
  return new ReplicationPublisher(stores, options);
}

// ── Replica side: applier ────────────────────────────────────────────────

export interface ReplicationApplierOptions {
  /** Shared secret, from the environment only. Verifies every batch. */
  secret: string;
  /** Expected primary node id. When set, batches from anyone else are rejected. */
  expectedNodeId?: string;
  /** Largest single entry payload, in JSON characters. */
  maxPayloadChars?: number;
  /**
   * Called for each entry, in seq order, BEFORE it is stored. A throwing
   * handler leaves the entry unstored, so the next pull redelivers it and
   * retries the handler. A crash after the handler but before the store
   * redelivers too, so handlers must be idempotent. Once stored, the
   * checkpoint advances per entry, and redelivery of a stored entry is
   * skipped. A handler that needs the entry in the replica log should
   * read it after applyBatch returns, not inside this callback.
   */
  onEntry?: (entry: OutboxEntry, file: string) => void | Promise<void>;
}

/** Result of applying one batch. */
export interface ReplicationApplyResult {
  applied: number;
  skipped: number;
  /** Checkpoint after this batch. Unchanged when the batch was rejected. */
  checkpoint: number;
}

function ensureReplicationTables(store: OutboxStore): void {
  store.rawRun(`
    CREATE TABLE IF NOT EXISTS "${REPLICATION_CHECKPOINT_TABLE}" (
      source TEXT NOT NULL,
      file TEXT NOT NULL,
      checkpoint_seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, file)
    );
  `);
  store.rawRun(`
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
  // Tables created before the status column existed gain it here.
  // The relay status of a replicated row is history, not a queue
  // state: it is stored for inspection, never acted on by the replica.
  const columns = store.rawAll<{ name: string }>(`PRAGMA table_info("${REPLICATION_LOG_TABLE}");`);
  if (!columns.some((c) => c.name === "status")) {
    store.rawRun(`ALTER TABLE "${REPLICATION_LOG_TABLE}" ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';`);
  }
}

/**
 * Replica side. Owns one database file's checkpoint and replicated log.
 *
 * Safety rules, in order:
 * 1. Signature first. An unsigned or mis-signed batch applies nothing.
 * 2. Source and node id must match what this applier expects.
 * 3. Entries must arrive in strictly increasing seq order within the
 *    batch, or the whole batch is rejected. Gaps are fine: the log
 *    contract says a gap means nothing was ever published there.
 * 4. Each entry is applied idempotently: seq at or below the checkpoint
 *    or an already-applied event_id is skipped, never re-applied.
 * 5. The apply handler runs before the entry is stored, and the
 *    checkpoint advances per entry, not per batch. A failing handler
 *    leaves the entry unstored, so the next pull redelivers and
 *    retries it; a crash after storing resumes after it. Redelivery
 *    converges instead of corrupting, as long as handlers are
 *    idempotent.
 */
export class ReplicationApplier {
  private readonly secret: string;
  private readonly expectedNodeId?: string;
  private readonly maxPayloadChars: number;
  private readonly onEntry?: (entry: OutboxEntry, file: string) => void | Promise<void>;

  constructor(
    private readonly store: OutboxStore,
    options: ReplicationApplierOptions,
  ) {
    if (!options.secret) throw new ReplicationError("Replication secret must not be empty.");
    this.secret = options.secret;
    this.expectedNodeId = options.expectedNodeId;
    this.maxPayloadChars = options.maxPayloadChars ?? REPLICATION_DEFAULTS.maxPayloadChars;
    this.onEntry = options.onEntry;
    ensureReplicationTables(store);
  }

  /** Last applied seq for one source/file, or 0 when nothing applied yet. */
  checkpoint(source: string, file: string): number {
    ensureReplicationTables(this.store);
    const row = this.store.rawGet<{ checkpoint_seq: number }>(
      `SELECT checkpoint_seq FROM "${REPLICATION_CHECKPOINT_TABLE}" WHERE source = ? AND file = ?;`,
      [source, file],
    );
    return row?.checkpoint_seq ?? 0;
  }

  /** Whether this event_id is already in this file's replicated log. */
  hasApplied(source: string, file: string, eventId: string): boolean {
    ensureReplicationTables(this.store);
    const row = this.store.rawGet<{ seq: number }>(
      `SELECT seq FROM "${REPLICATION_LOG_TABLE}" WHERE source = ? AND file = ? AND event_id = ?;`,
      [source, file, eventId],
    );
    return row !== null;
  }

  /** Replicated entries for one file, in seq order, for reads and inspection. */
  replicatedEntries(source: string, file: string, afterSeq = 0, limit = 100): OutboxEntry[] {
    ensureReplicationTables(this.store);
    const rows = this.store.rawAll<any>(
      `SELECT seq, event_id, event_type, aggregate_type, aggregate_id, payload,
              occurred_at, created_at, status
       FROM "${REPLICATION_LOG_TABLE}"
       WHERE source = ? AND file = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?;`,
      [source, file, afterSeq, Math.floor(limit)],
    );
    return rows.map((row) => ({
      seq: row.seq,
      eventId: row.event_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type ?? null,
      aggregateId: row.aggregate_id ?? null,
      payload: JSON.parse(row.payload),
      occurredAt: row.occurred_at,
      dedupeKey: null,
      status: (row.status ?? "pending") as OutboxEntry["status"],
      attempts: 0,
      nextAttemptAt: row.occurred_at,
      publishedAt: null,
      lastError: null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Applies one batch. Throws and applies nothing when the signature,
   * source, node id, or in-batch ordering is wrong. Entries already
   * applied are skipped; the rest apply in order.
   */
  async applyBatch(batch: unknown): Promise<ReplicationApplyResult> {
    const envelope = validateBatchEnvelope(batch);
    if (!verifyBatchSignature(this.secret, envelope)) {
      throw new ReplicationError("Replication batch rejected: bad signature.");
    }
    if (this.expectedNodeId !== undefined && envelope.nodeId !== this.expectedNodeId) {
      throw new ReplicationError("Replication batch rejected: unexpected primary node.");
    }
    if (envelope.entries.length > REPLICATION_DEFAULTS.maxBatchEntries) {
      throw new ReplicationError("Replication batch rejected: too many entries.");
    }
    // Validate every entry and the in-batch order before applying any
    // of them, so a bad batch cannot leave a half-applied prefix behind.
    const entries = envelope.entries.map((e) => validateReplicatedEntry(e, { maxPayloadChars: this.maxPayloadChars }));
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i]!.seq <= entries[i - 1]!.seq) {
        throw new ReplicationError("Replication batch rejected: entries are not in increasing seq order.");
      }
    }
    ensureReplicationTables(this.store);
    const source = envelope.source;
    const file = envelope.file;
    let checkpoint = this.checkpoint(source, file);
    let applied = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (entry.seq <= checkpoint || this.hasApplied(source, file, entry.eventId)) {
        skipped += 1;
        continue;
      }
      // Handler first, then store and checkpoint. A throwing handler
      // leaves nothing stored, so the next pull redelivers this entry
      // and retries it. A crash after the handler but before the store
      // redelivers too, so handlers must be idempotent. Once stored,
      // the checkpoint advances per entry, and redelivery of a stored
      // entry is skipped by the checks above.
      await this.onEntry?.(entry, file);
      this.store.rawRun(
        `INSERT INTO "${REPLICATION_LOG_TABLE}"
           (source, file, seq, event_id, event_type, aggregate_type, aggregate_id,
            payload, occurred_at, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          source,
          file,
          entry.seq,
          entry.eventId,
          entry.eventType,
          entry.aggregateType,
          entry.aggregateId,
          JSON.stringify(entry.payload),
          entry.occurredAt,
          entry.createdAt,
          entry.status,
        ],
      );
      this.store.rawRun(
        `INSERT INTO "${REPLICATION_CHECKPOINT_TABLE}" (source, file, checkpoint_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, file) DO UPDATE SET checkpoint_seq = excluded.checkpoint_seq, updated_at = excluded.updated_at;`,
        [source, file, entry.seq, Date.now()],
      );
      checkpoint = entry.seq;
      applied += 1;
    }
    return { applied, skipped, checkpoint };
  }
}

export function createReplicationApplier(
  store: OutboxStore,
  options: ReplicationApplierOptions,
): ReplicationApplier {
  return new ReplicationApplier(store, options);
}

/** How far behind the primary a replica is, in log positions. Never negative. */
export function replicationLag(latestSeq: number, checkpoint: number): number {
  return Math.max(0, latestSeq - checkpoint);
}

// ── Replica side: runner (poll loop) ─────────────────────────────────────

export interface ReplicationRunnerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

/**
 * Replica poll loop: pulls each file in turn and applies what arrives.
 * No loop runs until start() is called, and stop() ends it. A failed
 * pull or a rejected batch is recorded on the result and retried on
 * the next tick; it never crashes the process and never advances a
 * checkpoint past a rejected batch.
 */
export class ReplicationRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private lastError: string | null = null;

  constructor(
    private readonly transport: ReplicationTransport,
    private readonly appliers: Map<string, ReplicationApplier>,
    options: ReplicationRunnerOptions = {},
  ) {
    if (appliers.size === 0) throw new ReplicationError("Replication runner needs at least one applier.");
    this.pollIntervalMs = options.pollIntervalMs ?? REPLICATION_DEFAULTS.pollIntervalMs;
    this.batchSize = options.batchSize ?? REPLICATION_DEFAULTS.batchSize;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get lastFailure(): string | null {
    return this.lastError;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.runOnce().catch(() => {});
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      void this.runOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pull-and-apply pass over every file. Returns per-file results. */
  async runOnce(): Promise<Record<string, ReplicationApplyResult & { error: string | null }>> {
    if (this.inFlight) return {};
    this.inFlight = true;
    try {
      const results: Record<string, ReplicationApplyResult & { error: string | null }> = {};
      for (const [file, applier] of this.appliers) {
        try {
          // The applier's checkpoint is the cursor: a restart resumes
          // from it, and redelivered entries are skipped, not doubled.
          // The source name is the file key in this phase.
          const cursor = applier.checkpoint(file, file);
          const batch = await this.transport.pull(file, cursor, this.batchSize);
          const applied = await applier.applyBatch(batch);
          results[file] = { ...applied, error: null };
          this.lastError = null;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.lastError = message.slice(0, 2000);
          const cursor = (() => {
            try {
              return applier.checkpoint(file, file);
            } catch {
              return 0;
            }
          })();
          results[file] = { applied: 0, skipped: 0, checkpoint: cursor, error: this.lastError };
        }
      }
      return results;
    } finally {
      this.inFlight = false;
    }
  }
}

// ── HTTP transport + handler (Bun.serve compatible) ──────────────────────

/**
 * Pulls batches over HTTP. The token is a node token from
 * createNodeToken(), sent as a Bearer token. Transport only fetches:
 * signature and entry validation still happen in the applier.
 */
export function createHttpReplicationTransport(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): ReplicationTransport {
  const base = baseUrl.replace(/\/$/, "");
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    throw new ReplicationError("Replication primary URL must start with http:// or https://.");
  }
  return {
    async pull(file: string, afterSeq: number, limit: number): Promise<ReplicationBatch> {
      const url = `${base}/_yatta/replication/pull?file=${encodeURIComponent(file)}&afterSeq=${afterSeq}&limit=${limit}`;
      const res = await fetchFn(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new ReplicationError(`Replication pull failed with HTTP ${res.status}.`);
      }
      const body: unknown = await res.json();
      return validateBatchEnvelope(body);
    },
  };
}

/**
 * HTTP handler for the primary, shaped for Bun.serve's fetch option:
 * `Bun.serve({ fetch: createReplicationHttpHandler(publisher) })`.
 * Mount it under `/_yatta/replication/pull` in an app that already has
 * a server, or serve it standalone. Auth failures return 401 with no
 * data; unknown files return 404; bad cursors return 400.
 */
export function createReplicationHttpHandler(
  publisher: ReplicationPublisher,
): (req: Request) => Response {
  return (req: Request): Response => {
    try {
      const url = new URL(req.url);
      if (url.pathname !== "/_yatta/replication/pull") {
        return new Response("Not found.", { status: 404 });
      }
      if (req.method !== "GET") {
        return new Response("Method not allowed.", { status: 405 });
      }
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const file = url.searchParams.get("file") ?? "";
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1) {
        return new Response("Bad cursor.", { status: 400 });
      }
      const batch = publisher.pullFor(token, file, afterSeq, limit);
      return Response.json(batch);
    } catch (err) {
      if (err instanceof ReplicationError) {
        const message = err.message;
        if (message.includes("invalid node token") || message.includes("not on the allowlist")) {
          return new Response("Unauthorized.", { status: 401 });
        }
        if (message.includes("no file named")) {
          return new Response("Unknown file.", { status: 404 });
        }
        return new Response("Bad request.", { status: 400 });
      }
      return new Response("Replication error.", { status: 500 });
    }
  };
}

// ── Read-only replica guard + env config ─────────────────────────────────

/**
 * Wraps a store so app code on a replica can read but never write:
 * rawRun throws ReplicaWriteError. The applier itself uses the
 * underlying store directly, never this wrapper, so checkpoints and
 * the replicated log still update. This guards the raw surface only:
 * ORM-level writes through a full YattaDB object are a phase 2
 * follow-up, and the docs say so.
 */
export function createReadOnlyStore(store: OutboxStore): OutboxStore {
  return {
    rawRun(): { lastInsertRowid: number; changes: number } {
      throw new ReplicaWriteError();
    },
    rawAll<R = any>(sql: string, params?: any[]): R[] {
      return store.rawAll<R>(sql, params);
    },
    rawGet<R = any>(sql: string, params?: any[]): R | null {
      return store.rawGet<R>(sql, params);
    },
  };
}

/** Throws when code tries to write while this node is a replica. */
export function assertPrimaryWrite(role: ReplicationRole | null | undefined): void {
  if (role === "replica") throw new ReplicaWriteError();
}

/** Full replication config, built from code or the environment. */
export interface ReplicationConfig {
  role: ReplicationRole;
  nodeId: string;
  /** Shared secret, from the environment only. Never log this object whole. */
  secret: string;
  /** Primary base URL. Required for replicas. */
  primaryUrl?: string;
  /** Replica ids allowed to pull. Primary only; empty means any valid token. */
  allowedReplicaIds?: string[];
  pollIntervalMs?: number;
  batchSize?: number;
}

/**
 * Reads replication config from the environment. Returns null when
 * YATTA_REPLICATION_ROLE is unset: that is the normal unconfigured
 * case, and nothing replication-related starts. When the role IS set,
 * the secret is required: a configured node without a secret fails
 * closed instead of running unauthenticated.
 *
 * Variables: YATTA_REPLICATION_ROLE (primary|replica),
 * YATTA_REPLICATION_NODE_ID, YATTA_REPLICATION_SECRET,
 * YATTA_REPLICATION_PRIMARY_URL (replicas),
 * YATTA_REPLICATION_ALLOWED_REPLICAS (comma list, primary),
 * YATTA_REPLICATION_POLL_MS, YATTA_REPLICATION_BATCH_SIZE.
 */
export function replicationConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReplicationConfig | null {
  const roleRaw = env.YATTA_REPLICATION_ROLE?.trim();
  if (!roleRaw) return null;
  if (roleRaw !== "primary" && roleRaw !== "replica") {
    throw new ReplicationError('YATTA_REPLICATION_ROLE must be "primary" or "replica".');
  }
  const secret = env.YATTA_REPLICATION_SECRET ?? "";
  if (!secret) {
    throw new ReplicationError("YATTA_REPLICATION_SECRET is required when replication is configured.");
  }
  const nodeId = env.YATTA_REPLICATION_NODE_ID?.trim() || `${roleRaw}-1`;
  const config: ReplicationConfig = { role: roleRaw, nodeId, secret };
  if (roleRaw === "replica") {
    const primaryUrl = env.YATTA_REPLICATION_PRIMARY_URL?.trim();
    if (!primaryUrl) {
      throw new ReplicationError("YATTA_REPLICATION_PRIMARY_URL is required for a replica.");
    }
    config.primaryUrl = primaryUrl;
  }
  // The allowlist is a primary-side check; a replica has no use for it.
  if (roleRaw === "primary") {
    const allowed = env.YATTA_REPLICATION_ALLOWED_REPLICAS?.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed && allowed.length > 0) config.allowedReplicaIds = allowed;
  }
  const pollMs = Number(env.YATTA_REPLICATION_POLL_MS ?? "");
  if (Number.isFinite(pollMs) && pollMs > 0) config.pollIntervalMs = Math.floor(pollMs);
  const batchSize = Number(env.YATTA_REPLICATION_BATCH_SIZE ?? "");
  if (Number.isInteger(batchSize) && batchSize >= 1) config.batchSize = batchSize;
  return config;
}
