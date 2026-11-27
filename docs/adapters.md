# Database adapters

Yatta's ORM talks to storage through one interface, `DatabaseAdapter`, and
one config value, the driver. The driver picks the execution mode: SQLite is
sync; PGlite, Turso, DuckDB, and SurrealDB are async. Everything above the
adapter — `Table`, the query DSL, relations, migrations, search
orchestration — knows only `DatabaseAdapter` and `DatabaseSession`. It never
sees SQL, a driver, or a file.

`YattaDB` and `Table` are generic over the execution mode `M` (`"sync"` or
`"async"`), and every method returns `ModeResult<M, T>` — the plain value
for SQLite, a Promise for the async drivers. SQLite callers keep sync
types; async callers are forced by TypeScript to await. `QueryBuilder`
terminals (`all`, `first`, `count`, `exists`, `paginate`) follow the same
rule. `createDatabase` is overloaded the same way: SQLite returns its typed
proxy synchronously, the async drivers return a Promise of the proxy,
resolved after the driver connects and the schema syncs.

ScyllaDB is outside the portable API (see below) and has no adapter yet.

## The one rule

> **The adapter is the only thing that knows SQL, a driver, or a file.
> Everything above it knows only `DatabaseAdapter` and `DatabaseSession`.**

If a line of code in `src/types/db/` or `src/func/db.ts` outside
`src/types/db/adapters/*` mentions `bun:sqlite`, `Database`, `db.query`,
`db.prepare`, `?` placeholders, or a file path, the refactor is incomplete.
(The two exceptions are deliberate and out of scope: `cloud_backups.ts` and
`cache_queue.ts` use `bun:sqlite` for their own stores, not for the ORM.)

## The interface

`src/types/db/adapter.ts` is the only new public type surface of this phase.
Everything else is a move, not a new API.

```ts
import { createAdapter } from "yatta.js/db";

// SQLite is the default; this is the same database createDatabase() opens.
const sqlite = createAdapter("sqlite", { path: "Database/app.db" });

// All five adapters are live now — each returns its own session type.
const pg = createAdapter("pglite", { dataDir: "./pgdata" });
const turso = createAdapter("turso", { url: "file:./app.db" });
const duck = createAdapter("duckdb", { path: "./app.duckdb" });
const surreal = createAdapter("surrealdb", { url: "mem://" });
```

`DatabaseSession<M>` is the execution scope shared by the root adapter and
active transaction handles. It carries the CRUD surface (`insert`,
`insertMany`, `find`, `count`, `update`, `delete`, `upsert`), ranked
full-text `search`, the FTS maintenance methods (`syncSearchRow`,
`rebuildSearchIndex`, `searchVocabulary`), the migration-marker methods
(`ensureMigrationTable`, `listAppliedMigrations`, `recordMigration`), the
raw escape hatches (`executeRaw`, `executeBatch`), and `transaction`.
Search lives on the session, not only on the adapter, because a search must
work inside a transaction — the session is the transaction boundary.

`DatabaseAdapter<M>` extends the session with the lifecycle: `driver`,
`ready()`, `syncSchema(schema)`, `listTables()`, `listColumns(table)`,
`withMigrationLock(fn)`, `backup(destPath)`, `restore(sourcePath)`, `close()`.

The root adapter IS the root session. A transaction hands `fn` a session;
on SQLite that is the same session object (bun:sqlite nests via savepoints
on one connection). On PGlite and SurrealDB it is a real child session; on
DuckDB it is the same object tracked by `AsyncLocalStorage` (nested calls
join the outer transaction); on Turso it is a child session like PGlite's.

`Table` has two execution paths, chosen by `capabilities.compilerSql`:
SQL drivers (SQLite, PGlite, Turso, DuckDB) compile through the dialect's
compiler and execute via `db.run`; SurrealDB (`compilerSql: false`) has no
runnable SQL — its dialect refuses every SQL-emitting compiler method — so
`Table` calls the session's `insert` / `find` / `count` / `update` /
`delete` / `search` with dialect-neutral `Compiled*` shapes instead. A
schemaless table (`unsafeTable`) can only run on a SQL driver: the session
methods need column definitions.

## Capability table

| Capability | SQLite | PGlite | Turso (libSQL) | DuckDB | SurrealDB |
|---|---|---|---|---|---|
| Mode | sync | async | async | async | async |
| Joins | no — relations are batched separate queries | no | no | no | no |
| Foreign keys | yes | yes | yes | emulated in `delete()` — DuckDB rejects `ON DELETE CASCADE` / `SET NULL` at parse, so the dialect emits bare `REFERENCES` and the adapter cascades from an FK registry built at `syncSchema` | no — not enforced |
| ACID transactions | yes | yes | yes | yes, but a failed statement aborts the whole transaction (Postgres-style) | yes, but nested `transaction()` throws (no savepoints) |
| Savepoints | yes | yes (nested tx uses `SAVEPOINT`) | yes | **no** — `SAVEPOINT` is a parser error in DuckDB 2.0.1; a nested call joins the outer transaction and an inner failure rolls back everything | no |
| RETURNING clause | yes | yes | yes | yes | yes (CREATE/UPDATE/UPSERT return records; DELETE returns nothing, so the adapter counts first) |
| Full-text search | FTS5 | pg_fts (tsvector + GIN on a `__yatta_tsv` generated column) with ILIKE fallback | FTS5 incl. `bm25()` + `fts5vocab` | LIKE fallback ranked by (column, token) matches — the FTS extension cannot be installed offline | BM25 index per searchable column, rank = `-search::score` |
| Vectors | sqlite-vec | pgvector | — | — | — |
| Backup / restore | file copy (`VACUUM INTO`) | PGlite tar (`dumpDataDir("gzip")` / `loadDataDir`) | `VACUUM INTO` | `CHECKPOINT` + file copy; an in-memory database cannot be backed up or restored into | `EXPORT` / `IMPORT` snapshot |
| Multi-process safe | yes (WAL + `busy_timeout`) | yes (single connection + FIFO gate) | yes (embedded, `concurrency: 1`) | yes (single connection + FIFO mutex) | yes (embedded) |
| Max bind params | 999 | 65535 | 999 | — | — |

Backup files are **not interchangeable** between drivers: a SQLite backup
restores only into SQLite, a PGlite backup only into PGlite, and so on.

## Choosing a driver

```ts
import { createDatabase } from "yatta.js/db";

// SQLite (default) — same as before, no code change. Sync, returns the proxy.
const db = createDatabase({ path: "Database/app.db", schema });

// PGlite — async, await it. First init takes ~3–6s, later opens ~3s.
const pgdb = await createDatabase({ driver: "pglite", dataDir: "./pgdata", schema });

// Turso (libSQL) — async, await it. Embedded file: (default) or :memory:.
// A remote URL is accepted but was not tested against a live server here.
const tdb = await createDatabase({ driver: "turso", url: "file:./app.db", schema });

// DuckDB — async, await it. Embedded file or :memory:.
const ddb = await createDatabase({ driver: "duckdb", path: "./app.duckdb", schema });

// SurrealDB — async, await it. Embedded mem:// (default) or a server URL.
const sdb = await createDatabase({ driver: "surrealdb", url: "mem://", schema });
```

`DatabaseOptions` is a union of the five driver option types. All members
share `schema`, `relations`, `autoMigrate`, `debug`, `searchSynonyms`, and
`forceNew`. SQLite takes `path`; PGlite takes `dataDir`, plus `pool` (`min`
> 1 throws, `max` is clamped to 1 — PGlite is single-connection) and
`acquireTimeoutMs` (default 30,000); Turso takes `url` (`file:` / `:memory:`
embedded, or a remote `libsql://` / `http(s)://` URL) and `authToken`;
DuckDB takes `path`; SurrealDB takes `url` plus `namespace` / `database`
(defaults `"yatta"` / `"yatta"`).

The registry key is per-driver (`registryKeyForOptions` in `engine.ts`),
so a PGlite database is never cached under a SQLite path key — and
`close()` evicts by that key, not by path.

SQLite-only methods throw a plain `YattaError` on other drivers instead of
reaching for a handle that does not exist: `db.sqlite`, `db.exec()`,
`db.checkIntegrity()` (PRAGMA `quick_check`), `db.recordOutbox()`, and
`db.vectors`.

## Per-driver limits

- **PGlite.** `syncSchema` does not rewrite an existing `__yatta_tsv`
  expression when the searchable columns change — call
  `rebuildSearchIndex()` instead. The ILIKE fallback (no searchable
  columns indexed) is a design choice; SQLite throws in that case.
  `pool.max` clamping is recorded at construction only. `mode:
  "immediate"` is accepted and has no Postgres effect.
- **Turso.** Remote URLs are accepted but were not tested against a live
  server in this environment. BLOB values arrive as `ArrayBuffer` and are
  converted to `Uint8Array`; `COUNT(*)` is a number;
  `lastInsertRowid` is a bigint converted to `Number`.
- **DuckDB.** No `IDENTITY` / `AUTOINCREMENT` — `col.id()` is a sequence
  default plus `setval` past `MAX(id)`. Session-path deletes cascade /
  set-null from the FK registry; raw-SQL deletes do not. A failed statement
  aborts the whole transaction. In-memory databases cannot be backed up or
  restored into.
- **SurrealDB.** No enforced foreign keys and no `compilerSql` — `Table`
  runs on the session methods (see above). `search()` is engine-managed
  BM25, so `syncSearchRow` is a no-op there. A direct nested
  `transaction()` call on a session still throws (no savepoints); but at
  ORM level, `Table` writes inside a `db.transaction()` callback join the
  ambient transaction — the engine joins instead of opening a nested one
  when the adapter has no savepoints — so the ordinary round trip (insert
  inside a transaction, then commit or roll back) works.

## ScyllaDB — outside the portable API

ScyllaDB is the sixth driver in the design, but it is **not** part of the
portable `DatabaseAdapter` API and has no adapter yet: it needs a live
cluster (none is available in this environment), its model is wide-column
rather than relational, and `transactional: false` — `transaction()` must
throw a `YattaError`. When it lands it will be a separate narrow
`ScyllaDatabase` handle behind its own `DriverName` (`"scylladb"`),
excluded from `RelationalDriverName`, not a sixth `createAdapter` driver.

## What the core still owns

The split of `src/types/db.ts` (Phase 1, Step 1) put the pieces here:

| Module | Owns |
|---|---|
| `db/errors.ts` | `YattaError` |
| `db/schema.ts` | Column builders, `TableSchema`, `DatabaseSchema` |
| `db/query.ts` | `QueryBuilder`, `Condition`, `WhereClause`, English DSL |
| `db/search.ts` | Tokenizer, synonym phrases, typo correction (internal) |
| `db/table.ts` | `Table` — row operations, relations, search orchestration |
| `db/engine.ts` | `YattaDB<M>` — connection orchestration over a session; `registryKeyForOptions` |
| `db/factory.ts` | `createDatabase` (sync/async overloads), the typed proxy, `connect`, `DB` / `AsyncDBProxy` |
| `db/registry.ts` | The per-driver-key instance registry |
| `db/sql_dialect.ts` | The `SqlDialect` interface |
| `db/sql_compiler.ts` | `SqlCompiler` — driver-neutral SQL assembly |
| `db/adapters/sqlite_dialect.ts` | `SqliteDialect` — every SQLite SQL string |
| `db/adapters/sqlite.ts` | `SqliteSession` + `SqliteAdapter` — the bun:sqlite connection |
| `db/adapters/postgres_dialect.ts` | `PostgresDialect` — the shared Postgres SQL strings |
| `db/adapters/pglite_gate.ts` | The PGlite single-connection gate |
| `db/adapters/pglite.ts` | `PGliteSession` + `PGliteAdapter` — `@electric-sql/pglite` |
| `db/adapters/turso_dialect.ts` | `TursoDialect` — the libSQL SQL strings |
| `db/adapters/turso.ts` | `TursoSession` + `TursoAdapter` — `@libsql/client` |
| `db/adapters/duckdb_dialect.ts` | `DuckDBDialect` — the DuckDB SQL strings |
| `db/adapters/duckdb.ts` | `DuckDBSession` + `DuckDBAdapter` — `@duckdb/node-api` |
| `db/adapters/surrealdb.ts` | `SurrealDBSession` + `SurrealDBAdapter` — `@surrealdb/node` (embedded) |
| `db/adapter.ts` | The public adapter contract + `createAdapter` + `ModeResult` helpers (`chainResult`, `modeValue`, `allResults`, `runSequential`) |

`YattaDB` constructs the adapter for `options.driver` and delegates to it:
`run`, `transaction`, `syncSchema`, migrations (behind
`withMigrationLock`, which holds the lock across async migrations), FTS
index work, backup, restore, close. `Table` reaches the dialect and
compiler through `this.db`. The public API is unchanged for SQLite — see
`docs/api-surface.md` (60 names, frozen at Step 0 plus the 17 adapter names
added at Step 3).

Two details the adapter contract preserves exactly:

- **Timestamps.** `createdAt`/`updatedAt` are TEXT in `Date#toISOString()`
  format (`2026-11-24T13:41:00.123Z`). The SQLite default renders as
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; the PGlite default must render
  the same string (`to_char(now() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`). DuckDB stores them as `TIMESTAMP`
  and SurrealDB as `datetime`; both decode back to the same ISO string.
- **Integers.** `col.integer()` maps to BIGINT on PGlite — epoch
  milliseconds overflow a 32-bit INTEGER. PGlite returns INT8 as a number
  when safe, `BigInt` when unsafe.

## The seam test

`src/test/memory_adapter.ts` is a Map-backed `DatabaseAdapter<"sync">` that
exists only in tests. `src/test/db.memory-adapter.test.ts` drives the
session contract against it — CRUD, where operators, upsert, LIKE-fallback
search, snapshot transactions with savepoints, thenable refusal, and honest
refusals for raw SQL and backup/restore. If the interface were SQLite-shaped
(raw SQL strings, prepared statements, pragmas), a Map store could not
implement it — so this file passing is the proof the seam is real.
