/**
 * Transactional outbox and shared change log.
 *
 * The problem this solves: app code writes to one SQLite file, then pipes
 * an event or job into another file. A crash between the two drops the
 * event silently. The outbox table lives in the SAME file as the write it
 * records, and is written in the SAME transaction, so the change and its
 * log entry commit or roll back together.
 *
 * The same table is the shared change log for later features: see
 * docs/roadmap-14/shared-change-log.md for the contract (schema, ordering,
 * publish and dedupe rules, what each consumer reads). The relay below
 * publishes with at-least-once delivery: a row is marked published only
 * after its publish function resolves, and consumers dedupe by event_id.
 */

import crypto from "node:crypto";

/**
 * Minimal store surface the outbox needs. Any YattaDB instance (or its
 * transaction proxy) satisfies this, so `recordOutbox(tx, ...)` works
 * inside `db.transaction()` with no extra wiring.
 */
export interface OutboxStore {
  rawRun(sql: string, params?: any[]): { lastInsertRowid: number; changes: number };
  rawAll<R = any>(sql: string, params?: any[]): R[];
  rawGet<R = any>(sql: string, params?: any[]): R | null;
}

/** Lifecycle of an outbox row. Published rows are kept as history. */
export type OutboxStatus = "pending" | "published" | "dead";

/** One row of the shared change log. */
export interface OutboxEntry {
  /** Position in this file's log. The only ordering key. */
  seq: number;
  /** Stable identity of the event. The dedupe key. */
  eventId: string;
  /** What happened, e.g. "user.registered". */
  eventType: string;
  /** What kind of thing changed, e.g. "user". Null when there is no aggregate. */
  aggregateType: string | null;
  /** Which thing changed. Null when there is no aggregate. */
  aggregateId: string | null;
  /** Event data. Always JSON-serializable. */
  payload: unknown;
  /** Milliseconds since epoch when the event happened. */
  occurredAt: number;
  /** Caller-chosen dedupe key, e.g. "welcome-email:<userId>". */
  dedupeKey: string | null;
  status: OutboxStatus;
  /** Publish attempts so far. Only the relay increments this. */
  attempts: number;
  /** Earliest time the relay may retry, in milliseconds since epoch. */
  nextAttemptAt: number;
  /** When the relay marked the row published. Null until then. */
  publishedAt: number | null;
  /** Last publish failure message. Null when never failed. */
  lastError: string | null;
  /** Milliseconds since epoch when the row was recorded. */
  createdAt: number;
}

/** Input for recording one outbox entry. */
export interface RecordOutboxInput {
  eventType: string;
  payload: unknown;
  /** Defaults to a fresh UUID. Pass one to make recording itself idempotent. */
  eventId?: string;
  aggregateType?: string;
  aggregateId?: string;
  /** Caller-chosen dedupe key. Nulls do not collide. */
  dedupeKey?: string;
  /** Business time of the event. Defaults to now. */
  occurredAt?: number;
}

export const OUTBOX_TABLE = "_yatta_outbox";

/**
 * Stores whose outbox table has already been ensured, per connection object.
 *
 * `ensureOutboxTable` is called from every outbox entry point, and the outbox
 * sits on the write path of every feature that records a change. Running five
 * `CREATE ... IF NOT EXISTS` statements per write costs a parse and a plan each
 * — 500 DDL statements for 100 recorded events — for a schema that exists after
 * the first one. The store is the unit because it is the connection: a second
 * connection (another file, or after a restore) is not in this set and gets its
 * own ensure.
 *
 * The trade: a table dropped by something outside the framework mid-process is
 * not silently recreated on the next write; the insert fails with SQLite's own
 * "no such table" instead. Recreating it every write to guard against that is
 * the cost this memo exists to remove.
 */
const outboxReady = new WeakSet<object>();

/**
 * Creates the outbox table and its indexes if they do not exist yet.
 * Safe to call on every use; it never drops or rewrites existing rows, and
 * after the first call on a store it does no work at all.
 */
export function ensureOutboxTable(store: OutboxStore): void {
  if (outboxReady.has(store)) return;
  store.rawRun(`
    CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      aggregate_type TEXT,
      aggregate_id TEXT,
      payload TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      published_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  store.rawRun(`
    CREATE INDEX IF NOT EXISTS "idx_yatta_outbox_pending"
    ON "${OUTBOX_TABLE}" (status, next_attempt_at, seq);
  `);
  store.rawRun(`
    CREATE INDEX IF NOT EXISTS "idx_yatta_outbox_event_type"
    ON "${OUTBOX_TABLE}" (event_type, seq);
  `);
  store.rawRun(`
    CREATE INDEX IF NOT EXISTS "idx_yatta_outbox_aggregate"
    ON "${OUTBOX_TABLE}" (aggregate_type, aggregate_id, seq);
  `);
  store.rawRun(`
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_yatta_outbox_dedupe_key"
    ON "${OUTBOX_TABLE}" (dedupe_key)
    WHERE dedupe_key IS NOT NULL;
  `);
  // Only after the last statement succeeded: a locked or broken connection
  // must be retried on the next call, not remembered as ready.
  outboxReady.add(store);
}

function serializePayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new Error("Outbox payload must be JSON-serializable: it contains a circular value.");
  }
  if (json === undefined) {
    throw new Error("Outbox payload must be JSON-serializable: undefined, functions, and symbols are rejected.");
  }
  return json;
}

function deserializeRow(row: any): OutboxEntry {
  return {
    seq: row.seq,
    eventId: row.event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type ?? null,
    aggregateId: row.aggregate_id ?? null,
    payload: JSON.parse(row.payload),
    occurredAt: row.occurred_at,
    dedupeKey: row.dedupe_key ?? null,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  };
}

function insertOutboxRow(store: OutboxStore, input: RecordOutboxInput): OutboxEntry {
  const eventType = input.eventType?.trim();
  if (!eventType) {
    throw new Error("Outbox eventType must be a non-empty string.");
  }
  const payloadJson = serializePayload(input.payload);
  const now = Date.now();
  const row = store.rawGet<any>(
    `INSERT INTO "${OUTBOX_TABLE}"
      (event_id, event_type, aggregate_type, aggregate_id, payload, occurred_at,
       dedupe_key, status, attempts, next_attempt_at, published_at, last_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?)
     RETURNING *;`,
    [
      input.eventId ?? crypto.randomUUID(),
      eventType,
      input.aggregateType ?? null,
      input.aggregateId ?? null,
      payloadJson,
      input.occurredAt ?? now,
      input.dedupeKey ?? null,
      now,
      now,
    ],
  );
  if (!row) throw new Error("Outbox insert returned no row.");
  return deserializeRow(row);
}

/**
 * Records one outbox entry. Call this inside `db.transaction()` alongside
 * the user write it records, so both commit or roll back together. Called
 * outside a transaction it is still a single atomic insert, but it is no
 * longer atomic with anything else.
 *
 * A duplicate event_id or dedupe_key is rejected: the caller is recording
 * an event that already exists.
 */
export function recordOutbox(store: OutboxStore, input: RecordOutboxInput): OutboxEntry {
  ensureOutboxTable(store);
  return insertOutboxRow(store, input);
}

/** Options for reading the change log. */
export interface ReadChangeLogOptions {
  /** Exclusive lower bound: returns rows with seq greater than this. */
  afterSeq?: number;
  /** Maximum rows to return. Defaults to 100. */
  limit?: number;
  eventType?: string;
  aggregateType?: string;
  aggregateId?: string;
  status?: OutboxStatus;
}

/**
 * Reads the change log in seq order, for any consumer: replication,
 * replay, or inspection. Consumers keep their own checkpoint (last
 * processed seq) and resume from it. The log never tracks consumers.
 * Status is not filtered unless asked: replay reads history, and a row's
 * relay status says nothing about whether it happened.
 */
export function readChangeLog(store: OutboxStore, options: ReadChangeLogOptions = {}): OutboxEntry[] {
  ensureOutboxTable(store);
  const limit = options.limit ?? 100;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("Outbox read limit must be a positive number.");
  }
  const clauses: string[] = [];
  const params: any[] = [];
  if (options.afterSeq !== undefined) {
    clauses.push("seq > ?");
    params.push(options.afterSeq);
  }
  if (options.eventType !== undefined) {
    clauses.push("event_type = ?");
    params.push(options.eventType);
  }
  if (options.aggregateType !== undefined) {
    clauses.push("aggregate_type = ?");
    params.push(options.aggregateType);
  }
  if (options.aggregateId !== undefined) {
    clauses.push("aggregate_id = ?");
    params.push(options.aggregateId);
  }
  if (options.status !== undefined) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = store.rawAll<any>(
    `SELECT * FROM "${OUTBOX_TABLE}" ${where} ORDER BY seq ASC LIMIT ?;`,
    [...params, Math.floor(limit)],
  );
  return rows.map(deserializeRow);
}

/**
 * Reads pending rows due for publish, in seq order. This is the relay's
 * scan; other consumers should use readChangeLog() instead.
 */
export function listPending(store: OutboxStore, options: { limit?: number; now?: number } = {}): OutboxEntry[] {
  ensureOutboxTable(store);
  const limit = options.limit ?? 100;
  const now = options.now ?? Date.now();
  const rows = store.rawAll<any>(
    `SELECT * FROM "${OUTBOX_TABLE}"
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY seq ASC LIMIT ?;`,
    [now, Math.floor(limit)],
  );
  return rows.map(deserializeRow);
}

/** Returns one outbox row by event_id, or null. */
export function getOutboxByEventId(store: OutboxStore, eventId: string): OutboxEntry | null {
  ensureOutboxTable(store);
  const row = store.rawGet<any>(`SELECT * FROM "${OUTBOX_TABLE}" WHERE event_id = ?;`, [eventId]);
  return row ? deserializeRow(row) : null;
}

/**
 * Returns a dead row to pending for manual replay, resetting its attempt
 * count and retry time. Returns false when the row is not dead.
 * Published rows are never replayed this way: they already delivered.
 */
export function republishDead(store: OutboxStore, eventId: string, now = Date.now()): boolean {
  ensureOutboxTable(store);
  const res = store.rawRun(
    `UPDATE "${OUTBOX_TABLE}"
     SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL
     WHERE event_id = ? AND status = 'dead';`,
    [now, eventId],
  );
  return res.changes > 0;
}

/**
 * Deletes published rows only, never pending or dead ones. Purge only
 * below the lowest checkpoint of every consumer that reads history,
 * or that consumer's history is silently rewritten.
 */
export function purgePublished(
  store: OutboxStore,
  options: { beforeSeq?: number; olderThanMs?: number } = {},
): number {
  ensureOutboxTable(store);
  const clauses = ["status = 'published'"];
  const params: any[] = [];
  if (options.beforeSeq !== undefined) {
    clauses.push("seq < ?");
    params.push(options.beforeSeq);
  }
  if (options.olderThanMs !== undefined) {
    clauses.push("published_at <= ?");
    params.push(Date.now() - options.olderThanMs);
  }
  const res = store.rawRun(
    `DELETE FROM "${OUTBOX_TABLE}" WHERE ${clauses.join(" AND ")};`,
    params,
  );
  return res.changes;
}

/** Counts rows by status, for relay health checks. */
export function outboxCounts(store: OutboxStore): Record<OutboxStatus, number> {
  ensureOutboxTable(store);
  const rows = store.rawAll<{ status: OutboxStatus; count: number }>(
    `SELECT status, COUNT(*) as count FROM "${OUTBOX_TABLE}" GROUP BY status;`,
  );
  const counts: Record<OutboxStatus, number> = { pending: 0, published: 0, dead: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.count;
  }
  return counts;
}

/**
 * Publishes one outbox entry. The relay marks the row published only
 * after this resolves, so a rejection means "not delivered" and the row
 * stays pending for retry. Anything this function does must therefore
 * be safe to run twice: a crash after publish but before the mark
 * redelivers the entry.
 */
export type OutboxPublishFn = (entry: OutboxEntry) => Promise<void> | void;

/** Minimal job-queue surface the job adapter needs. */
export interface OutboxJobSink {
  enqueue(name: string, data: unknown, options?: { uniqueKey?: string; queue?: string }): Promise<unknown>;
}

/** Minimal event-bus surface the event adapter needs. */
export interface OutboxEventSink {
  emit(event: string, data: unknown, options?: { throwOnError?: boolean }): Promise<void>;
}

/**
 * Builds a publish function that enqueues one job per outbox entry.
 * The job's unique key is derived from the event_id, so a redelivery
 * while the first job is still active returns the existing job instead
 * of creating a duplicate. After the first job completes, the handler
 * itself must still tolerate a second delivery.
 */
export function toJobPublish(
  sink: OutboxJobSink,
  jobName: string,
  map?: (entry: OutboxEntry) => { jobName?: string; data?: unknown; options?: { uniqueKey?: string; queue?: string } },
): OutboxPublishFn {
  return async (entry) => {
    const mapped = map?.(entry);
    const data = mapped?.data ?? {
      outboxEventId: entry.eventId,
      eventType: entry.eventType,
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      payload: entry.payload,
      occurredAt: entry.occurredAt,
    };
    // The unique key goes last on purpose: it is the dedupe contract, so
    // a caller-supplied option must not be able to replace it and
    // silently turn a redelivery into a duplicate job.
    await sink.enqueue(mapped?.jobName ?? jobName, data, {
      ...(mapped?.options ?? {}),
      uniqueKey: `outbox:${entry.eventId}`,
    });
  };
}

/**
 * Builds a publish function that emits one bus event per outbox entry.
 * Emits with throwOnError so a listener failure counts as a publish
 * failure: the bus default swallows listener errors, and a relay built
 * on that default would mark rows published that no listener handled.
 */
export function toEventPublish(
  sink: OutboxEventSink,
  eventName?: string,
): OutboxPublishFn {
  return async (entry) => {
    await sink.emit(eventName ?? entry.eventType, {
      outboxEventId: entry.eventId,
      eventType: entry.eventType,
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      payload: entry.payload,
      occurredAt: entry.occurredAt,
    }, { throwOnError: true });
  };
}

/** Options for the outbox relay. */
export interface OutboxRelayOptions {
  /** Milliseconds between scans. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Rows per scan. Defaults to 100. */
  batchSize?: number;
  /** Attempts before a row goes dead. Defaults to 5. */
  maxAttempts?: number;
  /** First retry delay in milliseconds. Defaults to 1000. */
  retryBaseMs?: number;
  /** Retry delay cap in milliseconds. Defaults to 60000. */
  retryMaxMs?: number;
  /**
   * Maximum time a single publish may take, in milliseconds. Unset by
   * default: a publish function with no timeout of its own can stall a
   * scan forever, since scans run one row at a time. Set this when the
   * publish target has no timeout of its own; a timeout counts as a
   * publish failure, so the row stays pending for retry.
   */
  publishTimeoutMs?: number;
  /** Clock override, for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Result of one relay scan. */
export interface OutboxRelayResult {
  published: number;
  failed: number;
  dead: number;
}

/** Delay before the next attempt after `attempts` failures, capped. */
export function outboxBackoffMs(attempts: number, baseMs = 1000, maxMs = 60000): number {
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempts - 1)));
}

/**
 * Relay worker: publishes pending outbox rows, in seq order, with
 * at-least-once delivery.
 *
 * A row is marked published only after publish resolves. A crash
 * between publish and the mark leaves the row pending, so the next
 * scan publishes it again; consumers dedupe by event_id (see the
 * design doc). The relay keeps no state in memory, so a fresh relay
 * on the same file picks up unprocessed rows on its first scan —
 * that is how restart pickup works.
 *
 * Run one relay per database file. Two relays on the same file do
 * not lose events, but they can both publish the same row before
 * either marks it.
 */
export class OutboxRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly options: Required<Omit<OutboxRelayOptions, "now" | "publishTimeoutMs">> & {
    now: () => number;
    publishTimeoutMs?: number;
  };

  constructor(
    private readonly store: OutboxStore,
    private readonly publish: OutboxPublishFn,
    options: OutboxRelayOptions = {},
  ) {
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      batchSize: options.batchSize ?? 100,
      maxAttempts: options.maxAttempts ?? 5,
      retryBaseMs: options.retryBaseMs ?? 1000,
      retryMaxMs: options.retryMaxMs ?? 60000,
      publishTimeoutMs: options.publishTimeoutMs,
      now: options.now ?? Date.now,
    };
    ensureOutboxTable(store);
  }

  private async publishWithTimeout(entry: OutboxEntry): Promise<void> {
    const timeoutMs = this.options.publishTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await this.publish(entry);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(this.publish(entry)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Outbox publish timed out after ${timeoutMs}ms.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Whether the interval loop is running. */
  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Starts the interval loop and runs one scan immediately, so rows
   * left by a crashed relay are picked up on boot, not on the first tick.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.runOnce().catch(() => {
      // Per-row failures are already recorded on the row; a scan-level
      // failure (for example, a locked database) is retried on the
      // next tick instead of crashing the process that started the relay.
    });
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      void this.runOnce().catch(() => {});
    }, this.options.pollIntervalMs);
  }

  /** Stops the interval loop. A scan already running finishes. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Publishes one scan of due pending rows, in seq order, one at a
   * time. Sequential, not parallel: order within a scan is preserved,
   * and a failing row's backoff does not block later rows in later
   * scans. Returns counts; failures are recorded on their rows.
   */
  async runOnce(): Promise<OutboxRelayResult> {
    if (this.inFlight) return { published: 0, failed: 0, dead: 0 };
    this.inFlight = true;
    try {
      ensureOutboxTable(this.store);
      const rows = listPending(this.store, { limit: this.options.batchSize, now: this.options.now() });
      const result: OutboxRelayResult = { published: 0, failed: 0, dead: 0 };
      for (const entry of rows) {
        const now = this.options.now();
        try {
          await this.publishWithTimeout(entry);
        } catch (err) {
          const attempts = entry.attempts + 1;
          const dead = attempts >= this.options.maxAttempts;
          const message = err instanceof Error ? err.message : String(err);
          this.store.rawRun(
            `UPDATE "${OUTBOX_TABLE}"
             SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
             WHERE seq = ? AND status = 'pending';`,
            [
              dead ? "dead" : "pending",
              attempts,
              dead ? now : now + outboxBackoffMs(attempts, this.options.retryBaseMs, this.options.retryMaxMs),
              message.slice(0, 2000),
              entry.seq,
            ],
          );
          result.failed += 1;
          if (dead) result.dead += 1;
          continue;
        }
        // Mark done only after publish resolved, and only if the row is
        // still pending: a second relay may have marked it already.
        this.store.rawRun(
          `UPDATE "${OUTBOX_TABLE}"
           SET status = 'published', published_at = ?
           WHERE seq = ? AND status = 'pending';`,
          [this.options.now(), entry.seq],
        );
        result.published += 1;
      }
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

/** Creates an outbox relay. See {@link OutboxRelay}. */
export function createOutboxRelay(
  store: OutboxStore,
  publish: OutboxPublishFn,
  options?: OutboxRelayOptions,
): OutboxRelay {
  return new OutboxRelay(store, publish, options);
}
