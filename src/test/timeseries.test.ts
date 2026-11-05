import { describe, it, expect, afterEach } from "bun:test";
import { createDatabase, col, YattaError, type TypedDatabase } from "../types/db";
import { createCron } from "../types/job";
import {
  normalizeRollupPolicy,
  ensureRollupTables,
  runRollupPolicy,
  runRollupTier,
  readRollup,
  scheduleRollupPolicy,
  timeSeriesColumnName,
  listTimeSeriesTables,
  type RollupPolicyConfig,
} from "../types/timeseries";

const schema = {
  readings: {
    id: col.id(),
    at: col.integer().timeSeries(),
    region: col.text(),
    value: col.real(),
  },
  plain: {
    id: col.id(),
    at: col.integer(),
    value: col.real(),
  },
};

type TestDb = TypedDatabase<typeof schema>;
const dbs: TestDb[] = [];
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Fixed base: 2026-01-01 00:00 UTC, so hour buckets land on round hours.
const BASE = Date.UTC(2026, 0, 1);

function memDb(): TestDb {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true });
  dbs.push(db);
  return db;
}

function seed(db: TestDb) {
  const t = db.table("readings");
  t.insert({ at: BASE + 30 * MIN, region: "north", value: 30 });
  t.insert({ at: BASE + 0, region: "north", value: 10 });
  t.insert({ at: BASE + 10 * MIN, region: "north", value: 20 });
  t.insert({ at: BASE + 70 * MIN, region: "north", value: 5 });
  t.insert({ at: BASE + 80 * MIN, region: "south", value: 15 });
}

const policy: RollupPolicyConfig = {
  source: "readings",
  measures: ["value"],
  groupBy: ["region"],
  tiers: [
    { name: "hourly", window: "hour", olderThan: "1d" },
    { name: "daily", window: "day", olderThan: "7d" },
  ],
};

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }
  dbs.length = 0;
});

describe("time-series schema marker", () => {
  it("creates a time-ordered index for the marked column only", () => {
    const db = memDb();
    const indexes = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'readings'`,
    );
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_timeseries_readings_at");
    const plain = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'plain'`,
    );
    expect(plain.map((i) => i.name)).not.toContain("idx_timeseries_plain_at");
    expect(timeSeriesColumnName(db as any, "readings")).toBe("at");
    expect(timeSeriesColumnName(db as any, "plain")).toBeNull();
    expect(listTimeSeriesTables(db as any)).toEqual(["readings"]);
  });

  it("reads rows back in time order through the ordinary query path", () => {
    const db = memDb();
    seed(db);
    const rows = db.table("readings").findMany({ orderBy: { at: "desc" } });
    expect(rows.map((r) => r.at)).toEqual([
      BASE + 80 * MIN,
      BASE + 70 * MIN,
      BASE + 30 * MIN,
      BASE + 10 * MIN,
      BASE,
    ]);
  });

  it("rejects a non-timestamp column and two marked columns in one table", () => {
    expect(() => col.real().timeSeries()).toThrow(YattaError);
    expect(() =>
      createDatabase({
        path: ":memory:",
        schema: {
          bad: { a: col.integer().timeSeries(), b: col.integer().timeSeries() },
        },
        forceNew: true,
      }),
    ).toThrow(YattaError);
  });

  it("does not add a second identical index when .index() is already set", () => {
    const db = createDatabase({
      path: ":memory:",
      schema: { both: { id: col.id(), at: col.integer().index().timeSeries() } },
      forceNew: true,
    });
    dbs.push(db as any);
    const indexes = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'both'`,
    );
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_both_at");
    expect(names).not.toContain("idx_timeseries_both_at");
  });
});

describe("rollup policies", () => {
  it("aggregates count, sum, avg, min, and max per tier and per group", () => {
    const db = memDb();
    seed(db);
    const result = runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    expect(result.tiers.map((t) => t.tier)).toEqual(["hourly", "daily"]);
    const hourly = readRollup(db as any, policy, "hourly");
    expect(hourly).toHaveLength(3);
    const hour0North = hourly.find((r) => r.bucket_start === BASE && r.region === "north")!;
    expect(hour0North.bucket_end).toBe(BASE + HOUR);
    expect(hour0North.row_count).toBe(3);
    expect(hour0North.value_sum).toBe(60);
    expect(hour0North.value_avg).toBe(20);
    expect(hour0North.value_min).toBe(10);
    expect(hour0North.value_max).toBe(30);
    const hour1South = hourly.find((r) => r.bucket_start === BASE + HOUR && r.region === "south")!;
    expect(hour1South.row_count).toBe(1);
    expect(hour1South.value_sum).toBe(15);
    const daily = readRollup(db as any, policy, "daily");
    expect(daily).toHaveLength(2);
    const dayNorth = daily.find((r) => r.region === "north")!;
    expect(dayNorth.row_count).toBe(4);
    expect(dayNorth.value_sum).toBe(65);
    expect(dayNorth.value_avg).toBe(16.25);
  });

  it("is idempotent: re-running a tier replaces windows instead of double-counting", () => {
    const db = memDb();
    seed(db);
    runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    const second = runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    expect(second.tiers[0].windows).toBe(2);
    const hourly = readRollup(db as any, policy, "hourly");
    expect(hourly).toHaveLength(3);
    const hour0North = hourly.find((r) => r.bucket_start === BASE && r.region === "north")!;
    expect(hour0North.row_count).toBe(3);
    expect(hour0North.value_sum).toBe(60);
  });

  it("leaves an incomplete window alone until a later run", () => {
    const db = memDb();
    seed(db);
    // Cutoff 30 minutes into hour 1: hour 0 is complete, hour 1 is not.
    const now = BASE + HOUR + 30 * MIN + DAY;
    const result = runRollupPolicy(db as any, { ...policy, tiers: [policy.tiers[0]] }, { now });
    expect(result.tiers[0].windows).toBe(1);
    const hourly = readRollup(db as any, policy, "hourly");
    expect(hourly).toHaveLength(1);
    expect(hourly[0].bucket_start).toBe(BASE);
  });

  it("default policy deletes nothing", () => {
    const db = memDb();
    seed(db);
    const result = runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    expect(result.tiers.every((t) => t.rowsDeleted === 0)).toBe(true);
    expect(db.table("readings").findMany({})).toHaveLength(5);
  });

  it("opt-in deletion deletes only rolled-up raw rows", () => {
    const db = memDb();
    seed(db);
    const recent = BASE + 10 * DAY - 30 * MIN;
    db.table("readings").insert({ at: recent, region: "north", value: 99 });
    const deleting: RollupPolicyConfig = {
      source: "readings",
      measures: ["value"],
      groupBy: ["region"],
      tiers: [{ name: "hourly", window: "hour", olderThan: "1d", deleteRaw: true }],
    };
    const result = runRollupPolicy(db as any, deleting, { now: BASE + 10 * DAY });
    expect(result.tiers[0].rowsDeleted).toBe(5);
    const remaining = db.table("readings").findMany({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].at).toBe(recent);
    expect(remaining[0].value).toBe(99);
    // Summaries for the deleted windows are still readable.
    expect(readRollup(db as any, deleting, "hourly")).toHaveLength(3);
  });

  it("reads a tier with time ranges and group filters", () => {
    const db = memDb();
    seed(db);
    runRollupPolicy(db as any, policy, { now: BASE + 10 * DAY });
    const north = readRollup(db as any, policy, "hourly", { where: { region: "north" } });
    expect(north).toHaveLength(2);
    const later = readRollup(db as any, policy, "hourly", { from: BASE + HOUR });
    expect(later).toHaveLength(2);
    expect(() => readRollup(db as any, policy, "hourly", { where: { value: 1 } })).toThrow(YattaError);
    expect(readRollup(db as any, policy, "hourly", { where: { region: "nowhere" } })).toHaveLength(0);
  });

  it("returns an empty list when nothing has been rolled up yet", () => {
    const db = memDb();
    expect(readRollup(db as any, policy, "hourly")).toEqual([]);
  });

  it("unconfigured tables pay no rollup cost", () => {
    const db = memDb();
    db.table("plain").insert({ at: BASE, value: 1 });
    const tables = db.rawAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plain%'`,
    );
    expect(tables.map((t) => t.name)).toEqual(["plain"]);
    expect(listTimeSeriesTables(db as any)).toEqual(["readings"]);
  });
});

describe("rollup policy validation", () => {
  it("rejects unknown tables, columns, and non-numeric measures", () => {
    const db = memDb();
    expect(() => normalizeRollupPolicy(db as any, { ...policy, source: "missing" })).toThrow(YattaError);
    expect(() => normalizeRollupPolicy(db as any, { ...policy, measures: ["region"] })).toThrow(YattaError);
    expect(() => normalizeRollupPolicy(db as any, { ...policy, measures: ["nope"] })).toThrow(YattaError);
    expect(() => normalizeRollupPolicy(db as any, { ...policy, groupBy: ["at"] })).toThrow(YattaError);
    expect(() => normalizeRollupPolicy(db as any, { ...policy, tiers: [] })).toThrow(YattaError);
    expect(() =>
      normalizeRollupPolicy(db as any, { ...policy, tiers: [{ name: "hourly", window: "month" as any, olderThan: "1d" }] }),
    ).toThrow(YattaError);
  });

  it("rejects crafted identifiers instead of splicing them into SQL", () => {
    const db = memDb();
    seed(db);
    const evil: RollupPolicyConfig = {
      source: `readings"; DROP TABLE readings;--`,
      measures: ["value"],
      tiers: [{ name: "hourly", window: "hour", olderThan: "1d" }],
    };
    expect(() => normalizeRollupPolicy(db as any, evil)).toThrow(YattaError);
    expect(() =>
      normalizeRollupPolicy(db as any, { ...policy, measures: [`value"; DROP TABLE readings;--`] }),
    ).toThrow(YattaError);
    // The table survived the rejected policies untouched.
    expect(db.table("readings").findMany({})).toHaveLength(5);
  });

  it("rejects two tiers sharing one summary table and a zero duration", () => {
    const db = memDb();
    expect(() =>
      normalizeRollupPolicy(db as any, {
        ...policy,
        tiers: [
          { name: "a", window: "hour", olderThan: "1d", rollupTable: "shared" },
          { name: "b", window: "day", olderThan: "7d", rollupTable: "shared" },
        ],
      }),
    ).toThrow(YattaError);
    expect(() =>
      normalizeRollupPolicy(db as any, {
        ...policy,
        tiers: [{ name: "hourly", window: "hour", olderThan: "0d" }],
      }),
    ).toThrow(YattaError);
  });

  it("summarizes NULL groups into one row and keeps group filters parameterized", () => {
    const nullableSchema = {
      events: {
        id: col.id(),
        at: col.integer().timeSeries(),
        region: col.text().nullable(),
        value: col.real(),
      },
    };
    const db2 = createDatabase({ path: ":memory:", schema: nullableSchema, forceNew: true });
    dbs.push(db2 as any);
    db2.table("events").insert({ at: BASE + 5 * MIN, region: null, value: 4 });
    db2.table("events").insert({ at: BASE + 6 * MIN, region: null, value: 6 });
    db2.table("events").insert({ at: BASE + 7 * MIN, region: `nor"th`, value: 8 });
    const p = {
      source: "events",
      measures: ["value"],
      groupBy: ["region"],
      tiers: [{ name: "hourly", window: "hour", olderThan: "1d" }],
    } as const;
    runRollupPolicy(db2 as any, p as any, { now: BASE + 10 * DAY });
    runRollupPolicy(db2 as any, p as any, { now: BASE + 10 * DAY });
    const rows = readRollup(db2 as any, p as any, "hourly");
    expect(rows).toHaveLength(2);
    const nullGroup = rows.find((r) => r.region === null)!;
    expect(nullGroup.row_count).toBe(2);
    expect(nullGroup.value_sum).toBe(10);
    // A quote inside a filter value must not break the query or match
    // anything it should not: values are bound, never spliced.
    const quoted = readRollup(db2 as any, p as any, "hourly", { where: { region: `nor"th` } });
    expect(quoted).toHaveLength(1);
    expect(quoted[0].value_sum).toBe(8);
  });

  it("defaults the time column to the marked column and the table name to source_tier", () => {
    const db = memDb();
    const normalized = normalizeRollupPolicy(db as any, policy);
    expect(normalized.timeColumn).toBe("at");
    expect(normalized.tiers[0].rollupTable).toBe("readings_hourly");
    expect(normalized.tiers[0].deleteRaw).toBe(false);
  });

  it("refuses a rollup table name already holding a different shape", () => {
    const db = memDb();
    db.rawRun(`CREATE TABLE "readings_hourly" (something TEXT)`);
    expect(() => ensureRollupTables(db as any, policy)).toThrow(YattaError);
  });
});

describe("cron scheduling", () => {
  it("registers and stops a rollup task on the existing cron scheduler", () => {
    const db = memDb();
    const cron = createCron();
    const returned = scheduleRollupPolicy(cron, db as any, policy, { interval: "1h" });
    expect(returned).toBe(cron);
    // Stopping a registered task must not throw; the timer is unref'd,
    // so scheduling alone never keeps the process alive.
    cron.stop("timeseries-rollup:readings");
  });

  it("a tier run inside a caller transaction rolls back with it", () => {
    const db = memDb();
    seed(db);
    const normalized = normalizeRollupPolicy(db as any, policy);
    expect(() =>
      db.transaction(() => {
        runRollupTier(db as any, normalized, normalized.tiers[0], { now: BASE + 10 * DAY });
        throw new Error("caller aborts");
      }),
    ).toThrow("caller aborts");
    expect(readRollup(db as any, policy, "hourly")).toEqual([]);
  });
});
