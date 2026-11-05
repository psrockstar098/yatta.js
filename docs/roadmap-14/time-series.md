# Time-series collections and automatic rollups

A time-series table is an ordinary table whose rows arrive stamped with
a time and are read back in time order: sensor readings, request logs,
usage counters. Marking the timestamp column gives the table a
time-ordered index, and a rollup policy summarizes old raw rows into
summary tables on a schedule, so recent data stays detailed and old
data stays small.

```ts
import { createDatabase, col } from "../types/db";

export const schema = {
  readings: {
    id: col.id(),
    at: col.integer().timeSeries(),
    region: col.text(),
    value: col.real(),
  },
};

const db = createDatabase({ path: "Database/app.db", schema });
```

`.timeSeries()` marks the table's timestamp column. At schema sync the
table gets a dedicated index on that column, so time-ordered reads and
range scans use the index instead of sorting the whole table. Mark
exactly one timestamp column per table. Integer milliseconds since
epoch and ISO text timestamps can both be marked; only integer
timestamps can be rolled up (see below). A table with no marked column
is untouched: its write path is exactly the existing one, and no rollup
job runs unless a policy is configured.

Reading in time order is the ordinary query path:

```ts
const recent = db.readings.findMany({ orderBy: { at: "desc" }, limit: 100 });
```

## Rollup policies — aggregate old rows into summary tables

A policy names a source table, numeric measure columns, optional group
columns, and one tier per bucket size. Each tier writes one summary row
per bucket (and per group) holding the row count plus the sum, average,
minimum, and maximum of each measure.

```ts
import { runRollupPolicy, readRollup } from "../types/timeseries";

const policy = {
  source: "readings",
  measures: ["value"],
  groupBy: ["region"],
  tiers: [
    { name: "hourly", window: "hour", olderThan: "30d" },
    { name: "daily", window: "day", olderThan: "90d" },
  ],
};

// Summarize every complete window older than each tier's cutoff.
runRollupPolicy(db, policy);

// Read a tier's summary table, oldest bucket first.
const hours = readRollup(db, policy, "hourly", { from: Date.now() - 7 * 86400_000 });
```

The time column defaults to the table's `.timeSeries()` column, and a
tier's summary table defaults to `<source>_<tier>` (`readings_hourly`
above). Tiers use fixed bucket sizes: `minute`, `hour`, `day`, `week`.
Durations are milliseconds or a string with a unit: `ms`, `s`, `m`,
`h`, `d`, `w` (for example `"30d"`).

A tier only summarizes complete windows: a window is rolled up once its
end sits at or before the cutoff (`now - olderThan`), so a window still
receiving rows is never summarized early. Rows in an incomplete window
wait for a later run.

Summary tables are plain SQLite tables, not schema tables, created on
first use. Read them with `readRollup()` or directly:

```ts
const rows = db.unsafeTable("readings_hourly").findMany({
  where: { region: "north" },
  orderBy: { bucket_start: "asc" },
});
```

A summary row holds `bucket_start`, `bucket_end`, `row_count`, one
column per group, and `<measure>_sum`, `<measure>_avg`, `<measure>_min`,
`<measure>_max` per measure.

## Policies from a hand-edited config file

A policy kept in a file can be written as JSON5 instead of strict
JSON, so comments and trailing commas stay legal:

```ts
import { parseRollupPolicyConfig } from "../types/timeseries";
import { readFileSync } from "node:fs";

const policy = parseRollupPolicyConfig(readFileSync("rollups.json5", "utf8"));
runRollupPolicy(db, policy);
```

```json5
{
  // Summarize old readings by the hour.
  source: "readings",
  measures: ["value"],
  groupBy: ["region"],
  tiers: [
    { name: "hourly", window: "hour", olderThan: "30d" },
  ],
}
```

Parsing only parses: the policy is validated against the schema when
it runs, and a bad policy throws before any table is created or row is
touched. Plain JSON parses too, since JSON5 is a superset of it.

## Running policies on a schedule

Policies run through the existing cron subsystem. Nothing is scheduled
until the app calls this:

```ts
import { createCron } from "../types/job";
import { scheduleRollupPolicy } from "../types/timeseries";

const cron = createCron();
scheduleRollupPolicy(cron, db, policy); // hourly by default: "0 * * * *"
scheduleRollupPolicy(cron, db, policy, { interval: "6h" }); // or a fixed interval
```

The cron scheduler skips a run that is still in progress rather than
overlapping it, and logs a failed run instead of stopping the schedule.

## Idempotency — re-running a tier never double-counts

Each tier run deletes a window's summary rows and re-inserts them
inside one transaction for the tier, so re-running the same window
replaces its summaries instead of adding to them. A crash mid-run rolls
the whole tier back to its previous state: no half-written windows, no
half-deleted raw rows. A later tier failing leaves earlier tiers' work
in place.

This also covers late-arriving old rows: a row that lands in an already
summarized window is picked up by the next run, which replaces that
window's summary with the corrected one.

## Opt-in and lazy — zero cost when unconfigured

Time-series support is fully opt-in. Tables without the marker take the
exact existing write path: no extra index, no extra statement, no
rollup table. No policy means no job, no schedule, and no import cost:
the database module never imports the rollup module, so an app that
never imports it pays nothing for it.

## Bun runtime notes

These are the deliberate non-choices, so a later reader does not
re-litigate them:

- **No string-to-code anywhere.** The feature builds SQL strings from
  validated identifiers and bound parameters, but never turns a string
  into JavaScript code: no `eval`, no `new Function`, no `node:vm`, no
  Worker-from-string, no bundler plugin returning `contents`. It
  therefore runs unchanged under
  `--disallow-code-generation-from-strings`, including `=strict`.
  (SQL text is data for SQLite, not code for the JS engine.)
- **No runtime flags are set by the feature.** `--smol` trades speed
  for memory and is an operator's explicit choice for a
  memory-constrained deployment, never a default the library picks.
  Rollup jobs set no flags at all.
- **Typed hot paths.** The per-window loop and every policy function
  are fully typed, and the heavy aggregation itself runs inside SQLite
  rather than in a JavaScript loop — so an ahead-of-time build
  (`bun compile`) has typed code to work with instead of untyped code
  that can run slower than under the JIT. `bun compile --explain`
  lists any slow path, worst first, if a future change adds one.
- **No C via `bun:ffi`.** The C compiler path exists only where a
  profiler proves a hot path needs it, and TinyCC is fast to compile
  but not an optimizing compiler. Nothing here qualifies: aggregation
  is SQLite's work, and the surrounding JavaScript is a small loop over
  windows. The feature also uses no `cc()`, so it runs fine under
  `--no-ffi-cc` and `--no-addons`.
- **No bundler codegen.** `Bun.build()`'s `files` map bundles virtual
  files from memory without temp files, but this feature generates no
  code and writes no temp files, so there is nothing to route through
  it. If a future step ever generates code, that is the sanctioned
  path to use instead of a temp file.

## Gotchas

### Raw deletion is opt-in only — the default keeps every raw row

A policy aggregates without deleting unless a tier says so explicitly:

```ts
// DANGER: this tier deletes the raw rows it summarizes.
const policy = {
  source: "readings",
  measures: ["value"],
  tiers: [{ name: "hourly", window: "hour", olderThan: "30d", deleteRaw: true }],
};
```

Only `deleteRaw: true` deletes, and only the rows inside windows the
tier just summarized — recent rows and rows in incomplete windows are
never touched. Anything else, including omitting the flag, keeps every
raw row. Deletion happens in the same transaction as the summary
insert, so a failed run deletes nothing. There is no undo: once raw
rows are deleted, only their summaries remain.

### Rollups need integer timestamps

The bucket math divides integer timestamps. A `.timeSeries()` column
holding ISO text (for example from `col.createdAt()`) still gets its
time-ordered index, but a policy over it is rejected: use
`col.integer().timeSeries()` for the timestamp a policy rolls up, or
name an integer time column in the policy's `timeColumn`.

### Months are not a bucket size

Month buckets have uneven lengths, so the tier windows are fixed sizes
only: `minute`, `hour`, `day`, `week`. A monthly summary is a `day`
tier read back and grouped by month by the caller, or a second policy
over a `day` summary table.

### Changing a policy needs a new summary table

A summary table's columns come from the policy's measures and groups at
creation time. If a table of the same name already holds a different
shape, the run is refused rather than written into blindly — pick a
different `rollupTable` for the changed tier. Renaming a tier likewise
points it at a fresh table; the old table stays on disk until dropped
by hand.

### NULL measures and NULL groups

Aggregate functions skip NULL measures: a row with a NULL measure still
counts in `row_count`, but contributes nothing to sum, average, min, or
max. A NULL group summarizes into a single row with a NULL group value,
readable with `where: { region: null }`.

### One summary table per tier

Two tiers must not share a `rollupTable`: a tier run deletes by bucket
start before re-inserting, and bucket starts overlap across window
sizes, so sharing would delete the other tier's rows. Policies are
validated up front and a shared table is rejected before anything runs.
