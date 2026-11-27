// Core database engine (YattaDB): connection, schema synchronization,
// transactions, FTS search orchestration, migrations, backups, and restores.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).
// The connection lives in the adapter now (adapters/*.ts); this class is
// the core orchestration (schema, relations, migrations, vectors, outbox)
// over a session, generic over the execution mode: sync for SQLite, async
// for PGlite, Turso, DuckDB, and SurrealDB (Phase 2).

import type { Database } from "bun:sqlite";
import type { OutboxEntry, OutboxStore, RecordOutboxInput } from "../outbox";
import type { VectorStore } from "../vectors";
import { YattaError } from "./errors";
import { dbRegistry, getDefaultDatabase, resolveDatabasePath, setDefaultDatabase } from "./registry";
import type { DatabaseSchema, RelationsConfig } from "./schema";
import { Table } from "./table";
import { normalizeSynonyms } from "./search";
import {
  chainResult,
  createAdapter,
  modeValue,
  runSequential,
  type DatabaseAdapter,
  type DatabaseSession,
  type ExecutionMode,
  type ModeResult,
} from "./adapter";
import { SqliteAdapter, ftsTableName as sqliteFtsTableName } from "./adapters/sqlite";
import type { SqlCompiler } from "./sql_compiler";
import type { SqlDialect } from "./sql_dialect";
// ──────────────────────────────────────────────────────────────────────────
// 6. Main YattaDB Database Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Programmatic migration step definition.
 */
export interface Migration {
  /** Unique migration identifier (e.g. `"20260101_init"`). */
  name: string;
  /** Forward migration execution callback. `db` is the database the migration runs on, in whatever mode it runs. */
  up: (db: YattaDB<any>) => void | Promise<void>;
  /** Optional rollback migration callback. */
  down?: (db: YattaDB<any>) => void | Promise<void>;
}

/**
 * Configuration options for a SQLite-backed {@link YattaDB} instance.
 */
export interface SqliteDatabaseOptions {
  /** Which driver to use. SQLite is the default; omit it for the default. */
  driver?: "sqlite";
  /** File system path to the database (e.g. `"Database/app.db"`), or `":memory:"`. */
  path?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SQL queries with millisecond execution durations to stdout. */
  debug?: boolean;
  /**
   * Database-level synonym map for full-text search, e.g.
   * `{ laptop: ["notebook"] }`: searching "laptop" also matches "notebook".
   * Applied at query time, so changing it needs no reindex. A per-query
   * `synonyms` option overrides these keys for that query only.
   */
  searchSynonyms?: Record<string, string | string[]>;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Configuration options for a PGlite-backed database (Phase 2).
 *
 * Accepted by the types now so the union is complete; `createDatabase`
 * and the `YattaDB` constructor throw until Phase 2 implements it.
 */
export interface PgliteDatabaseOptions {
  /** Which driver to use. */
  driver: "pglite";
  /** Directory holding the PGlite data files. Omit for an in-memory database. */
  dataDir?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SQL queries with millisecond execution durations to stdout. */
  debug?: boolean;
  searchSynonyms?: Record<string, string | string[]>;
  /** Connection pool bounds. PGlite is single-connection: min > 1 throws, max is clamped to 1. */
  pool?: { min?: number; max?: number };
  /** Milliseconds to wait for the single connection. Default 30_000. */
  acquireTimeoutMs?: number;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Configuration options for a Turso (libSQL) backed database (Phase 2).
 * Embedded local file by default; a remote URL needs an auth token.
 */
export interface TursoDatabaseOptions {
  /** Which driver to use. */
  driver: "turso";
  /** Full database URL. `file:` (or `":memory:"`) for an embedded database, `libsql:`/`http:`/`https:`/`ws:`/`wss:` for a remote one. Defaults to an embedded file. */
  url?: string;
  /** File system path to the embedded database, or `":memory:"`. Defaults to `Database/app.db`. Ignored when `url` is set. */
  path?: string;
  /** Auth token for a remote database. */
  authToken?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SQL queries with millisecond execution durations to stdout. */
  debug?: boolean;
  searchSynonyms?: Record<string, string | string[]>;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Configuration options for a DuckDB-backed database (Phase 2).
 */
export interface DuckDBDatabaseOptions {
  /** Which driver to use. */
  driver: "duckdb";
  /** File system path to the database, or `":memory:"`. Defaults to `":memory:"`. */
  path?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SQL queries with millisecond execution durations to stdout. */
  debug?: boolean;
  searchSynonyms?: Record<string, string | string[]>;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Configuration options for a SurrealDB-backed database (Phase 2).
 * Embedded in-memory engine by default; a remote server needs a ws(s) URL.
 */
export interface SurrealDBDatabaseOptions {
  /** Which driver to use. */
  driver: "surrealdb";
  /** Endpoint to connect to. Defaults to `"mem://"` (embedded, in-memory). */
  url?: string;
  /** Namespace to select. Defaults to `"yatta"`. */
  namespace?: string;
  /** Database to select. Defaults to `"yatta"`. */
  database?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SurrealQL with millisecond execution durations to stdout. */
  debug?: boolean;
  searchSynonyms?: Record<string, string | string[]>;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Configuration options for initializing a {@link YattaDB} instance.
 */
export type DatabaseOptions =
  | SqliteDatabaseOptions
  | PgliteDatabaseOptions
  | TursoDatabaseOptions
  | DuckDBDatabaseOptions
  | SurrealDBDatabaseOptions;

/**
 * Builds the adapter for a {@link DatabaseOptions} value, dispatching on
 * `driver` (SQLite by default). The async drivers are constructed here
 * but not initialized — their `ready()` + schema sync happen in
 * `YattaDB.initialize()`, awaited by the async `createDatabase` path.
 */
function createAdapterForOptions(options: DatabaseOptions): DatabaseAdapter<ExecutionMode> {
  switch (options.driver) {
    case "sqlite":
    case undefined:
      return createAdapter("sqlite", { path: options.path, debug: options.debug });
    case "pglite":
      return createAdapter("pglite", {
        dataDir: options.dataDir,
        pool: options.pool,
        acquireTimeoutMs: options.acquireTimeoutMs,
        debug: options.debug,
      });
    case "turso":
      return createAdapter("turso", {
        url: options.url,
        path: options.path,
        authToken: options.authToken,
        debug: options.debug,
      });
    case "duckdb":
      return createAdapter("duckdb", { path: options.path, debug: options.debug });
    case "surrealdb":
      return createAdapter("surrealdb", {
        url: options.url,
        namespace: options.namespace,
        database: options.database,
        debug: options.debug,
      });
  }
}

/**
 * Driver-aware registry key for a {@link DatabaseOptions} value.
 *
 * A file path alone is not a key once several drivers exist: a PGlite
 * database must never be cached under a SQLite path key (the old
 * `createDatabase` threw for pglite before the registry lookup for
 * exactly this reason). Async drivers key on their own location
 * (dataDir / URL / path) so two drivers at the same path stay distinct.
 */
export function registryKeyForOptions(options: DatabaseOptions): string {
  switch (options.driver) {
    case "sqlite":
    case undefined:
      return resolveDatabasePath(options.path);
    case "pglite":
      return `pglite:${options.dataDir ?? ":memory:"}`;
    case "turso":
      return `turso:${options.url ?? `file:${resolveDatabasePath(options.path)}`}`;
    case "duckdb":
      return `duckdb:${options.path ?? ":memory:"}`;
    case "surrealdb":
      return `surrealdb:${options.url ?? "mem://"}:${options.namespace ?? "yatta"}:${options.database ?? "yatta"}`;
  }
}

/**
 * Core database engine: connection, schema synchronization, transactions,
 * FTS search orchestration, migrations, backups, and restores.
 *
 * Generic over the execution mode `M`: `"sync"` for SQLite (every method
 * returns its plain value, exactly as before) and `"async"` for PGlite,
 * Turso, DuckDB, and SurrealDB (every method returns a Promise). The mode
 * follows the driver, so sync callers keep sync types and async callers
 * are forced by TypeScript to await.
 *
 * Manages connections, WAL mode, prepared statement caching, schema synchronization,
 * transactions, backups, and restores.
 */
export class YattaDB<M extends ExecutionMode = "sync"> {
  /**
   * The adapter for this connection (its session runs the SQL).
   * The engine is the core orchestration over it; Table reaches the
   * compiler/dialect through this.db.
   */
  readonly adapter: DatabaseAdapter<M>;
  /** Execution mode of this connection (`"sync"` for SQLite, `"async"` otherwise). */
  readonly mode: M;
  /** Driver-aware registry key for this instance (see `registryKeyForOptions`). */
  readonly registryKey: string;
  /**
   * SQL dialect for this connection (SQLite in Phase 1; PGlite in Phase 2
   * picks its own). Owns every driver-specific SQL string: identifiers,
   * placeholders, types, defaults, DDL, LIKE, and value conversion.
   * Table reaches it (and the compiler below) through this.db.
   */
  get dialect(): SqlDialect {
    return this.currentSession().dialect;
  }
  /** Driver-neutral SQL compiler over the dialect (see sql_compiler.ts). */
  get compiler(): SqlCompiler {
    return this.currentSession().compiler;
  }
  /**
   * Whether this connection is currently inside a transaction.
   * Generated async migrations check this so they can skip their own
   * BEGIN IMMEDIATE when `migrate()` already holds the write lock.
   */
  get inTransaction(): boolean {
    return this.currentSession().inTransaction;
  }
  /**
   * The underlying bun:sqlite connection, for modules that need it directly
   * (vectors, outbox, timeseries). SQLite only — every other driver throws
   * a plain YattaError here instead of handing back a wrong handle.
   */
  get sqlite(): Database {
    if (this.adapter.driver !== "sqlite") {
      throw new YattaError(
        `db.sqlite is SQLite-only: this database runs "${this.adapter.driver}", which has no bun:sqlite handle.`,
      );
    }
    return (this.adapter as unknown as SqliteAdapter).database;
  }
  /** Active database schema definition. */
  readonly schema: DatabaseSchema;
  /** Active relational associations graph. */
  readonly relations: RelationsConfig;
  /** Resolved filesystem path to the database file, or `":memory:"`. */
  readonly path: string;
  private tables = new Map<string, Table<any, any, M>>();
  /** Normalized database-level search synonyms (see `DatabaseOptions.searchSynonyms`). */
  private dbSearchSynonyms: Map<string, string[][]>;
  /** Lazily created vector store (see `vectors`). Null until first access. */
  private vectorStore: VectorStore | null = null;
  /**
   * Active transaction session, set while a `transaction()` callback runs
   * and restored afterwards. Table instances reach the database through
   * this YattaDB, so binding the session here binds every Table call
   * inside the callback to the transaction — which is what prevents
   * single-connection deadlocks on PGlite (a root query inside an active
   * transaction throws there instead of queueing behind itself).
   */
  private sessionOverride: DatabaseSession<M> | null = null;
  /** Whether `ready()` + schema sync have run (always true for SQLite, which syncs in the constructor). */
  private initialized: boolean;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  private autoMigrate: boolean;

  /**
   * The session Table calls go through: the active transaction session
   * while a `transaction()` callback runs, the root adapter otherwise.
   */
  private currentSession(): DatabaseSession<M> {
    return this.sessionOverride ?? this.adapter;
  }

  /**
   * The session Table's session-path calls go through (SurrealDB CRUD).
   * Same binding as `currentSession()`: the active transaction session
   * inside a `transaction()` callback, the root adapter otherwise.
   */
  get session(): DatabaseSession<M> {
    return this.currentSession();
  }

  /**
   * Initializes the database connection, enables WAL mode, sets pragmas,
   * and optionally synchronizes the schema.
   *
   * SQLite initializes synchronously here. Async drivers only construct
   * their adapter here — `initialize()` (awaited by the async
   * `createDatabase` path, or called directly after `new YattaDB`) awaits
   * `ready()` and runs the schema sync.
   *
   * @param options Configuration options.
   */
  constructor(options: DatabaseOptions = {}) {
    this.adapter = createAdapterForOptions(options) as DatabaseAdapter<M>;
    this.mode = this.adapter.capabilities.mode as M;
    this.registryKey = registryKeyForOptions(options);
    this.path = this.adapter.path;
    this.schema = options.schema ?? {};
    this.relations = options.relations ?? {};
    this.dbSearchSynonyms = normalizeSynonyms(options.searchSynonyms);
    this.autoMigrate = options.autoMigrate !== false;

    if (this.mode === "sync") {
      if (this.autoMigrate && options.schema) this.syncSchema();
      this.initialized = true;
    } else {
      this.initialized = false;
    }
  }

  /**
   * Awaits adapter readiness and schema sync for async drivers. A no-op
   * (already initialized in the constructor) for SQLite. Idempotent —
   * safe to call again after the first call.
   */
  initialize(): ModeResult<M, void> {
    if (this.initialized) return modeValue(this.mode, undefined);
    this.initialized = true;
    return chainResult(this.mode, this.adapter.ready(), () => {
      if (this.autoMigrate && Object.keys(this.schema).length > 0) {
        return this.syncSchema();
      }
      return modeValue(this.mode, undefined);
    });
  }

  private getOrCreateTable(name: string): Table<any, any, M> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Table(name, this, this.schema[name]);
      this.tables.set(name, t);
    }
    return t;
  }

  /**
   * Returns a typed {@link Table} gateway for a defined schema table.
   *
   * @template T Row entity type.
   * @template TInsert Insertion payload type.
   * @param name Table name.
   * @throws {@link YattaError} if table is not defined in schema.
   */
  table<T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>>(
    name: string,
  ): Table<T, TInsert, M> {
    if (this.schema && Object.keys(this.schema).length > 0 && !(name in this.schema)) {
      throw new YattaError(
        `Table "${name}" is not defined in the schema. Use db.unsafeTable("${name}") to query untyped dynamic tables.`,
      );
    }
    return this.getOrCreateTable(name) as Table<T, TInsert, M>;
  }

  /**
   * Returns a {@link Table} gateway for an arbitrary or dynamically generated table not in the schema.
   *
   * @template T Row entity type.
   * @template TInsert Insertion payload type.
   * @param name Table name.
   */
  unsafeTable<T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>>(
    name: string,
  ): Table<T, TInsert, M> {
    return this.getOrCreateTable(name) as Table<T, TInsert, M>;
  }

  /**
   * Finalizes and purges all cached prepared statements.
   */
  clearStatementCache(): void {
    this.adapter.clearStatementCache();
  }

  /**
   * Prepares (or retrieves from LRU cache) and executes an SQL statement with parameters.
   *
   * @param sql SQL query string.
   * @param params Parameter arguments.
   * @param mode Execution mode (`"get"` for single row, `"all"` for all rows, `"run"` for DML).
   * @returns Query result.
   *
   * The statement cache and execution live in the adapter now
   * (adapters/sqlite.ts); this stays as the call site Table uses.
   * Inside a `transaction()` callback this runs on the transaction
   * session, not the root adapter.
   */
  run(sql: string, params: any[] = [], mode: "get" | "all" | "run"): ModeResult<M, unknown> {
    return this.currentSession().run(sql, params, mode);
  }

  /**
   * Executes a callback within an atomic transaction.
   * If the callback throws, the transaction is automatically rolled back.
   *
   * @template R Return type.
   * @param fn Callback receiving transaction context.
   * @returns Value returned from the callback.
   *
   * `fn` must be synchronous on SQLite: bun:sqlite commits as soon as the
   * callback returns, so an async callback committed immediately and left
   * its awaited work running outside the transaction. A thenable return
   * is refused by the adapter and the transaction rolled back, rather
   * than reported as a success. Async drivers accept an async callback
   * and await it before committing. The transaction itself lives in the
   * adapter now.
   *
   * The callback receives this same YattaDB, bound to the transaction
   * session for its duration (see `sessionOverride`): every Table call
   * inside `fn` runs on the transaction, never on the root adapter.
   */
  transaction<R>(fn: (tx: this) => ModeResult<M, R>): ModeResult<M, R> {
    return this.adapter.transaction((txSession) => {
      const prev = this.sessionOverride;
      this.sessionOverride = txSession;
      let result: ModeResult<M, R>;
      try {
        result = fn(this);
      } catch (e) {
        this.sessionOverride = prev;
        throw e;
      }
      if (this.mode === "sync") {
        this.sessionOverride = prev;
        return result;
      }
      // Async: restore the binding when fn's work settles, before the
      // adapter commits — no statement runs after this point.
      return (result as Promise<R>).then(
        (v) => {
          this.sessionOverride = prev;
          return v;
        },
        (e) => {
          this.sessionOverride = prev;
          throw e;
        },
      ) as ModeResult<M, R>;
    });
  }

  /**
   * Records one outbox entry in this database file, in the caller's
   * transaction when called inside `transaction()`. That is the point:
   * the user write and its log entry commit or roll back together, in
   * the same file, so a crash between them cannot drop the event.
   * See `src/types/outbox.ts` and docs/roadmap-14/shared-change-log.md.
   *
   * @example
   * ```ts
   * db.transaction((tx) => {
   *   tx.users.insert({ email: "ada@example.com", name: "Ada" });
   *   tx.recordOutbox({ eventType: "user.registered", payload: { email: "ada@example.com" } });
   * });
   * ```
   */
  recordOutbox(input: RecordOutboxInput): OutboxEntry {
    if (this.adapter.driver !== "sqlite") {
      throw new YattaError(
        `recordOutbox() is SQLite-only: the outbox table is SQLite DDL, and this database runs "${this.adapter.driver}".`,
      );
    }
    // Lazy on purpose: the outbox module is loaded only on the first
    // recordOutbox() call, never when this database module loads. An app
    // that never records an outbox entry pays nothing for the feature:
    // no module load, no table, no extra statement on any write. The
    // same file already uses bare require() for lazy loading elsewhere.
    const { ensureOutboxTable, recordOutbox: recordOutboxRow } = require("../outbox");
    ensureOutboxTable(this as unknown as OutboxStore);
    return recordOutboxRow(this as unknown as OutboxStore, input);
  }

  /**
   * Vector search over this database file: `db.vectors.search(...)`.
   *
   * Lazy like the outbox: the vectors module is loaded only on first
   * access, and no extension is loaded and no table created until the
   * first vector call. A database that never touches vectors pays
   * nothing for them. Note this reserves the table name "vectors", the
   * same way other YattaDB methods reserve theirs.
   *
   * The store tracks the connection it resolved its backend for, so a
   * `restore()` that swaps the connection re-resolves (and re-loads
   * vec0, when applicable) on next use instead of trusting the old one.
   */
  get vectors(): VectorStore {
    if (this.adapter.driver !== "sqlite") {
      throw new YattaError(
        `db.vectors is SQLite-only (sqlite-vec): this database runs "${this.adapter.driver}".`,
      );
    }
    if (this.vectorStore === null) {
      const { VectorStore: VectorStoreClass } = require("../vectors");
      this.vectorStore = new VectorStoreClass(this);
    }
    return this.vectorStore!;
  }

  // ── Raw SQL Suite ────────────────────────────────────────────────────────

  /**
   * Executes a raw SQL query and returns all matching rows.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns Array of resulting rows.
   */
  rawAll<R = any>(sql: string, params: any[] = []): ModeResult<M, R[]> {
    return chainResult(this.mode, this.run(sql, params, "all"), (rows) => rows as R[]);
  }

  /**
   * Executes a raw SQL query and returns the first matching row, or null.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns First row, or null when nothing matches.
   */
  rawGet<R = any>(sql: string, params: any[] = []): ModeResult<M, R | null> {
    return chainResult(this.mode, this.run(sql, params, "get"), (row) => row as R | null);
  }

  /**
   * Executes a raw SQL statement and returns its write result.
   *
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns Write result (`lastInsertRowid`, `changes`).
   */
  rawRun(sql: string, params: any[] = []): ModeResult<M, { lastInsertRowid: number; changes: number }> {
    return chainResult(
      this.mode,
      this.run(sql, params, "run"),
      (res) => res as { lastInsertRowid: number; changes: number },
    );
  }

  /**
   * Executes raw SQL in the specified execution mode.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @param mode Execution mode (`"get"`, `"all"`, or `"run"`).
   */
  raw<R = any>(sql: string, params: any[] = [], mode: "get" | "all" | "run" = "all"): ModeResult<M, any> {
    return this.run(sql, params, mode);
  }

  /**
   * Executes raw multi-statement SQL script directly on the database.
   * Clears prepared statement caches.
   *
   * SQLite only: it runs on the bun:sqlite handle, which other drivers
   * do not have. Use `executeBatch` on the adapter for multi-statement
   * SQL on other drivers.
   *
   * @param sql SQL script.
   */
  exec(sql: string): { lastInsertRowid: number; changes: number } {
    if (this.adapter.driver !== "sqlite") {
      throw new YattaError(
        `db.exec() is SQLite-only: it runs raw multi-statement SQL on the bun:sqlite handle, and this database runs "${this.adapter.driver}".`,
      );
    }
    this.adapter.clearStatementCache();
    return (this.adapter as unknown as SqliteAdapter).database.run(sql) as unknown as {
      lastInsertRowid: number;
      changes: number;
    };
  }

  /**
   * Performs an SQLite database integrity inspection (`PRAGMA quick_check;`).
   *
   * SQLite only: other drivers have no `quick_check`. Their own
   * `backup`/`restore` implementations validate instead.
   *
   * @returns `true` if database integrity is healthy, `false` otherwise.
   */
  checkIntegrity(): ModeResult<M, boolean> {
    if (this.adapter.driver !== "sqlite") {
      throw new YattaError(
        `checkIntegrity() is SQLite-only (PRAGMA quick_check): this database runs "${this.adapter.driver}".`,
      );
    }
    return chainResult(
      this.mode,
      this.run("PRAGMA quick_check;", [], "get"),
      (res) => (res as { quick_check: string } | null)?.quick_check === "ok",
    );
  }


  // ── Safe Migrations ──────────────────────────────────────────────────────

  /**
   * Compares the defined TypeScript schema against the live SQLite tables and automatically:
   * 1. Creates missing tables with all specified columns, primary keys, and indexes.
   * 2. Adds newly added columns to existing tables safely via `ALTER TABLE ADD COLUMN`.
   * 3. Creates missing indexes.
   * 4. Validates foreign key integrity.
   *
   * First boot in cluster mode runs this in every worker at once; the
   * loser of the write-lock race retries instead of crashing the worker.
   * The migration is idempotent (CREATE TABLE IF NOT EXISTS, and it rolls
   * back on error), so a retry is safe.
   *
   * The work lives in the adapter now (adapters/sqlite.ts); this stays as
   * the call site.
   */
  syncSchema(): ModeResult<M, void> {
    return this.adapter.syncSchema(this.schema);
  }

  /**
   * Applies programmatic migrations tracking applied versions in `_yatta_migrations`.
   *
   * @param migrations Array of {@link Migration} steps to evaluate.
   * @returns Object listing newly applied migration names.
   *
   * The cross-process lock (BEGIN IMMEDIATE) lives in the adapter now
   * (SqliteAdapter.withMigrationLock, which holds it across async
   * migrations); the async/sync `up` handling in migrateLocked below is
   * the orchestration that stays here.
   *
   * The migration body runs bound to the lock session (see
   * `sessionOverride`): on PGlite the lock is a transaction, so a
   * migration that queries the root adapter would hit the deadlock
   * guard instead of the transaction.
   */
  async migrate(migrations: Migration[]): Promise<{ applied: string[] }> {
    return this.adapter.withMigrationLock((session) => {
      const prev = this.sessionOverride;
      this.sessionOverride = session;
      return this.migrateLocked(migrations).then(
        (v) => {
          this.sessionOverride = prev;
          return v;
        },
        (e) => {
          this.sessionOverride = prev;
          throw e;
        },
      );
    });
  }

  private async migrateLocked(migrations: Migration[]): Promise<{ applied: string[] }> {
    // The marker table is created by the adapter in its own dialect
    // (SQLite AUTOINCREMENT is not valid on Postgres, DuckDB, or
    // SurrealDB), and the applied names + record go through it too —
    // the `?` placeholders in the old inline SQL are not valid on
    // PGlite (`$1`) or DuckDB (`$1`).
    await this.currentSession().ensureMigrationTable();

    const appliedRows = await this.currentSession().listAppliedMigrations();
    const appliedSet = new Set(appliedRows);
    const newlyApplied: string[] = [];

    for (const m of migrations) {
      if (appliedSet.has(m.name)) continue;

      /*
       * `Migration.up` is typed `(db) => void | Promise<void>`, so a caller can
       * legitimately write an async migration.
       *
       * bun:sqlite commits the instant its transaction callback returns, so
       * wrapping a thenable in `transaction()` committed immediately: the awaited
       * statements ran *after* the commit and after the marker row was written,
       * so the migration was reported as applied even if it never finished, and
       * a throw inside it became an unhandled rejection instead of a rollback.
       *
       * So the two cases are handled separately. `up` is called exactly once,
       * in the branch that can actually honour it:
       *
       *   async  awaited to completion, then the marker recorded. No
       *          transaction — SQLite has no async transaction — so a failure
       *          propagates and leaves no marker, and the migration is retried
       *          on the next run. (On async drivers the migration lock IS a
       *          transaction, so the async body shares it.)
       *   sync   body and marker share one real transaction, so a throw rolls
       *          back the schema change too.
       *
       * Asyncness is detected from the function itself rather than by calling
       * and inspecting the result, because calling twice would apply every
       * statement twice.
       *
       * `migrate()` stays `async` (a Promise) on every driver for this
       * reason: a sync-shaped return could not await an async `up`, and a
       * sync throw would escape instead of rejecting. Callers already
       * `await` it.
       */
      const isAsync = m.up.constructor.name === "AsyncFunction";

      if (isAsync) {
        await m.up(this);

        await this.currentSession().recordMigration(m.name);
      } else {
        await this.transaction(() => {
          m.up(this);
          return this.currentSession().recordMigration(m.name);
        });
      }

      newlyApplied.push(m.name);
    }

    this.clearStatementCache();
    return { applied: newlyApplied };
  }


  // ── Full-Text Search (FTS5) ──────────────────────────────────────────────
  //
  // One standalone FTS5 table per searchable base table, named `_fts_<table>`,
  // holding the searchable columns plus `__yatta_pk` (UNINDEXED, so the key
  // itself is never searchable) storing the base row's primary key as text.
  // Standalone, not an FTS5 content table, because Yatta primary keys can be
  // text UUIDs and FTS5 content tables only track an integer rowid.
  //
  // Sync: Table write paths (insert, update, updateById, delete, and upsert
  // through them) maintain the index on the same connection, so a transaction
  // rollback rolls index writes back with the rows. Writes that bypass Table
  // (raw SQL, exec, a copied database file) do NOT sync the index — that is
  // what rebuildSearchIndex() is for, and what ensureSearchIndex() repairs
  // for missing rows when counts disagree.

  /** FTS5 table name for a base table. */
  // ── Full-Text Search (FTS5) ──────────────────────────────────────────────
  //
  // One standalone FTS5 table per searchable base table, named `_fts_<table>`,
  // holding the searchable columns plus `__yatta_pk` (UNINDEXED, so the key
  // itself is never searchable) storing the base row's primary key as text.
  //
  // The index work lives in the adapter now (adapters/sqlite.ts); these stay
  // as the call sites Table uses.

  /** FTS5 table name for a base table. */
  ftsTableName(tableName: string): string {
    return sqliteFtsTableName(tableName);
  }

  /** Searchable column names for a table, in schema order. Empty when the table is not searchable. */
  searchableColumns(tableName: string): string[] {
    const tableDef = this.schema[tableName];
    if (!tableDef) return [];
    return Object.entries(tableDef)
      .filter(([, builder]) => builder.def.isSearchable)
      .map(([colName]) => colName);
  }

  /** Database-level synonym map, normalized (keys lowercased, values tokenized). */
  searchSynonyms(): Map<string, string[][]> {
    return new Map(this.dbSearchSynonyms);
  }

  /** Whether the FTS table for a base table exists right now. */
  ftsTableExists(tableName: string): ModeResult<M, boolean> {
    return this.currentSession().ftsTableExists(tableName);
  }

  /**
   * Makes sure one table's FTS index exists and matches its searchable
   * columns, rebuilding when it does not. Called by `search()` so a first
   * search never fails on a missing index.
   */
  ensureSearchIndex(tableName: string): ModeResult<M, void> {
    const tableDef = this.schema[tableName];
    if (!tableDef) return modeValue(this.mode, undefined);
    return this.currentSession().ensureSearchIndex(tableName, tableDef);
  }

  /**
   * Rebuilds the full-text index from current rows — the escape hatch for
   * rows changed outside the Table write paths. With no argument, rebuilds
   * every searchable table. A table with no searchable columns is refused:
   * there is nothing to rebuild.
   */
  rebuildSearchIndex(tableName?: string): ModeResult<M, void> {
    const targets = tableName ? [tableName] : Object.keys(this.schema);
    for (const target of targets) {
      const tableDef = this.schema[target];
      if (!tableDef) {
        // Mirrors the old behaviour: an unknown table has no searchable
        // columns, so the rebuild is refused with that message.
        throw new YattaError(
          `Table "${target}" has no searchable columns, so there is no search index to rebuild. ` +
            `Mark a text column with .searchable() first.`,
        );
      }
    }
    return chainResult(
      this.mode,
      runSequential(
        this.mode,
        targets.map((target) => () => this.currentSession().rebuildSearchIndex(target, this.schema[target]!)),
      ),
      () => {
        this.clearStatementCache();
      },
    );
  }

  /**
   * The indexed vocabulary for a table: every distinct term the FTS index
   * holds, used for typo correction. Read from the fts5vocab table when it
   * exists; otherwise scanned from the base table's searchable values.
   */
  ftsVocabulary(tableName: string): ModeResult<M, Set<string>> {
    const tableDef = this.schema[tableName];
    if (!tableDef) return modeValue(this.mode, new Set<string>());
    return this.currentSession().searchVocabulary(tableName, tableDef);
  }

  /**
   * Inserts one row's FTS entry without deleting a prior one. Only correct
   * for freshly inserted rows: a successful base-table insert means the pk
   * is new, so there is nothing to delete — and the DELETE is a full FTS
   * scan (`__yatta_pk` is UNINDEXED), which dominated insert cost on
   * large tables. Updates still go through `ftsUpsert`.
   */
  ftsInsert(tableName: string, pk: string | number, row: Record<string, any>): ModeResult<M, void> {
    const tableDef = this.schema[tableName];
    if (!tableDef) return modeValue(this.mode, undefined);
    // The row carries its own primary key; `pk` is the same value Table passed.
    void pk;
    return this.currentSession().syncSearchRow(tableName, tableDef, row, "insert");
  }

  /**
   * Replaces one row's FTS entry with its current searchable text. Silent
   * when the index does not exist yet: the next search rebuilds it from the
   * base rows, so a skipped write here loses nothing.
   */
  ftsUpsert(tableName: string, pk: string | number, row: Record<string, any>): ModeResult<M, void> {
    const tableDef = this.schema[tableName];
    if (!tableDef) return modeValue(this.mode, undefined);
    void pk;
    return this.currentSession().syncSearchRow(tableName, tableDef, row, "update");
  }

  /** Removes one row's FTS entry. Silent when the index does not exist yet. */
  ftsDelete(tableName: string, pk: string | number): ModeResult<M, void> {
    const tableDef = this.schema[tableName];
    if (!tableDef) return modeValue(this.mode, undefined);
    void pk;
    return this.currentSession().syncSearchRow(tableName, tableDef, { [this.pkColumnFor(tableName)]: pk }, "delete");
  }

  /** Primary key column for a table's schema, for the delete path above. */
  private pkColumnFor(tableName: string): string {
    const tableDef = this.schema[tableName];
    if (tableDef) {
      for (const [colName, builder] of Object.entries(tableDef)) {
        if (builder.def.primaryKey) return colName;
      }
      if ("id" in tableDef) return "id";
    }
    return "id";
  }


  // ── Atomic Backup & Validated Restore ─────────────────────────────────────

  /**
   * Performs an atomic online backup snapshot of the database using SQLite's `VACUUM INTO`.
   * Safe to run concurrently while readers and writers are active.
   *
   * @param destPath Destination file path for the backup.
   * @returns Object indicating success and destination path.
   *
   * The work lives in the adapter now; this reconstructs the old return shape.
   */
  backup(destPath: string): ModeResult<M, { success: boolean; path: string }> {
    return chainResult(this.mode, this.adapter.backup(destPath), () => ({ success: true, path: destPath }));
  }

  /**
   * Restores the database from a backup file:
   * 1. Validates the backup file's SQLite integrity (`quick_check`).
   * 2. Atomically replaces current database files with backup.
   * 3. Rolls back safely to previous state if anything fails.
   *
   * @param backupPath File path to the SQLite backup to restore from.
   * @returns Object indicating success.
   * @throws {@link YattaError} if restore fails or backup is corrupt.
   *
   * The work lives in the adapter now; this reconstructs the old return shape.
   * (The validation step is the adapter's: each driver validates its own
   * backup format.)
   */
  restore(backupPath: string): ModeResult<M, { success: boolean }> {
    return chainResult(this.mode, this.adapter.restore(backupPath), () => ({ success: true }));
  }

  /**
   * Closes the SQLite database connection, frees prepared statements,
   * and unregisters this instance from the global cache.
   */
  close(): ModeResult<M, void> {
    return chainResult(this.mode, this.adapter.close(), () => {
      /*
       * Evict by registry key, not by identity.
       *
       * createDatabase registers the *proxy*, so `registry.get(key) === this`
       * was never true: a closed database stayed in the registry and became the
       * default, and the next createDatabase for that path handed back a closed
       * connection that threw "Cannot use a closed database". Comparing the
       * underlying adapter handles matches the proxy to its target.
       */
      const registered = dbRegistry.get(this.registryKey) as any;
      if (registered === this || registered?.adapter === this.adapter) {
        dbRegistry.delete(this.registryKey);
      }

      const current = getDefaultDatabase() as any;
      if (current === this || current?.adapter === this.adapter) {
        setDefaultDatabase(null);
      }
    });
  }
}
