/**
 * Time-travel replay (dev only).
 *
 * Rebuilds an aggregate's state from the shared change log, with no
 * second log: it reads the same `_yatta_outbox` table the outbox relay
 * publishes from, via `readChangeLog()`. See
 * docs/roadmap-14/shared-change-log.md for that contract. Replay reads
 * history, so it ignores each row's relay status and never marks rows.
 *
 * Three pieces:
 * 1. The ordered log itself — already there, in `_yatta_outbox`.
 * 2. State snapshots — checkpoints in `_yatta_replay_snapshots`, each
 *    checksummed, so a rewind starts from a snapshot and replays only
 *    the entries after it.
 * 3. A replay runner — applies entries in `seq` order through a caller
 *    reducer, which must be pure: it returns new state and performs no
 *    external effect. Replaying a job, email, or payment handler
 *    directly would double-apply it; see the idempotency note below.
 *
 * Dev-only gate: every entry point here requires an explicit opt-in
 * (`enabled: true`) AND a non-production environment. Production is
 * refused in code, not just in docs, and the check looks at the
 * explicit environment, `YATTA_ENV`, and `NODE_ENV` — if any of them
 * says production, the call throws. Nothing in this module ever
 * writes back to the application's own tables: a rewind returns
 * rebuilt state in memory, and the caller decides what to do with it
 * in their dev database.
 *
 * Lazy by design: this module is not imported by the framework entry
 * points, so importing the framework costs nothing here. Nothing runs
 * until a caller creates a runner with the dev flag set.
 *
 * Idempotency note: the shared log delivers at-least-once, so a
 * replayed entry may be one the caller already acted on. Pass
 * `isApplied` / `markApplied` (backed by a store the caller owns) to
 * skip entries already applied; without them, replay assumes the
 * reducer is pure and re-running it is safe.
 */

import crypto from "node:crypto";
import {
  ensureOutboxTable,
  readChangeLog,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox";

/** A pure fold over one log entry: returns the next state, no side effects. */
export type ReplayReducer<S> = (state: S, entry: OutboxEntry) => S;

/** Options for every replay entry point. `enabled` must be true. */
export interface ReplayOptions {
  /** Explicit opt-in. Defaults to false: replay stays off unless asked for. */
  enabled?: boolean;
  /**
   * Environment name, checked before any fallback. When omitted, the
   * check falls back to `YATTA_ENV`, then `NODE_ENV`.
   */
  environment?: string;
}

/** True when the name means production. Case and whitespace do not matter. */
export function isProductionEnvironment(name: string | undefined | null): boolean {
  if (name === undefined || name === null) return false;
  const value = name.trim().toLowerCase();
  return value === "production" || value === "prod";
}

/**
 * The environment a replay call runs in: the explicit option first,
 * then `YATTA_ENV`, then `NODE_ENV`, then undefined (unknown).
 */
export function resolveReplayEnvironment(options: ReplayOptions = {}): string | undefined {
  if (options.environment !== undefined) return options.environment;
  if (typeof process !== "undefined") {
    return process.env.YATTA_ENV ?? process.env.NODE_ENV;
  }
  return undefined;
}

/**
 * Throws unless replay is explicitly enabled and the environment is
 * known and not production. This is the dev-only enforcement: all
 * three halves are required, and the gate fails closed. An unknown
 * environment refuses too — a production deploy that simply forgot
 * to set NODE_ENV must not slip through as "not production".
 */
export function assertReplayAllowed(options: ReplayOptions = {}): void {
  if (options.enabled !== true) {
    throw new Error(
      "Time-travel replay is disabled: pass { enabled: true } to opt in. " +
        "It is a dev-only tool and is never enabled by default.",
    );
  }
  // Check every signal, not just one: an explicit option must not be
  // able to hide a production NODE_ENV, and vice versa.
  const signals: (string | undefined)[] = [
    options.environment,
    typeof process !== "undefined" ? process.env.YATTA_ENV : undefined,
    typeof process !== "undefined" ? process.env.NODE_ENV : undefined,
  ];
  for (const signal of signals) {
    if (isProductionEnvironment(signal)) {
      throw new Error(
        "Time-travel replay refuses to run in a production environment: " +
          "rewinding a production database is never allowed.",
      );
    }
  }
  if (resolveReplayEnvironment(options) === undefined) {
    throw new Error(
      "Time-travel replay refuses to run with an unknown environment: " +
        "set NODE_ENV, YATTA_ENV, or the environment option to a " +
        "non-production value first.",
    );
  }
}

/** One stored snapshot: an aggregate's state as of one log position. */
export interface ReplaySnapshot<S = unknown> {
  aggregateType: string;
  aggregateId: string;
  /** Last log `seq` folded into `state`. -1 when no entry was folded. */
  upToSeq: number;
  state: S;
  /** SHA-256 over the snapshot's identity, position, and state. */
  checksum: string;
  createdAt: number;
}

export const REPLAY_SNAPSHOT_TABLE = "_yatta_replay_snapshots";

/** Creates the snapshot table if it does not exist yet. Never drops rows. */
export function ensureSnapshotTable(store: OutboxStore): void {
  ensureOutboxTable(store);
  store.rawRun(`
    CREATE TABLE IF NOT EXISTS "${REPLAY_SNAPSHOT_TABLE}" (
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      up_to_seq INTEGER NOT NULL,
      state TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (aggregate_type, aggregate_id, up_to_seq)
    );
  `);
}

// Stable JSON: same value, same string, whatever key order it arrived in.
// The checksum must not break just because an object was rebuilt.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error("Snapshot state must be JSON-serializable.");
    }
    return json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** Checksum for a snapshot's identity, position, and state. */
export function computeSnapshotChecksum(
  aggregateType: string,
  aggregateId: string,
  upToSeq: number,
  state: unknown,
): string {
  const canonical = stableStringify({ aggregateType, aggregateId, upToSeq, state });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Verifies a snapshot's checksum. Throws on mismatch: a corrupt
 * snapshot must fail loudly, never silently replay wrong state.
 */
export function verifySnapshot<S>(snapshot: ReplaySnapshot<S>): ReplaySnapshot<S> {
  const expected = computeSnapshotChecksum(
    snapshot.aggregateType,
    snapshot.aggregateId,
    snapshot.upToSeq,
    snapshot.state,
  );
  if (expected !== snapshot.checksum) {
    throw new Error(
      `Replay snapshot checksum mismatch for ${snapshot.aggregateType}:${snapshot.aggregateId} ` +
        `at seq ${snapshot.upToSeq}: the snapshot is corrupt or tampered with, refusing to replay from it.`,
    );
  }
  return snapshot;
}

function snapshotFromRow<S>(row: any): ReplaySnapshot<S> {
  return {
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    upToSeq: row.up_to_seq,
    state: JSON.parse(row.state) as S,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

/** Result of a replay run. */
export interface ReplayResult<S> {
  state: S;
  /** Last log `seq` folded, or the starting seq when nothing was folded. */
  lastSeq: number;
  /** Entries folded into state. */
  appliedCount: number;
  /** Entries skipped because `isApplied` already knew them. */
  skippedCount: number;
  /** Event ids folded, in `seq` order. */
  eventIds: string[];
}

/** Shared inputs for replay, snapshot, and rewind calls. */
export interface ReplayTarget<S> {
  aggregateType: string;
  aggregateId: string;
  reducer: ReplayReducer<S>;
  initialState: S;
  /** Skip entries already acted on (caller-owned applied set). */
  isApplied?: (eventId: string) => boolean;
  /** Record an entry as acted on, after the reducer ran. */
  markApplied?: (eventId: string) => void;
}

function validateTarget<S>(target: ReplayTarget<S>): void {
  if (!target.aggregateType?.trim()) {
    throw new Error("Replay aggregateType must be a non-empty string.");
  }
  if (!target.aggregateId?.trim()) {
    throw new Error("Replay aggregateId must be a non-empty string.");
  }
  if (typeof target.reducer !== "function") {
    throw new Error("Replay needs a reducer function.");
  }
}

/**
 * Folds entries in order through the reducer, with tamper checks:
 * `seq` must strictly increase, `event_id` must be unique, and each
 * entry must belong to the requested aggregate. Any violation throws
 * instead of producing state from a damaged log. A corrupt payload
 * also throws: `readChangeLog()` parses JSON, and a bad row fails
 * there rather than replaying as something else.
 */
export function replayEntries<S>(
  entries: OutboxEntry[],
  target: ReplayTarget<S>,
  start: { state: S; lastSeq: number },
): ReplayResult<S> {
  validateTarget(target);
  let state = start.state;
  let lastSeq = start.lastSeq;
  let appliedCount = 0;
  let skippedCount = 0;
  const eventIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.eventId?.trim() || !entry.eventType?.trim()) {
      throw new Error(
        `Replay refuses entry at seq ${entry.seq}: missing event id or event type.`,
      );
    }
    if (seen.has(entry.eventId)) {
      throw new Error(
        `Replay refuses duplicate event id ${entry.eventId}: the log must not replay one event twice.`,
      );
    }
    seen.add(entry.eventId);
    if (entry.seq <= lastSeq) {
      throw new Error(
        `Replay refuses out-of-order log: seq ${entry.seq} follows ${lastSeq}. ` +
          "Entries must arrive in strictly increasing seq order.",
      );
    }
    if (
      entry.aggregateType !== target.aggregateType ||
      entry.aggregateId !== target.aggregateId
    ) {
      throw new Error(
        `Replay refuses entry ${entry.eventId}: it belongs to ` +
          `${entry.aggregateType}:${entry.aggregateId}, not ` +
          `${target.aggregateType}:${target.aggregateId}.`,
      );
    }
    lastSeq = entry.seq;
    if (target.isApplied?.(entry.eventId)) {
      skippedCount += 1;
      continue;
    }
    state = target.reducer(state, entry);
    target.markApplied?.(entry.eventId);
    appliedCount += 1;
    eventIds.push(entry.eventId);
  }
  return { state, lastSeq, appliedCount, skippedCount, eventIds };
}

const REPLAY_PAGE_SIZE = 500;

/** Reads one aggregate's log in pages, in `seq` order, ignoring status. */
function readAggregateLog(
  store: OutboxStore,
  aggregateType: string,
  aggregateId: string,
  afterSeq: number,
  upToSeq?: number,
): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = readChangeLog(store, {
      afterSeq: cursor,
      limit: REPLAY_PAGE_SIZE,
      aggregateType,
      aggregateId,
    });
    if (page.length === 0) break;
    for (const entry of page) {
      if (upToSeq !== undefined && entry.seq > upToSeq) return entries;
      entries.push(entry);
      cursor = entry.seq;
    }
    if (page.length < REPLAY_PAGE_SIZE) break;
  }
  return entries;
}

/** Options for `replayAggregate`, plus the target fields. */
export interface ReplayAggregateOptions<S> extends ReplayTarget<S>, ReplayOptions {
  /** Exclusive lower bound: entries after this seq only. Defaults to -1. */
  fromSeq?: number;
  /** Inclusive upper bound: entries up to this seq only. */
  upToSeq?: number;
  /** Start from this snapshot's state and position instead of initial state. */
  snapshot?: ReplaySnapshot<S>;
}

/**
 * Rebuilds one aggregate's state from the shared log. Reads `published`
 * and `dead` rows as well as `pending` ones — the log is history, and
 * a row's relay status says nothing about whether it happened. Never
 * marks log rows, and never writes to the application's own tables.
 */
export function replayAggregate<S>(
  store: OutboxStore,
  options: ReplayAggregateOptions<S>,
): ReplayResult<S> {
  assertReplayAllowed(options);
  validateTarget(options);
  const startSeq = options.snapshot ? options.snapshot.upToSeq : (options.fromSeq ?? -1);
  const startState = options.snapshot
    ? verifySnapshot(options.snapshot).state
    : options.initialState;
  const entries = readAggregateLog(
    store,
    options.aggregateType,
    options.aggregateId,
    startSeq,
    options.upToSeq,
  );
  return replayEntries(entries, options, { state: startState, lastSeq: startSeq });
}

/** Options for `createSnapshot`, plus the target fields. */
export interface CreateSnapshotOptions<S> extends ReplayTarget<S>, ReplayOptions {
  /** Inclusive upper bound: snapshot the state as of this seq. Defaults to latest. */
  upToSeq?: number;
  /** Start folding from this snapshot instead of initial state. */
  snapshot?: ReplaySnapshot<S>;
}

/**
 * Folds an aggregate's log into state and stores it as a checksummed
 * snapshot at the last seq folded (or the starting seq when the log
 * had nothing new). Replaces a snapshot at the same position.
 */
export function createSnapshot<S>(
  store: OutboxStore,
  options: CreateSnapshotOptions<S>,
): ReplaySnapshot<S> {
  assertReplayAllowed(options);
  validateTarget(options);
  ensureSnapshotTable(store);
  const startSeq = options.snapshot ? options.snapshot.upToSeq : -1;
  const startState = options.snapshot
    ? verifySnapshot(options.snapshot).state
    : options.initialState;
  const entries = readAggregateLog(
    store,
    options.aggregateType,
    options.aggregateId,
    startSeq,
    options.upToSeq,
  );
  const result = replayEntries(entries, options, { state: startState, lastSeq: startSeq });
  const snapshot: ReplaySnapshot<S> = {
    aggregateType: options.aggregateType,
    aggregateId: options.aggregateId,
    upToSeq: result.lastSeq,
    state: result.state,
    checksum: computeSnapshotChecksum(
      options.aggregateType,
      options.aggregateId,
      result.lastSeq,
      result.state,
    ),
    createdAt: Date.now(),
  };
  let stateJson: string;
  try {
    stateJson = JSON.stringify(snapshot.state);
  } catch {
    throw new Error("Snapshot state must be JSON-serializable.");
  }
  if (stateJson === undefined) {
    throw new Error("Snapshot state must be JSON-serializable.");
  }
  store.rawRun(
    `INSERT INTO "${REPLAY_SNAPSHOT_TABLE}"
       (aggregate_type, aggregate_id, up_to_seq, state, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (aggregate_type, aggregate_id, up_to_seq) DO UPDATE SET
       state = excluded.state, checksum = excluded.checksum,
       created_at = excluded.created_at;`,
    [
      snapshot.aggregateType,
      snapshot.aggregateId,
      snapshot.upToSeq,
      stateJson,
      snapshot.checksum,
      snapshot.createdAt,
    ],
  );
  return snapshot;
}

/**
 * Latest stored snapshot for an aggregate, verified, or null when
 * none exists. `atOrBeforeSeq` limits it to snapshots at or before
 * that seq; without it, the latest snapshot overall is returned.
 */
export function loadSnapshot<S>(
  store: OutboxStore,
  aggregateType: string,
  aggregateId: string,
  options: ReplayOptions & { atOrBeforeSeq?: number } = {},
): ReplaySnapshot<S> | null {
  assertReplayAllowed(options);
  ensureSnapshotTable(store);
  const clauses = ["aggregate_type = ?", "aggregate_id = ?"];
  const params: any[] = [aggregateType, aggregateId];
  if (options.atOrBeforeSeq !== undefined) {
    clauses.push("up_to_seq <= ?");
    params.push(options.atOrBeforeSeq);
  }
  const row = store.rawGet<any>(
    `SELECT * FROM "${REPLAY_SNAPSHOT_TABLE}"
     WHERE ${clauses.join(" AND ")}
     ORDER BY up_to_seq DESC LIMIT 1;`,
    params,
  );
  if (!row) return null;
  return verifySnapshot(snapshotFromRow<S>(row));
}

/** All stored snapshots for an aggregate, newest first, each verified. */
export function listSnapshots<S>(
  store: OutboxStore,
  aggregateType: string,
  aggregateId: string,
  options: ReplayOptions = {},
): ReplaySnapshot<S>[] {
  assertReplayAllowed(options);
  ensureSnapshotTable(store);
  const rows = store.rawAll<any>(
    `SELECT * FROM "${REPLAY_SNAPSHOT_TABLE}"
     WHERE aggregate_type = ? AND aggregate_id = ?
     ORDER BY up_to_seq DESC;`,
    [aggregateType, aggregateId],
  );
  return rows.map((row) => verifySnapshot(snapshotFromRow<S>(row)));
}

/** Options for `rewindTo`, plus the target fields. */
export interface RewindOptions<S> extends ReplayTarget<S>, ReplayOptions {
  /** Inclusive target seq: the state as of this log position. */
  targetSeq: number;
}

/**
 * Rewinds to a log position and returns the rebuilt state in memory.
 * It starts from the latest verified snapshot at or before the
 * target, then replays only the entries after it. It never mutates
 * the application's tables — rewinding a live database in place is
 * exactly what the production refusal exists to prevent, and even in
 * dev the caller writes state back explicitly if that is what they
 * want. A target before the first entry returns the initial state.
 */
export function rewindTo<S>(
  store: OutboxStore,
  options: RewindOptions<S>,
): ReplayResult<S> & { snapshotUsed: ReplaySnapshot<S> | null } {
  assertReplayAllowed(options);
  validateTarget(options);
  const snapshot = loadSnapshot<S>(store, options.aggregateType, options.aggregateId, {
    ...options,
    atOrBeforeSeq: options.targetSeq,
  });
  const result = replayAggregate(store, {
    ...options,
    snapshot: snapshot ?? undefined,
    fromSeq: snapshot ? undefined : -1,
    upToSeq: options.targetSeq,
  });
  return { ...result, snapshotUsed: snapshot };
}

/**
 * Dev-only replay runner bound to one store and one opt-in. The gate
 * is checked at construction and again on every call, so a process
 * that flips into production after construction still refuses.
 */
export class ReplayRunner {
  constructor(
    private readonly store: OutboxStore,
    private readonly options: ReplayOptions,
  ) {
    assertReplayAllowed(options);
  }

  /** Rebuilds one aggregate's state from the shared log. */
  replay<S>(target: Omit<ReplayAggregateOptions<S>, keyof ReplayOptions>): ReplayResult<S> {
    return replayAggregate(this.store, { ...target, ...this.options });
  }

  /** Folds an aggregate's log into a checksummed snapshot. */
  snapshot<S>(target: Omit<CreateSnapshotOptions<S>, keyof ReplayOptions>): ReplaySnapshot<S> {
    return createSnapshot(this.store, { ...target, ...this.options });
  }

  /** Latest verified snapshot for an aggregate, or null. */
  load<S>(
    aggregateType: string,
    aggregateId: string,
    atOrBeforeSeq?: number,
  ): ReplaySnapshot<S> | null {
    return loadSnapshot(this.store, aggregateType, aggregateId, {
      ...this.options,
      atOrBeforeSeq,
    });
  }

  /** All verified snapshots for an aggregate, newest first. */
  list<S>(aggregateType: string, aggregateId: string): ReplaySnapshot<S>[] {
    return listSnapshots(this.store, aggregateType, aggregateId, this.options);
  }

  /** Rewinds to a log position and returns the rebuilt state in memory. */
  rewind<S>(target: Omit<RewindOptions<S>, keyof ReplayOptions>): ReplayResult<S> & {
    snapshotUsed: ReplaySnapshot<S> | null;
  } {
    return rewindTo(this.store, { ...target, ...this.options });
  }
}

/** Creates a dev-only replay runner. Throws unless the gate passes. */
export function createReplayRunner(
  store: OutboxStore,
  options: ReplayOptions,
): ReplayRunner {
  return new ReplayRunner(store, options);
}
