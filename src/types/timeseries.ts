/**
 * Time-series collections and automatic rollups.
 *
 * A time-series table is an ordinary schema table whose timestamp column
 * is marked with `.timeSeries()` (see `src/types/db.ts`). Marking the
 * column only adds a time-ordered index at schema sync; tables without
 * the marker take the exact existing write path, and no rollup job runs
 * unless the app configures a policy below. Nothing in this module is
 * imported by the database module, so an app that never imports it pays
 * nothing for it.
 *
 * A rollup policy aggregates old raw rows into summary tables, one tier
 * at a time (for example, per-minute rows become hourly summaries once
 * they are older than 30 days). Each tier writes one summary row per
 * time bucket (and per group, when dimensions are given) holding the row
 * count plus sum, average, minimum, and maximum of each measure column.
 *
 * Two guarantees shape the design:
 *
 * - Raw deletion is opt-in only. A policy deletes raw rows only when its
 *   tier says `deleteRaw: true` in plain text. The default policy
 *   aggregates and keeps every raw row.
 * - A tier run is idempotent. Each window's summary rows are deleted and
 *   re-inserted inside one transaction, so re-running a tier over the
 *   same window replaces its summaries instead of double-counting them,
 *   and a crash mid-run rolls the whole tier back to the previous state.
 *
 * Rollup tables are plain SQLite tables, not schema tables, so they are
 * read with `db.unsafeTable("<rollup table>")` or with {@link readRollup}
 * below. They are created on first use by {@link ensureRollupTables},
 * never by schema sync, so a policy never rewrites an app's schema.
 */

import { YattaError, type DatabaseSchema } from "./db";
import type { CronScheduler, Duration } from "./job";

/**
 * Minimal store surface a rollup needs. Any YattaDB instance satisfies
 * this, including the transaction proxy passed to `db.transaction()`.
 */
export interface TimeSeriesStore {
  readonly schema: DatabaseSchema;
  rawRun(sql: string, params?: any[]): { lastInsertRowid: number; changes: number };
  rawAll<R = any>(sql: string, params?: any[]): R[];
  rawGet<R = any>(sql: string, params?: any[]): R | null;
  transaction<R>(fn: (tx: TimeSeriesStore) => R): R;
}

/** Fixed bucket sizes a tier can aggregate into. Months are left out on purpose. */
export type RollupWindow = "minute" | "hour" | "day" | "week";

/** Milliseconds in each fixed bucket size. */
const WINDOW_MS: Record<RollupWindow, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** One tier of a rollup policy: one bucket size, one age cutoff, one summary table. */
export interface RollupTierConfig {
  /** Tier name, used in the default summary table name (`<source>_<name>`). */
  name: string;
  /** Bucket size the raw rows are summarized into. */
  window: RollupWindow;
  /** Only rows older than this are rolled up, e.g. `"30d"` or milliseconds. */
  olderThan: string | number;
  /**
   * Delete the raw rows a window covers, once that window is summarized.
   * Default `false`. This is the only way raw data is ever deleted, and
   * it must be written out explicitly: omitting it keeps every raw row.
   */
  deleteRaw?: boolean;
  /** Summary table name. Defaults to `<source>_<name>`. */
  rollupTable?: string;
}

/** A rollup policy: which table, which columns, and which tiers to run. */
export interface RollupPolicyConfig {
  /** Source table holding the raw time-series rows. */
  source: string;
  /**
   * Timestamp column holding milliseconds since epoch. Defaults to the
   * table's `.timeSeries()` column when the policy does not name one.
   */
  timeColumn?: string;
  /** Numeric columns to summarize with count, sum, average, min, and max. */
  measures: string[];
  /** Low-cardinality dimension columns kept as-is in each summary row. */
  groupBy?: string[];
  /** Tiers to run, in the order given. Each tier runs in its own transaction. */
  tiers: RollupTierConfig[];
}

/** A tier with every default resolved and every duration parsed to milliseconds. */
export interface NormalizedRollupTier {
  name: string;
  window: RollupWindow;
  windowMs: number;
  olderThanMs: number;
  deleteRaw: boolean;
  rollupTable: string;
}

/** A policy with every default resolved, ready to run. */
export interface NormalizedRollupPolicy {
  source: string;
  timeColumn: string;
  measures: string[];
  groupBy: string[];
  tiers: NormalizedRollupTier[];
}

/** Outcome of one tier run. */
export interface RollupTierResult {
  tier: string;
  rollupTable: string;
  /** Complete windows summarized by this run. */
  windows: number;
  /** Summary rows written (one per window, per group). */
  rowsWritten: number;
  /** Raw rows deleted. Always 0 unless the tier sets `deleteRaw: true`. */
  rowsDeleted: number;
}

/** Outcome of running every tier of a policy. */
export interface RollupPolicyResult {
  source: string;
  tiers: RollupTierResult[];
}

/** One summary row as stored in a rollup table. */
export interface RollupRow {
  bucket_start: number;
  bucket_end: number;
  row_count: number;
  [column: string]: unknown;
}

/** Options for reading a tier's summary table. */
export interface ReadRollupOptions {
  /** Only buckets starting at or after this timestamp (ms since epoch). */
  from?: number;
  /** Only buckets starting before this timestamp (ms since epoch). */
  to?: number;
  /** Exact matches on group columns, e.g. `{ region: "north" }`. */
  where?: Record<string, unknown>;
  /** Maximum rows returned. Defaults to 1000. */
  limit?: number;
}

// Quote an identifier the same way the schema layer does: wrap it in
// double quotes and double any double quote inside. Validation below
// rejects names outside `[A-Za-z_][A-Za-z0-9_]*` first, so quoting is a
// second layer, not the only one.
function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdent(kind: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || !IDENT.test(name)) {
    throw new YattaError(
      `Invalid ${kind} "${String(name)}". Table, column, and tier names may only use letters, digits, and underscore, and may not start with a digit.`,
    );
  }
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parses a duration to milliseconds. Accepts a plain millisecond number
 * or a string like `"30d"`, `"12h"`, `"15m"`, `"7d"`, `"1w"`.
 */
export function parseRollupDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new YattaError(`Invalid rollup duration "${value}". Durations must be positive.`);
    }
    return Math.floor(value);
  }
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim());
  if (!match) {
    throw new YattaError(
      `Invalid rollup duration "${value}". Use milliseconds, or a number with a unit: ms, s, m, h, d, w (for example "30d").`,
    );
  }
  const ms = Number(match[1]) * DURATION_UNITS[match[2]];
  if (ms <= 0) {
    throw new YattaError(`Invalid rollup duration "${value}". Durations must be positive.`);
  }
  return ms;
}

/**
 * Name of the table's `.timeSeries()` column, or null when the table
 * marks no timestamp column.
 */
export function timeSeriesColumnName(store: TimeSeriesStore, table: string): string | null {
  const tableDef = store.schema?.[table];
  if (!tableDef) return null;
  for (const [colName, builder] of Object.entries(tableDef)) {
    if ((builder as { def?: { isTimeSeries?: boolean } }).def?.isTimeSeries) return colName;
  }
  return null;
}

/** Every schema table that marks a time-series timestamp column. */
export function listTimeSeriesTables(store: TimeSeriesStore): string[] {
  return Object.keys(store.schema ?? {}).filter((table) => timeSeriesColumnName(store, table) !== null);
}

/**
 * Validates a policy against the schema and resolves every default.
 * Throws on the first problem, before any table is created or row is
 * touched. Pure: it writes nothing.
 */
export function normalizeRollupPolicy(store: TimeSeriesStore, policy: RollupPolicyConfig): NormalizedRollupPolicy {
  if (!policy || typeof policy !== "object") {
    throw new YattaError("A rollup policy is required.");
  }
  checkIdent("source table", policy.source);
  const tableDef = store.schema?.[policy.source];
  if (!tableDef) {
    throw new YattaError(
      `Rollup source table "${policy.source}" is not in the schema. Rollups only run over schema tables, so a typo cannot point one at an unrelated table.`,
    );
  }
  const columns = Object.keys(tableDef);

  const timeColumn = policy.timeColumn ?? timeSeriesColumnName(store, policy.source);
  if (!timeColumn) {
    throw new YattaError(
      `Rollup policy for "${policy.source}" names no time column and the table marks none with .timeSeries(). ` +
        `Mark the timestamp column, or set the policy's timeColumn.`,
    );
  }
  checkIdent("time column", timeColumn);
  if (!columns.includes(timeColumn)) {
    throw new YattaError(`Rollup time column "${timeColumn}" is not a column of "${policy.source}".`);
  }
  // Rollup bucket math divides integer timestamps, so a text timestamp
  // (an ISO string from col.createdAt()) cannot be bucketed. The index
  // from .timeSeries() still helps its reads; only rollups need integers.
  if (tableDef[timeColumn].def.type !== "INTEGER") {
    throw new YattaError(
      `Rollup time column "${policy.source}.${timeColumn}" must hold integer milliseconds since epoch. ` +
        `Use col.integer().timeSeries() for the timestamp a policy rolls up.`,
    );
  }

  if (!Array.isArray(policy.measures) || policy.measures.length === 0) {
    throw new YattaError(`Rollup policy for "${policy.source}" needs at least one measure column.`);
  }
  const measures: string[] = [];
  for (const measure of policy.measures) {
    checkIdent("measure column", measure);
    if (!columns.includes(measure)) {
      throw new YattaError(`Rollup measure "${measure}" is not a column of "${policy.source}".`);
    }
    if (tableDef[measure].def.type !== "INTEGER" && tableDef[measure].def.type !== "REAL") {
      throw new YattaError(
        `Rollup measure "${policy.source}.${measure}" must be a numeric column (integer or real). Aggregates over text or JSON have no meaning here.`,
      );
    }
    if (measures.includes(measure)) {
      throw new YattaError(`Rollup measure "${measure}" is listed twice for "${policy.source}".`);
    }
    measures.push(measure);
  }

  const groupBy: string[] = [];
  for (const group of policy.groupBy ?? []) {
    checkIdent("group column", group);
    if (!columns.includes(group)) {
      throw new YattaError(`Rollup group column "${group}" is not a column of "${policy.source}".`);
    }
    if (group === timeColumn || measures.includes(group)) {
      throw new YattaError(
        `Rollup group column "${group}" cannot also be the time column or a measure of "${policy.source}".`,
      );
    }
    if (groupBy.includes(group)) {
      throw new YattaError(`Rollup group column "${group}" is listed twice for "${policy.source}".`);
    }
    groupBy.push(group);
  }

  if (!Array.isArray(policy.tiers) || policy.tiers.length === 0) {
    throw new YattaError(`Rollup policy for "${policy.source}" needs at least one tier.`);
  }
  const seenTiers = new Set<string>();
  const tiersSoFar = new Set<string>();
  const tiers: NormalizedRollupTier[] = policy.tiers.map((tier) => {
    if (!tier || typeof tier !== "object") {
      throw new YattaError(`Rollup tier for "${policy.source}" must be an object.`);
    }
    checkIdent("tier name", tier.name);
    if (seenTiers.has(tier.name)) {
      throw new YattaError(`Rollup tier "${tier.name}" is listed twice for "${policy.source}".`);
    }
    seenTiers.add(tier.name);
    if (!(tier.window in WINDOW_MS)) {
      throw new YattaError(
        `Rollup tier "${tier.name}" uses window "${String(tier.window)}". Windows are fixed sizes: minute, hour, day, week.`,
      );
    }
    const rollupTable = tier.rollupTable ?? `${policy.source}_${tier.name}`;
    checkIdent("rollup table", rollupTable);
    // Two tiers writing one summary table would delete each other's
    // buckets: a tier run deletes by bucket_start before re-inserting,
    // and bucket starts overlap across window sizes.
    if (tiersSoFar.has(rollupTable)) {
      throw new YattaError(
        `Rollup tiers "${tier.name}" and another tier of "${policy.source}" both write to "${rollupTable}". Give each tier its own summary table.`,
      );
    }
    tiersSoFar.add(rollupTable);
    if (rollupTable === policy.source) {
      throw new YattaError(`Rollup tier "${tier.name}" would write summaries into its own source table "${policy.source}".`);
    }
    if (tier.deleteRaw !== undefined && typeof tier.deleteRaw !== "boolean") {
      throw new YattaError(`Rollup tier "${tier.name}" sets deleteRaw to a non-boolean. Use deleteRaw: true, or leave it out to keep raw rows.`);
    }
    return {
      name: tier.name,
      window: tier.window,
      windowMs: WINDOW_MS[tier.window],
      olderThanMs: parseRollupDuration(tier.olderThan),
      // Only a literal true deletes. Anything else, including a truthy
      // string, keeps the raw rows: deletion must be unmistakable.
      deleteRaw: tier.deleteRaw === true,
      rollupTable,
    };
  });

  return { source: policy.source, timeColumn, measures, groupBy, tiers };
}

/** Expected columns of a tier's summary table, in storage order. */
function rollupColumns(store: TimeSeriesStore, policy: NormalizedRollupPolicy): { name: string; type: string; nullable: boolean }[] {
  const tableDef = store.schema[policy.source];
  const cols: { name: string; type: string; nullable: boolean }[] = [
    { name: "bucket_start", type: "INTEGER", nullable: false },
    { name: "bucket_end", type: "INTEGER", nullable: false },
    { name: "row_count", type: "INTEGER", nullable: false },
  ];
  // Group columns stay nullable: a NULL group still summarizes into one
  // row, and a NOT NULL summary column would reject it.
  for (const group of policy.groupBy) {
    cols.push({ name: group, type: tableDef[group].def.type, nullable: true });
  }
  for (const measure of policy.measures) {
    cols.push({ name: `${measure}_sum`, type: "REAL", nullable: true });
    cols.push({ name: `${measure}_avg`, type: "REAL", nullable: true });
    cols.push({ name: `${measure}_min`, type: "REAL", nullable: true });
    cols.push({ name: `${measure}_max`, type: "REAL", nullable: true });
  }
  return cols;
}

/**
 * Creates a tier's summary table and its indexes when missing. Safe to
 * call on every run: an existing table with the expected columns is left
 * alone, with its rows untouched. A table of the same name holding a
 * different shape is refused rather than written into blindly.
 */
export function ensureRollupTable(store: TimeSeriesStore, policy: NormalizedRollupPolicy, tier: NormalizedRollupTier): void {
  const expected = rollupColumns(store, policy);
  const existing = store.rawAll<{ name: string }>(`PRAGMA table_info(${q(tier.rollupTable)})`);
  if (existing.length > 0) {
    const actual = new Set(existing.map((c) => c.name));
    const missing = expected.filter((c) => !actual.has(c.name));
    if (missing.length > 0) {
      throw new YattaError(
        `Rollup table "${tier.rollupTable}" already exists without ${missing.map((c) => c.name).join(", ")}. ` +
          `Pick a different rollupTable for tier "${tier.name}", or drop the mismatched table first.`,
      );
    }
    return;
  }
  const defs = expected.map((c) => `${q(c.name)} ${c.type}${c.nullable ? "" : " NOT NULL"}`).join(", ");
  store.rawRun(`CREATE TABLE IF NOT EXISTS ${q(tier.rollupTable)} (${defs})`);
  const bucketKeys = ["bucket_start", ...policy.groupBy].map(q).join(", ");
  const idxBase = `${tier.rollupTable}_bucket`.replace(/"/g, '""');
  store.rawRun(`CREATE UNIQUE INDEX IF NOT EXISTS "${idxBase}" ON ${q(tier.rollupTable)} (${bucketKeys})`);
  const startIdx = `${tier.rollupTable}_start`.replace(/"/g, '""');
  store.rawRun(`CREATE INDEX IF NOT EXISTS "${startIdx}" ON ${q(tier.rollupTable)} ("bucket_start")`);
}

/** Creates every tier's summary table for a policy. */
export function ensureRollupTables(store: TimeSeriesStore, policy: RollupPolicyConfig): NormalizedRollupPolicy {
  const normalized = normalizeRollupPolicy(store, policy);
  for (const tier of normalized.tiers) ensureRollupTable(store, normalized, tier);
  return normalized;
}

/**
 * Runs one tier over every complete window older than its cutoff.
 * A window is complete when its end sits at or before the cutoff, so a
 * window still receiving rows is never summarized. Each window is
 * replaced, not appended to, inside a single transaction for the tier:
 * re-running the tier reproduces the same summary rows, and a crash
 * mid-run rolls the tier back instead of leaving half-written windows.
 */
export function runRollupTier(
  store: TimeSeriesStore,
  policy: NormalizedRollupPolicy,
  tier: NormalizedRollupTier,
  opts: { now?: number } = {},
): RollupTierResult {
  const now = opts.now ?? Date.now();
  const cutoff = now - tier.olderThanMs;
  // Complete windows only: a window ending after the cutoff may still
  // gain rows, so its rows stay raw until a later run.
  const lastRowTime = cutoff - tier.windowMs;
  return store.transaction((tx) => {
    ensureRollupTable(tx, policy, tier);
    const windows = tx.rawAll<{ b: number }>(
      `SELECT DISTINCT ((CAST(${q(policy.timeColumn)} AS INTEGER) / ?) * ?) AS b ` +
        `FROM ${q(policy.source)} WHERE ${q(policy.timeColumn)} <= ? ORDER BY b ASC`,
      [tier.windowMs, tier.windowMs, lastRowTime],
    );
    let rowsWritten = 0;
    let rowsDeleted = 0;
    const groupCols = policy.groupBy.map(q).join(", ");
    const groupList = groupCols ? `, ${groupCols}` : "";
    const groupBySql = groupCols ? `, ${groupCols}` : "";
    const measureCols = policy.measures
      .flatMap((m) => [`${m}_sum`, `${m}_avg`, `${m}_min`, `${m}_max`])
      .map(q)
      .join(", ");
    const measureSelect = policy.measures
      .flatMap((m) => [`SUM(${q(m)})`, `AVG(${q(m)})`, `MIN(${q(m)})`, `MAX(${q(m)})`])
      .join(", ");
    const targetCols = `"bucket_start", "bucket_end", "row_count"${groupList}${measureCols ? `, ${measureCols}` : ""}`;
    for (const { b: bucketStart } of windows) {
      const bucketEnd = bucketStart + tier.windowMs;
      // Replace, never append: the same window re-run yields the same rows.
      tx.rawRun(`DELETE FROM ${q(tier.rollupTable)} WHERE "bucket_start" = ?`, [bucketStart]);
      const inserted = tx.rawRun(
        `INSERT INTO ${q(tier.rollupTable)} (${targetCols}) ` +
          `SELECT ?, ?, COUNT(*)${groupList}, ${measureSelect} ` +
          `FROM ${q(policy.source)} WHERE ${q(policy.timeColumn)} >= ? AND ${q(policy.timeColumn)} < ?` +
          ` GROUP BY ${groupCols || "1"}`,
        [bucketStart, bucketEnd, bucketStart, bucketEnd],
      );
      rowsWritten += inserted.changes;
      if (tier.deleteRaw) {
        const deleted = tx.rawRun(
          `DELETE FROM ${q(policy.source)} WHERE ${q(policy.timeColumn)} >= ? AND ${q(policy.timeColumn)} < ?`,
          [bucketStart, bucketEnd],
        );
        rowsDeleted += deleted.changes;
      }
    }
    return { tier: tier.name, rollupTable: tier.rollupTable, windows: windows.length, rowsWritten, rowsDeleted };
  });
}

/**
 * Runs every tier of a policy, in order. Each tier commits in its own
 * transaction, so a failure in a later tier leaves earlier tiers' work
 * in place and the failed tier untouched.
 */
export function runRollupPolicy(
  store: TimeSeriesStore,
  policy: RollupPolicyConfig,
  opts: { now?: number } = {},
): RollupPolicyResult {
  return runNormalizedPolicy(store, normalizeRollupPolicy(store, policy), opts);
}

/** Same as {@link runRollupPolicy}, for a policy already normalized once. */
function runNormalizedPolicy(
  store: TimeSeriesStore,
  normalized: NormalizedRollupPolicy,
  opts: { now?: number } = {},
): RollupPolicyResult {
  return {
    source: normalized.source,
    tiers: normalized.tiers.map((tier) => runRollupTier(store, normalized, tier, opts)),
  };
}

/**
 * Reads one tier's summary table in bucket order. Returns an empty list
 * when nothing has been rolled up yet, instead of failing on a missing
 * table. Group filters must name group columns of the policy; every
 * value is bound as a parameter, never spliced into the SQL.
 */
export function readRollup(
  store: TimeSeriesStore,
  policy: RollupPolicyConfig,
  tierName: string,
  opts: ReadRollupOptions = {},
): RollupRow[] {
  const normalized = normalizeRollupPolicy(store, policy);
  const tier = normalized.tiers.find((t) => t.name === tierName);
  if (!tier) {
    throw new YattaError(`Rollup policy for "${normalized.source}" has no tier named "${tierName}".`);
  }
  const exists = store.rawGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tier.rollupTable],
  );
  if (!exists) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.from !== undefined) {
    where.push(`"bucket_start" >= ?`);
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    where.push(`"bucket_start" < ?`);
    params.push(opts.to);
  }
  for (const [key, value] of Object.entries(opts.where ?? {})) {
    checkIdent("group column", key);
    if (!normalized.groupBy.includes(key)) {
      throw new YattaError(`Cannot filter rollup "${tier.rollupTable}" by "${key}": it is not a group column of this policy.`);
    }
    if (value === null) {
      where.push(`${q(key)} IS NULL`);
    } else {
      where.push(`${q(key)} = ?`);
      params.push(value);
    }
  }
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new YattaError(`Rollup read limit must be a positive integer, got "${String(opts.limit)}".`);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return store.rawAll<RollupRow>(
    `SELECT * FROM ${q(tier.rollupTable)}${whereSql} ORDER BY "bucket_start" ASC LIMIT ?`,
    [...params, limit],
  );
}

/**
 * Runs a policy on a cron schedule, through the existing cron subsystem.
 * Pass a cron expression (default: hourly, `"0 * * * *"`) or a fixed
 * interval. The handler creates the summary tables on first run and
 * then runs every tier; the cron scheduler itself logs and skips over
 * a run that is still in progress. Returns the scheduler, for chaining.
 * Nothing is scheduled until this is called.
 */
export function scheduleRollupPolicy(
  cron: CronScheduler,
  store: TimeSeriesStore,
  policy: RollupPolicyConfig,
  opts: { name?: string; cronExpression?: string; interval?: Duration } = {},
): CronScheduler {
  const normalized = normalizeRollupPolicy(store, policy);
  const name = opts.name ?? `timeseries-rollup:${normalized.source}`;
  const handler = () => {
    runNormalizedPolicy(store, normalized);
  };
  if (opts.interval !== undefined) {
    cron.every(opts.interval, handler, name);
  } else {
    cron.schedule(name, opts.cronExpression ?? "0 * * * *", handler);
  }
  return cron;
}
