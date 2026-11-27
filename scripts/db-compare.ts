#!/usr/bin/env bun
/**
 * Yatta.js database comparison — one workload, five live adapters.
 *
 *   bun scripts/db-compare.ts
 *
 * Benchmarks SQLite, PGlite, Turso (libSQL), DuckDB and SurrealDB through
 * the PUBLIC ORM surface only (`createDatabase`, `col` from `../src/types/db`).
 * Real backends only, never mocks. ScyllaDB is deliberately excluded: it is
 * outside the portable API by design (see docs/adapters.md) and has no adapter.
 *
 * Workload (identical for every adapter):
 *   Schema: users { id: col.id(), name: col.text().searchable(),
 *                   bio: col.text().searchable(), age: col.integer(),
 *                   active: col.boolean(), createdAt: col.createdAt() }
 *   Rows: deterministic. name `User NNNNN`, bio "owns a laptop and writes
 *   code" for every 10th row, otherwise "writes code and reads books",
 *   age 18 + (i % 60) (so 18..77), active unless i % 3 === 0.
 *   - Startup: time from calling createDatabase to ready (first call).
 *   - Insert 1,000 rows one-by-one through the ORM (each `insert()`).
 *   - Insert 10,000 rows via `insertMany`, in 10 chunks of 1,000
 *     (insertMany batches per-row inserts inside one transaction — see
 *     src/types/db/table.ts — so a single 10,000-row call and 10x1,000
 *     measure the same method; chunking keeps any one transaction bounded).
 *   - Latencies, average over 100 reps on the resulting 11,000 rows:
 *     point lookup findFirst({ where: { id: <middle loaded row> } }),
 *     filtered scan findMany({ where: { age: { gte: 70 } } }) (~13% of rows),
 *     sorted+limit findMany({ orderBy: [{ age: "desc" }], take: 10 }).
 *     If a load phase failed for an adapter, its latencies are measured on
 *     the rows that did load, and the table says so — the numbers are then
 *     not directly comparable across adapters.
 *   - Search latency, average over 20 reps: users.search("laptop")
 *     (~1,100 hits of 11,000 rows).
 *   - Rollback: insert 100 rows in a transaction and throw — count unchanged.
 *   - Commit: insert 100 rows in a transaction — count +100 after.
 *   - On-disk size after the 10k bulk load + tx rows (11,100 rows total).
 *   - Persistence: close, reopen the same path/dataDir, verify the row count
 *     (file-backed adapters only; SurrealDB mem:// is not persistent by design).
 *
 * Every timed phase is soft-capped at 120s: if the cap is hit the phase stops
 * and reports the partial number with the reps/rows actually completed,
 * instead of hanging. A step an adapter cannot do at all is reported as
 * not-supported with the reason, never as zero.
 *
 * Each adapter gets a fresh unique tmp dir under os.tmpdir(), removed after
 * its run. Numbers are indicative of this VM, not absolute — see
 * docs/db-comparison.md.
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, col } from "../src/types/db";

// ── Workload constants ──────────────────────────────────────────────────────
const ONE_BY_ONE_ROWS = 1_000;
const BULK_ROWS = 10_000;
const BULK_CHUNK = 1_000;
const LATENCY_REPS = 100;
const SEARCH_REPS = 20;
const TX_ROWS = 100;
const AGE_THRESHOLD = 70;
const PHASE_BUDGET_MS = 120_000;

const schema = {
  users: {
    id: col.id(),
    name: col.text().searchable(),
    bio: col.text().searchable(),
    age: col.integer(),
    active: col.boolean(),
    createdAt: col.createdAt(),
  },
};

type Db = any;

function userRow(i: number) {
  return {
    name: `User ${String(i).padStart(5, "0")}`,
    bio: i % 10 === 0 ? "owns a laptop and writes code" : "writes code and reads books",
    age: 18 + (i % 60),
    active: i % 3 !== 0,
  };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size;
  }
  return total;
}

function fmtBytes(n: number | null, hasDiskFile: boolean): string {
  if (n === null) return hasDiskFile ? "error — not measured" : "n/a (mem:// — no disk file)";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(0)} ms`;
}

// Average latency over up to `reps` repetitions, stopping early at the
// phase budget. Returns the average, how many reps ran, and partial flag.
async function avgLatency(
  reps: number,
  fn: (i: number) => any,
): Promise<{ avgMs: number; reps: number; partial: boolean }> {
  const start = performance.now();
  let total = 0;
  let n = 0;
  for (let i = 0; i < reps; i++) {
    if (performance.now() - start > PHASE_BUDGET_MS) break;
    const t0 = performance.now();
    await fn(i);
    total += performance.now() - t0;
    n++;
  }
  return { avgMs: n ? total / n : Number.NaN, reps: n, partial: n < reps };
}

interface AdapterSpec {
  label: string;
  driver: string;
  /** Build createDatabase options for a fresh DB in `dir`. */
  freshOptions: (dir: string) => any;
  /** Build createDatabase options to reopen the same DB in `dir`. null = not persistent by design. */
  reopenOptions: ((dir: string) => any) | null;
  /** Path/dir whose on-disk size to measure. null = no disk file. */
  sizeDir: (dir: string) => string | null;
  /** Mode: SQLite is sync, the other four are async. */
  sync: boolean;
}

const ADAPTERS: AdapterSpec[] = [
  {
    label: "SQLite",
    driver: "sqlite",
    freshOptions: (dir) => ({ path: join(dir, "bench.db"), schema, forceNew: true }),
    reopenOptions: (dir) => ({ path: join(dir, "bench.db"), schema }),
    sizeDir: (dir) => dir,
    sync: true,
  },
  {
    label: "PGlite",
    driver: "pglite",
    freshOptions: (dir) => ({ driver: "pglite", dataDir: join(dir, "pgdata"), schema, forceNew: true }),
    reopenOptions: (dir) => ({ driver: "pglite", dataDir: join(dir, "pgdata"), schema }),
    sizeDir: (dir) => dir,
    sync: false,
  },
  {
    label: "Turso",
    driver: "turso",
    freshOptions: (dir) => ({ driver: "turso", url: `file:${join(dir, "bench.db")}`, schema, forceNew: true }),
    reopenOptions: (dir) => ({ driver: "turso", url: `file:${join(dir, "bench.db")}`, schema }),
    sizeDir: (dir) => dir,
    sync: false,
  },
  {
    label: "DuckDB",
    driver: "duckdb",
    freshOptions: (dir) => ({ driver: "duckdb", path: join(dir, "bench.duckdb"), schema, forceNew: true }),
    reopenOptions: (dir) => ({ driver: "duckdb", path: join(dir, "bench.duckdb"), schema }),
    sizeDir: (dir) => dir,
    sync: false,
  },
  {
    label: "SurrealDB",
    driver: "surrealdb",
    freshOptions: (_dir) => ({ driver: "surrealdb", url: "mem://", schema, forceNew: true }),
    reopenOptions: null, // mem:// is in-memory by design — nothing to reopen.
    sizeDir: null,
    sync: false,
  },
];

interface AdapterResult {
  label: string;
  startupMs: number | null;
  startupNote: string;
  insert1kRowsPerSec: number | null;
  insert1kRows: number;
  insert1kPartial: boolean;
  bulkRowsPerSec: number | null;
  bulkRows: number;
  bulkPartial: boolean;
  bulkError: string | null;
  /** Rows actually present when latencies were measured (11,000, or fewer if a load phase failed). */
  loadedRows: number;
  pointId: number;
  pointMs: number | null;
  pointReps: number;
  pointPartial: boolean;
  scanMs: number | null;
  scanReps: number;
  scanPartial: boolean;
  sortedMs: number | null;
  sortedReps: number;
  sortedPartial: boolean;
  searchMs: number | null;
  searchReps: number;
  searchPartial: boolean;
  searchHits: number | null;
  searchNote: string;
  rollbackOk: boolean | null;
  rollbackNote: string;
  commitOk: boolean | null;
  commitNote: string;
  diskBytes: number | null;
  hasDiskFile: boolean;
  persistenceOk: boolean | null;
  persistenceNote: string;
  error: string | null;
}

async function runAdapter(spec: AdapterSpec): Promise<AdapterResult> {
  const dir = mkdtempSync(join(tmpdir(), `yatta-db-compare-${spec.driver}-`));
  const r: AdapterResult = {
    label: spec.label,
    startupMs: null, startupNote: "",
    insert1kRowsPerSec: null, insert1kRows: 0, insert1kPartial: false,
    bulkRowsPerSec: null, bulkRows: 0, bulkPartial: false, bulkError: null,
    loadedRows: 0, pointId: 0,
    pointMs: null, pointReps: 0, pointPartial: false,
    scanMs: null, scanReps: 0, scanPartial: false,
    sortedMs: null, sortedReps: 0, sortedPartial: false,
    searchMs: null, searchReps: 0, searchPartial: false, searchHits: null, searchNote: "",
    rollbackOk: null, rollbackNote: "",
    commitOk: null, commitNote: "",
    diskBytes: null, hasDiskFile: spec.sizeDir !== null,
    persistenceOk: null, persistenceNote: "",
    error: null,
  };
  let db: Db = null;
  try {
    // 1. Startup / open.
    const t0 = performance.now();
    db = await createDatabase(spec.freshOptions(dir));
    r.startupMs = performance.now() - t0;

    // 2. Insert 1,000 rows one-by-one through the ORM.
    {
      const start = performance.now();
      let done = 0;
      for (let i = 1; i <= ONE_BY_ONE_ROWS; i++) {
        if (performance.now() - start > PHASE_BUDGET_MS) { r.insert1kPartial = true; break; }
        await db.users.insert(userRow(i));
        done = i;
      }
      const secs = (performance.now() - start) / 1000;
      r.insert1kRows = done;
      r.insert1kRowsPerSec = done / secs;
    }

    // 3. Insert 10,000 rows via insertMany (10 chunks of 1,000). A failure
    // here is recorded, not fatal: later phases run on whatever rows loaded.
    {
      const start = performance.now();
      let done = 0;
      try {
        for (let base = 0; base < BULK_ROWS; base += BULK_CHUNK) {
          if (performance.now() - start > PHASE_BUDGET_MS) { r.bulkPartial = true; break; }
          const chunk = Array.from({ length: BULK_CHUNK }, (_, k) => userRow(ONE_BY_ONE_ROWS + base + k + 1));
          await db.users.insertMany(chunk);
          done += BULK_CHUNK;
        }
      } catch (err: any) {
        r.bulkError = `${err?.message ?? err}`.split("\n")[0];
      }
      const secs = (performance.now() - start) / 1000;
      r.bulkRows = done;
      r.bulkRowsPerSec = done > 0 ? done / secs : null;
    }
    r.loadedRows = await db.users.count();
    if (r.loadedRows !== ONE_BY_ONE_ROWS + r.bulkRows) {
      r.error = `row count mismatch after loads: expected ${ONE_BY_ONE_ROWS + r.bulkRows}, got ${r.loadedRows}`;
    }
    // Point lookup targets a real row: the middle of what actually loaded.
    r.pointId = Math.max(1, Math.floor(r.loadedRows / 2));

    // 4. Latencies (100 reps each) on the loaded rows. Each phase is
    // independent: a failure is recorded and the run continues.
    const point = await avgLatency(LATENCY_REPS, () => db.users.findFirst({ where: { id: r.pointId } }));
    r.pointMs = point.avgMs; r.pointReps = point.reps; r.pointPartial = point.partial;
    const scan = await avgLatency(LATENCY_REPS, () =>
      db.users.findMany({ where: { age: { gte: AGE_THRESHOLD } } }));
    r.scanMs = scan.avgMs; r.scanReps = scan.reps; r.scanPartial = scan.partial;
    const sorted = await avgLatency(LATENCY_REPS, () =>
      db.users.findMany({ orderBy: [{ age: "desc" }], take: 10 }));
    r.sortedMs = sorted.avgMs; r.sortedReps = sorted.reps; r.sortedPartial = sorted.partial;

    // 5. Search latency (20 reps). Every adapter supports search (see docs/adapters.md).
    try {
      const hits = await db.users.search("laptop");
      r.searchHits = Array.isArray(hits) ? hits.length : null;
      const s = await avgLatency(SEARCH_REPS, () => db.users.search("laptop"));
      r.searchMs = s.avgMs; r.searchReps = s.reps; r.searchPartial = s.partial;
    } catch (err: any) {
      r.searchMs = null;
      r.searchNote = `not supported: ${err?.message ?? err}`;
    }

    // 6. Rollback correctness: 100 rows in a tx, then throw.
    {
      const before = await db.users.count();
      try {
        if (spec.sync) {
          db.transaction((tx: Db) => {
            for (let i = 0; i < TX_ROWS; i++) tx.users.insert(userRow(100_000 + i + 1));
            throw new Error("compare-rollback");
          });
        } else {
          await db.transaction(async (tx: Db) => {
            for (let i = 0; i < TX_ROWS; i++) await tx.users.insert(userRow(100_000 + i + 1));
            throw new Error("compare-rollback");
          });
        }
        r.rollbackOk = false;
        r.rollbackNote = "transaction did NOT throw — rollback not triggered";
      } catch (err: any) {
        if (err?.message === "compare-rollback") {
          const after = await db.users.count();
          r.rollbackOk = after === before;
          r.rollbackNote = after === before
            ? `count unchanged at ${after}`
            : `count changed ${before} -> ${after} — rollback FAILED`;
        } else {
          r.rollbackOk = false;
          r.rollbackNote = `unexpected error: ${err?.message ?? err}`;
        }
      }
    }

    // 7. Commit path: 100 rows in a tx, verify present after.
    {
      const before = await db.users.count();
      if (spec.sync) {
        db.transaction((tx: Db) => {
          for (let i = 0; i < TX_ROWS; i++) tx.users.insert(userRow(200_000 + i + 1));
        });
      } else {
        await db.transaction(async (tx: Db) => {
          for (let i = 0; i < TX_ROWS; i++) await tx.users.insert(userRow(200_000 + i + 1));
        });
      }
      const after = await db.users.count();
      r.commitOk = after === before + TX_ROWS;
      r.commitNote = r.commitOk
        ? `count ${before} -> ${after}`
        : `count ${before} -> ${after}, expected ${before + TX_ROWS}`;
    }

    // 8. On-disk size (loaded rows + 100 committed tx rows at this point).
    if (spec.sizeDir) {
      r.diskBytes = dirSizeBytes(spec.sizeDir(dir));
    } else {
      r.diskBytes = null; // SurrealDB mem:// — no disk file, honestly n/a.
    }

    // 9. Persistence across reopen (file-backed only).
    const expectedFinal = r.loadedRows + TX_ROWS;
    if (spec.reopenOptions) {
      await db.close();
      db = null;
      const db2: Db = await createDatabase(spec.reopenOptions(dir));
      try {
        const count = await db2.users.count();
        r.persistenceOk = count === expectedFinal;
        r.persistenceNote = r.persistenceOk
          ? `reopened, count ${count}`
          : `reopened, count ${count}, expected ${expectedFinal}`;
      } finally {
        await db2.close();
      }
    } else {
      r.persistenceOk = null;
      r.persistenceNote = "mem:// is in-memory by design, not persistent";
    }
  } catch (err: any) {
    r.error = `${err?.message ?? err}`;
  } finally {
    try { if (db) await db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
  return r;
}

function cell(v: string): string { return v; }

function mainTable(results: AdapterResult[]): string {
  const headers = ["Metric", ...results.map((r) => r.label)];
  const rows: string[][] = [];
  const fmtThroughput = (r: AdapterResult) =>
    r.insert1kRowsPerSec === null ? "error" : `${r.insert1kRowsPerSec.toFixed(0)} rows/s${r.insert1kPartial ? ` (partial: ${r.insert1kRows}/${ONE_BY_ONE_ROWS} rows)` : ""}`;
  const fmtBulk = (r: AdapterResult) => {
    if (r.bulkError) return `FAILED — ${r.bulkError}${r.bulkRows > 0 ? ` (${r.bulkRows} rows loaded before failure)` : ""}`;
    if (r.bulkRowsPerSec === null) return "error";
    return `${r.bulkRowsPerSec.toFixed(0)} rows/s${r.bulkPartial ? ` (partial: ${r.bulkRows}/${BULK_ROWS} rows)` : ""}`;
  };
  // Latency/search cells are only comparable at equal row counts; flag the
  // adapters whose load phase failed so their smaller dataset is visible.
  const fullLoad = ONE_BY_ONE_ROWS + BULK_ROWS;
  const loadSuffix = (r: AdapterResult) => (r.loadedRows === fullLoad ? "" : ` (on ${r.loadedRows.toLocaleString()} rows)`);
  const fmtLat = (ms: number | null, reps: number, partial: boolean, want: number) =>
    ms === null || Number.isNaN(ms)
      ? "error"
      : `${fmtMs(ms)}${partial ? ` (partial: avg over ${reps}/${want} reps)` : ` (avg over ${reps} reps)`}`;
  const fmtBool = (ok: boolean | null, note: string) =>
    ok === null ? (note ? `n/a — ${note}` : "not reached") : ok ? `yes (${note})` : `NO (${note})`;

  rows.push(["Startup / open", ...results.map((r) => (r.startupMs === null ? "error" : fmtMs(r.startupMs)))]);
  rows.push(["Insert 1,000 rows one-by-one (insert)", ...results.map(fmtThroughput)]);
  rows.push(["Insert 10,000 rows (insertMany, 10×1,000)", ...results.map(fmtBulk)]);
  rows.push(["Point lookup by id (findFirst, avg)", ...results.map((r) => fmtLat(r.pointMs, r.pointReps, r.pointPartial, LATENCY_REPS) + loadSuffix(r))]);
  rows.push(["Filtered scan age >= 70 (findMany, avg)", ...results.map((r) => fmtLat(r.scanMs, r.scanReps, r.scanPartial, LATENCY_REPS) + loadSuffix(r))]);
  rows.push(["Sorted + limit age desc, take 10 (avg)", ...results.map((r) => fmtLat(r.sortedMs, r.sortedReps, r.sortedPartial, LATENCY_REPS) + loadSuffix(r))]);
  rows.push(["Search \"laptop\" (avg)", ...results.map((r) =>
    r.searchMs === null ? (r.searchNote || "error") : `${fmtMs(r.searchMs)} (avg over ${r.searchReps} reps, ${r.searchHits ?? "?"} hits)${loadSuffix(r)}`)]);
  rows.push(["Rollback: 100-row tx + throw, count unchanged", ...results.map((r) => fmtBool(r.rollbackOk, r.rollbackNote))]);
  rows.push(["Commit: 100-row tx, rows present after", ...results.map((r) => fmtBool(r.commitOk, r.commitNote))]);
  rows.push(["On-disk size after load + 100 tx rows", ...results.map((r) => fmtBytes(r.diskBytes, r.hasDiskFile) + (r.hasDiskFile && r.loadedRows !== fullLoad ? ` (${(r.loadedRows + TX_ROWS).toLocaleString()} rows)` : ""))]);
  rows.push(["Persistence across reopen", ...results.map((r) => fmtBool(r.persistenceOk, r.persistenceNote))]);

  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

const FEATURE_MATRIX = `| Capability | SQLite | PGlite | Turso (libSQL) | DuckDB | SurrealDB | ScyllaDB |
|---|---|---|---|---|---|---|
| Mode | sync | async | async | async | async | — (not in portable API) |
| Full-text search | yes — FTS5 | yes — pg_fts (tsvector + GIN) | yes — FTS5 incl. bm25() | yes — LIKE fallback (FTS ext. unavailable offline) | yes — BM25 per searchable column | n/a — outside portable API |
| ACID transactions | yes | yes | yes | yes (failed stmt aborts whole tx) | yes (nested tx throws) | n/a — transactional: false by design |
| Nested tx / savepoints | yes | yes (SAVEPOINT) | yes | no — SAVEPOINT is a parser error; nested call joins outer tx | no — nested transaction() throws | n/a — outside portable API |
| Vectors | yes — sqlite-vec | yes — pgvector | no | no | no | n/a — outside portable API |
| Backup / restore | yes — file copy (VACUUM INTO) | yes — PGlite tar dump/loadDataDir | yes — VACUUM INTO | yes — CHECKPOINT + file copy (in-memory cannot) | yes — EXPORT / IMPORT snapshot | n/a — outside portable API |`;

async function main() {
  console.log("# Yatta.js database comparison");
  console.log("");
  console.log("Workload: users { id, name (searchable), bio (searchable), age, active, createdAt };");
  console.log(`1,000 rows one-by-one + 10,000 rows via insertMany (10x1,000) + 100 tx-commit rows = 11,100 rows;`);
  console.log(`latencies avg over ${LATENCY_REPS} reps; search avg over ${SEARCH_REPS} reps; point lookup = middle loaded row;`);
  console.log(`filtered scan age >= ${AGE_THRESHOLD}; search term "laptop" (~1,100 hits at full load). Each phase soft-capped at 120s.`);
  console.log("");
  const results: AdapterResult[] = [];
  for (const spec of ADAPTERS) {
    console.log(`--- ${spec.label} ---`);
    const r = await runAdapter(spec);
    results.push(r);
    if (r.error) console.log(`  ERROR: ${r.error}`);
    else console.log(`  done: startup ${r.startupMs === null ? "?" : fmtMs(r.startupMs)}, 1k ${r.insert1kRowsPerSec?.toFixed(0) ?? "?"} rows/s, bulk ${r.bulkRowsPerSec?.toFixed(0) ?? "?"} rows/s`);
  }
  console.log("");
  console.log(mainTable(results));
  console.log("");
  // Per-adapter caveats, so a FAILED / partial cell is never read as a number.
  for (const r of results) {
    const notes: string[] = [];
    if (r.bulkError) {
      notes.push(
        `insertMany FAILED: ${r.bulkError} — its latencies, search, disk size and persistence were measured on ${r.loadedRows.toLocaleString()} rows, not 11,000. ` +
        `Root cause (verified separately): Table.insertMany maps rows to Table.insert() and awaits them with Promise.all, so on async drivers the per-row nested savepoint transactions run concurrently; ` +
        `on Turso the RELEASE of the earlier savepoint also releases the later one (SQLite savepoint semantics), and the later RELEASE fails with "no such savepoint". ` +
        `Two inserts inside one explicit db.transaction() work fine, and the session-level insertMany (one tx, sequential loop) is covered by src/test/db.turso-adapter.test.ts — the failure is specific to Table.insertMany through the public ORM. ` +
        `PGlite survives the same concurrency through its single-connection FIFO gate; DuckDB and SurrealDB join the ambient transaction instead of opening savepoints.`,
      );
    }
    if (r.insert1kPartial || r.bulkPartial || r.pointPartial || r.scanPartial || r.sortedPartial || r.searchPartial) {
      notes.push("a phase hit the 120s cap and reports a partial average — see the (partial: …) markers in the table.");
    }
    if (r.error) notes.push(`run error: ${r.error}`);
    if (notes.length > 0) console.log(`Notes — ${r.label}: ${notes.join(" ")}`);
  }
  console.log("");
  console.log("## Feature matrix (from docs/adapters.md — documented capabilities, not re-measured)");
  console.log("");
  console.log(FEATURE_MATRIX);
  console.log("");
  console.log("ScyllaDB is not benchmarked: it is outside the portable API by design");
  console.log("(no adapter, needs a live cluster, transactional: false).");
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    console.log("");
    console.log(`Errors: ${failed.map((r) => `${r.label}: ${r.error}`).join("; ")}`);
    process.exitCode = 1;
  }
}

await main();
