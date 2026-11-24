// SQLite adapter + session (Phase 1 of the multi-database ORM refactor).
//
// Moved from src/types/db/engine.ts: the engine owned the bun:sqlite
// connection; the session owns it now, and the engine delegates to it.
// The session is the only module (besides the dialect) that imports
// bun:sqlite — the gate is: no bun:sqlite in src/types/db.ts,
// src/types/db/*.ts, or src/func/db.ts outside adapters/sqlite*.ts.
//
// The adapter extends the session: the root adapter IS the root session.
// A transaction hands fn the same session object — bun:sqlite nests
// transactions via savepoints on one connection, so no child session
// object is needed (PGlite, single-connection with a FIFO gate, needs a
// real child session instead — Phase 2).

import { Database, type Statement } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { YattaError } from "../errors";
import type { ColumnDefinition, DatabaseSchema, TableSchema } from "../schema";
import { ftsPhrase, tokenizeText } from "../search";
import type {
  AdapterCapabilities,
  CompiledFindQuery,
  CompiledSearchQuery,
  CompiledUpsertPlan,
  DatabaseAdapter,
  DatabaseSession,
  IntrospectedColumn,
  PgliteAdapterOptions,
  QueryResult,
  SqliteAdapterOptions,
  TransactionOptions,
} from "../adapter";
import { SqliteDialect } from "./sqlite_dialect";
import { SqlCompiler } from "../sql_compiler";
import type { SqlDialect } from "../sql_dialect";
import type { WhereClause } from "../query";

/** Whether a value is a thenable (moved from engine.ts; only transaction() uses it). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Whether an error is SQLite lock contention (SQLITE_BUSY / "database is locked"). */
function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "SQLITE_BUSY" ||
    /database is locked|database table is locked/i.test(
      String((err as Error | null)?.message ?? err),
    )
  );
}

/** Short synchronous wait for the open-time retries below. Runs once at construction. */
function sleepBusy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* wait for the competing connection to finish */
  }
}

/** FTS5 table name for a base table. */
export function ftsTableName(tableName: string): string {
  return `_fts_${tableName}`;
}

function ftsVocabTableName(tableName: string): string {
  return `_fts_${tableName}_vocab`;
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
 * A table's primary key column, or null when it has none. Search maps index
 * entries back to rows through the key, so a keyless table cannot be
 * searched — and must not crash schema sync trying.
 */
function pkColumnName(schema: TableSchema): string | null {
  for (const [colName, builder] of Object.entries(schema)) {
    if (builder.def.primaryKey) return colName;
  }
  return "id" in schema ? "id" : null;
}

export const SQLITE_CAPABILITIES: AdapterCapabilities = {
  mode: "sync",
  // Relations are batched separate queries, never JOINs.
  joins: false,
  foreignKeys: true,
  acidTransactions: true,
  // bun:sqlite nests transactions via savepoints on one connection.
  savepoints: true,
  returningClause: true,
  fullTextSearch: "fts5",
  // vec0 when loadable; the vectors module falls back to plain-SQLite cosine.
  vectors: "sqlite-vec",
  // VACUUM INTO + file swap.
  backupRestore: "file-copy",
  // WAL + busy_timeout.
  multiProcessSafe: true,
  // SQLite's historical SQLITE_MAX_VARIABLE_NUMBER floor; the compiler never
  // generates more than a few hundred params for realistic queries.
  maxBindParams: 999,
};

/**
 * One SQLite connection, implementing the session contract. Owns the
 * bun:sqlite Database, the prepared-statement cache, the pragmas, and the
 * FTS5 indexes. The engine (YattaDB) holds one of these and delegates its
 * SQLite-specific work to it.
 */
export class SqliteSession implements DatabaseSession<"sync"> {
  readonly capabilities: AdapterCapabilities = SQLITE_CAPABILITIES;
  /** SQL dialect for this connection. Owns every driver-specific SQL string. */
  readonly dialect: SqlDialect = new SqliteDialect();
  /** Driver-neutral SQL compiler over the dialect. */
  readonly compiler: SqlCompiler = new SqlCompiler(this.dialect);

  /** Resolved filesystem path to the database file, or `":memory:"`. */
  readonly path: string;
  private readonly debug: boolean;
  protected db: Database;
  private static readonly MAX_STMT_CACHE = 500;
  private stmtCache = new Map<string, Statement>();
  /** Searchable tables whose FTS table is known to exist, so writes skip a lookup. */
  protected ftsReady = new Set<string>();
  /** Tables whose FTS row counts have been verified against the base table at least once in this process. */
  protected ftsVerified = new Set<string>();
  /** Cached typo-correction vocabulary per table. Invalidated on every FTS write through this instance. */
  protected ftsVocabCache = new Map<string, Set<string>>();

  constructor(options: SqliteAdapterOptions = {}) {
    let targetPath = options.path ?? "Database/app.db";

    if (targetPath === ":memory:") {
      this.path = ":memory:";
    } else {
      const hasExtension = path.extname(targetPath) !== "";
      if (!hasExtension || targetPath.endsWith("/") || targetPath.endsWith("\\")) {
        targetPath = path.join(targetPath, "app.db");
      }

      this.path = path.resolve(process.cwd(), targetPath);

      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.debug = options.debug ?? false;
    this.db = new Database(this.path, { create: true });
    this.applyPragmas();
  }

  /** Direct access to the underlying `bun:sqlite` Database instance. */
  get database(): Database {
    return this.db;
  }

  /** Whether this connection is currently inside a transaction. */
  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  /**
   * Applies connection pragmas required for safe multi-process access.
   *
   * `busy_timeout` goes first, on its own: the WAL switch needs a write lock
   * and fails at once without a timeout in place. The switch can still lose
   * the race when four cluster workers open a fresh database at once, so it
   * retries with a short escalating backoff. Must be re-applied after any
   * connection is replaced (see `restore()`).
   */
  protected applyPragmas(): void {
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.applyPragmasWithRetry(8);
  }

  private applyPragmasWithRetry(attempts: number): void {
    try {
      this.db.run("PRAGMA journal_mode = WAL;");
      this.db.run("PRAGMA foreign_keys = ON;");
      this.db.run("PRAGMA synchronous = NORMAL;");
    } catch (err) {
      if (!isSqliteBusy(err) || attempts <= 1) throw err;
      sleepBusy(20 * (9 - attempts));
      this.applyPragmasWithRetry(attempts - 1);
    }
  }

  /** Finalizes and purges all cached prepared statements. */
  clearStatementCache(): void {
    for (const stmt of this.stmtCache.values()) {
      try { stmt.finalize(); } catch {}
    }
    this.stmtCache.clear();
  }

  /**
   * Prepares (or retrieves from LRU cache) and executes an SQL statement
   * with parameters. The engine's `run()` lives here now; the engine
   * delegates to it.
   */
  run(sql: string, params: any[] = [], mode: "get" | "all" | "run"): any {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
    } else {
      if (this.stmtCache.size >= SqliteSession.MAX_STMT_CACHE) {
        const oldestKey = this.stmtCache.keys().next().value;
        if (oldestKey !== undefined) {
          try { this.stmtCache.get(oldestKey)?.finalize(); } catch {}
          this.stmtCache.delete(oldestKey);
        }
      }
      stmt = this.db.query(sql);
      this.stmtCache.set(sql, stmt);
    }

    const start = this.debug ? performance.now() : 0;
    try {
      const result = mode === "get" ? stmt.get(...params) : mode === "all" ? stmt.all(...params) : stmt.run(...params);
      if (this.debug) console.log(`[yatta-db] ${(performance.now() - start).toFixed(2)}ms  ${sql}`, params.length ? params : "");
      return result;
    } catch (err: any) {
      throw new YattaError(err?.message ?? String(err), sql);
    }
  }

  // ── Session CRUD ─────────────────────────────────────────────────────────

  insert(table: string, schema: TableSchema, row: Record<string, unknown>): Record<string, unknown> {
    const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), row);
    return this.compiler.decodeRow(columnsOf(schema), this.run(sql, params, "get"));
  }

  insertMany(table: string, schema: TableSchema, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return this.transaction(() => rows.map((row) => this.insert(table, schema, row)));
  }

  find(table: string, schema: TableSchema, query: CompiledFindQuery): Record<string, unknown>[] {
    const { sql, params } = this.compiler.compileSelect(table, columnsOf(schema), query);
    return (this.run(sql, params, "all") as any[]).map((r) => this.compiler.decodeRow(columnsOf(schema), r));
  }

  count(table: string, schema: TableSchema, where?: WhereClause<any>): number {
    const { sql, params } = this.compiler.compileCount(table, columnsOf(schema), where);
    return (this.run(sql, params, "get") as { count: number }).count;
  }

  update(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
    patch: Record<string, unknown>,
  ): Record<string, unknown>[] {
    if (Object.keys(patch).length === 0) return [];
    const { sql, params } = this.compiler.compileUpdate(table, columnsOf(schema), patch, where, { returning: true });
    return (this.run(sql, params, "all") as any[]).map((r) => this.compiler.decodeRow(columnsOf(schema), r));
  }

  delete(table: string, schema: TableSchema, where: WhereClause<any>): number {
    const { sql, params } = this.compiler.compileDelete(table, columnsOf(schema), where);
    return (this.run(sql, params, "run") as { changes: number }).changes;
  }

  upsert(table: string, schema: TableSchema, plan: CompiledUpsertPlan): Record<string, unknown> {
    // compileUpsert returns null for SQLite (and for Postgres in Phase 2):
    // the transactional find-first fallback is the behaviour, not a stopgap.
    return this.transaction(() => {
      const existing = this.find(table, schema, { where: plan.where, take: 1 });
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
        return this.compiler.decodeRow(columnsOf(schema), this.run(sql, params, "get"));
      }
      const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), plan.createRow);
      return this.compiler.decodeRow(columnsOf(schema), this.run(sql, params, "get"));
    });
  }

  // ── Full-text search ─────────────────────────────────────────────────────
  //
  // One standalone FTS5 table per searchable base table, named `_fts_<table>`,
  // holding the searchable columns plus `__yatta_pk` (UNINDEXED, so the key
  // itself is never searchable) storing the base row's primary key as text.
  // Standalone, not an FTS5 content table, because Yatta primary keys can be
  // text UUIDs and FTS5 content tables only track an integer rowid.

  search(table: string, schema: TableSchema, query: CompiledSearchQuery): Array<{ row: Record<string, unknown>; rank: number }> {
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

    // Creates (or repairs) the index on first use, so a table opened with
    // autoMigrate off, or a database file copied in from elsewhere, still
    // searches correctly instead of failing on a missing FTS table.
    this.ensureSearchIndex(table, schema);

    // Each group is one query token's alternatives (typo-corrected spelling
    // plus synonym phrases, already computed by the core in Table.search);
    // groups are ANDed, alternatives inside a group are ORed.
    const groups = query.expandedGroups.map((group) => {
      const alternatives = group.map(ftsPhrase).join(" OR ");
      const wrapped = group.length > 1 ? `(${alternatives})` : alternatives;
      return restricted ? `{${restricted.join(" ")}} : ${wrapped}` : wrapped;
    });
    const matchExpr = groups.join(" AND ");

    const fts = this.dialect.quoteIdent(ftsTableName(table));
    // SQLite rejects a bare OFFSET with no LIMIT, so an offset-only page
    // gets LIMIT -1 (SQLite's "no upper bound"), the same idiom findMany uses.
    const limitSql = query.limit !== undefined ? `LIMIT ${query.limit}` : query.offset !== undefined ? "LIMIT -1" : "";
    const offsetSql = query.offset !== undefined ? `OFFSET ${query.offset}` : "";
    const sql = [
      `SELECT "__yatta_pk" AS pk, bm25(${fts}) AS rank FROM ${fts}`,
      `WHERE ${fts} MATCH ? ORDER BY rank ASC`,
      limitSql,
      offsetSql,
    ].filter(Boolean).join(" ").concat(";");

    const hits = this.run(sql, [matchExpr], "all") as { pk: unknown; rank: number }[];
    if (hits.length === 0) return [];

    const pkDef = columnsOf(schema).get(pkCol);
    const coercePk = (stored: unknown): string | number => {
      if (pkDef?.type === "INTEGER") {
        const n = Number(stored);
        return Number.isFinite(n) ? n : String(stored);
      }
      return String(stored);
    };
    const pks = hits.map((h) => coercePk(h.pk));
    const pkFilter = { [pkCol]: { in: pks } } as any;
    const where = query.where && Object.keys(query.where).length > 0
      ? ({ AND: [query.where, pkFilter] } as WhereClause<any>)
      : pkFilter;
    const rows = this.find(table, schema, { where });
    const byPk = new Map(rows.map((r) => [String((r as any)[pkCol]), r]));

    const out: Array<{ row: Record<string, unknown>; rank: number }> = [];
    for (const h of hits) {
      const row = byPk.get(String(h.pk));
      if (row) out.push({ row, rank: h.rank });
    }
    return out;
  }

  /**
   * Maintains one row's full-text index entry. `insert` writes a fresh entry
   * (no prior DELETE — the fast path: a row that just inserted has no prior
   * FTS entry, and the DELETE is a full FTS scan because `__yatta_pk` is
   * UNINDEXED); `update` replaces it; `delete` removes it.
   */
  syncSearchRow(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
    op: "insert" | "update" | "delete",
  ): void {
    const cols = searchableColumns(schema);
    if (cols.length === 0) return;
    const pkCol = pkColumnName(schema);
    if (pkCol === null) return;
    const pk = row[pkCol];
    if (pk === null || pk === undefined) return;
    if (!this.ftsReady.has(table)) {
      if (!this.ftsTableExists(table)) return;
      this.ftsReady.add(table);
    }
    const fts = this.dialect.quoteIdent(ftsTableName(table));
    const pkText = String(pk);
    try {
      if (op !== "insert") {
        this.run(`DELETE FROM ${fts} WHERE "__yatta_pk" = ?;`, [pkText], "run");
      }
      if (op !== "delete") {
        this.ftsInsertRow(table, cols, pkText, row);
      }
      this.ftsVocabCache.delete(table);
    } catch (err: any) {
      // The cache can go stale when the index is dropped outside this
      // instance's knowledge (restore of an older backup, a manual DROP).
      // A missing index is a repair-on-search situation, never a reason for
      // a write to fail: drop the stale cache entry and let the next search
      // rebuild. Any other error still propagates.
      if (String(err?.message ?? err).includes("no such table")) {
        this.ftsReady.delete(table);
        this.ftsVerified.delete(table);
        return;
      }
      throw err;
    }
  }

  /** Rebuilds one table's full-text index from its current rows. */
  rebuildSearchIndex(table: string, schema: TableSchema): void {
    const cols = searchableColumns(schema);
    if (cols.length === 0) {
      throw new YattaError(
        `Table "${table}" has no searchable columns, so there is no search index to rebuild. ` +
          `Mark a text column with .searchable() first.`,
      );
    }
    if (!this.baseTableExists(table)) {
      throw new YattaError(`Table "${table}" does not exist in this database, so its search index cannot be rebuilt.`);
    }
    if (pkColumnName(schema) === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so its search index cannot be rebuilt. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
    this.dropFtsTable(table);
    this.createFtsTable(table, cols);
    this.populateFtsTable(table, cols, pkColumnName(schema) ?? "id");
    this.ftsReady.add(table);
    // A fresh rebuild matches the base table by construction.
    this.ftsVerified.add(table);
    this.ftsVocabCache.delete(table);
    this.clearStatementCache();
  }

  /**
   * The indexed vocabulary for a table: every distinct term the FTS index
   * holds, used for typo correction. Read from the fts5vocab table when it
   * exists; otherwise scanned from the base table's searchable values.
   */
  searchVocabulary(table: string, schema: TableSchema): Set<string> {
    const cached = this.ftsVocabCache.get(table);
    if (cached) return cached;
    const vocab = ftsVocabTableName(table);
    const vocabExists = this.run(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`,
      [vocab],
      "get",
    ) as { ok: number } | null;
    if (vocabExists) {
      try {
        const qvocab = this.dialect.quoteIdent(vocab);
        const rows = this.run(`SELECT DISTINCT term FROM ${qvocab};`, [], "all") as { term: string }[];
        const loaded = new Set(rows.map((r) => r.term));
        this.ftsVocabCache.set(table, loaded);
        return loaded;
      } catch {
        // Fall through to the scan below.
      }
    }
    const cols = searchableColumns(schema);
    const terms = new Set<string>();
    if (cols.length === 0) return terms;
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const rows = this.run(`SELECT ${colSql} FROM ${this.dialect.quoteIdent(table)};`, [], "all") as Record<string, unknown>[];
    for (const row of rows) {
      for (const c of cols) {
        const value = row[c];
        if (typeof value === "string") {
          for (const token of tokenizeText(value)) terms.add(token);
        }
      }
    }
    this.ftsVocabCache.set(table, terms);
    return terms;
  }

  /** Whether the FTS table for a base table exists right now. */
  ftsTableExists(tableName: string): boolean {
    const row = this.run(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`,
      [ftsTableName(tableName)],
      "get",
    ) as { ok: number } | null;
    return row !== null && row !== undefined;
  }

  /**
   * Makes sure one table's FTS index exists and matches its searchable
   * columns, rebuilding when it does not. Called by `search()` so a first
   * search never fails on a missing index. Also rebuilds when the row counts
   * disagree — the cheap signal that rows were added or removed outside the
   * Table write paths.
   */
  ensureSearchIndex(tableName: string, schema: TableSchema): void {
    const cols = searchableColumns(schema);
    if (cols.length === 0) return;
    if (!this.baseTableExists(tableName)) {
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
    const existing = this.ftsColumnNames(tableName);
    const expected = [...cols, "__yatta_pk"];
    const matches = existing.length === expected.length && expected.every((c) => existing.includes(c));
    if (!matches) {
      this.rebuildSearchIndex(tableName, schema);
      return;
    }
    this.ftsReady.add(tableName);
    // The counts are a full FTS scan (~1 ms at 5k rows, growing with the
    // table), so they run once per process open, not on every search.
    if (this.ftsVerified.has(tableName)) return;
    try {
      const fts = this.dialect.quoteIdent(ftsTableName(tableName));
      const base = this.dialect.quoteIdent(tableName);
      const ftsCount = (this.db.query(`SELECT COUNT(*) AS c FROM ${fts}`).get() as { c: number }).c;
      const baseCount = (this.db.query(`SELECT COUNT(*) AS c FROM ${base}`).get() as { c: number }).c;
      if (ftsCount !== baseCount) this.rebuildSearchIndex(tableName, schema);
      this.ftsVerified.add(tableName);
    } catch {
      // Counting is a repair heuristic, not the search itself. A failure
      // here must not mask the search that follows.
    }
  }

  // ── Raw SQL ──────────────────────────────────────────────────────────────

  /**
   * Raw SQL escape hatch. Reads return their rows; writes return their
   * change count. Which side a statement falls on is decided by its first
   * keyword (SELECT/WITH/VALUES/EXPLAIN/PRAGMA, or anything with a RETURNING
   * clause, reads rows; everything else reports changes) — an escape hatch,
   * not a parser, so callers that need exact mode control use `run()`.
   */
  executeRaw(sql: string, params: unknown[] = []): QueryResult {
    const head = sql.trimStart().toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("VALUES") ||
      head.startsWith("EXPLAIN") ||
      head.startsWith("PRAGMA") ||
      /RETURNING\b/i.test(sql);
    if (isRead) {
      const rows = this.run(sql, params as any[], "all") as Record<string, unknown>[];
      return { rows, affectedRows: rows.length };
    }
    const res = this.run(sql, params as any[], "run") as { changes: number };
    return { rows: [], affectedRows: res.changes };
  }

  /** Runs multi-statement SQL (DDL scripts, migrations). */
  executeBatch(sql: string): void {
    this.db.exec(sql);
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  /**
   * Runs `fn` inside a SQLite transaction.
   *
   * `fn` must be synchronous. bun:sqlite commits as soon as the callback
   * returns, so an async callback committed immediately and left its awaited
   * work running outside the transaction — a silent correctness failure.
   * A thenable return is therefore refused and the transaction rolled back,
   * rather than reported as a success.
   *
   * The same session object is handed to `fn`: bun:sqlite nests transactions
   * via savepoints on one connection.
   */
  transaction<R>(fn: (txSession: DatabaseSession<"sync">) => R, options?: TransactionOptions): R {
    if (options?.mode === "immediate" && !this.db.inTransaction) {
      this.db.run("BEGIN IMMEDIATE;");
      try {
        const returned = fn(this);
        if (isThenable(returned)) {
          throw new YattaError(
            "transaction() needs a sync function. A bun:sqlite transaction saves the " +
              "work the moment the function returns, so an async function would " +
              "save before its own awaits finish. Do the async work first, then run " +
              "the transaction.",
          );
        }
        this.db.run("COMMIT;");
        return returned;
      } catch (err) {
        try { this.db.run("ROLLBACK;"); } catch {}
        throw err;
      }
    }
    return this.db.transaction(() => {
      const returned = fn(this);
      if (isThenable(returned)) {
        throw new YattaError(
          "transaction() needs a sync function. A bun:sqlite transaction saves the " +
            "work the moment the function returns, so an async function would " +
            "save before its own awaits finish. Do the async work first, then run " +
            "the transaction.",
        );
      }
      return returned;
    })();
  }

  // ── FTS internals (protected: the adapter subclass uses them) ───────────

  protected baseTableExists(tableName: string): boolean {
    const row = this.db
      .query(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`)
      .get(tableName) as { ok: number } | null;
    return row !== null && row !== undefined;
  }

  protected createFtsTable(tableName: string, cols: string[]): void {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    try {
      this.db.run(`CREATE VIRTUAL TABLE ${fts} USING fts5(${colSql}, "__yatta_pk" UNINDEXED, tokenize='unicode61');`);
    } catch (err: any) {
      // Bun's docs do not promise FTS5: on Linux/Windows Bun links its own
      // SQLite build, but on macOS it uses Apple's build, whose compile
      // options Bun does not control. A build without FTS5 must fail with
      // this explanation, not SQLite's bare "no such module: fts5".
      if (String(err?.message ?? err).includes("no such module")) {
        throw new YattaError(
          `Full-text search needs SQLite's FTS5 module, which this Bun/SQLite build does not include. ` +
            `Search cannot be used with this build; every other Yatta feature works without it.`,
        );
      }
      throw err;
    }
    // Vocabulary table for typo correction: distinct indexed terms, read at
    // query time. Best effort — if it cannot be created, search falls back
    // to scanning the base table's searchable values for terms.
    try {
      const vocab = this.dialect.quoteIdent(ftsVocabTableName(tableName));
      this.db.run(`CREATE VIRTUAL TABLE ${vocab} USING fts5vocab(${fts}, 'col');`);
    } catch {
      // Vocab is an optimization, not the index itself. Search still works.
    }
  }

  protected dropFtsTable(tableName: string): void {
    const vocab = this.dialect.quoteIdent(ftsVocabTableName(tableName));
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    this.db.run(`DROP TABLE IF EXISTS ${vocab};`);
    this.db.run(`DROP TABLE IF EXISTS ${fts};`);
    this.ftsVerified.delete(tableName);
    this.ftsVocabCache.delete(tableName);
  }

  protected populateFtsTable(tableName: string, cols: string[], pkCol: string): void {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const base = this.dialect.quoteIdent(tableName);
    const qpk = this.dialect.quoteIdent(pkCol);
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const selectCols = cols.map((c) => `COALESCE(${this.dialect.quoteIdent(c)}, '')`).join(", ");
    this.db.run(
      `INSERT INTO ${fts} (${colSql}, "__yatta_pk") SELECT ${selectCols}, CAST(${qpk} AS TEXT) FROM ${base};`,
    );
  }

  protected ftsColumnNames(tableName: string): string[] {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    try {
      return (this.db.query(`PRAGMA table_info(${fts})`).all() as any[]).map((c) => c.name);
    } catch {
      return [];
    }
  }

  /** Shared INSERT half of the FTS write paths. */
  protected ftsInsertRow(tableName: string, cols: string[], pkText: string, row: Record<string, any>): void {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => {
      const v = row[c];
      return v === null || v === undefined ? "" : String(v);
    });
    this.run(
      `INSERT INTO ${fts} (${colSql}, "__yatta_pk") VALUES (${placeholders}, ?);`,
      [...values, pkText],
      "run",
    );
  }
}

/**
 * The SQLite adapter: the root session plus the connection-level operations
 * (schema sync, migration lock, backup/restore, close). The root adapter IS
 * the root session — `open()` returns `this`.
 */
export class SqliteAdapter extends SqliteSession implements DatabaseAdapter<"sync"> {
  readonly driver = "sqlite" as const;

  /** Eagerly wait for initialization — no-op on sync SQLite. */
  ready(): void {}

  /**
   * Applies a declarative schema: creates missing tables and columns,
   * repairs FTS indexes, and fails the whole sync on a foreign-key
   * violation.
   */
  syncSchema(schema: DatabaseSchema): void {
    this.syncSchemaWithRetry(schema, 8);
  }

  private syncSchemaWithRetry(schema: DatabaseSchema, attempts: number): void {
    try {
      this.syncSchemaOnce(schema);
    } catch (err) {
      if (!isSqliteBusy(err) || attempts <= 1) throw err;
      sleepBusy(20 * (9 - attempts));
      this.syncSchemaWithRetry(schema, attempts - 1);
    }
  }

  private syncSchemaOnce(schema: DatabaseSchema): void {
    const schemaHash = crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);

    this.db.run("PRAGMA foreign_keys = OFF;");

    try {
      // BEGIN IMMEDIATE, not the deferred BEGIN that transaction() issues.
      //
      // With a deferred transaction the write lock is acquired lazily, so two
      // processes migrating the same schema concurrently can deadlock. SQLite
      // detects that and returns SQLITE_BUSY *immediately*, without consulting
      // busy_timeout — which surfaced as an intermittent "database is locked"
      // crash on boot when several worker threads mounted the same schema.
      // Taking the write lock up front makes busy_timeout apply as intended.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.syncSchemaBody(schema, schemaHash);
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Already rolled back by SQLite.
        }
        throw err;
      }
    } finally {
      this.db.run("PRAGMA foreign_keys = ON;");
      this.clearStatementCache();
    }
  }

  /**
   * Applies the schema inside an open transaction.
   * Split out from {@link syncSchema} so the lock handling stays readable.
   */
  private syncSchemaBody(schema: DatabaseSchema, schemaHash: string): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "_yatta_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        hash TEXT,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    for (const [tableName, tableDef] of Object.entries(schema)) {
      const indexSqls: string[] = [];
      const indexedCols = new Set<string>();
      const timeSeriesCols: string[] = [];

      // DDL comes from the dialect as one unit (CREATE TABLE plus its
      // indexes), so a fragment error surfaces before the time-series
      // check below, exactly as the old inline loop ordered it.
      const [createSql, ...createIndexes] = this.dialect.compileCreateTableStatements(tableName, tableDef);

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

      this.db.run(createSql);
      indexSqls.push(...createIndexes);

      const existingColumns = (this.db.query(`PRAGMA table_info(${this.dialect.quoteIdent(tableName)})`).all() as any[]).map(
        (c) => c.name,
      );

      for (const [colName, colBuilder] of Object.entries(tableDef)) {
        if (existingColumns.includes(colName)) continue;
        const def = colBuilder.def;

        /*
         * SQLite refuses `ALTER TABLE ... ADD COLUMN` with a non-constant default
         * when the table already has rows — "Cannot add a column with non-constant
         * default" — and `col.createdAt()` / `col.updatedAt()` both default to the
         * strftime expression. Adding a timestamp to a populated table therefore
         * threw at boot, which is the first schema change most projects make, and
         * it threw on every start rather than once.
         *
         * SQLite has no way to attach an expression default to an existing column,
         * so the table is rebuilt instead: the new definition is appended to the
         * stored CREATE TABLE, the rows are copied, and the old table is swapped
         * out. Indexes and triggers on the table are saved and recreated, because
         * dropping a table takes them with it. Verified to preserve the
         * AUTOINCREMENT counter, so ids do not restart at 1.
         */
        if (
          this.needsExpressionDefault(def) &&
          this.rowCount(tableName) > 0
        ) {
          this.rebuildTableWithColumn(tableName, colName, def);
        } else {
          const fragment = this.dialect.compileColumnFragment(colName, def, "alter");
          this.db.run(this.dialect.compileAddColumnSql(tableName, fragment));
        }

        this.db
          .query(`INSERT OR IGNORE INTO "_yatta_migrations" (name, hash) VALUES (?, ?)`)
          .run(`alter:${tableName}.${colName}`, schemaHash);

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

      for (const idx of indexSqls) this.db.run(idx);
    }

    // Full-text indexes are built after the base tables exist, in the
    // same transaction, so a fresh database and an upgraded one (a new
    // .searchable() column on an existing table) both end up indexed.
    this.syncFtsTables(schema);

    const violations = this.db.query("PRAGMA foreign_key_check;").all();
    if (violations.length > 0) {
      throw new YattaError(`Foreign key integrity check failed after schema sync: ${JSON.stringify(violations)}`);
    }
  }

  /** User tables (internal tables — FTS indexes, migration log — are excluded). */
  listTables(): string[] {
    const rows = this.db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_fts_%' AND name != '_yatta_migrations' ORDER BY name;`)
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  listColumns(table: string): IntrospectedColumn[] {
    const rows = this.db.query(`PRAGMA table_info(${this.dialect.quoteIdent(table)})`).all() as any[];
    return rows.map((c) => ({
      name: c.name as string,
      type: c.type as string,
      nullable: c.notnull === 0,
      primaryKey: (c.pk as number) > 0,
    }));
  }

  /**
   * Exclusive lock across migrations (BEGIN IMMEDIATE on SQLite).
   * Two processes migrating at once used to both read the marker table, both
   * run up() for the same migration, and the second marker INSERT threw
   * UNIQUE — after a non-idempotent up had already applied twice. BEGIN
   * IMMEDIATE takes the write lock up front (busy_timeout makes the loser
   * wait, then fail loudly instead of double-applying). If a transaction is
   * already open on this connection, the lock cannot be taken and fn runs
   * inside it.
   */
  withMigrationLock<R>(fn: (session: DatabaseSession<"sync">) => R): R {
    let locked = false;
    let fkWasOn = false;
    try {
      const fkRow = this.db.query("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      } | null;
      fkWasOn = fkRow?.foreign_keys === 1;
      if (fkWasOn) this.db.run("PRAGMA foreign_keys = OFF;");
      try {
        this.db.run("BEGIN IMMEDIATE;");
      } catch (beginErr: any) {
        // The pragma above already ran: restore FK before bailing out.
        try { this.db.run("PRAGMA foreign_keys = ON;"); } catch {}
        fkWasOn = false;
        throw beginErr;
      }
      locked = true;
    } catch (err: any) {
      if (!/cannot start a transaction within a transaction/i.test(String(err?.message))) {
        throw err;
      }
      // Already inside a transaction: the lock cannot be taken and the
      // FK pragma (if it ran) stays as set — restore it below via fkWasOn.
    }

    const release = (commit: boolean): void => {
      if (locked) {
        try { this.db.run(commit ? "COMMIT;" : "ROLLBACK;"); } catch {}
      }
      if (fkWasOn) {
        try { this.db.run("PRAGMA foreign_keys = ON;"); } catch {}
      }
    };

    let result: R;
    try {
      result = fn(this);
    } catch (err) {
      release(false);
      throw err;
    }

    // A thenable return (an async migration) holds the lock across the
    // await: the COMMIT waits for it, exactly as the engine's migrate()
    // did inline. A sync return commits at once.
    if (isThenable(result)) {
      return (result as PromiseLike<unknown>).then(
        (value) => {
          release(true);
          return value as R;
        },
        (err) => {
          release(false);
          throw err;
        },
      ) as R;
    }
    release(true);
    return result;
  }

  /**
   * Performs an atomic online backup snapshot using SQLite's `VACUUM INTO`.
   * Safe to run concurrently while readers and writers are active.
   */
  backup(destPath: string): void {
    const tempPath = `${destPath}.tmp.${Date.now()}`;
    try {
      /*
       * VACUUM INTO writes through SQLite, which will not create intermediate
       * directories. Asking for `Database/backups/x.db` therefore failed with
       * "unable to open database" — an error that says nothing about the real
       * cause. Creating the parent here makes the obvious call work.
       */
      const parentDir = path.dirname(destPath);
      if (parentDir && parentDir !== "." && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      const escaped = tempPath.replace(/'/g, "''");
      this.db.run(`VACUUM INTO '${escaped}';`);
      fs.renameSync(tempPath, destPath);
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new YattaError(`Backup failed: ${err.message}`);
    }
  }

  /**
   * Restores the database from a backup file:
   * 1. Validates the backup file's SQLite integrity (`quick_check`).
   * 2. Atomically replaces current database files with backup.
   * 3. Rolls back safely to previous state if anything fails.
   */
  restore(sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) throw new YattaError(`Backup file not found: ${sourcePath}`);
    if (this.path === ":memory:") throw new YattaError("Cannot restore into an in-memory database.");

    let testDb: Database | null = null;
    try {
      testDb = new Database(sourcePath, { readonly: true });
      const check = testDb.query("PRAGMA quick_check;").get() as { quick_check: string } | null;
      if (check?.quick_check !== "ok") {
        throw new Error("Backup file failed integrity check (corrupt or invalid SQLite file)");
      }

      /*
       * `quick_check` is not sufficient on its own: SQLite treats a
       * zero-length file as a valid, empty database, so quick_check answers
       * "ok" for it. Restoring one therefore reported success and left the
       * live database empty. A truncated file is caught ("database disk image
       * is malformed"), but the 0-byte case is exactly the one a failed `cp`,
       * an interrupted upload or an empty log file produces. So the backup
       * has to contain a schema: at least one table.
       */
      const tables = testDb
        .query("SELECT name FROM sqlite_master WHERE type = 'table';")
        .all() as { name: string }[];
      if (tables.length === 0) {
        throw new Error("backup file is a valid but empty SQLite database — it holds no schema");
      }
    } catch (err: any) {
      throw new YattaError(`Invalid or corrupt backup file: ${err.message}`);
    } finally {
      testDb?.close(true);
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
      // WAL into the main file before the connection closes; the WAL
      // files are then moved alongside the rollback copy, not deleted,
      // so a failed swap can still restore the live database whole.
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
      this.db.close(true);

      if (fs.existsSync(this.path)) {
        fs.renameSync(this.path, rollbackPath);
      }

      const walPath = `${this.path}-wal`;
      const shmPath = `${this.path}-shm`;
      const rollbackWal = `${rollbackPath}-wal`;
      const rollbackShm = `${rollbackPath}-shm`;
      if (fs.existsSync(walPath)) fs.renameSync(walPath, rollbackWal);
      if (fs.existsSync(shmPath)) fs.renameSync(shmPath, rollbackShm);

      fs.renameSync(tempPath, this.path);
      swapped = true;

      if (fs.existsSync(rollbackPath)) {
        fs.unlinkSync(rollbackPath);
      }
      if (fs.existsSync(rollbackWal)) fs.unlinkSync(rollbackWal);
      if (fs.existsSync(rollbackShm)) fs.unlinkSync(rollbackShm);
    } catch (err: any) {
      if (!swapped && fs.existsSync(rollbackPath)) {
        try { fs.renameSync(rollbackPath, this.path); } catch {}
      }
      // The rollback is only whole with its WAL: without it, every
      // committed transaction that lived only in the WAL is silently gone.
      if (!swapped && fs.existsSync(`${rollbackPath}-wal`)) {
        try { fs.renameSync(`${rollbackPath}-wal`, `${this.path}-wal`); } catch {}
      }
      if (!swapped && fs.existsSync(`${rollbackPath}-shm`)) {
        try { fs.renameSync(`${rollbackPath}-shm`, `${this.path}-shm`); } catch {}
      }
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new YattaError(`Restore failed and was rolled back: ${err.message}`);
    } finally {
      this.db = new Database(this.path, { create: true });
      this.applyPragmas();
      // The restored file may predate the search index (or carry a
      // different one). Cached "index exists" knowledge from the old file
      // must not survive: the next write re-checks, and the next search
      // rebuilds if needed, instead of writing into a table that is gone.
      this.ftsReady.clear();
      this.clearStatementCache();
    }
  }

  /** Closes the SQLite connection and frees prepared statements. */
  close(): void {
    this.clearStatementCache();
    this.db.close(true);
  }

  // ── Schema-sync internals (protected: shared with the session's FTS work) ──

  /** Whether a column's SQL default is an expression rather than a literal. */
  protected needsExpressionDefault(def: ColumnDefinition): boolean {
    return def.defaultValue === "CURRENT_TIMESTAMP";
  }

  /** Current number of rows in a table, or 0 if it does not exist yet. */
  protected rowCount(tableName: string): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM ${this.dialect.quoteIdent(tableName)}`)
      .get() as { c: number } | null;
    return row?.c ?? 0;
  }

  /**
   * Creates or repairs every searchable table's FTS index, inside the
   * schema-sync transaction. A table whose FTS columns no longer match its
   * searchable columns is rebuilt; a matching index is reconciled — orphan
   * entries dropped, missing rows inserted. Changed text on an existing row
   * is NOT repaired here; only a full rebuild sees it.
   */
  protected syncFtsTables(schema: DatabaseSchema): void {
    for (const [tableName, tableDef] of Object.entries(schema)) {
      const cols = searchableColumns(tableDef);
      if (cols.length === 0) continue;
      if (!this.baseTableExists(tableName)) continue;
      // A keyless table cannot be searched (no key to map hits back to
      // rows), so sync skips it instead of crashing schema setup. Search
      // and rebuild refuse it plainly when actually attempted.
      if (pkColumnName(tableDef) === null) continue;
      const existing = this.ftsColumnNames(tableName);
      const expected = [...cols, "__yatta_pk"];
      const matches = existing.length === expected.length && expected.every((c) => existing.includes(c));
      if (!matches) {
        this.dropFtsTable(tableName);
        this.createFtsTable(tableName, cols);
        this.populateFtsTable(tableName, cols, pkColumnName(tableDef) ?? "id");
        this.ftsReady.add(tableName);
        continue;
      }
      const fts = this.dialect.quoteIdent(ftsTableName(tableName));
      const base = this.dialect.quoteIdent(tableName);
      const pkCol = this.dialect.quoteIdent(pkColumnName(tableDef) ?? "id");
      const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
      const selectCols = cols.map((c) => `COALESCE(${this.dialect.quoteIdent(c)}, '')`).join(", ");
      this.db.run(
        `DELETE FROM ${fts} WHERE "__yatta_pk" NOT IN (SELECT CAST(${pkCol} AS TEXT) FROM ${base});`,
      );
      this.db.run(
        `INSERT INTO ${fts} (${colSql}, "__yatta_pk") ` +
          `SELECT ${selectCols}, CAST(b.${pkCol} AS TEXT) FROM ${base} AS b ` +
          `WHERE NOT EXISTS (SELECT 1 FROM ${fts} WHERE "__yatta_pk" = CAST(b.${pkCol} AS TEXT));`,
      );
      this.ftsReady.add(tableName);
    }
  }

  /**
   * Adds a column to a populated table by rebuilding it. Called only for the
   * case `ALTER TABLE ADD COLUMN` cannot express. The original CREATE TABLE
   * is read back from `sqlite_master` rather than regenerated from the
   * current schema, so columns that exist in the database but not in the
   * schema — and constraints declared by hand — survive.
   */
  protected rebuildTableWithColumn(tableName: string, colName: string, def: ColumnDefinition): void {
    const quoted = tableName.replace(/"/g, '""');
    const original = this.db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(quoted) as { sql: string } | null;

    if (!original?.sql) {
      throw new YattaError(
        `Cannot add "${colName}" to "${tableName}": its CREATE TABLE could not be read from sqlite_master, ` +
          `so the table cannot be rebuilt safely. Add the column with ALTER TABLE by hand.`,
      );
    }

    // Indexes and triggers live outside the CREATE TABLE text and are dropped with it.
    const savedObjects = this.db
      .query(
        `SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
      )
      .all(quoted) as { sql: string }[];

    // Built in create mode: a rebuilt table can carry PRIMARY KEY and UNIQUE, which
    // ALTER TABLE cannot add.
    const fragment = this.dialect.compileColumnFragment(colName, def, "create");
    const existingColumnList = (this.db.query(`PRAGMA table_info("${quoted}")`).all() as any[]).map(
      (c) => c.name,
    );
    const insertColumns = existingColumnList
      .map((n) => `"${n.replace(/"/g, '""')}"`)
      .join(", ");

    // Insert the new column before the closing paren of the column list.
    // The old regex only matched a `)` at the very end of the statement,
    // so a CREATE TABLE with trailing clauses (e.g. WITHOUT ROWID) was
    // silently rebuilt without the column and no error was raised. Scan
    // for the paren that closes the first `(` — the column list — honouring
    // quoted strings, so a `)` inside a default value cannot end the scan.
    const rebuilt = this.insertIntoColumnList(original.sql, fragment);

    this.db.run(`DROP TABLE IF EXISTS "_yatta_rebuild_${quoted}"`);
    this.db.run(
      rebuilt.replace(new RegExp(`^CREATE TABLE (IF NOT EXISTS )?"?${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`), `CREATE TABLE "_yatta_rebuild_${quoted}"`),
    );
    this.db.run(
      `INSERT INTO "_yatta_rebuild_${quoted}" (${insertColumns}) SELECT ${insertColumns} FROM "${quoted}";`,
    );
    this.db.run(`DROP TABLE "${quoted}";`);

    // `legacy_alter_table` is toggled because renaming a table with it off
    // makes SQLite rewrite references to that name in every other table,
    // which would turn other tables' foreign keys into dangling text.
    this.db.run("PRAGMA legacy_alter_table = ON;");
    try {
      this.db.run(`ALTER TABLE "_yatta_rebuild_${quoted}" RENAME TO "${quoted}";`);
    } finally {
      this.db.run("PRAGMA legacy_alter_table = OFF;");
    }

    for (const object of savedObjects) this.db.run(object.sql);
  }

  /**
   * Inserts `, <fragment>` just before the `)` that closes the column list
   * of a CREATE TABLE statement. Trailing clauses (WITHOUT ROWID, STRICT,
   * ...) follow that paren and are left untouched.
   */
  protected insertIntoColumnList(createSql: string, fragment: string): string {
    const open = createSql.indexOf("(");
    if (open === -1) {
      throw new YattaError(
        `Cannot add a column: the stored CREATE TABLE text has no column list.`,
      );
    }
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < createSql.length; i++) {
      const ch = createSql[i]!;
      if (quote !== null) {
        // Doubled quotes are an escaped quote inside the string, not its end.
        if (ch === quote && createSql[i + 1] === quote) {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          return `${createSql.slice(0, i)}, ${fragment}${createSql.slice(i)}`;
        }
      }
    }
    throw new YattaError(
      `Cannot add a column: the stored CREATE TABLE text has an unbalanced column list.`,
    );
  }
}
