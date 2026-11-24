# Database adapters

Yatta's ORM talks to storage through one interface, `DatabaseAdapter`, and
one config value, the driver. The driver picks the execution mode: SQLite is
sync, PGlite is async. Everything above the adapter — `Table`, the query DSL,
relations, migrations, search orchestration — knows only `DatabaseAdapter`
and `DatabaseSession`. It never sees SQL, a driver, or a file.

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

// PGlite lands in Phase 2 — today this throws a plain YattaError.
const pg = createAdapter("pglite", { dataDir: "./pgdata" });
```

`DatabaseSession<M>` is the execution scope shared by the root adapter and
active transaction handles. It carries the CRUD surface (`insert`,
`insertMany`, `find`, `count`, `update`, `delete`, `upsert`), ranked
full-text `search`, the FTS maintenance methods (`syncSearchRow`,
`rebuildSearchIndex`, `searchVocabulary`), the raw escape hatches
(`executeRaw`, `executeBatch`), and `transaction`. Search lives on the
session, not only on the adapter, because a search must work inside a
transaction — the session is the transaction boundary.

`DatabaseAdapter<M>` extends the session with the lifecycle: `driver`,
`ready()`, `syncSchema(schema)`, `listTables()`, `listColumns(table)`,
`withMigrationLock(fn)`, `backup(destPath)`, `restore(sourcePath)`, `close()`.

The root adapter IS the root session. A transaction hands `fn` a session;
on SQLite that is the same session object (bun:sqlite nests via savepoints
on one connection). On PGlite it will be a real child session — see the
Phase 2 notes below.

## Capability table

| Capability | SQLite (today) | PGlite (Phase 2) |
|---|---|---|
| Mode | sync | async |
| Joins | no — relations are batched separate queries | no |
| Foreign keys | yes | yes |
| ACID transactions | yes | yes |
| Savepoints | yes | yes |
| RETURNING clause | yes | yes |
| Full-text search | FTS5 | pg_fts (tsvector + GIN) with ILIKE fallback |
| Vectors | sqlite-vec | pgvector |
| Backup / restore | file copy (`VACUUM INTO`) | PGlite tar (`dumpDataDir` / `loadDataDir`) |
| Multi-process safe | yes (WAL + `busy_timeout`) | yes (single connection + FIFO gate) |
| Max bind params | 999 | 65535 |

Backup files are **not interchangeable** between drivers: a SQLite backup
restores only into SQLite, a PGlite backup only into PGlite.

## Choosing a driver

```ts
import { createDatabase } from "yatta.js/db";

// SQLite (default) — same as before, no code change.
const db = createDatabase({ path: "Database/app.db", schema });

// PGlite — accepted by the types now, throws until Phase 2 implements it.
const pgdb = createDatabase({ driver: "pglite", dataDir: "./pgdata", schema });
```

`DatabaseOptions` is a union: `SqliteDatabaseOptions | PgliteDatabaseOptions`.
Both members share `schema`, `relations`, `autoMigrate`, `debug`,
`searchSynonyms`, and `forceNew`. SQLite takes `path`; PGlite takes
`dataDir`, plus `pool` (`min` > 1 throws, `max` is clamped to 1 — PGlite is
single-connection) and `acquireTimeoutMs` (default 30,000).

## What the core still owns

The split of `src/types/db.ts` (Phase 1, Step 1) put the pieces here:

| Module | Owns |
|---|---|
| `db/errors.ts` | `YattaError` |
| `db/schema.ts` | Column builders, `TableSchema`, `DatabaseSchema` |
| `db/query.ts` | `QueryBuilder`, `Condition`, `WhereClause`, English DSL |
| `db/search.ts` | Tokenizer, synonym phrases, typo correction (internal) |
| `db/table.ts` | `Table` — row operations, relations, search orchestration |
| `db/engine.ts` | `YattaDB` — connection orchestration over a session |
| `db/factory.ts` | `createDatabase`, the typed proxy, `connect` |
| `db/registry.ts` | The per-path instance registry |
| `db/sql_dialect.ts` | The `SqlDialect` interface |
| `db/sql_compiler.ts` | `SqlCompiler` — driver-neutral SQL assembly |
| `db/adapters/sqlite_dialect.ts` | `SqliteDialect` — every SQLite SQL string |
| `db/adapters/sqlite.ts` | `SqliteSession` + `SqliteAdapter` — the bun:sqlite connection |
| `db/adapter.ts` | The public adapter contract + `createAdapter` |

`YattaDB` constructs a `SqliteAdapter` and delegates to it: `run`,
`transaction`, `syncSchema`, migrations (behind `withMigrationLock`, which
holds the lock across async migrations), FTS index work, backup, restore,
close. `Table` reaches the dialect and compiler through `this.db`. The
public API is unchanged — see `docs/api-surface.md` (60 names, frozen at
Step 0 plus the 17 adapter names added at Step 3).

Two details the adapter contract preserves exactly:

- **Timestamps.** `createdAt`/`updatedAt` are TEXT in `Date#toISOString()`
  format (`2026-11-24T13:41:00.123Z`). The SQLite default renders as
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; the PGlite default must render
  the same string (`to_char(now() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`).
- **Integers.** `col.integer()` maps to BIGINT on PGlite — epoch
  milliseconds overflow a 32-bit INTEGER.

## The seam test

`src/test/memory_adapter.ts` is a Map-backed `DatabaseAdapter<"sync">` that
exists only in tests. `src/test/db.memory-adapter.test.ts` drives the
session contract against it — CRUD, where operators, upsert, LIKE-fallback
search, snapshot transactions with savepoints, thenable refusal, and honest
refusals for raw SQL and backup/restore. If the interface were SQLite-shaped
(raw SQL strings, prepared statements, pragmas), a Map store could not
implement it — so this file passing is the proof the seam is real.
