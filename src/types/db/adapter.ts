// Pluggable database adapter contract (Phase 1 of the multi-database ORM refactor).
//
// The adapter is the only thing that knows SQL, a driver, or a file.
// Everything above it — Table, the query DSL, relations, migrations, search
// orchestration — knows only DatabaseAdapter and DatabaseSession.
//
// Shape: f1 from the Gemini design (ExecutionMode / ModeResult,
// RelationalDriverName with ScyllaDB under a separate DriverName,
// DatabaseAdapter extends DatabaseSession), NOT the prose §2.2 draft
// (Mode / MaybeResult, separate adapter/session shapes).
//
// One deliberate deviation from f1: `search` lives on DatabaseSession, not
// only on DatabaseAdapter. A search must work inside a transaction (the
// transaction's uncommitted rows should be searchable), and the session is
// the transaction boundary — so the session carries it and the adapter
// inherits it.

import { YattaError } from "./errors";
import type { DatabaseSchema, TableSchema } from "./schema";
import type { OrderBy, WhereClause } from "./query";
import type { SqlCompiler } from "./sql_compiler";
import type { SqlDialect } from "./sql_dialect";
import { SqliteAdapter, SqliteSession } from "./adapters/sqlite";
import { PGliteAdapter, PGliteSession } from "./adapters/pglite";
import { TursoAdapter, TursoSession, type TursoAdapterOptions } from "./adapters/turso";
import { DuckDBAdapter, DuckDBSession, type DuckDBAdapterOptions } from "./adapters/duckdb";
import { SurrealDBAdapter, SurrealDBSession, type SurrealDBAdapterOptions } from "./adapters/surrealdb";

export { SqliteAdapter, SqliteSession, PGliteAdapter, PGliteSession, TursoAdapter, TursoSession, DuckDBAdapter, DuckDBSession, SurrealDBAdapter, SurrealDBSession };
export type { TursoAdapterOptions, DuckDBAdapterOptions, SurrealDBAdapterOptions };

/** Relational drivers the ORM can target. ScyllaDB is deliberately absent: it is not relational. */
export type RelationalDriverName = "sqlite" | "pglite" | "turso" | "duckdb" | "surrealdb";
/** Every driver name, including the non-relational one. */
export type DriverName = RelationalDriverName | "scylladb";
/** Whether a driver executes synchronously or only through promises. */
export type ExecutionMode = "sync" | "async";

/** A value in sync mode, a Promise of it in async mode. Sync callers never see a Promise. */
export type ModeResult<M extends ExecutionMode, T> = M extends "sync" ? T : Promise<T>;

/**
 * Chains a value through a function that may itself return a mode result.
 * Sync: calls `fn` directly — no Promise is ever created, so a sync call
 * stays sync end to end. Async: `.then(fn)`, which flattens automatically
 * (a `fn` returning a Promise is awaited, not wrapped).
 */
export function chainResult<M extends ExecutionMode, T, R>(
  mode: M,
  value: ModeResult<M, T>,
  fn: (value: T) => R | ModeResult<M, R>,
): ModeResult<M, R> {
  if (mode === "sync") {
    return fn(value as T) as ModeResult<M, R>;
  }
  return (value as Promise<T>).then(fn) as ModeResult<M, R>;
}

/** Lifts a plain value into the mode: the value itself in sync, a resolved Promise in async. */
export function modeValue<M extends ExecutionMode, T>(mode: M, value: T): ModeResult<M, T> {
  return (mode === "sync" ? value : Promise.resolve(value)) as ModeResult<M, T>;
}

/**
 * Runs tasks strictly in order and discards their results. Sync: a plain
 * loop. Async: a promise chain. A single-connection driver cannot run
 * concurrent work on one transaction handle, so parallel helpers
 * (Promise.all) are never used for per-row work inside a transaction —
 * sequential here is the correctness rule, not a performance choice.
 */
export function runSequential<M extends ExecutionMode>(
  mode: M,
  tasks: Array<() => ModeResult<M, void>>,
): ModeResult<M, void> {
  if (mode === "sync") {
    for (const task of tasks) task();
    return undefined as ModeResult<M, void>;
  }
  return tasks.reduce<Promise<void>>(
    (prev, task) => prev.then(task as () => Promise<void>),
    Promise.resolve(),
  ) as ModeResult<M, void>;
}

/** What a driver can and cannot do, declared honestly so the core can enforce it. */
export interface AdapterCapabilities {
  readonly mode: ExecutionMode;
  /** Whether the driver can execute JOINs. (The ORM generates none — relations are batched separate queries.) */
  readonly joins: boolean;
  readonly foreignKeys: boolean;
  readonly acidTransactions: boolean;
  readonly savepoints: boolean;
  readonly returningClause: boolean;
  readonly fullTextSearch: "fts5" | "pg_fts" | "like_fallback" | "none";
  readonly vectors: "sqlite-vec" | "pgvector" | "cosine-fallback" | "none";
  readonly backupRestore: "file-copy" | "pglite-tar" | "snapshot" | "none";
  readonly multiProcessSafe: boolean;
  /** Maximum bound parameters in one statement. */
  readonly maxBindParams: number;
}

/** A find query compiled to dialect-neutral shape (no SQL strings). */
export interface CompiledFindQuery {
  where?: WhereClause<any>;
  orderBy?: OrderBy<any>[];
  select?: string[];
  take?: number;
  skip?: number;
}

/** An upsert compiled to its two possible outcomes. The session picks one by looking first (compileUpsert returns null for both current dialects). */
export interface CompiledUpsertPlan {
  where: WhereClause<any>;
  /** Columns that would conflict, derived from unique/PK where fields when atomic ON CONFLICT is possible. */
  conflictColumns: string[];
  createRow: Record<string, unknown>;
  updateRow: Record<string, unknown>;
}

/** A search query compiled to dialect-neutral shape (no SQL strings). */
export interface CompiledSearchQuery {
  tokens: string[];
  /** Synonym-expanded token phrases, one group per token: each group is a list of alternatives, each alternative a list of tokens (ORed within the group). */
  expandedGroups: string[][][];
  columns: string[];
  where?: WhereClause<any>;
  limit?: number;
  offset?: number;
  typoCorrection: boolean;
}

export interface TransactionOptions {
  mode?: "immediate" | "deferred";
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
}

/** What a raw statement returns: rows for reads, a change count for writes. */
export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  affectedRows: number;
}

export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

/**
 * Execution scope shared by the root adapter and active transaction handles.
 * Binding Table instances inside `db.transaction(fn)` to the active `tx`
 * DatabaseSession prevents single-connection deadlocks on PGlite.
 */
export interface DatabaseSession<M extends ExecutionMode = ExecutionMode> {
  readonly capabilities: AdapterCapabilities;

  /**
   * SQL dialect for this session. Owns every driver-specific SQL string:
   * identifiers, placeholders, types, defaults, DDL, LIKE, and value
   * conversion. Table reaches it (and the compiler below) through its db.
   */
  readonly dialect: SqlDialect;
  /** Driver-neutral SQL compiler over this session's dialect. */
  readonly compiler: SqlCompiler;
  /** Whether this session is currently inside a transaction. */
  readonly inTransaction: boolean;

  /**
   * Prepares (or retrieves from cache) and executes an SQL statement with
   * parameters. The honest execution seam: Table compiles via the compiler
   * and hands the strings here. `"get"` returns one row or null, `"all"`
   * returns all rows, `"run"` returns the write result
   * (`{ lastInsertRowid, changes }` — `lastInsertRowid` is 0 on drivers
   * with no rowid, such as Postgres; use RETURNING to read an id back).
   */
  run(sql: string, params?: unknown[], mode?: "get" | "all" | "run"): ModeResult<M, unknown>;

  /**
   * Makes sure one table's full-text index exists and matches its
   * searchable columns, creating or repairing it when it does not. A
   * driver whose index maintains itself (a Postgres generated column)
   * repairs the missing column/index instead; a driver with no index
   * no-ops. Called by `search()` so a first search never fails on a
   * missing index.
   */
  ensureSearchIndex(table: string, schema: TableSchema): ModeResult<M, void>;

  /** Finalizes and purges cached prepared statements. A no-op when the driver keeps none. */
  clearStatementCache(): void;

  insert(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
  ): ModeResult<M, Record<string, unknown>>;

  insertMany(
    table: string,
    schema: TableSchema,
    rows: Record<string, unknown>[],
  ): ModeResult<M, Record<string, unknown>[]>;

  find(
    table: string,
    schema: TableSchema,
    query: CompiledFindQuery,
  ): ModeResult<M, Record<string, unknown>[]>;

  count(
    table: string,
    schema: TableSchema,
    where?: WhereClause<any>,
  ): ModeResult<M, number>;

  update(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
    patch: Record<string, unknown>,
  ): ModeResult<M, Record<string, unknown>[]>;

  delete(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
  ): ModeResult<M, number>;

  upsert(
    table: string,
    schema: TableSchema,
    plan: CompiledUpsertPlan,
  ): ModeResult<M, Record<string, unknown>>;

  /** Full-text search, ranked (smaller rank = more relevant, matching FTS5's bm25 convention). */
  search(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
  ): ModeResult<M, Array<{ row: Record<string, unknown>; rank: number }>>;

  /**
   * Maintains one row's full-text index entry. `insert` writes a fresh entry
   * (no prior DELETE — the fast path); `update` replaces it; `delete` removes it.
   * A driver with no full-text index no-ops this.
   */
  syncSearchRow(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
    op: "insert" | "update" | "delete",
  ): ModeResult<M, void>;

  /** Rebuilds one table's full-text index from its current rows. A driver with no full-text index no-ops this. */
  rebuildSearchIndex(table: string, schema: TableSchema): ModeResult<M, void>;

  /** The indexed vocabulary for a table (every distinct indexed term), used for typo correction. */
  searchVocabulary(table: string, schema: TableSchema): ModeResult<M, Set<string>>;

  /** Raw SQL/query escape hatch (used by migrations, outbox, vectors, tests). */
  executeRaw(sql: string, params?: unknown[]): ModeResult<M, QueryResult>;
  executeBatch(sql: string): ModeResult<M, void>;

  /** Starts a root transaction or SAVEPOINT if already inside one. */
  transaction<R>(
    fn: (txSession: DatabaseSession<M>) => ModeResult<M, R>,
    options?: TransactionOptions,
  ): ModeResult<M, R>;
}

/**
 * Full database adapter contract implemented by SQLite, PGlite, etc.
 * The adapter extends the session: the root adapter IS the root session.
 */
export interface DatabaseAdapter<M extends ExecutionMode = ExecutionMode>
  extends DatabaseSession<M> {
  readonly driver: RelationalDriverName;

  /** Resolved location of the database: file path, data directory, or `":memory:"`. */
  readonly path: string;

  /** Eagerly wait for initialization (no-op on sync SQLite). */
  ready(): ModeResult<M, void>;

  /** Apply declarative schema (tables, indexes, FTS indexes/triggers). */
  syncSchema(schema: DatabaseSchema): ModeResult<M, void>;

  /** User tables (internal tables — FTS indexes, migration log — are excluded). */
  listTables(): ModeResult<M, string[]>;
  listColumns(table: string): ModeResult<M, IntrospectedColumn[]>;

  /** Exclusive lock across migrations (BEGIN IMMEDIATE on SQLite, advisory/tx lock on PGlite). */
  withMigrationLock<R>(
    fn: (session: DatabaseSession<M>) => ModeResult<M, R>,
  ): ModeResult<M, R>;

  backup(destPath: string): ModeResult<M, void>;
  restore(sourcePath: string): ModeResult<M, void>;
  close(): ModeResult<M, void>;
}

/** Connection options for the SQLite adapter. */
export interface SqliteAdapterOptions {
  /** File system path to the database, or `":memory:"`. Defaults to `Database/app.db`. */
  path?: string;
  /** Whether to log executed SQL with millisecond durations to stdout. */
  debug?: boolean;
}

/** Connection options for the PGlite adapter (Phase 2). */
export interface PgliteAdapterOptions {
  /** Directory holding the PGlite data files. Omit for an in-memory database. */
  dataDir?: string;
  /** Connection pool bounds. PGlite is single-connection: min > 1 throws, max is clamped to 1. */
  pool?: { min?: number; max?: number };
  /** Milliseconds to wait for the single connection. Default 30_000. */
  acquireTimeoutMs?: number;
  /** Whether to log executed SQL with millisecond durations to stdout. */
  debug?: boolean;
}

/**
 * Factory — one function, one config value. The driver picks the mode:
 * sqlite is sync, pglite is async. Drivers with no implementation yet
 * throw a plain YattaError rather than returning a stub.
 */
export function createAdapter(driver: "sqlite", options?: SqliteAdapterOptions): SqliteAdapter;
export function createAdapter(driver: "pglite", options?: PgliteAdapterOptions): DatabaseAdapter<"async">;
export function createAdapter(driver: "turso", options?: TursoAdapterOptions): DatabaseAdapter<"async">;
export function createAdapter(driver: "duckdb", options?: DuckDBAdapterOptions): DatabaseAdapter<"async">;
export function createAdapter(driver: "surrealdb", options?: SurrealDBAdapterOptions): DatabaseAdapter<"async">;
export function createAdapter(
  driver: RelationalDriverName,
  options?: SqliteAdapterOptions | PgliteAdapterOptions | TursoAdapterOptions | DuckDBAdapterOptions | SurrealDBAdapterOptions,
): DatabaseAdapter<ExecutionMode>;
export function createAdapter(
  driver: RelationalDriverName,
  options?: SqliteAdapterOptions | PgliteAdapterOptions | TursoAdapterOptions | DuckDBAdapterOptions | SurrealDBAdapterOptions,
): DatabaseAdapter<ExecutionMode> {
  switch (driver) {
    case "sqlite":
      return new SqliteAdapter((options ?? {}) as SqliteAdapterOptions);
    case "pglite":
      return new PGliteAdapter((options ?? {}) as PgliteAdapterOptions);
    case "turso":
      return new TursoAdapter((options ?? {}) as TursoAdapterOptions);
    case "duckdb":
      return new DuckDBAdapter((options ?? {}) as DuckDBAdapterOptions);
    case "surrealdb":
      return new SurrealDBAdapter((options ?? {}) as SurrealDBAdapterOptions);
    default:
      throw new YattaError(`Driver "${driver}" is not implemented.`);
  }
}
