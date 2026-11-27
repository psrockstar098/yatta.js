// DuckDB adapter + session (Phase 2 of the multi-database ORM refactor).
//
// One DuckDBInstance + one DuckDBConnection from @duckdb/node-api
// (2.0.1-r.1), all Promise-based: DuckDBInstance.create(path?),
// instance.connect(), connection.run(sql, values) for writes,
// connection.runAndReadAll(sql, values) + reader.getRowObjectsJS()
// for reads. Every behaviour here is probe-verified against that
// package under Bun (see the probe notes inline); the API is used as
// documented in node_modules/@duckdb/node-api/README.md and
// lib/DuckDBConnection.d.ts, not from memory.
//
// The adapter extends the session: the root adapter IS the root session.
// A transaction hands fn the same session object. DuckDB is
// single-connection, so every statement is serialized through a FIFO
// mutex — except statements inside an active transaction, which run
// straight on the connection (they already hold it). Which case
// applies is tracked with AsyncLocalStorage, exactly like PGlite's
// gate: a nested transaction() in the same async context joins the
// outer one, while a concurrent transaction() from another context
// waits on the mutex instead of joining a transaction it does not own.
//
// Honest limits, all probe-verified:
//   - The `@duckdb/node-api` package is loaded LAZILY (see `loadDuckdb`
//     below), never statically imported: its loader
//     (`@duckdb/node-bindings/duckdb.js`) conditionally requires a native
//     `.node` binary per platform, and `bun build --compile` resolves
//     every branch statically — so a static import broke the standalone
//     build with "Could not resolve" for the seven platforms not
//     installed here. A computed-specifier dynamic import is invisible
//     to the bundler: the package stays out of the binary entirely, and
//     a SQLite-only binary works standalone. A DuckDB database loads the
//     package from `node_modules` at runtime instead, so a standalone
//     binary that USES DuckDB needs the package resolvable next to it.
//   - SAVEPOINT is a parser error in DuckDB 2.0.1, so there are no
//     savepoints: a nested transaction joins the outer one and an
//     inner failure rolls back everything (capabilities.savepoints is
//     false, and the tests pin the join behaviour).
//   - A failed statement aborts the whole transaction (Postgres-style):
//     transaction() always ROLLBACKs on error and rethrows.
//   - The FTS extension cannot be installed offline (INSTALL fts fails
//     in this environment), so search is a LIKE fallback across the
//     searchable columns (capabilities.fullTextSearch is
//     "like_fallback"), ranked by how many (column, token) pairs match.
//   - No IDENTITY/AUTOINCREMENT syntax: col.id() is a sequence
//     default (see the dialect), and an explicit id insert is followed
//     by a setval() past MAX(id), like PGlite's identity sync.
//   - DuckDB rejects ON DELETE CASCADE / SET NULL at parse time, so
//     the dialect emits a bare REFERENCES (RESTRICT behaviour) and the
//     adapter emulates CASCADE/SET NULL in delete() from an FK
//     registry built at syncSchema. Session-path deletes cascade;
//     raw-SQL deletes do not (the database cannot express the action).
//   - Backup is CHECKPOINT + file copy (verified: a copied file
//     reopens with its rows). In-memory databases cannot be backed up
//     or restored into, like SQLite's restore refusal.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DuckDBConnection,
  DuckDBInstance,
  DuckDBValue,
} from "@duckdb/node-api";
import { YattaError } from "../errors";
import type { ColumnDefinition, DatabaseSchema, TableSchema } from "../schema";
import { tokenizeText } from "../search";
import { SqlCompiler, escapeLike } from "../sql_compiler";
import type {
  AdapterCapabilities,
  CompiledFindQuery,
  CompiledSearchQuery,
  CompiledUpsertPlan,
  DatabaseAdapter,
  DatabaseSession,
  IntrospectedColumn,
  QueryResult,
  TransactionOptions,
} from "../adapter";
import { DuckDBDialect, duckSequenceName } from "./duckdb_dialect";

/**
 * Lazily loads `@duckdb/node-api`, cached after the first call. The
 * specifier is computed at runtime on purpose: a static import (or a
 * literal dynamic import) lets `bun build --compile` trace into the
 * package's native-binding loader, which requires a `.node` binary per
 * platform — and the build fails resolving the seven platforms not
 * installed on the build machine. A computed specifier is invisible to
 * the bundler, so the package is never bundled; it is resolved from
 * `node_modules` when a DuckDB database actually opens. Every use goes
 * through `ensureReady()` first, which awaits `initConnection()`,
 * which awaits this — so the module is loaded before any statement
 * runs, and a failure to load it surfaces as a plain error from
 * `ready()` instead of a crash at import time.
 */
type DuckDBNodeApi = typeof import("@duckdb/node-api");
let duckApi: DuckDBNodeApi | null = null;
async function loadDuckdb(): Promise<DuckDBNodeApi> {
  if (duckApi) return duckApi;
  const specifier = ["@duckdb", "node-api"].join("/");
  duckApi = (await import(specifier)) as DuckDBNodeApi;
  return duckApi;
}
import type { SqlDialect } from "../sql_dialect";
import type { WhereClause } from "../query";

/** Maps a DuckDB/node-api error onto a YattaError (message + SQL). */
function wrapDuckError(err: unknown, sql?: string): YattaError {
  if (err instanceof YattaError) return err;
  return new YattaError((err as Error)?.message ?? String(err), sql);
}

/** Column definitions of one table's schema, as a Map. */
function columnsOf(schema: TableSchema): Map<string, ColumnDefinition> {
  return new Map(Object.entries(schema).map(([name, builder]) => [name, builder.def]));
}

/** Searchable column names for one table's schema, in schema order. */
function searchableColumns(schema: TableSchema): string[] {
  return Object.entries(schema)
    .filter(([, builder]) => builder.def.isSearchable)
    .map(([colName]) => colName);
}

/**
 * A table's primary key column, or null when it has none. Search maps
 * index entries back to rows through the key, so a keyless table cannot
 * be searched — and must not crash schema sync trying.
 */
function pkColumnName(schema: TableSchema): string | null {
  for (const [colName, builder] of Object.entries(schema)) {
    if (builder.def.primaryKey) return colName;
  }
  return "id" in schema ? "id" : null;
}

/**
 * Orders tables so a CREATE TABLE never references a table that does
 * not exist yet (DuckDB rejects forward references; SQLite tolerates
 * them). Self-references are ignored; a cycle falls back to
 * declaration order for the tables in it.
 */
function topologicalSortTables(schema: DatabaseSchema): string[] {
  const names = Object.keys(schema);
  const deps = new Map<string, Set<string>>();
  for (const name of names) {
    const refs = new Set<string>();
    for (const builder of Object.values(schema[name]!)) {
      const ref = builder.def.references?.table;
      if (ref && ref !== name && names.includes(ref)) refs.add(ref);
    }
    deps.set(name, refs);
  }
  const out: string[] = [];
  const remaining = new Set(names);
  while (remaining.size > 0) {
    let progressed = false;
    for (const name of [...remaining]) {
      if ([...deps.get(name)!].every((d) => !remaining.has(d))) {
        out.push(name);
        remaining.delete(name);
        progressed = true;
      }
    }
    if (!progressed) {
      out.push(...names.filter((n) => remaining.has(n)));
      break;
    }
  }
  return out;
}

/**
 * After an insert that supplied an explicit value for an auto-increment
 * column, moves the sequence past the largest id in the table. A
 * sequence does not follow explicit inserts on its own; without this,
 * the next auto id collides with the explicit one. Runs on the same
 * session, so it is transactional. setval(seq, MAX(id)) never rewinds:
 * the sequence is always at or past MAX(id) except right after an
 * explicit insert raised it.
 */
async function syncSequenceIfExplicitPk(
  session: DatabaseSession<"async">,
  table: string,
  schema: TableSchema,
  row: Record<string, unknown>,
): Promise<void> {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  for (const [colName, builder] of Object.entries(schema)) {
    if (!builder.def.autoIncrement) continue;
    if (row[colName] === undefined) continue;
    const seq = duckSequenceName(table, colName).replace(/'/g, "''");
    await session.executeRaw(
      `SELECT setval('${seq}', (SELECT COALESCE(MAX(${q(colName)}), 0) FROM ${q(table)}));`,
    );
  }
}

export const DUCKDB_CAPABILITIES: AdapterCapabilities = {
  mode: "async",
  // DuckDB executes JOINs natively (the ORM still batches relations
  // into separate queries, as on every other driver).
  joins: true,
  // Verified live: an orphan insert and a parent delete are both
  // rejected with a foreign-key constraint error. CASCADE / SET NULL
  // cannot be expressed in DuckDB DDL (parser error), so the adapter
  // emulates them in delete() from the FK registry syncSchema builds
  // — session-path deletes cascade; raw-SQL deletes do not.
  foreignKeys: true,
  acidTransactions: true,
  // SAVEPOINT is a parser error in DuckDB 2.0.1: nested transactions
  // join the outer one instead (see transaction()).
  savepoints: false,
  returningClause: true,
  // The FTS extension cannot be installed offline, so search is a
  // LIKE fallback across the searchable columns.
  fullTextSearch: "like_fallback",
  vectors: "none",
  // CHECKPOINT + file copy, verified by reopening the copy.
  backupRestore: "file-copy",
  // A DuckDB file database is single-writer: a second process
  // opening the same file read-write fails on the lock.
  multiProcessSafe: false,
  // Conservative floor matching the other adapters; the compiler
  // never generates more than a few hundred params for realistic
  // queries.
  maxBindParams: 999,
  // The DuckDB dialect compiles runnable SQL.
  compilerSql: true,
};

/** Connection options for the DuckDB adapter. */
export interface DuckDBAdapterOptions {
  /** File system path to the database, or `":memory:"`. Defaults to `":memory:"`. */
  path?: string;
  /** Whether to log executed SQL with millisecond durations to stdout. */
  debug?: boolean;
}

/**
 * One DuckDB connection, implementing the session contract. Owns the
 * DuckDBInstance + DuckDBConnection, the FIFO mutex, and the
 * transaction AsyncLocalStorage. No prepared-statement cache is kept
 * (clearStatementCache is a no-op): every run() binds its values
 * inline through runAndReadAll/run.
 */
export class DuckDBSession implements DatabaseSession<"async"> {
  readonly capabilities: AdapterCapabilities = DUCKDB_CAPABILITIES;
  /** SQL dialect for this connection. Owns every driver-specific SQL string. */
  readonly dialect: SqlDialect;
  /** Driver-neutral SQL compiler over the dialect. */
  readonly compiler: SqlCompiler;
  /** The DuckDB dialect (same object as `dialect`, with setTableContext). */
  protected readonly duckDialect: DuckDBDialect;

  /** Resolved filesystem path to the database file, or `":memory:"`. */
  readonly path: string;
  private readonly debug: boolean;
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  protected readyPromise: Promise<void>;
  protected closed = false;
  /** FIFO mutex serializing statements on the single connection. */
  private mutex: Promise<void> = Promise.resolve();
  /** Active transaction for this async context (join target for nesting). */
  private txLocal = new AsyncLocalStorage<{ depth: number }>();
  /**
   * Referential actions DuckDB cannot express in DDL (CASCADE /
   * SET NULL), keyed by parent table. Built by syncSchemaBody from the
   * full schema; delete() consults it to emulate the action on the
   * session path. RESTRICT needs no entry: the database enforces it.
   */
  protected fkChildren = new Map<
    string,
    Array<{ childTable: string; childCol: string; onDelete: string; childSchema: TableSchema }>
  >();

  constructor(options: DuckDBAdapterOptions = {}) {
    this.duckDialect = new DuckDBDialect();
    this.dialect = this.duckDialect;
    this.compiler = new SqlCompiler(this.dialect);

    let targetPath = options.path ?? ":memory:";
    if (targetPath === ":memory:") {
      this.path = ":memory:";
    } else {
      const hasExtension = path.extname(targetPath) !== "";
      if (!hasExtension || targetPath.endsWith("/") || targetPath.endsWith("\\")) {
        targetPath = path.join(targetPath, "app.duckdb");
      }
      this.path = path.resolve(process.cwd(), targetPath);
      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.debug = options.debug ?? false;
    this.readyPromise = this.initConnection();
  }

  /** Direct access to the underlying DuckDBConnection (null until ready). */
  get duckConnection(): DuckDBConnection | null {
    return this.connection;
  }

  /** Whether this session is currently inside a transaction (this async context). */
  get inTransaction(): boolean {
    return this.txLocal.getStore() !== undefined;
  }

  /** Opens the instance + connection. Re-run after restore() closes them. */
  protected async initConnection(): Promise<void> {
    const api = await loadDuckdb();
    const instance = await api.DuckDBInstance.create(this.path);
    this.instance = instance;
    this.connection = await instance.connect();
  }

  /** Waits for the connection to be open (no-op once it is). */
  protected async ensureReady(): Promise<void> {
    if (this.closed) throw new YattaError("DuckDB connection is closed.");
    await this.readyPromise;
    if (!this.connection) throw new YattaError("DuckDB connection is not open.");
  }

  /** Runs fn exclusively on the single connection (FIFO). */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Disconnects and closes the instance + connection (no closed flag). Used by close() and restore(). */
  protected closeConnection(): void {
    if (this.connection) {
      try {
        this.connection.disconnectSync();
      } catch {}
      this.connection = null;
    }
    if (this.instance) {
      try {
        this.instance.closeSync();
      } catch {}
      this.instance = null;
    }
  }

  /** Finalizes and purges cached prepared statements. A no-op: this driver keeps none. */
  clearStatementCache(): void {}

  /**
   * Executes an SQL statement with parameters. `"get"` returns one row
   * or null, `"all"` returns all rows, `"run"` returns the write
   * result (`{ lastInsertRowid, changes }` — `lastInsertRowid` is 0 on
   * DuckDB, as on Postgres; use RETURNING to read an id back).
   *
   * Parameter binding: the node-api infers a parameter's type from
   * its JS value, and a bare Uint8Array is ambiguous (it maps to ANY
   * and the write fails with "Cannot create values of type ANY"), so
   * BLOB values are wrapped with blobValue() here. JS numbers bind as
   * DOUBLE and cast to BIGINT on insert; the dialect already binds
   * INTEGER-column values as bigint, so ids and epoch-ms timestamps
   * stay exact.
   */
  async run(
    sql: string,
    params: unknown[] = [],
    mode: "get" | "all" | "run" = "all",
  ): Promise<unknown> {
    // Inside a transaction this async context already holds the
    // connection, so the statement runs straight on it; outside one
    // it waits its turn on the mutex.
    if (this.txLocal.getStore()) return this.execRun(sql, params, mode);
    return this.withLock(() => this.execRun(sql, params, mode));
  }

  private async execRun(
    sql: string,
    params: unknown[],
    mode: "get" | "all" | "run",
  ): Promise<unknown> {
    await this.ensureReady();
    const conn = this.connection!;
    // `ensureReady()` awaited `initConnection()`, which loaded the
    // package — so this is a cache hit, not a second load.
    const api = await loadDuckdb();
    const bound = params.map((v) =>
      v instanceof Uint8Array ? api.blobValue(v) : v,
    ) as DuckDBValue[];
    const start = this.debug ? performance.now() : 0;
    try {
      if (mode === "run") {
        const res = await conn.run(sql, bound);
        const changes = res.rowsChanged;
        res.closeSync();
        return { lastInsertRowid: 0, changes };
      }
      const reader = await conn.runAndReadAll(sql, bound);
      try {
        const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
        if (mode === "get") return rows[0] ?? null;
        return rows;
      } finally {
        reader.closeSync();
      }
    } catch (err) {
      throw wrapDuckError(err, sql);
    } finally {
      if (this.debug) {
        console.log(
          `[yatta-db] ${(performance.now() - start).toFixed(2)}ms  ${sql}`,
          params.length ? params : "",
        );
      }
    }
  }

  // ── Session CRUD ─────────────────────────────────────────────────────────

  async insert(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), row);
    const inserted = (await this.run(sql, params, "get")) as Record<string, unknown> | null;
    await syncSequenceIfExplicitPk(this, table, schema, row);
    return this.compiler.decodeRow(columnsOf(schema), inserted);
  }

  async insertMany(
    table: string,
    schema: TableSchema,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    // One transaction, one insert at a time: the driver is
    // single-connection — never Promise.all.
    return this.transaction(async (tx) => {
      const out: Record<string, unknown>[] = [];
      for (const row of rows) out.push(await tx.insert(table, schema, row));
      return out;
    });
  }

  async find(
    table: string,
    schema: TableSchema,
    query: CompiledFindQuery,
  ): Promise<Record<string, unknown>[]> {
    const { sql, params } = this.compiler.compileSelect(table, columnsOf(schema), query);
    const rows = (await this.run(sql, params, "all")) as Record<string, unknown>[];
    return rows.map((r) => this.compiler.decodeRow(columnsOf(schema), r));
  }

  async count(
    table: string,
    schema: TableSchema,
    where?: WhereClause<any>,
  ): Promise<number> {
    const { sql, params } = this.compiler.compileCount(table, columnsOf(schema), where);
    const row = (await this.run(sql, params, "get")) as { count: unknown } | null;
    // COUNT(*) is BIGINT on DuckDB; the dialect's decodeValue turns a
    // safe BigInt into a number and throws past MAX_SAFE_INTEGER.
    // (decodeValue lives on the dialect, not the compiler.)
    return this.dialect.decodeValue(row?.count ?? 0, undefined) as number;
  }

  async update(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    if (Object.keys(patch).length === 0) return [];
    const { sql, params } = this.compiler.compileUpdate(table, columnsOf(schema), patch, where, { returning: true });
    const rows = (await this.run(sql, params, "all")) as Record<string, unknown>[];
    return rows.map((r) => this.compiler.decodeRow(columnsOf(schema), r));
  }

  async delete(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
  ): Promise<number> {
    // Referential actions the database cannot express (see the header):
    // CASCADE deletes the referencing rows first, SET NULL nulls them.
    // The child deletes go through delete()/update() themselves, so a
    // multi-level chain cascades too. They must run BEFORE the parent
    // delete, or the FK rejects the parent delete. RESTRICT needs no
    // work here: the database enforces it.
    const children = this.fkChildren.get(table);
    if (children && children.length > 0) {
      const pkCol = pkColumnName(schema);
      if (pkCol !== null) {
        const { sql: pkSql, params: pkParams } = this.compiler.compilePkSelect(
          table,
          columnsOf(schema),
          pkCol,
          where,
        );
        const pkRows = (await this.run(pkSql, pkParams, "all")) as { pk: unknown }[];
        const pks = pkRows.map((r) => r.pk);
        for (const fk of children) {
          // Chunked: one IN list must stay under maxBindParams.
          for (let i = 0; i < pks.length; i += 500) {
            const chunk = pks.slice(i, i + 500);
            const childWhere = { [fk.childCol]: { in: chunk } } as any;
            if (fk.onDelete === "CASCADE") {
              await this.delete(fk.childTable, fk.childSchema, childWhere);
            } else if (fk.onDelete === "SET NULL") {
              await this.update(fk.childTable, fk.childSchema, childWhere, { [fk.childCol]: null });
            }
          }
        }
      }
    }
    const { sql, params } = this.compiler.compileDelete(table, columnsOf(schema), where);
    return (await this.run(sql, params, "run") as { changes: number }).changes;
  }

  async upsert(
    table: string,
    schema: TableSchema,
    plan: CompiledUpsertPlan,
  ): Promise<Record<string, unknown>> {
    // compileUpsert returns null for DuckDB (and for SQLite and
    // Postgres): the transactional find-first fallback is the
    // behaviour, not a stopgap.
    return this.transaction(async () => {
      const existing = await this.find(table, schema, { where: plan.where, take: 1 });
      if (existing.length > 0) {
        const pkCol = pkColumnName(schema) ?? "id";
        const pk = (existing[0] as any)[pkCol];
        const { sql, params } = this.compiler.compileUpdate(
          table,
          columnsOf(schema),
          plan.updateRow,
          { [pkCol]: pk } as any,
          { returning: true },
        );
        return this.compiler.decodeRow(columnsOf(schema), await this.run(sql, params, "get"));
      }
      const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), plan.createRow);
      return this.compiler.decodeRow(columnsOf(schema), await this.run(sql, params, "get"));
    });
  }

  // ── Full-text search (LIKE fallback) ─────────────────────────────────────
  //
  // No FTS index: the FTS extension cannot be installed offline, so
  // search scans the live rows with ILIKE (DuckDB LIKE is
  // case-sensitive; ILIKE matches SQLite's case-insensitive behaviour).
  // Each synonym-expanded group is one query token's alternatives
  // (already computed by the core in Table.search); groups are ANDed,
  // alternatives inside a group are ORed, and a phrase's tokens must
  // all match in one column. Rank is the negated count of (column,
  // token) pairs that match — smaller rank = more relevant, matching
  // the FTS5 bm25 convention — computed by reusing each bound
  // placeholder in the SELECT list (DuckDB lets one $n appear twice).

  async search(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
  ): Promise<Array<{ row: Record<string, unknown>; rank: number }>> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) {
      throw new YattaError(
        `Table "${table}" has no searchable columns. ` +
          `Mark a text column with .searchable() to make the table searchable.`,
      );
    }
    const pkCol = pkColumnName(schema);
    if (pkCol === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so search cannot map index entries back to rows. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }

    const restricted = query.columns.length > 0 ? query.columns : null;
    if (restricted) {
      for (const c of restricted) {
        if (!cols.includes(c)) {
          throw new YattaError(
            `Column "${c}" on table "${table}" is not searchable. ` +
              `Searchable columns: ${cols.join(", ")}. ` +
              `Non-searchable columns are never searched, and naming one here is refused rather than silently ignored.`,
          );
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) {
          throw new YattaError(
            `Column "${c}" on table "${table}" cannot be used as a search column filter because its name is not a plain identifier.`,
          );
        }
      }
    }

    if (query.expandedGroups.length === 0) return [];

    // No index to build, but the table must exist before it can be
    // searched (same failure as a missing FTS table on SQLite).
    await this.ensureSearchIndex(table, schema);

    const searchCols = restricted ?? cols;
    const params: unknown[] = [];
    let nextParam = 1;
    const ph = (): string => this.dialect.placeholder(nextParam++);
    /** One (column, token) test, reused by both the WHERE and the rank sum. */
    const matchCells: Array<{ col: string; placeholder: string }> = [];
    const groupPredicates: string[] = [];

    for (const group of query.expandedGroups) {
      const altPredicates: string[] = [];
      for (const phrase of group) {
        if (phrase.length === 0) continue;
        const colPredicates: string[] = [];
        for (const col of searchCols) {
          const qc = this.dialect.quoteIdent(col);
          const tokenPreds = phrase.map((tok) => {
            const placeholder = ph();
            params.push(`%${escapeLike(tok)}%`);
            matchCells.push({ col: qc, placeholder });
            return `${qc} ILIKE ${placeholder} ESCAPE '\\'`;
          });
          colPredicates.push(tokenPreds.length > 1 ? `(${tokenPreds.join(" AND ")})` : tokenPreds[0]!);
        }
        altPredicates.push(colPredicates.length > 1 ? `(${colPredicates.join(" OR ")})` : colPredicates[0]!);
      }
      if (altPredicates.length === 0) continue;
      groupPredicates.push(altPredicates.length > 1 ? `(${altPredicates.join(" OR ")})` : altPredicates[0]!);
    }
    if (groupPredicates.length === 0) return [];

    const searchPred = groupPredicates.length > 1 ? `(${groupPredicates.join(" AND ")})` : groupPredicates[0]!;
    const rankExpr =
      matchCells.length > 0
        ? `(-(${matchCells.map((c) => `CASE WHEN ${c.col} ILIKE ${c.placeholder} THEN 1 ELSE 0 END`).join(" + ")}))`
        : "0";
    const { clause: userClause, params: userParams } = this.compiler.compileWhere(
      table,
      columnsOf(schema),
      query.where,
      nextParam,
    );
    const whereSql = [searchPred, userClause].filter(Boolean).join(" AND ");
    const limitOffsetSql = this.dialect.compileLimitOffset(query.limit, query.offset);
    const qt = this.dialect.quoteIdent(table);
    const sql =
      `SELECT ${qt}.*, ${rankExpr} AS "__yatta_rank" FROM ${qt} WHERE ${whereSql} ` +
      `ORDER BY "__yatta_rank" ASC ${limitOffsetSql};`;

    const rows = (await this.run(sql, [...params, ...userParams], "all")) as Record<string, unknown>[];
    return rows.map((r) => {
      const rank = Number(r["__yatta_rank"]);
      const { __yatta_rank: _dropped, ...rest } = r;
      return { row: this.compiler.decodeRow(columnsOf(schema), rest), rank };
    });
  }

  /**
   * Maintains one row's full-text index entry. A no-op: the LIKE
   * fallback has no index to maintain — every search reads the live
   * rows, so inserts, updates, and deletes are visible at once.
   */
  async syncSearchRow(
    _table: string,
    _schema: TableSchema,
    _row: Record<string, unknown>,
    _op: "insert" | "update" | "delete",
  ): Promise<void> {}

  /** Rebuilds one table's full-text index from its current rows. A no-op after the same guards SQLite applies: with no index, there is nothing to rebuild, and a search already reads the live rows. */
  async rebuildSearchIndex(table: string, schema: TableSchema): Promise<void> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) {
      throw new YattaError(
        `Table "${table}" has no searchable columns, so there is no search index to rebuild. ` +
          `Mark a text column with .searchable() first.`,
      );
    }
    if (!(await this.baseTableExists(table))) {
      throw new YattaError(`Table "${table}" does not exist in this database, so its search index cannot be rebuilt.`);
    }
    if (pkColumnName(schema) === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so its search index cannot be rebuilt. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
  }

  /**
   * The indexed vocabulary for a table: every distinct term the search
   * can match, used for typo correction. With no FTS index to read,
   * it is scanned from the base table's searchable values.
   */
  async searchVocabulary(table: string, schema: TableSchema): Promise<Set<string>> {
    const cols = searchableColumns(schema);
    const terms = new Set<string>();
    if (cols.length === 0) return terms;
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const rows = (await this.run(
      `SELECT ${colSql} FROM ${this.dialect.quoteIdent(table)};`,
      [],
      "all",
    )) as Record<string, unknown>[];
    for (const row of rows) {
      for (const c of cols) {
        const value = row[c];
        if (typeof value === "string") {
          for (const token of tokenizeText(value)) terms.add(token);
        }
      }
    }
    return terms;
  }

  /** Whether the base table exists right now. */
  protected async baseTableExists(tableName: string): Promise<boolean> {
    const row = (await this.run(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'main' AND table_name = $1 LIMIT 1;`,
      [tableName],
      "get",
    )) as { ok: number } | null;
    return row !== null && row !== undefined;
  }

  /**
   * No standalone FTS table exists on this driver: search is a LIKE
   * fallback over the live rows, so there is nothing for Table.delete
   * to clean up. Always false.
   */
  async ftsTableExists(_tableName: string): Promise<boolean> {
    return false;
  }

  /**
   * Makes sure one table can be searched. With no index to build or
   * repair this only verifies the table exists and has a primary key;
   * the search itself reads the live rows.
   */
  async ensureSearchIndex(tableName: string, schema: TableSchema): Promise<void> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) return;
    if (!(await this.baseTableExists(tableName))) {
      throw new YattaError(
        `Table "${tableName}" does not exist in this database, so it cannot be searched. ` +
          `Create it first (a schema with autoMigrate creates tables on open).`,
      );
    }
    if (pkColumnName(schema) === null) {
      throw new YattaError(
        `Table "${tableName}" has no primary key column, so search cannot map index entries back to rows. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
  }

  // ── Raw SQL ──────────────────────────────────────────────────────────────

  /**
   * Raw SQL escape hatch. Reads return their rows; writes return their
   * change count. Which side a statement falls on is decided by its first
   * keyword (SELECT/WITH/VALUES/EXPLAIN/SHOW/PRAGMA, or anything with a
   * RETURNING clause, reads rows; everything else reports changes) — an
   * escape hatch, not a parser, so callers that need exact mode control
   * use `run()`.
   */
  async executeRaw(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const head = sql.trimStart().toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("VALUES") ||
      head.startsWith("EXPLAIN") ||
      head.startsWith("SHOW") ||
      head.startsWith("PRAGMA") ||
      /RETURNING\b/i.test(sql);
    if (isRead) {
      const rows = (await this.run(sql, params, "all")) as Record<string, unknown>[];
      return { rows, affectedRows: rows.length };
    }
    const res = (await this.run(sql, params, "run")) as { changes: number };
    return { rows: [], affectedRows: res.changes };
  }

  /** Runs multi-statement SQL (DDL scripts, migrations). DuckDB's run accepts several statements separated by `;`. */
  async executeBatch(sql: string): Promise<void> {
    await this.run(sql, [], "run");
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  /**
   * Runs `fn` inside a DuckDB transaction. `fn` is async (the driver
   * is Promise-based) and is awaited before COMMIT, so an async
   * callback commits after its own awaits finish.
   *
   * Nesting: DuckDB 2.0.1 has no SAVEPOINT (it is a parser error), so
   * a nested transaction() joins the outer one — the same session
   * object, the same transaction. An inner failure therefore rolls
   * back the whole outer transaction, not just the inner work. The
   * join is tracked per async context (AsyncLocalStorage), so a
   * concurrent transaction() from another context waits on the mutex
   * instead of joining a transaction it does not own.
   *
   * `options.mode` ("immediate") and `options.isolationLevel` are
   * accepted and ignored: DuckDB has no BEGIN IMMEDIATE, and the
   * session mutex already serializes transactions, which is what
   * immediate mode is for on SQLite.
   */
  async transaction<R>(
    fn: (txSession: DatabaseSession<"async">) => Promise<R>,
    _options?: TransactionOptions,
  ): Promise<R> {
    await this.ensureReady();
    const store = this.txLocal.getStore();
    if (store) {
      store.depth++;
      try {
        return await fn(this);
      } finally {
        store.depth--;
      }
    }
    return this.withLock(async () => {
      const state = { depth: 1 };
      return this.txLocal.run(state, async () => {
        await this.execRun("BEGIN", [], "run");
        try {
          const result = await fn(this);
          await this.execRun("COMMIT", [], "run");
          return result;
        } catch (err) {
          // A failed statement aborts the whole DuckDB transaction,
          // so the ROLLBACK below is what lets the connection run
          // statements again; it must not mask the original error.
          try {
            await this.execRun("ROLLBACK", [], "run");
          } catch {}
          throw err;
        }
      });
    });
  }
  /**
   * Creates the migration-marker table (`_yatta_migrations`) in DuckDB
   * DDL. Its id is a sequence default like any col.id(). The transaction
   * hands callers this same adapter object, so this also serves a
   * transaction child session (DuckDB transactions hand callers
   * this same object, so the adapter inherits it unchanged).
   */
  async ensureMigrationTable(): Promise<void> {
    await this.ensureSequence("_yatta_migrations", "id");
    this.duckDialect.setTableContext("_yatta_migrations");
    try {
      const fragments = [
        this.duckDialect.compileColumnFragment("id", { type: "INTEGER", primaryKey: true, autoIncrement: true, notNull: true }, "create"),
        this.duckDialect.compileColumnFragment("name", { type: "TEXT", unique: true }, "create"),
        this.duckDialect.compileColumnFragment("hash", { type: "TEXT" }, "create"),
        this.duckDialect.compileColumnFragment("applied_at", { type: "TEXT", defaultValue: "CURRENT_TIMESTAMP" }, "create"),
      ];
      await this.run(this.duckDialect.compileCreateTableSql("_yatta_migrations", fragments), [], "run");
    } finally {
      this.duckDialect.setTableContext(null);
    }
  }

  /** Names of migrations already recorded as applied. */
  async listAppliedMigrations(): Promise<string[]> {
    return (
      (await this.run("SELECT name FROM _yatta_migrations", [], "all")) as { name: string }[]
    ).map((r) => r.name);
  }

  /** Records one migration as applied (ignored when already present). */
  async recordMigration(name: string): Promise<void> {
    await this.run(
      `INSERT INTO "_yatta_migrations" ("name", "hash") VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
      [name, "migration"],
      "run",
    );
  }

  protected async ensureSequence(table: string, colName: string): Promise<void> {
    const seq = duckSequenceName(table, colName).replace(/"/g, '""');
    await this.run(`CREATE SEQUENCE IF NOT EXISTS "${seq}" START WITH 1;`, [], "run");
  }

}

/**
 * The DuckDB adapter: the root session plus the connection-level
 * operations (schema sync, migration lock, backup/restore, close).
 * The root adapter IS the root session.
 */
export class DuckDBAdapter extends DuckDBSession implements DatabaseAdapter<"async"> {
  readonly driver = "duckdb" as const;

  /** Eagerly wait for initialization (the instance + connection open asynchronously). */
  async ready(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * Applies a declarative schema: creates missing tables and columns,
   * and the auto-increment sequences their defaults need. Runs inside
   * one transaction, so a failed sync leaves the previous schema
   * untouched. Unlike SQLite, an expression default (CURRENT_TIMESTAMP)
   * CAN be added to a populated table with plain ALTER TABLE, so no
   * table rebuild is ever needed here.
   */
  async syncSchema(schema: DatabaseSchema): Promise<void> {
    await this.ensureReady();
    await this.transaction(async () => {
      await this.syncSchemaBody(schema);
    });
  }

  private async syncSchemaBody(schema: DatabaseSchema): Promise<void> {
    const schemaHash = crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);

    // Referential actions for delete() to emulate (DuckDB cannot
    // express CASCADE / SET NULL in DDL; see the header). Rebuilt on
    // every sync, so a schema change cannot leave stale actions.
    this.fkChildren.clear();
    for (const [childTable, childDef] of Object.entries(schema)) {
      for (const [childCol, builder] of Object.entries(childDef)) {
        const ref = builder.def.references;
        if (!ref || !ref.onDelete || ref.onDelete === "RESTRICT") continue;
        const list = this.fkChildren.get(ref.table) ?? [];
        list.push({ childTable, childCol, onDelete: ref.onDelete, childSchema: childDef });
        this.fkChildren.set(ref.table, list);
      }
    }

    // Migration log. Its id is a sequence default like any col.id().
    await this.ensureMigrationTable();

    for (const tableName of topologicalSortTables(schema)) {
      const tableDef = schema[tableName]!;
      const indexSqls: string[] = [];
      const indexedCols = new Set<string>();
      const timeSeriesCols: string[] = [];

      for (const [colName, colBuilder] of Object.entries(tableDef)) {
        if (colBuilder.def.isTimeSeries) timeSeriesCols.push(colName);
      }

      // One timestamp orders a table's rows. Two marked columns would
      // leave rollups guessing which one is the time axis, so the
      // schema is rejected here instead of silently picking one.
      if (timeSeriesCols.length > 1) {
        throw new YattaError(
          `Table "${tableName}" marks more than one time-series column (${timeSeriesCols.join(", ")}). ` +
            `Mark exactly one timestamp column per table with .timeSeries().`,
        );
      }

      // Sequences first: the CREATE TABLE's nextval() defaults need
      // them to exist before the table is created.
      for (const [colName, colBuilder] of Object.entries(tableDef)) {
        if (colBuilder.def.autoIncrement) await this.ensureSequence(tableName, colName);
      }

      const [createSql, ...createIndexes] = this.dialect.compileCreateTableStatements(tableName, tableDef);
      await this.run(createSql, [], "run");
      indexSqls.push(...createIndexes);

      const existingColumns = (await this.listColumns(tableName)).map((c) => c.name);

      for (const [colName, colBuilder] of Object.entries(tableDef)) {
        if (existingColumns.includes(colName)) continue;
        const def = colBuilder.def;

        if (
          def.notNull &&
          def.defaultValue === undefined &&
          !def.autoIncrement &&
          (await this.rowCount(tableName)) > 0
        ) {
          throw new YattaError(
            `Cannot add NOT NULL column "${colName}" without a default value in DuckDB. ` +
              `Add .default(...) or make it .nullable().`,
          );
        }

        if (def.autoIncrement) await this.ensureSequence(tableName, colName);
        this.duckDialect.setTableContext(tableName);
        try {
          const fragment = this.duckDialect.compileColumnFragment(colName, def, "alter");
          await this.run(this.duckDialect.compileAddColumnSql(tableName, fragment), [], "run");
        } finally {
          this.duckDialect.setTableContext(null);
        }

        await this.run(
          `INSERT INTO "_yatta_migrations" ("name", "hash") VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
          [`alter:${tableName}.${colName}`, schemaHash],
          "run",
        );

        if (def.unique) {
          indexSqls.push(this.dialect.compileIndexSql(tableName, colName, "unique"));
        }
        if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
          indexedCols.add(colName);
          indexSqls.push(this.dialect.compileIndexSql(tableName, colName, "plain"));
        }
        if (def.isTimeSeries && !def.isIndex && !indexedCols.has(colName)) {
          indexedCols.add(colName);
          indexSqls.push(this.dialect.compileIndexSql(tableName, colName, "timeseries"));
        }
      }

      for (const idx of indexSqls) await this.run(idx, [], "run");
    }
  }

  /** Creates a table's auto-increment sequence if it does not exist yet. Runs before the CREATE TABLE / ADD COLUMN that references it. */
  /** Current number of rows in a table, or 0 if it does not exist yet. */
  protected async rowCount(tableName: string): Promise<number> {
    const row = (await this.run(
      `SELECT COUNT(*) AS c FROM ${this.dialect.quoteIdent(tableName)}`,
      [],
      "get",
    )) as { c: unknown } | null;
    return this.dialect.decodeValue(row?.c ?? 0, undefined) as number;
  }

  /** User tables (internal tables — the migration log — are excluded). */
  async listTables(): Promise<string[]> {
    const rows = (await this.run(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' AND table_name <> '_yatta_migrations' ORDER BY table_name;`,
      [],
      "all",
    )) as { table_name: string }[];
    return rows.map((r) => r.table_name);
  }

  async listColumns(table: string): Promise<IntrospectedColumn[]> {
    const rows = (await this.run(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'main' AND table_name = $1 ORDER BY ordinal_position;`,
      [table],
      "all",
    )) as { column_name: string; data_type: string; is_nullable: string }[];
    const pkRows = (await this.run(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name ` +
        `WHERE tc.table_schema = 'main' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY';`,
      [table],
      "all",
    )) as { column_name: string }[];
    const pk = new Set(pkRows.map((r) => r.column_name));
    return rows.map((c) => ({
      name: c.column_name as string,
      type: c.data_type as string,
      nullable: c.is_nullable === "YES",
      primaryKey: pk.has(c.column_name),
    }));
  }

  /**
   * Exclusive lock across migrations. DuckDB has no advisory locks:
   * exclusivity comes from the session mutex (serializing every
   * statement in this process) plus DuckDB's own single-writer rule
   * on a file database, so running the migration inside one
   * transaction is the lock. Already inside a transaction, fn runs
   * inside it.
   */
  async withMigrationLock<R>(
    fn: (session: DatabaseSession<"async">) => Promise<R>,
  ): Promise<R> {
    await this.ensureReady();
    return this.transaction(fn);
  }


  /**
   * Performs a backup snapshot: CHECKPOINT folds the WAL into the main
   * file, then the file is copied (via a temp file + rename, so a
   * failed copy never leaves a half-written backup). Refuses an
   * in-memory database: there is no file to copy.
   */
  async backup(destPath: string): Promise<void> {
    await this.ensureReady();
    if (this.path === ":memory:") {
      throw new YattaError("Cannot back up an in-memory DuckDB database: there is no file to copy. Use a file-backed database for backups.");
    }
    const tempPath = `${destPath}.tmp.${Date.now()}`;
    try {
      const parentDir = path.dirname(destPath);
      if (parentDir && parentDir !== "." && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      await this.run("CHECKPOINT", [], "run");
      fs.copyFileSync(this.path, tempPath);
      fs.renameSync(tempPath, destPath);
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      if (err instanceof YattaError) throw err;
      throw new YattaError(`Backup failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Restores the database from a backup file:
   * 1. Validates the backup file by opening it read-only (a corrupt
   *    file, or an empty one, fails to open; a valid file with no
   *    tables is refused as an empty database).
   * 2. Atomically replaces the current database file with the backup.
   * 3. Rolls back safely to the previous state if anything fails.
   * Refuses an in-memory database and a restore inside a transaction.
   */
  async restore(sourcePath: string): Promise<void> {
    await this.ensureReady();
    if (this.path === ":memory:") throw new YattaError("Cannot restore into an in-memory database.");
    if (!fs.existsSync(sourcePath)) throw new YattaError(`Backup file not found: ${sourcePath}`);
    if (this.inTransaction) throw new YattaError("Cannot restore inside a transaction.");

    let testInstance: DuckDBInstance | null = null;
    try {
      const api = await loadDuckdb();
      testInstance = await api.DuckDBInstance.create(sourcePath, { access_mode: "READ_ONLY" });
      const testConn = await testInstance.connect();
      try {
        const reader = await testConn.runAndReadAll(
          `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'`,
        );
        const count = Number(reader.getRowObjectsJS()[0]?.c ?? 0);
        reader.closeSync();
        if (count === 0) {
          throw new Error("backup file is a valid but empty DuckDB database — it holds no schema");
        }
      } finally {
        testConn.disconnectSync();
      }
    } catch (err: any) {
      throw new YattaError(`Invalid or corrupt backup file: ${err?.message ?? err}`);
    } finally {
      if (testInstance) {
        try {
          testInstance.closeSync();
        } catch {}
      }
    }

    const tempPath = `${this.path}.restore.${Date.now()}`;
    const rollbackPath = `${this.path}.rollback.${Date.now()}`;

    // Set once the restored file is in place: a failure after that point
    // (e.g. deleting the rollback copy) must not roll the live database
    // back to the old file.
    let swapped = false;
    try {
      fs.copyFileSync(sourcePath, tempPath);

      this.clearStatementCache();
      // Checkpoint first so committed transactions are folded from the
      // WAL into the main file before the connection closes.
      await this.run("CHECKPOINT", [], "run");
      this.closeConnection();

      if (fs.existsSync(this.path)) {
        fs.renameSync(this.path, rollbackPath);
      }

      const walPath = `${this.path}.wal`;
      const rollbackWal = `${rollbackPath}.wal`;
      if (fs.existsSync(walPath)) fs.renameSync(walPath, rollbackWal);

      fs.renameSync(tempPath, this.path);
      swapped = true;

      if (fs.existsSync(rollbackPath)) {
        fs.unlinkSync(rollbackPath);
      }
      if (fs.existsSync(rollbackWal)) fs.unlinkSync(rollbackWal);
    } catch (err: any) {
      if (!swapped && fs.existsSync(rollbackPath)) {
        try {
          fs.renameSync(rollbackPath, this.path);
        } catch {}
      }
      // The rollback is only whole with its WAL: without it, every
      // committed transaction that lived only in the WAL is silently gone.
      if (!swapped && fs.existsSync(`${rollbackPath}.wal`)) {
        try {
          fs.renameSync(`${rollbackPath}.wal`, `${this.path}.wal`);
        } catch {}
      }
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw new YattaError(`Restore failed and was rolled back: ${err?.message ?? err}`);
    } finally {
      // Reopen on the restored file. A reopen failure surfaces after
      // the swap (or the rollback) above, never instead of it.
      this.closed = false;
      this.readyPromise = this.initConnection();
    }
    await this.readyPromise;
  }

  /** Closes the DuckDB connection and instance. */
  async close(): Promise<void> {
    try {
      await this.readyPromise;
    } catch {
      // Init failed: nothing to close.
    }
    this.clearStatementCache();
    this.closeConnection();
    this.closed = true;
  }
}
