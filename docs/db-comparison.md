# Database comparison

One workload, five live adapters, through the public ORM surface only
(`createDatabase`, `col`). ScyllaDB is not benchmarked: it is outside the
portable API by design (no adapter, needs a live cluster,
`transactional: false`) — see `docs/adapters.md`.

## How to regenerate

```sh
bun scripts/db-compare.ts
```

The script is self-contained (`scripts/db-compare.ts`). It benchmarks each
adapter in turn with real backends only — SQLite file, PGlite `dataDir`,
Turso `file:`, DuckDB file, SurrealDB `mem://` (embedded) — in a fresh
unique tmp dir per adapter, removed afterwards. Nothing else needs to be
running while it runs; it takes about 2 minutes on this VM.

## Workload (identical for every adapter)

Schema (the round-trip shape, `users` table only):

```ts
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
```

Rows are deterministic: `name` is `User NNNNN`; `bio` is
`"owns a laptop and writes code"` for every 10th row, otherwise
`"writes code and reads books"`; `age` is `18 + (i % 60)` (so 18–77);
`active` is false when `i % 3 === 0`.

| Step | Method |
|---|---|
| Startup / open | Time from calling `createDatabase` to ready (first call, schema sync included). |
| Insert 1,000 rows one-by-one | `users.insert(row)` per row; reported as rows/sec. |
| Insert 10,000 rows | `users.insertMany(chunk)` in 10 chunks of 1,000; reported as rows/sec. Note: `insertMany` batches per-row inserts inside one transaction (see `src/types/db/table.ts`), so this measures the batched method, not a single bulk SQL statement. |
| Point lookup | `users.findFirst({ where: { id } })`, id = middle loaded row (5,500 at full load); average over 100 reps, ms. |
| Filtered scan | `users.findMany({ where: { age: { gte: 70 } } })` (~13% of rows, ~1,430 at full load); average over 100 reps, ms. |
| Sorted + limit | `users.findMany({ orderBy: [{ age: "desc" }], take: 10 })`; average over 100 reps, ms. |
| Search | `users.search("laptop")` (~1,100 hits at full load); average over 20 reps, ms. |
| Rollback | Insert 100 rows inside a transaction and throw; verify the count is unchanged after. |
| Commit | Insert 100 rows inside a transaction; verify the count is +100 after. |
| On-disk size | Total size of the adapter's tmp dir after load + the 100 committed tx rows (11,100 rows at full load). |
| Persistence | Close, reopen the same path / `dataDir`, verify the row count. File-backed adapters only. |

Every timed phase is soft-capped at 120s: if the cap is hit the phase stops
and reports the partial number with the reps/rows actually completed. A step
an adapter cannot do at all is recorded as failed / not-supported with the
reason, never as zero.

## Results (measured 2026-11-27, branch `wip/multidb-phase2`)

| Metric | SQLite | PGlite | Turso | DuckDB | SurrealDB |
| --- | --- | --- | --- | --- | --- |
| Startup / open | 6.52 ms | 5711 ms | 618 ms | 1439 ms | 584 ms |
| Insert 1,000 rows one-by-one (insert) | 3389 rows/s | 609 rows/s | 1708 rows/s | 171 rows/s | 233 rows/s |
| Insert 10,000 rows (insertMany, 10×1,000) | 17162 rows/s | 1569 rows/s | 2747 rows/s | 329 rows/s | 409 rows/s |
| Point lookup by id (findFirst, avg) | 0.04 ms (avg over 100 reps) | 0.48 ms (avg over 100 reps) | 0.15 ms (avg over 100 reps) | 2.99 ms (avg over 100 reps) | 1.70 ms (avg over 100 reps) |
| Filtered scan age >= 70 (findMany, avg) | 1.65 ms (avg over 100 reps) | 20.5 ms (avg over 100 reps) | 7.10 ms (avg over 100 reps) | 8.71 ms (avg over 100 reps) | 33.7 ms (avg over 100 reps) |
| Sorted + limit age desc, take 10 (avg) | 1.09 ms (avg over 100 reps) | 2.89 ms (avg over 100 reps) | 1.20 ms (avg over 100 reps) | 4.30 ms (avg over 100 reps) | 9.69 ms (avg over 100 reps) |
| Search "laptop" (avg) | 7.24 ms (avg over 20 reps, 1100 hits) | 83.9 ms (avg over 20 reps, 1100 hits) | 14.9 ms (avg over 20 reps, 1100 hits) | 81.9 ms (avg over 20 reps, 1100 hits) | 137 ms (avg over 20 reps, 1100 hits) |
| Rollback: 100-row tx + throw, count unchanged | yes (count unchanged at 11000) | yes (count unchanged at 11000) | yes (count unchanged at 11000) | yes (count unchanged at 11000) | yes (count unchanged at 11000) |
| Commit: 100-row tx, rows present after | yes (count 11000 -> 11100) | yes (count 11000 -> 11100) | yes (count 11000 -> 11100) | yes (count 11000 -> 11100) | yes (count 11000 -> 11100) |
| On-disk size after load + 100 tx rows | 4.55 MB | 42.43 MB | 4.55 MB | 1.21 MB | n/a (mem:// — no disk file) |
| Persistence across reopen | yes (reopened, count 11100) | yes (reopened, count 11100) | yes (reopened, count 11100) | yes (reopened, count 11100) | n/a — mem:// is in-memory by design, not persistent |

**Reading the numbers.** These were measured on this VM (a small shared
Linux VM, quiet at run time) and are indicative, not absolute: re-runs move
by roughly 10–30% per cell (e.g. PGlite search measured 92 ms, 150 ms and
112 ms across three runs; SQLite bulk 16k–20k rows/s). The ordering is
stable across runs: SQLite is fastest at every step by a wide margin;
PGlite pays ~6s startup (WASM init) and the largest disk footprint
(42 MB, mostly the PGlite data dir, not the 11k rows); DuckDB and
SurrealDB are the slowest per-row writers here (a few hundred rows/s
one-by-one). PGlite's startup includes first-init WASM work; reopening an
existing `dataDir` is faster than the ~6s first open measured here.

**Turso now completes the full load.** An earlier run of this comparison
caught Turso's `insertMany` failing (see below); it is fixed, and every
adapter in the table above was measured on the full 11,100 rows.

## Turso `insertMany` failure — found by this comparison, now fixed

`Table.insertMany` used to fail on Turso through the public ORM with:

```
SQLITE_ERROR: no such savepoint: yatta_sp_2
SQL: RELEASE SAVEPOINT "yatta_sp_2";
```

Reproduced independently of the benchmark: `insertMany` of 3 rows failed
the same way, while two `insert()` calls inside one explicit
`db.transaction()` succeeded. Root cause: `Table.insertMany`
(`src/types/db/table.ts`) mapped rows to `Table.insert()` and awaited them
with `Promise.all` (`allResults` in `src/types/db/adapter.ts`), so on async
drivers the per-row nested savepoint transactions ran concurrently. On
Turso the `RELEASE` of the earlier savepoint also releases the later one
(SQLite savepoint semantics), and the later `RELEASE` then failed with
"no such savepoint". The session-level `insertMany` (one transaction,
sequential loop) is covered by `src/test/db.turso-adapter.test.ts` and
worked — the failure was specific to `Table.insertMany` through the public
ORM. PGlite survived the same concurrency through its single-connection
FIFO gate; DuckDB and SurrealDB join the ambient transaction instead of
opening savepoints, so they never hit it. The ORM round-trip tests
(`src/test/db.orm-roundtrip.*.test.ts`) never exercised `insertMany`, which
is why the per-adapter verification passed while this step failed.

Fix: `Table.insertMany` now runs its rows sequentially via a new
`collectSequential` helper (`src/types/db/adapter.ts`), the value-collecting
sibling of the existing `runSequential` — sequential per-row work inside a
transaction is the codebase's standing correctness rule for
single-connection drivers. Re-measured after the fix, Turso's `insertMany`
loads 10,000 rows at 2,747 rows/s, and an `insertMany` step was added to
all five ORM round-trip test files so the path stays covered.

## Feature matrix (from `docs/adapters.md` — documented capabilities, not re-measured)

| Capability | SQLite | PGlite | Turso (libSQL) | DuckDB | SurrealDB | ScyllaDB |
|---|---|---|---|---|---|---|
| Mode | sync | async | async | async | async | — (not in portable API) |
| Full-text search | yes — FTS5 | yes — pg_fts (tsvector + GIN) | yes — FTS5 incl. bm25() | yes — LIKE fallback (FTS ext. unavailable offline) | yes — BM25 per searchable column | n/a — outside portable API |
| ACID transactions | yes | yes | yes | yes (failed stmt aborts whole tx) | yes (nested tx throws) | n/a — transactional: false by design |
| Nested tx / savepoints | yes | yes (SAVEPOINT) | yes | no — SAVEPOINT is a parser error; nested call joins outer tx | no — nested transaction() throws | n/a — outside portable API |
| Vectors | yes — sqlite-vec | yes — pgvector | no | no | no | n/a — outside portable API |
| Backup / restore | yes — file copy (VACUUM INTO) | yes — PGlite tar dump/loadDataDir | yes — VACUUM INTO | yes — CHECKPOINT + file copy (in-memory cannot) | yes — EXPORT / IMPORT snapshot | n/a — outside portable API |

Notes on the matrix: the search column is confirmed live by this run —
every adapter returned the expected hits for `search("laptop")` (1,100 at
full load). Transactions are confirmed live by this run too — rollback and commit both verified correct on all five
adapters. Nested transactions / savepoints, vectors and backup/restore are
taken from `docs/adapters.md` as documented and were not re-measured here.
