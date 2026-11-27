// Turso adapter + session (Phase 2 of the multi-database ORM refactor).
//
// libSQL (@libsql/client) over an embedded local file by default, with a
// remote URL + authToken for later. The session is the only module (besides
// the dialect) that imports @libsql/client — the same gate as bun:sqlite
// for the SQLite adapter: no @libsql/client outside adapters/turso*.ts.
//
// The adapter extends the session: the root adapter IS the root session.
// A transaction hands fn a child session over the libSQL Transaction
// object; nesting uses SAVEPOINTs on that one transaction, mirroring how
// bun:sqlite nests on one connection.
//
// Verified against @libsql/client@0.18.0 (see the probe notes inline):
// - `createClient({ url: ":memory:" })` and `file:/abs/path.db` both work;
//   the local client is a connection pool, so embedded use passes
//   `concurrency: 1` — one connection, which keeps PRAGMA state (foreign_keys,
//   journal_mode) stable across statements and makes every statement run on
//   the connection the open transaction holds.
// - `@libsql/client` is loaded through `loadLibsql()` (a computed-specifier
//   `require`), never statically imported: the client loads a native
//   binding (`@libsql/linux-x64-gnu`) at import time, and a static import
//   makes `bun build --compile` bundle the client but leave the binding
//   unresolvable — a standalone binary then crashes at startup with
//   "Cannot find module '@libsql/linux-x64-gnu'", even for apps that only
//   use SQLite. The computed require is invisible to the bundler, so the
//   package stays out of the binary entirely; a Turso database loads it
//   from `node_modules` at runtime instead, so a standalone binary that
//   USES Turso needs the package resolvable next to it.
// - `client.execute(sql, args)` returns a ResultSet whose rows carry both
//   numeric and named access; rows are converted to plain objects from
//   `columns`, with BLOB ArrayBuffers converted to Uint8Array (bun:sqlite
//   returns Buffer for BLOBs, and callers expect that shape).
// - `client.transaction("write")` is BEGIN IMMEDIATE; `client.batch` is
//   atomic; `client.executeMultiple` runs multi-statement SQL; interactive
//   Transaction has execute/batch/executeMultiple/commit/rollback/close.
// - FTS5 works embedded: CREATE VIRTUAL TABLE ... USING fts5, MATCH ?,
//   bm25(), and fts5vocab all verified live — fullTextSearch is "fts5".
// - `VACUUM INTO` works on both :memory: and file databases and produces a
//   file that passes `PRAGMA quick_check` — backup is "file-copy".
// - COUNT(*) comes back as a number (intMode "number", the default);
//   lastInsertRowid is a bigint (converted to Number for "run" mode).

import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";
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
  QueryResult,
  TransactionOptions,
} from "../adapter";
import { TursoDialect } from "./turso_dialect";

/**
 * Loads `@libsql/client` through a computed-specifier `require` (see the
 * header note): the client is created in the adapter's synchronous
 * constructor, so a dynamic `import()` cannot be used here, and a static
 * import would bundle the native binding loader into standalone binaries
 * that never use Turso. `require` with a computed specifier is invisible
 * to `bun build`, so the package is resolved from `node_modules` only
 * when a Turso database is actually created.
 */
function loadLibsql(): typeof import("@libsql/client") {
  const specifier = ["@libsql", "client"].join("/");
  return require(specifier) as typeof import("@libsql/client");
}
import { SqlCompiler } from "../sql_compiler";
import type { SqlDialect } from "../sql_dialect";
import type { WhereClause } from "../query";

/** Connection options for the Turso adapter (findings §2.2: driver "turso", url, authToken). */
export interface TursoAdapterOptions {
  /**
   * File system path to the embedded database, or `":memory:"`.
   * Defaults to `Database/app.db`. Ignored when `url` is set.
   */
  path?: string;
  /**
   * Full database URL. `file:` (or `":memory:"`) for an embedded database,
   * `libsql:` / `http:` / `https:` / `ws:` / `wss:` for a remote one.
   * Takes precedence over `path`. Remote URLs are accepted but untested —
   * no remote server is available in this environment.
   */
  url?: string;
  /** Authentication token for a remote database (or an embedded replica's sync URL). */
  authToken?: string;
  /**
   * Remote URL to sync an embedded replica from. Passed straight through
   * to the libSQL client; untested — the local file is used when offline.
   */
  syncUrl?: string;
  /** Whether to log executed SQL with millisecond durations to stdout. */
  debug?: boolean;
}

/** Whether an error is libSQL lock contention (SQLITE_BUSY / "database is locked"). */
function isTursoBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "SQLITE_BUSY" ||
    /database is locked|database table is locked/i.test(
      String((err as Error | null)?.message ?? err),
    )
  );
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

/** Monotonic savepoint counter: names must be unique within a transaction. */
let savepointSeq = 0;

/**
 * One libSQL result row as a plain object. Built from `columns` rather than
 * spreading the Row (whose numeric indices would leak in), and BLOB values
 * arrive as ArrayBuffer from the client — converted to Uint8Array so callers
 * see the same shape bun:sqlite returns for BLOB columns.
 */
function toPlainRow(rs: ResultSet, row: ResultSet["rows"][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of rs.columns) {
    const value = row[col];
    out[col] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return out;
}

/** The two ways a session reaches libSQL: the root client, or an open transaction. */
interface TursoExecutor {
  execute(sql: string, args?: unknown[]): Promise<ResultSet>;
  executeMultiple(sql: string): Promise<void>;
}

/** Shared mutable state for one Turso database: the open libSQL transaction, if any. */
interface TursoTxState {
  tx: Transaction | null;
}

/** Wiring for a TursoSession: the root session builds it from options, a transaction builds a child from it. */
interface TursoSessionWiring {
  client: Client;
  path: string;
  isLocal: boolean;
  debug: boolean;
  txState: TursoTxState;
  initPromise: Promise<void>;
}

/**
 * Connection pragmas for an embedded database. Local only: a remote server
 * owns its own pragmas. `PRAGMA foreign_keys` is per-connection, so this
 * only holds because the embedded client runs with `concurrency: 1`
 * (a single pooled connection).
 */
async function applyTursoPragmas(client: Client, dbPath: string): Promise<void> {
  await client.execute("PRAGMA busy_timeout = 5000;");
  if (dbPath !== ":memory:") {
    await client.execute("PRAGMA journal_mode = WAL;");
  }
  await client.execute("PRAGMA foreign_keys = ON;");
}

/** Resolves adapter options to a libSQL URL, a display path, and locality. */
function resolveTursoLocation(options: TursoAdapterOptions): {
  url: string;
  path: string;
  isLocal: boolean;
  /** Absolute file path when the database is a local file (for mkdir / backup / restore), else null. */
  localPath: string | null;
} {
  if (options.url !== undefined) {
    const url = options.url;
    if (url === ":memory:" || url === "file::memory:" || url.startsWith("file::memory:?")) {
      return { url: ":memory:", path: ":memory:", isLocal: true, localPath: null };
    }
    if (url.startsWith("file:")) {
      let filePart = url.slice("file:".length);
      const queryAt = filePart.indexOf("?");
      if (queryAt !== -1) filePart = filePart.slice(0, queryAt);
      // file:/abs/path, file:///abs/path, or file:relative/path.
      const resolved = path.resolve(process.cwd(), filePart.replace(/^\/+/, "/"));
      return { url: `file:${resolved}`, path: resolved, isLocal: true, localPath: resolved };
    }
    // Remote URL (libsql:/http:/ws:): the URL itself is the location.
    return { url, path: url, isLocal: false, localPath: null };
  }

  let targetPath = options.path ?? "Database/app.db";
  if (targetPath === ":memory:") {
    return { url: ":memory:", path: ":memory:", isLocal: true, localPath: null };
  }
  if (targetPath.startsWith("file:")) targetPath = targetPath.slice("file:".length);
  const hasExtension = path.extname(targetPath) !== "";
  if (!hasExtension || targetPath.endsWith("/") || targetPath.endsWith("\\")) {
    targetPath = path.join(targetPath, "app.db");
  }
  const resolved = path.resolve(process.cwd(), targetPath);
  return { url: `file:${resolved}`, path: resolved, isLocal: true, localPath: resolved };
}

export const TURSO_CAPABILITIES: AdapterCapabilities = {
  mode: "async",
  // libSQL is SQLite: JOINs work. (The ORM still batches relations as
  // separate queries, as for SQLite — this declares what the driver can do.)
  joins: true,
  foreignKeys: true,
  acidTransactions: true,
  // Nested transactions are SAVEPOINTs on the one open Transaction.
  savepoints: true,
  returningClause: true,
  // FTS5 verified live on the embedded client (MATCH + bm25 + fts5vocab).
  fullTextSearch: "fts5",
  vectors: "none",
  // VACUUM INTO + file swap, verified: the output passes quick_check.
  backupRestore: "file-copy",
  // Single-connection embedded client (concurrency 1); no cross-process
  // lockfile or busy-retry coordination beyond busy_timeout.
  multiProcessSafe: false,
  // SQLite's historical SQLITE_MAX_VARIABLE_NUMBER floor, as for SQLite.
  maxBindParams: 999,
  // The Postgres dialect compiles runnable SQL.
  compilerSql: true,
};

/**
 * One Turso connection, implementing the async session contract. Owns the
 * libSQL Client, the FTS5 indexes, and the shared transaction state. The
 * adapter (TursoAdapter) is the root session; transaction() hands fn a
 * child session over the libSQL Transaction object.
 */
export class TursoSession implements DatabaseSession<"async"> {
  readonly capabilities: AdapterCapabilities = TURSO_CAPABILITIES;
  /** SQL dialect for this connection. Owns every driver-specific SQL string. */
  readonly dialect: SqlDialect = new TursoDialect();
  /** Driver-neutral SQL compiler over the dialect. */
  readonly compiler: SqlCompiler = new SqlCompiler(this.dialect);

  /** Resolved filesystem path to the database file, `":memory:"`, or the remote URL. */
  readonly path: string;
  protected readonly isLocal: boolean;
  protected readonly debug: boolean;
  protected client: Client;
  protected readonly txState: TursoTxState;
  protected initPromise: Promise<void>;
  /** Searchable tables whose FTS table is known to exist, so writes skip a lookup. */
  protected ftsReady = new Set<string>();
  /** Tables whose FTS row counts have been verified against the base table at least once in this process. */
  protected ftsVerified = new Set<string>();
  /** Cached typo-correction vocabulary per table. Invalidated on every FTS write through this instance. */
  protected ftsVocabCache = new Map<string, Set<string>>();
  protected closed = false;

  constructor(wiring: TursoSessionWiring) {
    this.client = wiring.client;
    this.path = wiring.path;
    this.isLocal = wiring.isLocal;
    this.debug = wiring.debug;
    this.txState = wiring.txState;
    this.initPromise = wiring.initPromise;
  }

  /** Direct access to the underlying libSQL Client. */
  get libsqlClient(): Client {
    return this.client;
  }

  /** Whether this session is currently inside a transaction. */
  get inTransaction(): boolean {
    return this.txState.tx !== null;
  }

  /** Awaits the connection pragmas (no-op once applied). */
  protected async ensureReady(): Promise<void> {
    await this.initPromise;
  }

  /**
   * Routes a statement at the open transaction when one exists, else at the
   * root client. Routing the root session into the open transaction mirrors
   * bun:sqlite, where the one connection executes inside its transaction —
   * and it never calls the pooled client while the transaction holds the
   * single connection (the pool would reject that with TRANSACTION_ACTIVE).
   */
  protected get executor(): TursoExecutor {
    const tx = this.txState.tx;
    if (tx !== null) {
      return {
        // Transaction.execute takes one InStatement object, unlike the
        // client's two-argument overload.
        execute: (sql, args) => tx.execute({ sql, args: args as InValue[] }),
        executeMultiple: (sql) => tx.executeMultiple(sql),
      };
    }
    return {
      execute: (sql, args) => this.client.execute(sql, args as InValue[]),
      executeMultiple: (sql) => this.client.executeMultiple(sql),
    };
  }

  /** A child session over one open libSQL Transaction, sharing this session's transaction state. */
  protected txSession(): TursoSession {
    return new TursoSession({
      client: this.client,
      path: this.path,
      isLocal: this.isLocal,
      debug: this.debug,
      txState: this.txState,
      initPromise: this.initPromise,
    });
  }

  /** Finalizes and purges cached prepared statements. A no-op: the libSQL client keeps no cache this session owns. */
  clearStatementCache(): void {}

  /**
   * Executes an SQL statement with parameters. `"get"` returns one row or
   * null, `"all"` returns all rows, `"run"` returns the write result
   * (`{ lastInsertRowid, changes }` — `lastInsertRowid` is 0 when the
   * statement was not an INSERT or the table has no rowid).
   */
  async run(sql: string, params: unknown[] = [], mode: "get" | "all" | "run" = "all"): Promise<unknown> {
    await this.ensureReady();
    // libSQL's InValue has no `undefined`: a caller passing one means NULL.
    const args = params.map((p) => (p === undefined ? null : p));
    const start = this.debug ? performance.now() : 0;
    try {
      const rs = await this.executor.execute(sql, args);
      if (this.debug) {
        console.log(`[yatta-db] ${(performance.now() - start).toFixed(2)}ms  ${sql}`, params.length ? params : "");
      }
      if (mode === "get") {
        const row = rs.rows[0];
        return row === undefined ? null : toPlainRow(rs, row);
      }
      if (mode === "all") return rs.rows.map((row) => toPlainRow(rs, row));
      return {
        lastInsertRowid: rs.lastInsertRowid === undefined ? 0 : Number(rs.lastInsertRowid),
        changes: rs.rowsAffected ?? 0,
      };
    } catch (err: any) {
      throw new YattaError(err?.message ?? String(err), sql);
    }
  }

  // ── Session CRUD ─────────────────────────────────────────────────────────

  async insert(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), row);
    return this.compiler.decodeRow(columnsOf(schema), await this.run(sql, params, "get"));
  }

  async insertMany(
    table: string,
    schema: TableSchema,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    // One transaction, one insert at a time: the driver is single-connection
    // and transaction concurrency is unverified — never Promise.all.
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
    const value = row?.count ?? 0;
    return typeof value === "bigint" ? Number(value) : (value as number);
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

  async delete(table: string, schema: TableSchema, where: WhereClause<any>): Promise<number> {
    const { sql, params } = this.compiler.compileDelete(table, columnsOf(schema), where);
    return (await this.run(sql, params, "run") as { changes: number }).changes;
  }

  async upsert(table: string, schema: TableSchema, plan: CompiledUpsertPlan): Promise<Record<string, unknown>> {
    // compileUpsert returns null for Turso (and for SQLite): the
    // transactional find-first fallback is the behaviour, not a stopgap.
    return this.transaction(async (tx) => {
      const existing = await tx.find(table, schema, { where: plan.where, take: 1 });
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
        return this.compiler.decodeRow(columnsOf(schema), await tx.run(sql, params, "get"));
      }
      const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), plan.createRow);
      return this.compiler.decodeRow(columnsOf(schema), await tx.run(sql, params, "get"));
    });
  }

  // ── Full-text search ─────────────────────────────────────────────────────
  //
  // One standalone FTS5 table per searchable base table, named `_fts_<table>`,
  // holding the searchable columns plus `__yatta_pk` (UNINDEXED, so the key
  // itself is never searchable) storing the base row's primary key as text.
  // Standalone, not an FTS5 content table, because Yatta primary keys can be
  // text UUIDs and FTS5 content tables only track an integer rowid.
  // FTS5 is verified live on the embedded libSQL client (MATCH + bm25 +
  // fts5vocab), so this mirrors the SQLite adapter exactly.

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

    // Creates (or repairs) the index on first use, so a table opened with
    // autoMigrate off, or a database file copied in from elsewhere, still
    // searches correctly instead of failing on a missing FTS table.
    await this.ensureSearchIndex(table, schema);

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
    // libSQL rejects a bare OFFSET with no LIMIT, so an offset-only page
    // gets LIMIT -1 (SQLite's "no upper bound"), the same idiom findMany uses.
    const limitSql = query.limit !== undefined ? `LIMIT ${query.limit}` : query.offset !== undefined ? "LIMIT -1" : "";
    const offsetSql = query.offset !== undefined ? `OFFSET ${query.offset}` : "";
    const sql = [
      `SELECT "__yatta_pk" AS pk, bm25(${fts}) AS rank FROM ${fts}`,
      `WHERE ${fts} MATCH ? ORDER BY rank ASC`,
      limitSql,
      offsetSql,
    ].filter(Boolean).join(" ").concat(";");

    const hits = (await this.run(sql, [matchExpr], "all")) as { pk: unknown; rank: number }[];
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
    const rows = await this.find(table, schema, { where });
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
  async syncSearchRow(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
    op: "insert" | "update" | "delete",
  ): Promise<void> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) return;
    const pkCol = pkColumnName(schema);
    if (pkCol === null) return;
    const pk = row[pkCol];
    if (pk === null || pk === undefined) return;
    if (!this.ftsReady.has(table)) {
      if (!(await this.ftsTableExists(table))) return;
      this.ftsReady.add(table);
    }
    const fts = this.dialect.quoteIdent(ftsTableName(table));
    const pkText = String(pk);
    try {
      if (op !== "insert") {
        await this.run(`DELETE FROM ${fts} WHERE "__yatta_pk" = ?;`, [pkText], "run");
      }
      if (op !== "delete") {
        await this.ftsInsertRow(table, cols, pkText, row);
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
    await this.dropFtsTable(table);
    await this.createFtsTable(table, cols);
    await this.populateFtsTable(table, cols, pkColumnName(schema) ?? "id");
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
  async searchVocabulary(table: string, schema: TableSchema): Promise<Set<string>> {
    const cached = this.ftsVocabCache.get(table);
    if (cached) return cached;
    const vocab = ftsVocabTableName(table);
    const vocabExists = (await this.run(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`,
      [vocab],
      "get",
    )) as { ok: number } | null;
    if (vocabExists) {
      try {
        const qvocab = this.dialect.quoteIdent(vocab);
        const rows = (await this.run(`SELECT DISTINCT term FROM ${qvocab};`, [], "all")) as { term: string }[];
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
    const rows = (await this.run(`SELECT ${colSql} FROM ${this.dialect.quoteIdent(table)};`, [], "all")) as Record<string, unknown>[];
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
  async ftsTableExists(tableName: string): Promise<boolean> {
    const row = (await this.run(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`,
      [ftsTableName(tableName)],
      "get",
    )) as { ok: number } | null;
    return row !== null && row !== undefined;
  }

  /**
   * Makes sure one table's FTS index exists and matches its searchable
   * columns, rebuilding when it does not. Called by `search()` so a first
   * search never fails on a missing index. Also rebuilds when the row counts
   * disagree — the cheap signal that rows were added or removed outside the
   * Table write paths.
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
    const existing = await this.ftsColumnNames(tableName);
    const expected = [...cols, "__yatta_pk"];
    const matches = existing.length === expected.length && expected.every((c) => existing.includes(c));
    if (!matches) {
      await this.rebuildSearchIndex(tableName, schema);
      return;
    }
    this.ftsReady.add(tableName);
    // The counts are a full FTS scan (~1 ms at 5k rows, growing with the
    // table), so they run once per process open, not on every search.
    if (this.ftsVerified.has(tableName)) return;
    try {
      const fts = this.dialect.quoteIdent(ftsTableName(tableName));
      const base = this.dialect.quoteIdent(tableName);
      const ftsCount = ((await this.run(`SELECT COUNT(*) AS c FROM ${fts}`, [], "get")) as { c: number }).c;
      const baseCount = ((await this.run(`SELECT COUNT(*) AS c FROM ${base}`, [], "get")) as { c: number }).c;
      if (ftsCount !== baseCount) await this.rebuildSearchIndex(tableName, schema);
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
  async executeRaw(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const head = sql.trimStart().toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("VALUES") ||
      head.startsWith("EXPLAIN") ||
      head.startsWith("PRAGMA") ||
      /RETURNING\b/i.test(sql);
    if (isRead) {
      const rows = (await this.run(sql, params as any[], "all")) as Record<string, unknown>[];
      return { rows, affectedRows: rows.length };
    }
    const res = (await this.run(sql, params as any[], "run")) as { changes: number };
    return { rows: [], affectedRows: res.changes };
  }

  /** Runs multi-statement SQL (DDL scripts, migrations). */
  async executeBatch(sql: string): Promise<void> {
    await this.ensureReady();
    try {
      await this.executor.executeMultiple(sql);
    } catch (err: any) {
      throw new YattaError(err?.message ?? String(err), sql);
    }
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  /**
   * Runs `fn` inside a libSQL transaction.
   *
   * A root call opens an interactive transaction on the client
   * (`"write"` = BEGIN IMMEDIATE for `mode: "immediate"`, `"deferred"`
   * otherwise) and hands fn a child session over it; commit on success,
   * rollback on throw. A nested call — one already inside a transaction —
   * uses a SAVEPOINT on the same transaction instead: the inner failure
   * rolls back only the inner work, mirroring bun:sqlite's nesting.
   *
   * The child session routes every statement through the Transaction
   * object, never the pooled client: the transaction holds the single
   * embedded connection, and the pool rejects client calls while it does.
   */
  async transaction<R>(
    fn: (txSession: DatabaseSession<"async">) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    await this.ensureReady();
    if (this.txState.tx !== null) {
      const sp = `yatta_sp_${++savepointSeq}`;
      const child = this.txSession();
      await child.run(`SAVEPOINT "${sp}";`, [], "run");
      try {
        const result = await fn(child);
        await child.run(`RELEASE SAVEPOINT "${sp}";`, [], "run");
        return result;
      } catch (err) {
        try { await child.run(`ROLLBACK TO SAVEPOINT "${sp}";`, [], "run"); } catch {}
        try { await child.run(`RELEASE SAVEPOINT "${sp}";`, [], "run"); } catch {}
        throw err;
      }
    }

    const mode = options?.mode === "immediate" ? "write" : "deferred";
    const tx = await this.client.transaction(mode);
    this.txState.tx = tx;
    const child = this.txSession();
    try {
      const result = await fn(child);
      await tx.commit();
      return result;
    } catch (err) {
      try { await tx.rollback(); } catch {}
      throw err;
    } finally {
      this.txState.tx = null;
      tx.close();
    }
  }

  // ── FTS internals (protected: the adapter subclass uses them) ───────────

  protected async baseTableExists(tableName: string): Promise<boolean> {
    const row = (await this.run(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;`,
      [tableName],
      "get",
    )) as { ok: number } | null;
    return row !== null && row !== undefined;
  }

  protected async createFtsTable(tableName: string, cols: string[]): Promise<void> {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    try {
      await this.run(`CREATE VIRTUAL TABLE ${fts} USING fts5(${colSql}, "__yatta_pk" UNINDEXED, tokenize='unicode61');`, [], "run");
    } catch (err: any) {
      // libSQL links its own SQLite build, which is expected to include
      // FTS5 — but a build without it must fail with this explanation, not
      // libSQL's bare "no such module: fts5".
      if (String(err?.message ?? err).includes("no such module")) {
        throw new YattaError(
          `Full-text search needs SQLite's FTS5 module, which this libSQL build does not include. ` +
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
      await this.run(`CREATE VIRTUAL TABLE ${vocab} USING fts5vocab(${fts}, 'col');`, [], "run");
    } catch {
      // Vocab is an optimization, not the index itself. Search still works.
    }
  }

  protected async dropFtsTable(tableName: string): Promise<void> {
    const vocab = this.dialect.quoteIdent(ftsVocabTableName(tableName));
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    await this.run(`DROP TABLE IF EXISTS ${vocab};`, [], "run");
    await this.run(`DROP TABLE IF EXISTS ${fts};`, [], "run");
    this.ftsVerified.delete(tableName);
    this.ftsVocabCache.delete(tableName);
  }

  protected async populateFtsTable(tableName: string, cols: string[], pkCol: string): Promise<void> {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const base = this.dialect.quoteIdent(tableName);
    const qpk = this.dialect.quoteIdent(pkCol);
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const selectCols = cols.map((c) => `COALESCE(${this.dialect.quoteIdent(c)}, '')`).join(", ");
    await this.run(
      `INSERT INTO ${fts} (${colSql}, "__yatta_pk") SELECT ${selectCols}, CAST(${qpk} AS TEXT) FROM ${base};`,
      [],
      "run",
    );
  }

  protected async ftsColumnNames(tableName: string): Promise<string[]> {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    try {
      return ((await this.run(`PRAGMA table_info(${fts})`, [], "all")) as any[]).map((c) => c.name);
    } catch {
      return [];
    }
  }

  /** Shared INSERT half of the FTS write paths. */
  protected async ftsInsertRow(tableName: string, cols: string[], pkText: string, row: Record<string, any>): Promise<void> {
    const fts = this.dialect.quoteIdent(ftsTableName(tableName));
    const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => {
      const v = row[c];
      return v === null || v === undefined ? "" : String(v);
    });
    await this.run(
      `INSERT INTO ${fts} (${colSql}, "__yatta_pk") VALUES (${placeholders}, ?);`,
      [...values, pkText],
      "run",
    );
  }

  protected async syncSchemaWithRetry(schema: DatabaseSchema, attempts: number): Promise<void> {
    try {
      await this.syncSchemaOnce(schema);
    } catch (err) {
      if (!isTursoBusy(err) || attempts <= 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (9 - attempts)));
      await this.syncSchemaWithRetry(schema, attempts - 1);
    }
  }

  protected async syncSchemaOnce(schema: DatabaseSchema): Promise<void> {
    const schemaHash = crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);

    // PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled
    // outside the transaction below — on the same single pooled connection
    // the transaction then borrows. Local only; remote servers are not
    // toggled (untested path).
    if (this.isLocal) await this.run("PRAGMA foreign_keys = OFF;", [], "run");

    try {
      // "write" is BEGIN IMMEDIATE, not the deferred BEGIN a default
      // transaction issues: taking the write lock up front makes
      // busy_timeout apply as intended instead of failing at once.
      const tx = await this.client.transaction("write");
      this.txState.tx = tx;
      try {
        const child = this.txSession();
        await child.syncSchemaBody(schema, schemaHash);
        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch {}
        throw err;
      } finally {
        this.txState.tx = null;
        tx.close();
      }
    } finally {
      if (this.isLocal) {
        try { await this.run("PRAGMA foreign_keys = ON;", [], "run"); } catch {}
      }
      this.clearStatementCache();
    }
  }

  /**
   * Applies the schema inside an open transaction.
   * Split out from {@link syncSchemaOnce} so the lock handling stays readable.
   * Runs on a transaction child session: every statement here goes through
   * the Transaction object.
   */
  protected async syncSchemaBody(schema: DatabaseSchema, schemaHash: string): Promise<void> {
    await this.ensureMigrationTable();

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

      await this.run(createSql, [], "run");
      indexSqls.push(...createIndexes);

      const existingColumns = ((await this.run(`PRAGMA table_info(${this.dialect.quoteIdent(tableName)})`, [], "all")) as any[]).map(
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
          (await this.rowCount(tableName)) > 0
        ) {
          await this.rebuildTableWithColumn(tableName, colName, def);
        } else {
          const fragment = this.dialect.compileColumnFragment(colName, def, "alter");
          await this.run(this.dialect.compileAddColumnSql(tableName, fragment), [], "run");
        }

        await this.run(
          `INSERT OR IGNORE INTO "_yatta_migrations" (name, hash) VALUES (?, ?)`,
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

    // Full-text indexes are built after the base tables exist, in the
    // same transaction, so a fresh database and an upgraded one (a new
    // .searchable() column on an existing table) both end up indexed.
    await this.syncFtsTables(schema);

    const violations = (await this.run("PRAGMA foreign_key_check;", [], "all")) as unknown[];
    if (violations.length > 0) {
      throw new YattaError(`Foreign key integrity check failed after schema sync: ${JSON.stringify(violations)}`);
    }
  }

  // ── Schema-sync internals (protected: shared with the session's FTS work) ──

  /** Whether a column's SQL default is an expression rather than a literal. */
  protected needsExpressionDefault(def: ColumnDefinition): boolean {
    return def.defaultValue === "CURRENT_TIMESTAMP";
  }

  /** Current number of rows in a table, or 0 if it does not exist yet. */
  protected async rowCount(tableName: string): Promise<number> {
    const row = (await this.run(
      `SELECT COUNT(*) AS c FROM ${this.dialect.quoteIdent(tableName)}`,
      [],
      "get",
    )) as { c: number } | null;
    return row?.c ?? 0;
  }

  /**
   * Creates or repairs every searchable table's FTS index, inside the
   * schema-sync transaction. A table whose FTS columns no longer match its
   * searchable columns is rebuilt; a matching index is reconciled — orphan
   * entries dropped, missing rows inserted. Changed text on an existing row
   * is NOT repaired here; only a full rebuild sees it.
   */
  protected async syncFtsTables(schema: DatabaseSchema): Promise<void> {
    for (const [tableName, tableDef] of Object.entries(schema)) {
      const cols = searchableColumns(tableDef);
      if (cols.length === 0) continue;
      if (!(await this.baseTableExists(tableName))) continue;
      // A keyless table cannot be searched (no key to map hits back to
      // rows), so sync skips it instead of crashing schema setup. Search
      // and rebuild refuse it plainly when actually attempted.
      if (pkColumnName(tableDef) === null) continue;
      const existing = await this.ftsColumnNames(tableName);
      const expected = [...cols, "__yatta_pk"];
      const matches = existing.length === expected.length && expected.every((c) => existing.includes(c));
      if (!matches) {
        await this.dropFtsTable(tableName);
        await this.createFtsTable(tableName, cols);
        await this.populateFtsTable(tableName, cols, pkColumnName(tableDef) ?? "id");
        this.ftsReady.add(tableName);
        continue;
      }
      const fts = this.dialect.quoteIdent(ftsTableName(tableName));
      const base = this.dialect.quoteIdent(tableName);
      const pkCol = this.dialect.quoteIdent(pkColumnName(tableDef) ?? "id");
      const colSql = cols.map((c) => this.dialect.quoteIdent(c)).join(", ");
      const selectCols = cols.map((c) => `COALESCE(${this.dialect.quoteIdent(c)}, '')`).join(", ");
      await this.run(
        `DELETE FROM ${fts} WHERE "__yatta_pk" NOT IN (SELECT CAST(${pkCol} AS TEXT) FROM ${base});`,
        [],
        "run",
      );
      await this.run(
        `INSERT INTO ${fts} (${colSql}, "__yatta_pk") ` +
          `SELECT ${selectCols}, CAST(b.${pkCol} AS TEXT) FROM ${base} AS b ` +
          `WHERE NOT EXISTS (SELECT 1 FROM ${fts} WHERE "__yatta_pk" = CAST(b.${pkCol} AS TEXT));`,
        [],
        "run",
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
  protected async rebuildTableWithColumn(tableName: string, colName: string, def: ColumnDefinition): Promise<void> {
    const quoted = tableName.replace(/"/g, '""');
    const original = (await this.run(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [quoted],
      "get",
    )) as { sql: string } | null;

    if (!original?.sql) {
      throw new YattaError(
        `Cannot add "${colName}" to "${tableName}": its CREATE TABLE could not be read from sqlite_master, ` +
          `so the table cannot be rebuilt safely. Add the column with ALTER TABLE by hand.`,
      );
    }

    // Indexes and triggers live outside the CREATE TABLE text and are dropped with it.
    const savedObjects = (await this.run(
      `SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`,
      [quoted],
      "all",
    )) as { sql: string }[];

    // Built in create mode: a rebuilt table can carry PRIMARY KEY and UNIQUE, which
    // ALTER TABLE cannot add.
    const fragment = this.dialect.compileColumnFragment(colName, def, "create");
    const existingColumnList = ((await this.run(`PRAGMA table_info("${quoted}")`, [], "all")) as any[]).map(
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

    await this.run(`DROP TABLE IF EXISTS "_yatta_rebuild_${quoted}"`, [], "run");
    await this.run(
      rebuilt.replace(new RegExp(`^CREATE TABLE (IF NOT EXISTS )?"?${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`), `CREATE TABLE "_yatta_rebuild_${quoted}"`),
      [],
      "run",
    );
    await this.run(
      `INSERT INTO "_yatta_rebuild_${quoted}" (${insertColumns}) SELECT ${insertColumns} FROM "${quoted}";`,
      [],
      "run",
    );
    await this.run(`DROP TABLE "${quoted}";`, [], "run");

    // `legacy_alter_table` is toggled because renaming a table with it off
    // makes SQLite rewrite references to that name in every other table,
    // which would turn other tables' foreign keys into dangling text.
    await this.run("PRAGMA legacy_alter_table = ON;", [], "run");
    try {
      await this.run(`ALTER TABLE "_yatta_rebuild_${quoted}" RENAME TO "${quoted}";`, [], "run");
    } finally {
      await this.run("PRAGMA legacy_alter_table = OFF;", [], "run");
    }

    for (const object of savedObjects) await this.run(object.sql, [], "run");
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

  /**
   * Creates the migration-marker table (`_yatta_migrations`) in SQLite
   * DDL (libSQL speaks SQLite). Runs on this session, so it works on a
   * transaction child session as well as the root adapter.
   */
  async ensureMigrationTable(): Promise<void> {
    await this.run(
      `
      CREATE TABLE IF NOT EXISTS "_yatta_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        hash TEXT,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `,
      [],
      "run",
    );
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
      `INSERT OR IGNORE INTO "_yatta_migrations" (name, hash) VALUES (?, ?)`,
      [name, "migration"],
      "run",
    );
  }
}

/**
 * The Turso adapter: the root session plus the connection-level operations
 * (schema sync, migration lock, backup/restore, close). The root adapter IS
 * the root session.
 */
export class TursoAdapter extends TursoSession implements DatabaseAdapter<"async"> {
  readonly driver = "turso" as const;

  constructor(options: TursoAdapterOptions = {}) {
    const resolved = resolveTursoLocation(options);
    if (resolved.localPath) {
      const dir = path.dirname(resolved.localPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    const client = loadLibsql().createClient({
      url: resolved.url,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.syncUrl !== undefined ? { syncUrl: options.syncUrl } : {}),
      // Single pooled connection for embedded databases: keeps PRAGMA state
      // stable across statements and matches the one-connection design the
      // transaction path relies on. Remote clients keep the default pool.
      ...(resolved.isLocal ? { concurrency: 1 } : {}),
      intMode: "number",
    });
    super({
      client,
      path: resolved.path,
      isLocal: resolved.isLocal,
      debug: options.debug ?? false,
      txState: { tx: null },
      // Pragmas are local-only; a remote server owns its own.
      initPromise: resolved.isLocal ? applyTursoPragmas(client, resolved.path) : Promise.resolve(),
    });
  }

  /** Eagerly wait for initialization (connection pragmas on embedded databases). */
  async ready(): Promise<void> {
    await this.ensureReady();
  }

  /**
   * Applies a declarative schema: creates missing tables and columns,
   * repairs FTS indexes, and fails the whole sync on a foreign-key
   * violation.
   */
  async syncSchema(schema: DatabaseSchema): Promise<void> {
    await this.syncSchemaWithRetry(schema, 8);
  }



  /** User tables (internal tables — FTS indexes, migration log — are excluded). */
  async listTables(): Promise<string[]> {
    const rows = (await this.run(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_fts_%' AND name != '_yatta_migrations' ORDER BY name;`,
      [],
      "all",
    )) as { name: string }[];
    return rows.map((r) => r.name);
  }

  async listColumns(table: string): Promise<IntrospectedColumn[]> {
    const rows = (await this.run(`PRAGMA table_info(${this.dialect.quoteIdent(table)})`, [], "all")) as any[];
    return rows.map((c) => ({
      name: c.name as string,
      type: c.type as string,
      nullable: c.notnull === 0,
      primaryKey: (c.pk as number) > 0,
    }));
  }

  /**
   * Exclusive lock across migrations (BEGIN IMMEDIATE on Turso).
   * Two processes migrating at once used to both read the marker table, both
   * run up() for the same migration, and the second marker INSERT threw
   * UNIQUE — after a non-idempotent up had already applied twice. BEGIN
   * IMMEDIATE takes the write lock up front (busy_timeout makes the loser
   * wait, then fail loudly instead of double-applying). If a transaction is
   * already open on this connection, the lock cannot be taken and fn runs
   * inside it.
   */
  async withMigrationLock<R>(fn: (session: DatabaseSession<"async">) => Promise<R>): Promise<R> {
    await this.ensureReady();
    if (this.txState.tx !== null) {
      // Already inside a transaction: the lock cannot be taken; fn runs inside it.
      return fn(this);
    }

    let fkWasOn = false;
    if (this.isLocal) {
      try {
        const fkRow = (await this.run("PRAGMA foreign_keys", [], "get")) as { foreign_keys: number } | null;
        fkWasOn = fkRow?.foreign_keys === 1;
        if (fkWasOn) await this.run("PRAGMA foreign_keys = OFF;", [], "run");
      } catch {
        fkWasOn = false;
      }
    }

    const tx = await this.client.transaction("write");
    this.txState.tx = tx;
    const child = this.txSession();
    try {
      const result = await fn(child);
      await tx.commit();
      return result;
    } catch (err) {
      try { await tx.rollback(); } catch {}
      throw err;
    } finally {
      this.txState.tx = null;
      tx.close();
      if (fkWasOn) {
        try { await this.run("PRAGMA foreign_keys = ON;", [], "run"); } catch {}
      }
    }
  }

  /**
   * Performs an atomic online backup snapshot using libSQL's `VACUUM INTO`.
   * Verified: the output passes `PRAGMA quick_check` on both :memory: and
   * file databases. Remote databases are refused — VACUUM INTO is a local
   * operation and is untested over hrana.
   */
  async backup(destPath: string): Promise<void> {
    if (!this.isLocal) {
      throw new YattaError("Backup is only supported for local embedded Turso databases, not remote URLs.");
    }
    const tempPath = `${destPath}.tmp.${Date.now()}`;
    try {
      /*
       * VACUUM INTO writes through libSQL, which will not create intermediate
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
      await this.run(`VACUUM INTO '${escaped}';`, [], "run");
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
   * 1. Validates the backup file's SQLite integrity (`quick_check`) on a
   *    throwaway copy, so the source file is never opened read-write.
   * 2. Atomically replaces current database files with backup.
   * 3. Rolls back safely to previous state if anything fails.
   *
   * Local file databases only: restoring into `:memory:` or a remote URL
   * is refused, as for SQLite.
   */
  async restore(sourcePath: string): Promise<void> {
    if (!fs.existsSync(sourcePath)) throw new YattaError(`Backup file not found: ${sourcePath}`);
    if (this.path === ":memory:" || !this.isLocal) {
      throw new YattaError("Cannot restore into an in-memory or remote Turso database.");
    }
    const localPath = this.path;

    // Validate a copy: libSQL has no read-only open mode, so opening the
    // source itself could checkpoint or create sidecar files next to it.
    const tempPath = `${localPath}.restore.${Date.now()}`;
    const rollbackPath = `${localPath}.rollback.${Date.now()}`;
    let validationClient: Client | null = null;
    try {
      fs.copyFileSync(sourcePath, tempPath);
      validationClient = loadLibsql().createClient({ url: `file:${tempPath}`, intMode: "number" });
      const check = await validationClient.execute("PRAGMA quick_check;");
      const ok = check.rows[0] as unknown as { quick_check: string } | undefined;
      if (ok?.quick_check !== "ok") {
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
      const tables = await validationClient.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table';",
      );
      if (tables.rows.length === 0) {
        throw new Error("backup file is a valid but empty SQLite database — it holds no schema");
      }
    } catch (err: any) {
      if (err instanceof YattaError) throw err;
      throw new YattaError(`Invalid or corrupt backup file: ${err.message}`);
    } finally {
      validationClient?.close();
    }

    // Set once the restored file is in place: a failure after that point
    // (e.g. deleting the rollback copy) must not roll the live database
    // back to the old file.
    let swapped = false;
    try {
      this.clearStatementCache();
      if (this.txState.tx !== null) {
        try { this.txState.tx.close(); } catch {}
        this.txState.tx = null;
      }
      // Checkpoint first so committed transactions are folded from the
      // WAL into the main file before the connection closes; the WAL
      // files are then moved alongside the rollback copy, not deleted,
      // so a failed swap can still restore the live database whole.
      try {
        await this.run("PRAGMA wal_checkpoint(TRUNCATE);", [], "run");
      } catch {}
      this.client.close();
      this.closed = true;

      if (fs.existsSync(localPath)) {
        fs.renameSync(localPath, rollbackPath);
      }

      const walPath = `${localPath}-wal`;
      const shmPath = `${localPath}-shm`;
      const rollbackWal = `${rollbackPath}-wal`;
      const rollbackShm = `${rollbackPath}-shm`;
      if (fs.existsSync(walPath)) fs.renameSync(walPath, rollbackWal);
      if (fs.existsSync(shmPath)) fs.renameSync(shmPath, rollbackShm);

      fs.renameSync(tempPath, localPath);
      swapped = true;

      if (fs.existsSync(rollbackPath)) {
        fs.unlinkSync(rollbackPath);
      }
      if (fs.existsSync(rollbackWal)) fs.unlinkSync(rollbackWal);
      if (fs.existsSync(rollbackShm)) fs.unlinkSync(rollbackShm);
    } catch (err: any) {
      if (!swapped && fs.existsSync(rollbackPath)) {
        try { fs.renameSync(rollbackPath, localPath); } catch {}
      }
      // The rollback is only whole with its WAL: without it, every
      // committed transaction that lived only in the WAL is silently gone.
      if (!swapped && fs.existsSync(`${rollbackPath}-wal`)) {
        try { fs.renameSync(`${rollbackPath}-wal`, `${localPath}-wal`); } catch {}
      }
      if (!swapped && fs.existsSync(`${rollbackPath}-shm`)) {
        try { fs.renameSync(`${rollbackPath}-shm`, `${localPath}-shm`); } catch {}
      }
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new YattaError(`Restore failed and was rolled back: ${err.message}`);
    } finally {
      this.client = loadLibsql().createClient({
        url: `file:${localPath}`,
        concurrency: 1,
        intMode: "number",
      });
      this.initPromise = applyTursoPragmas(this.client, localPath);
      this.closed = false;
      // The restored file may predate the search index (or carry a
      // different one). Cached "index exists" knowledge from the old file
      // must not survive: the next write re-checks, and the next search
      // rebuilds if needed, instead of writing into a table that is gone.
      this.ftsReady.clear();
      this.clearStatementCache();
    }
  }

  /** Closes the libSQL client and frees resources. */
  async close(): Promise<void> {
    if (this.txState.tx !== null) {
      // Closing the transaction rolls it back; the client cannot close
      // cleanly while it holds the single connection.
      try { this.txState.tx.close(); } catch {}
      this.txState.tx = null;
    }
    this.clearStatementCache();
    this.closed = true;
    this.client.close();
  }

}
