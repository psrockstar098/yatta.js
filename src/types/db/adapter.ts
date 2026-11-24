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
import { SqliteAdapter, SqliteSession } from "./adapters/sqlite";

export { SqliteAdapter, SqliteSession };

/** Relational drivers the ORM can target. ScyllaDB is deliberately absent: it is not relational. */
export type RelationalDriverName = "sqlite" | "pglite" | "turso" | "duckdb" | "surrealdb";
/** Every driver name, including the non-relational one. */
export type DriverName = RelationalDriverName | "scylladb";
/** Whether a driver executes synchronously or only through promises. */
export type ExecutionMode = "sync" | "async";

/** A value in sync mode, a Promise of it in async mode. Sync callers never see a Promise. */
export type ModeResult<M extends ExecutionMode, T> = M extends "sync" ? T : Promise<T>;

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
export function createAdapter(
  driver: RelationalDriverName,
  options?: SqliteAdapterOptions | PgliteAdapterOptions,
): DatabaseAdapter<ExecutionMode>;
export function createAdapter(
  driver: RelationalDriverName,
  options?: SqliteAdapterOptions | PgliteAdapterOptions,
): DatabaseAdapter<ExecutionMode> {
  switch (driver) {
    case "sqlite":
      return new SqliteAdapter((options ?? {}) as SqliteAdapterOptions);
    case "pglite":
      throw new YattaError(
        `Driver "pglite" is not available yet — PGlite support lands in Phase 2 of the multi-database build.`,
      );
    default:
      throw new YattaError(`Driver "${driver}" is not implemented.`);
  }
}
