// PGlite adapter (Postgres via @electric-sql/pglite) — Phase 2 of the
// multi-database ORM refactor.
//
// Two classes in one file:
//   PGliteSession — a DatabaseSession<"async"> over one PGlite instance (or
//     a transaction on it). The root session routes every statement through
//     the PGliteConnectionGate; a transaction session calls its Transaction
//     object directly (it already holds the connection).
//   PGliteAdapter — PGliteSession plus the adapter-only surface: init,
//     syncSchema, listTables/listColumns, withMigrationLock, backup/restore,
//     close. It owns the PGlite instance (in a mutable holder shared with
//     its sessions) and a process lockfile for persistent dataDirs.
//
// All PGlite behaviour here is probe-verified against
// @electric-sql/pglite@0.6.0 (see ~/workspace/scratch/pglite-probe-results.md):
// - `new PGlite(dataDir?, options?)` + `await pg.waitReady` — waitReady is a
//   Promise PROPERTY, not a method. `PGlite.create(...)` exists but is unused.
// - `pg.query(sql, params)` with $1 placeholders; `pg.exec(sql)` runs
//   multi-statement DDL. `pg.transaction(cb)` exists; the callback receives
//   a Transaction with { query, sql, exec, rollback, listen, closed } and no
//   nested transaction() — nested work uses SAVEPOINT SQL.
// - `dumpDataDir("gzip")` returns a File|Blob; `loadDataDir` does NOT exist
//   as a method — restore is a CONSTRUCTOR OPTION.
// - INT8 comes back as a number when safe, BigInt when not; TIMESTAMPTZ as
//   a Date. No custom parsers are needed.
// - Errors carry `code` = Postgres SQLSTATE; `e.name` prints "error".
//   Error mapping reads `code`, never `name`.
// - PGlite is single-connection: pool.min > 1 is refused at construction,
//   pool.max is clamped to 1, and every statement is serialized through
//   PGliteConnectionGate (see ./pglite_gate).

import fs from "node:fs";
import path from "node:path";
import { PGlite, type Transaction as PgTransaction } from "@electric-sql/pglite";
import { YattaError } from "../errors";
import type { ColumnDefinition, DatabaseSchema, TableSchema } from "../schema";
import type { WhereClause } from "../query";
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
  PgliteAdapterOptions,
  QueryResult,
  TransactionOptions,
} from "../adapter";
import { PGliteConnectionGate } from "./pglite_gate";
import {
  postgresDialect,
  PostgresDialect,
  PGLITE_SEARCH_VECTOR_COLUMN,
  searchVectorExpression,
} from "./postgres_dialect";

/** Capabilities of the PGlite adapter (Postgres, single connection). */
export const PGLITE_CAPABILITIES: AdapterCapabilities = {
  mode: "async",
  // Relations are batched separate queries, never JOINs.
  joins: false,
  foreignKeys: true,
  acidTransactions: true,
  // Nested transactions are SAVEPOINTs on the one connection.
  savepoints: true,
  returningClause: true,
  // Real tsvector + GIN, with an ILIKE fallback for undeclared tables.
  fullTextSearch: "pg_fts",
  vectors: "none",
  backupRestore: "pglite-tar",
  multiProcessSafe: false,
  maxBindParams: 65535,
};

/**
 * Advisory-lock key for migrations (prose §3.5 of the design; the sketch's
 * 79617474 was rejected in favour of this value at Step 0). One key, one
 * migration at a time, per database.
 */
export const YATTA_MIGRATION_LOCK_KEY = 727001;

/** Extra column selected by the ILIKE-fallback search; stripped before the row is returned. */
const YATTA_SEARCH_MATCHES_COLUMN = "__yatta_matches";

/** One shared compiler over the Postgres dialect (stateless). */
const pgCompiler = new SqlCompiler(postgresDialect);
/** The shared dialect, typed as its class so the Postgres-only search helpers are visible. */
const pgDialect = postgresDialect as PostgresDialect;

/** The PGlite instance, shared by the adapter and every session it spawns. */
interface PgHolder {
  pg: PGlite | null;
  /** In-flight (or completed) initialization; sessions await it in ensureReady. */
  initPromise?: Promise<void>;
  /** Lazily (re)initializes the instance; set by the adapter after construction. */
  ensureInit?: () => Promise<void>;
}

/** Root executor: every statement goes through the FIFO gate (and fails fast inside a transaction). */
function makeRootExecutor(gate: PGliteConnectionGate, holder: PgHolder): PgExecutor {
  const pgOrThrow = (): PGlite => {
    if (!holder.pg) throw new YattaError("PGlite adapter is not initialized");
    return holder.pg;
  };
  return {
    query: async (sql, params) =>
      gate.runExclusive(async () => {
        const res = await pgOrThrow().query(sql, params ?? []);
        return {
          rows: res.rows as Record<string, unknown>[],
          affectedRows: res.affectedRows ?? res.rowCount ?? 0,
        };
      }),
    exec: async (sql) => {
      await gate.runExclusive(async () => {
        await pgOrThrow().exec(sql);
      });
    },
  };
}

/** Transaction executor: the Transaction object already holds the connection — no gate. */
function makeTxExecutor(pgTx: PgTransaction): PgExecutor {
  return {
    query: async (sql, params) => {
      const res = await pgTx.query(sql, params ?? []);
      return {
        rows: res.rows as Record<string, unknown>[],
        affectedRows: res.affectedRows ?? res.rowCount ?? 0,
      };
    },
    exec: async (sql) => {
      await pgTx.exec(sql);
    },
  };
}

/** The two ways a session reaches Postgres: through the gate (root) or straight at a transaction (tx). */
interface PgExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
  exec(sql: string): Promise<void>;
}

/** Resolves a dataDir to an absolute path, or undefined for an in-memory database. */
function resolvePGliteDataDir(dataDir: string | undefined): string | undefined {
  if (dataDir === undefined) return undefined;
  const resolved = path.resolve(dataDir);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new YattaError(`PGlite dataDir is a file, not a directory: ${resolved}`);
  }
  return resolved;
}

/** Maps a PGlite/Postgres error onto a YattaError, keyed by SQLSTATE code (never `name` — it prints "error"). */
function wrapPgError(err: unknown, sql?: string): YattaError {
  if (err instanceof YattaError) return err;
  const code = (err as { code?: unknown })?.code;
  const message = (err as Error)?.message ?? String(err);
  return new YattaError(
    typeof code === "string" && code !== "" ? `[${code}] ${message}` : message,
    sql,
  );
}

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

/** Creates the process lockfile inside a persistent dataDir; throws when another process holds it. */
function acquireProcessLock(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".yatta.lock");
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      let owner = "unknown";
      try {
        owner = fs.readFileSync(lockPath, "utf8").trim() || "unknown";
      } catch {
        // Unreadable lock: the message stands without a pid.
      }
      throw new YattaError(
        `PGlite dataDir is already in use by another process (lock held by pid ${owner}): ${dataDir}`,
      );
    }
    throw err;
  }
  return lockPath;
}

/**
 * Renders one token as a tsquery lexeme. Tokens come from tokenizeText
 * ([Unicode letters and digits]); a plain [a-z0-9_]+ token is a safe bare
 * lexeme, anything else is single-quoted (a tsquery string is one lexeme).
 */
function tsLexeme(token: string): string {
  return /^[a-z0-9_]+$/.test(token) ? token : `'${token.replace(/'/g, "''")}'`;
}

/**
 * Builds a tsquery string from the core's synonym-expanded groups:
 * alternatives are ORed within a group, tokens of one alternative are
 * adjacent (<->), groups are ANDed. Returned as one string, passed as a
 * single $1 parameter to to_tsquery('simple', $1).
 */
function buildTsquery(expandedGroups: string[][][]): string {
  const groups: string[] = [];
  for (const group of expandedGroups) {
    const alternatives: string[] = [];
    for (const phrase of group) {
      if (phrase.length === 0) continue;
      alternatives.push(
        phrase.length === 1 ? tsLexeme(phrase[0]!) : phrase.map(tsLexeme).join(" <-> "),
      );
    }
    if (alternatives.length === 0) continue;
    groups.push(alternatives.length > 1 ? `(${alternatives.join(" | ")})` : alternatives[0]!);
  }
  return groups.join(" & ");
}

/**
 * Orders tables so a CREATE TABLE never references a table that does not
 * exist yet (Postgres rejects forward references; SQLite tolerates them).
 * Self-references are ignored; a cycle falls back to declaration order for
 * the tables in it.
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
 * column, moves the identity sequence past the largest id in the table.
 * Postgres sequences do not follow explicit inserts on their own (SQLite's
 * AUTOINCREMENT does); without this, the next auto id collides with the
 * explicit one. Runs on the same session, so it is transactional.
 */
async function syncIdentityIfExplicitPk(
  session: DatabaseSession<"async">,
  table: string,
  schema: TableSchema,
  row: Record<string, unknown>,
): Promise<void> {
  const q = postgresDialect.quoteIdent;
  for (const [colName, builder] of Object.entries(schema)) {
    if (!builder.def.autoIncrement) continue;
    if (row[colName] === undefined) continue;
    await session.executeRaw(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT MAX(${q(colName)}) FROM ${q(table)}), 1), 1));`,
      [table, colName],
    );
  }
}

// ── PGliteSession ──────────────────────────────────────────────────────────

/**
 * One PGlite session: the root session (via the gate) or one transaction
 * (via its Transaction object). The adapter IS the root session.
 */
export class PGliteSession implements DatabaseSession<"async"> {
  readonly driver = "pglite" as const;
  readonly capabilities = PGLITE_CAPABILITIES;
  readonly dialect = postgresDialect;
  readonly compiler = pgCompiler;

  constructor(
    protected readonly gate: PGliteConnectionGate,
    protected readonly holder: PgHolder,
    private readonly executor: PgExecutor,
    private readonly inTx: boolean,
    private readonly debug: boolean = false,
  ) {}

  get inTransaction(): boolean {
    return this.inTx || this.gate.activeTransaction !== undefined;
  }

  /**
   * Decodes one row like the compiler, then strips the generated search
   * column: SELECT * returns it (it is a real column on the table), but
   * it is an index, not data — callers must never see it.
   */
  private decodeRow(
    columns: Map<string, ColumnDefinition>,
    row: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const decoded = this.compiler.decodeRow(columns, row) as Record<string, unknown>;
    if (decoded && typeof decoded === "object") {
      delete decoded[PGLITE_SEARCH_VECTOR_COLUMN];
    }
    return decoded;
  }

  /** No-op on a plain session; the adapter awaits its init promise. */
  protected async ensureReady(): Promise<void> {
    if (this.holder.pg) return;
    if (this.holder.ensureInit) {
      await this.holder.ensureInit();
      return;
    }
    if (this.holder.initPromise) await this.holder.initPromise;
  }

  async run(
    sql: string,
    params: unknown[] = [],
    mode: "all" | "get" | "run" = "all",
  ): Promise<unknown> {
    await this.ensureReady();
    const start = this.debug ? performance.now() : 0;
    try {
      const res = await this.executor.query(sql, params);
      if (mode === "get") return res.rows[0] ?? null;
      if (mode === "all") return res.rows;
      // Postgres has no rowid: lastInsertRowid is always 0; read ids back
      // with RETURNING (the compiler emits it for inserts/updates).
      return { lastInsertRowid: 0, changes: res.affectedRows ?? 0 };
    } catch (err) {
      throw wrapPgError(err, sql);
    } finally {
      if (this.debug) {
        console.log(
          `[yatta-db] ${(performance.now() - start).toFixed(2)}ms  ${sql}`,
          params.length ? params : "",
        );
      }
    }
  }

  async executeRaw(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const head = sql.trimStart().toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("VALUES") ||
      head.startsWith("EXPLAIN") ||
      head.startsWith("SHOW") ||
      /RETURNING\b/i.test(sql);
    if (isRead) {
      const rows = (await this.run(sql, params, "all")) as Record<string, unknown>[];
      return { rows, affectedRows: rows.length };
    }
    const res = (await this.run(sql, params, "run")) as { changes: number };
    return { rows: [], affectedRows: res.changes };
  }

  async executeBatch(sql: string): Promise<void> {
    await this.ensureReady();
    try {
      await this.executor.exec(sql);
    } catch (err) {
      throw wrapPgError(err, sql);
    }
  }

  async insert(
    table: string,
    schema: TableSchema,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), row);
    const inserted = (await this.run(sql, params, "get")) as Record<string, unknown> | null;
    await syncIdentityIfExplicitPk(this, table, schema, row);
    return this.decodeRow(columnsOf(schema), inserted);
  }

  async insertMany(
    table: string,
    schema: TableSchema,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    // One transaction, one insert at a time: the driver is single-connection
    // and PGlite transaction concurrency is unverified — never Promise.all.
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
    return rows.map((r) => this.decodeRow(columnsOf(schema), r));
  }

  async count(
    table: string,
    schema: TableSchema,
    where?: WhereClause<any>,
  ): Promise<number> {
    const { sql, params } = this.compiler.compileCount(table, columnsOf(schema), where);
    const row = (await this.run(sql, params, "get")) as { count: unknown } | null;
    // COUNT(*) is BIGINT on Postgres; decodeValue turns a safe BigInt into a
    // number and throws past MAX_SAFE_INTEGER.
    return this.dialect.decodeValue(row?.count ?? 0, undefined) as number;
  }

  async update(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    if (Object.keys(patch).length === 0) return [];
    const { sql, params } = this.compiler.compileUpdate(
      table,
      columnsOf(schema),
      patch,
      where,
      { returning: true },
    );
    const rows = (await this.run(sql, params, "all")) as Record<string, unknown>[];
    return rows.map((r) => this.decodeRow(columnsOf(schema), r));
  }

  async delete(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
  ): Promise<number> {
    const { sql, params } = this.compiler.compileDelete(table, columnsOf(schema), where);
    const res = (await this.run(sql, params, "run")) as { changes: number };
    return res.changes;
  }

  async upsert(
    table: string,
    schema: TableSchema,
    plan: CompiledUpsertPlan,
  ): Promise<Record<string, unknown>> {
    // compileUpsert returns null for Postgres (as for SQLite): the
    // transactional find-first-then-update/insert fallback is the behaviour.
    // All work runs on the tx session, so a nested upsert uses a SAVEPOINT.
    return this.transaction(async (tx) => {
      const existing = await tx.find(table, schema, { where: plan.where, take: 1 });
      if (existing.length > 0) {
        const pkCol = pkColumnName(schema) ?? "id";
        const pk = (existing[0] as Record<string, unknown>)[pkCol];
        if (Object.keys(plan.updateRow).length === 0) return existing[0]!;
        const { sql, params } = this.compiler.compileUpdate(
          table,
          columnsOf(schema),
          plan.updateRow,
          { [pkCol]: pk } as WhereClause<any>,
          { returning: true },
        );
        const updated = (await tx.run(sql, params, "get")) as Record<string, unknown> | null;
        return this.decodeRow(columnsOf(schema), updated);
      }
      const { sql, params } = this.compiler.compileInsert(table, columnsOf(schema), plan.createRow);
      const inserted = (await tx.run(sql, params, "get")) as Record<string, unknown> | null;
      await syncIdentityIfExplicitPk(tx, table, schema, plan.createRow);
      return this.decodeRow(columnsOf(schema), inserted);
    });
  }

  // ── Full-text search ─────────────────────────────────────────────────────
  //
  // Postgres tsvector, not FTS5: a generated `__yatta_tsv` column (kept in
  // sync by Postgres on every write) plus a GIN index, created by
  // syncSchema and repaired by ensureSearchIndex. Rank is -ts_rank, so
  // smaller-is-better like FTS5's bm25. When a table has no searchable
  // columns, search falls back to ILIKE across its TEXT columns instead
  // of throwing — the generated column cannot exist without one.

  async search(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
  ): Promise<Array<{ row: Record<string, unknown>; rank: number }>> {
    const cols = searchableColumns(schema);
    const pkCol = pkColumnName(schema);
    if (pkCol === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so search cannot map index entries back to rows. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
    if (query.expandedGroups.length === 0 && query.tokens.length === 0) return [];

    // Column restriction is validated against the columns actually searched.
    const searchedCols = cols.length > 0 ? cols : this.textColumns(schema);
    const restricted = query.columns.length > 0 ? query.columns : null;
    if (restricted) {
      for (const c of restricted) {
        if (!searchedCols.includes(c)) {
          throw new YattaError(
            `Column "${c}" on table "${table}" is not searchable. ` +
              `Searchable columns: ${searchedCols.join(", ")}. ` +
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

    if (cols.length === 0) {
      if (searchedCols.length === 0) {
        throw new YattaError(
          `Table "${table}" has no searchable columns. ` +
            `Mark a text column with .searchable() to make the table searchable.`,
        );
      }
      return this.searchIlike(table, schema, query, pkCol, searchedCols);
    }

    try {
      return await this.searchTsvector(table, schema, query, pkCol, restricted);
    } catch (err) {
      // The generated column is gone (table created outside syncSchema and
      // the repair raced it, or the column was dropped by hand): fall back
      // to ILIKE rather than failing a read. Any other error propagates.
      const code = (err as { code?: unknown })?.code;
      const message = String((err as Error)?.message ?? err);
      if (code === "42703" || /__yatta_tsv/.test(message)) {
        return this.searchIlike(table, schema, query, pkCol, cols);
      }
      throw err;
    }
  }

  /** TEXT columns (col.text/string/uuid/date map to TEXT) for the ILIKE fallback. */
  private textColumns(schema: TableSchema): string[] {
    return Object.entries(schema)
      .filter(([, builder]) => builder.def.type === "TEXT" && !builder.def.isJson && !builder.def.isBoolean)
      .map(([colName]) => colName);
  }

  /** Shared tail of both search paths: map pk+rank hits back to rows, in hit order, honouring query.where. */
  private async mapSearchHits(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
    pkCol: string,
    hits: Array<{ pk: unknown; rank: number }>,
  ): Promise<Array<{ row: Record<string, unknown>; rank: number }>> {
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
    const pkFilter = { [pkCol]: { in: pks } } as WhereClause<any>;
    const where =
      query.where && Object.keys(query.where).length > 0
        ? ({ AND: [query.where, pkFilter] } as WhereClause<any>)
        : pkFilter;
    const rows = await this.find(table, schema, { where });
    const byPk = new Map(rows.map((r) => [String((r as Record<string, unknown>)[pkCol]), r]));
    const out: Array<{ row: Record<string, unknown>; rank: number }> = [];
    for (const h of hits) {
      const row = byPk.get(String(h.pk));
      if (row) out.push({ row, rank: h.rank });
    }
    return out;
  }

  private async searchTsvector(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
    pkCol: string,
    restricted: string[] | null,
  ): Promise<Array<{ row: Record<string, unknown>; rank: number }>> {
    // Creates (or repairs) the index on first use, so a table opened with
    // autoMigrate off, or a database file copied in from elsewhere, still
    // searches correctly instead of failing on a missing column.
    await this.ensureSearchIndex(table, schema);
    const tsquery = buildTsquery(query.expandedGroups);
    if (tsquery === "") return [];
    const q = postgresDialect.quoteIdent;
    const vectorExpr = restricted
      ? searchVectorExpression(restricted)
      : `"${PGLITE_SEARCH_VECTOR_COLUMN}"`;
    const limitOffset = postgresDialect.compileLimitOffset(query.limit, query.offset);
    const sql = [
      `SELECT ${q(pkCol)} AS pk, -ts_rank(${vectorExpr}, to_tsquery('simple', $1)) AS rank FROM ${q(table)}`,
      `WHERE ${vectorExpr} @@ to_tsquery('simple', $1) ORDER BY rank ASC`,
      limitOffset,
    ]
      .filter(Boolean)
      .join(" ")
      .concat(";");
    const hits = (await this.run(sql, [tsquery], "all")) as Array<{ pk: unknown; rank: number }>;
    return this.mapSearchHits(table, schema, query, pkCol, hits);
  }

  private async searchIlike(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
    pkCol: string,
    cols: string[],
  ): Promise<Array<{ row: Record<string, unknown>; rank: number }>> {
    const tokens = query.tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const q = postgresDialect.quoteIdent;
    // One bound parameter per token; Postgres allows the same $n to appear
    // many times, so the WHERE and the rank expression share them.
    const whereParts = tokens.map((_, i) => {
      const ph = `$${i + 1}`;
      return `(${cols.map((c) => `${q(c)} ILIKE ${ph} ESCAPE '\\'`).join(" OR ")})`;
    });
    const rankTerms: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      for (const c of cols) {
        rankTerms.push(`(CASE WHEN ${q(c)} ILIKE $${i + 1} ESCAPE '\\' THEN 1 ELSE 0 END)`);
      }
    }
    const limitOffset = postgresDialect.compileLimitOffset(query.limit, query.offset);
    const sql = [
      `SELECT ${q(pkCol)} AS pk, -(${rankTerms.join(" + ")}) AS rank FROM ${q(table)}`,
      `WHERE ${whereParts.join(" AND ")} ORDER BY rank ASC, ${q(pkCol)} ASC`,
      limitOffset,
    ]
      .filter(Boolean)
      .join(" ")
      .concat(";");
    const params = tokens.map((t) => `%${escapeLike(t)}%`);
    const hits = (await this.run(sql, params, "all")) as Array<{ pk: unknown; rank: number }>;
    return this.mapSearchHits(table, schema, query, pkCol, hits);
  }

  /**
   * The generated tsvector column maintains itself on every write, so
   * there is nothing to sync per row — insert/update/delete need no
   * index maintenance here. This is a deliberate no-op, not a stub:
   * the column is kept in sync by Postgres, and search() repairs it
   * when a table was created outside syncSchema.
   */
  async syncSearchRow(
    _table: string,
    _schema: TableSchema,
    _row: Record<string, unknown>,
    _op: "insert" | "update" | "delete",
  ): Promise<void> {}

  /** Rebuilds one table's search vector from its current rows (drop + re-add the generated column, then the GIN index). */
  async rebuildSearchIndex(table: string, schema: TableSchema): Promise<void> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) {
      throw new YattaError(
        `Table "${table}" has no searchable columns, so there is no search index to rebuild. ` +
          `Mark a text column with .searchable() first.`,
      );
    }
    if (pkColumnName(schema) === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so its search index cannot be rebuilt. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
    const exists = (await this.run(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1;`,
      [table],
      "get",
    )) as { ok: number } | null;
    if (!exists) {
      throw new YattaError(`Table "${table}" does not exist in this database, so its search index cannot be rebuilt.`);
    }
    const q = postgresDialect.quoteIdent;
    const sql = [
      `ALTER TABLE ${q(table)} DROP COLUMN IF EXISTS "${PGLITE_SEARCH_VECTOR_COLUMN}";`,
      `ALTER TABLE ${q(table)} ADD COLUMN "${PGLITE_SEARCH_VECTOR_COLUMN}" tsvector GENERATED ALWAYS AS (${searchVectorExpression(cols)}) STORED;`,
      pgDialect.compileSearchIndexSql(table),
    ].join(" ");
    await this.executeBatch(sql);
  }

  /** The indexed vocabulary for a table: distinct tokens scanned from its searchable values (used for typo correction). */
  async searchVocabulary(table: string, schema: TableSchema): Promise<Set<string>> {
    const cols = searchableColumns(schema);
    const terms = new Set<string>();
    if (cols.length === 0) return terms;
    const colSql = cols.map((c) => postgresDialect.quoteIdent(c)).join(", ");
    const rows = (await this.run(
      `SELECT ${colSql} FROM ${postgresDialect.quoteIdent(table)};`,
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

  /**
   * Makes sure one table's search vector exists and matches its
   * searchable columns. Called by search() so a first search never fails
   * on a missing column. Idempotent: ADD COLUMN IF NOT EXISTS + CREATE
   * INDEX IF NOT EXISTS. A column whose expression no longer matches
   * (searchable columns changed) is not rewritten here — use
   * rebuildSearchIndex for that.
   */
  async ensureSearchIndex(table: string, schema: TableSchema): Promise<void> {
    const cols = searchableColumns(schema);
    if (cols.length === 0) return;
    if (pkColumnName(schema) === null) {
      throw new YattaError(
        `Table "${table}" has no primary key column, so search cannot map index entries back to rows. ` +
          `Add col.id() or col.uuid() to search it.`,
      );
    }
    const exists = (await this.run(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1;`,
      [table],
      "get",
    )) as { ok: number } | null;
    if (!exists) {
      throw new YattaError(
        `Table "${table}" does not exist in this database, so it cannot be searched. ` +
          `Create it first (a schema with autoMigrate creates tables on open).`,
      );
    }
    for (const stmt of pgDialect.compileSearchRepairStatements(table, schema)) {
      await this.executeBatch(stmt);
    }
  }

  /** Finalizes and purges cached prepared statements. PGlite keeps none — a no-op. */
  clearStatementCache(): void {}

  // ── Transactions ─────────────────────────────────────────────────────────

  /**
   * Runs fn inside a transaction on the one connection. Root calls go
   * through the gate's pg.transaction(); nested calls use SAVEPOINTs on
   * the active transaction (the gate detects ALS re-entrancy). A root
   * query inside fn throws immediately via the gate instead of
   * deadlocking behind itself.
   */
  async transaction<R>(
    fn: (txSession: DatabaseSession<"async">) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    await this.ensureReady();
    const pg = this.holder.pg;
    if (!pg) throw new YattaError("PGlite adapter is not initialized");
    return this.gate.runTransaction(pg, async (txState) => {
      const txSession = new PGliteSession(
        this.gate,
        this.holder,
        makeTxExecutor(txState.pgTx),
        true,
        this.debug,
      );
      if (options?.isolationLevel) {
        const levels: Record<string, string> = {
          "read committed": "READ COMMITTED",
          "repeatable read": "REPEATABLE READ",
          serializable: "SERIALIZABLE",
        };
        const level = levels[options.isolationLevel];
        if (level) await txSession.executeRaw(`SET TRANSACTION ISOLATION LEVEL ${level};`);
      }
      return fn(txSession);
    });
  }
}

// ── PGliteAdapter ──────────────────────────────────────────────────────────

/**
 * The PGlite adapter: the root session plus the connection-level
 * operations (init, schema sync, migration lock, backup/restore, close).
 * The root adapter IS the root session — it extends PGliteSession and
 * routes every statement through the gate.
 */
export class PGliteAdapter extends PGliteSession implements DatabaseAdapter<"async"> {
  override readonly driver = "pglite" as const;
  /** Resolved data directory, or ":memory:" for an in-memory database. */
  readonly path: string;

  private readonly dataDir: string | undefined;
  private readonly acquireTimeoutMs: number;
  private lockPath: string | undefined;

  constructor(options: PgliteAdapterOptions = {}) {
    if (options.pool?.min !== undefined && options.pool.min > 1) {
      throw new YattaError(
        `PGlite is single-connection: pool.min ${options.pool.min} is impossible. ` +
          `Use pool.min 1 (or omit pool) — pool.max is clamped to 1.`,
      );
    }
    // pool.max is clamped to 1 (PGlite holds exactly one connection);
    // the value is recorded, not enforced anywhere else, because there
    // is no pool to configure.
    void (options.pool?.max !== undefined ? Math.min(options.pool.max, 1) : 1);
    const dataDir = resolvePGliteDataDir(options.dataDir);
    const gate = new PGliteConnectionGate(options.acquireTimeoutMs ?? 30_000);
    const holder: PgHolder = { pg: null };
    super(gate, holder, makeRootExecutor(gate, holder), false, options.debug ?? false);
    this.dataDir = dataDir;
    this.path = dataDir ?? ":memory:";
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    void this.acquireTimeoutMs;
    // Sessions created from this adapter lazily initialize through here.
    holder.ensureInit = () => this.initialize();
  }

  /** Lazily creates the PGlite instance (once, shared by concurrent callers). */
  private async initialize(): Promise<void> {
    if (this.holder.pg) return;
    if (this.holder.initPromise) return this.holder.initPromise;
    this.holder.initPromise = this.doInitialize();
    try {
      await this.holder.initPromise;
    } catch (err) {
      this.holder.initPromise = undefined;
      throw err;
    }
  }

  private async doInitialize(): Promise<void> {
    if (this.dataDir) this.lockPath = acquireProcessLock(this.dataDir);
    try {
      const pg = this.dataDir ? new PGlite(this.dataDir) : new PGlite();
      await pg.waitReady;
      await pg.query("SELECT 1");
      this.holder.pg = pg;
    } catch (err) {
      if (this.lockPath) {
        try { fs.unlinkSync(this.lockPath); } catch {}
        this.lockPath = undefined;
      }
      throw wrapPgError(err);
    }
  }

  /** Eagerly wait for initialization (lazy on first use otherwise). */
  async ready(): Promise<void> {
    await this.initialize();
  }

  /**
   * Applies a declarative schema in topological order (Postgres rejects
   * forward references; SQLite tolerates them), inside one transaction
   * so DDL is atomic. Missing columns are added with ALTER TABLE —
   * Postgres fills existing rows from the DEFAULT expression, so no
   * table rebuild is needed for expression defaults.
   */
  async syncSchema(schema: DatabaseSchema): Promise<void> {
    await this.ensureReady();
    await this.transaction(async (tx) => {
      await tx.executeBatch(
        `CREATE TABLE IF NOT EXISTS "_yatta_migrations" (` +
          `"id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, ` +
          `"name" TEXT UNIQUE, "hash" TEXT, ` +
          `"applied_at" TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));`,
      );
      for (const tableName of topologicalSortTables(schema)) {
        const tableDef = schema[tableName]!;
        const timeSeriesCols = Object.entries(tableDef)
          .filter(([, b]) => b.def.isTimeSeries)
          .map(([n]) => n);
        if (timeSeriesCols.length > 1) {
          throw new YattaError(
            `Table "${tableName}" marks more than one time-series column (${timeSeriesCols.join(", ")}). ` +
              `Mark exactly one timestamp column per table with .timeSeries().`,
          );
        }
        const [createSql, ...createIndexes] = postgresDialect.compileCreateTableStatements(tableName, tableDef);
        await tx.executeBatch(createSql);
        const existing = (await tx.run(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1;`,
          [tableName],
          "all",
        )) as Array<{ column_name: string }>;
        const existingNames = new Set(existing.map((r) => r.column_name));
        const indexSqls: string[] = [...createIndexes];
        const indexedCols = new Set<string>();
        for (const [colName, colBuilder] of Object.entries(tableDef)) {
          if (existingNames.has(colName)) continue;
          const def = colBuilder.def;
          const fragment = postgresDialect.compileColumnFragment(colName, def, "alter");
          await tx.executeBatch(postgresDialect.compileAddColumnSql(tableName, fragment));
          if (def.unique) {
            indexSqls.push(postgresDialect.compileIndexSql(tableName, colName, "unique"));
          }
          if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
            indexedCols.add(colName);
            indexSqls.push(postgresDialect.compileIndexSql(tableName, colName, "plain"));
          }
          if (def.isTimeSeries && !def.isIndex && !indexedCols.has(colName)) {
            indexedCols.add(colName);
            indexSqls.push(postgresDialect.compileIndexSql(tableName, colName, "timeseries"));
          }
        }
        for (const idx of indexSqls) await tx.executeBatch(idx);
        // A keyless table cannot be searched (no key to map hits back
        // to rows), so sync skips it instead of crashing schema setup.
        // Search refuses it plainly when actually attempted.
        if (searchableColumns(tableDef).length > 0 && pkColumnName(tableDef) !== null) {
          await tx.ensureSearchIndex(tableName, tableDef);
        }
      }
    });
  }

  /** User tables (internal tables — the migration log — are excluded). */
  async listTables(): Promise<string[]> {
    const rows = (await this.run(
      `SELECT table_name AS name FROM information_schema.tables ` +
        `WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ` +
        `AND table_name <> '_yatta_migrations' ORDER BY table_name;`,
      [],
      "all",
    )) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async listColumns(table: string): Promise<IntrospectedColumn[]> {
    const rows = (await this.run(
      `SELECT c.column_name AS name, c.data_type AS type, ` +
        `CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END AS nullable, ` +
        `EXISTS (SELECT 1 FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema ` +
        `WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = c.table_name ` +
        `AND kcu.column_name = c.column_name) AS "primaryKey" ` +
        `FROM information_schema.columns c ` +
        `WHERE c.table_schema = 'public' AND c.table_name = $1 ORDER BY c.ordinal_position;`,
      [table],
      "all",
    )) as Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      primaryKey: r.primaryKey,
    }));
  }

  /**
   * Exclusive lock across migrations: SELECT pg_advisory_xact_lock(727001)
   * inside the migration transaction (released at COMMIT/ROLLBACK). If
   * already inside a transaction, fn runs in it — the lock cannot be
   * taken twice on the same connection.
   */
  async withMigrationLock<R>(
    fn: (session: DatabaseSession<"async">) => Promise<R>,
  ): Promise<R> {
    await this.ensureReady();
    if (this.inTransaction) return fn(this);
    return this.transaction(async (tx) => {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(${YATTA_MIGRATION_LOCK_KEY});`);
      return fn(tx);
    });
  }

  /**
   * Online backup: CHECKPOINT, then dumpDataDir("gzip") to a temp file
   * renamed into place.
   */
  async backup(destPath: string): Promise<void> {
    await this.ensureReady();
    const parentDir = path.dirname(destPath);
    if (parentDir && parentDir !== "." && !fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const tempPath = `${destPath}.tmp.${Date.now()}`;
    try {
      await this.executeRaw("CHECKPOINT");
      const blob = await this.gate.runExclusive(async () => {
        const pg = this.holder.pg;
        if (!pg) throw new YattaError("PGlite adapter is not initialized");
        return pg.dumpDataDir("gzip");
      });
      fs.writeFileSync(tempPath, Buffer.from(await blob.arrayBuffer()));
      fs.renameSync(tempPath, destPath);
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      if (err instanceof YattaError) throw err;
      throw wrapPgError(err);
    }
  }

  /**
   * Restores from a backup file: the file is probed first in a throwaway
   * in-memory PGlite (loadDataDir constructor option) and must hold at
   * least one table; then the live instance is closed, the persistent
   * dataDir (if any) is emptied, and a fresh instance is opened with
   * loadDataDir. An empty or missing file is refused before anything
   * is touched.
   */
  async restore(sourcePath: string): Promise<void> {
    if (!fs.existsSync(sourcePath)) {
      throw new YattaError(`Backup file not found: ${sourcePath}`);
    }
    const buf = fs.readFileSync(sourcePath);
    if (buf.length === 0) {
      throw new YattaError("Invalid or corrupt backup file: backup file is empty");
    }
    const blob = new Blob([buf]);
    let probe: PGlite | null = null;
    try {
      probe = await PGlite.create({ loadDataDir: blob });
      await probe.waitReady;
      const tables = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`,
      );
      if (tables.rows.length === 0) {
        throw new YattaError("Invalid or corrupt backup file: backup holds no tables");
      }
    } catch (err) {
      if (err instanceof YattaError) throw err;
      throw new YattaError(
        `Invalid or corrupt backup file: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      if (probe) {
        try { await probe.close(); } catch {}
      }
    }

    await this.close();
    if (this.dataDir) {
      try { fs.rmSync(this.dataDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.lockPath = acquireProcessLock(this.dataDir);
    }
    try {
      const pg = this.dataDir
        ? new PGlite(this.dataDir, { loadDataDir: blob })
        : new PGlite({ loadDataDir: blob });
      await pg.waitReady;
      this.holder.pg = pg;
      this.holder.initPromise = Promise.resolve();
    } catch (err) {
      if (this.lockPath) {
        try { fs.unlinkSync(this.lockPath); } catch {}
        this.lockPath = undefined;
      }
      this.holder.pg = null;
      this.holder.initPromise = undefined;
      throw wrapPgError(err);
    }
  }

  /** Closes the PGlite instance and removes the process lockfile. */
  async close(): Promise<void> {
    const pg = this.holder.pg;
    this.holder.pg = null;
    this.holder.initPromise = undefined;
    if (pg) {
      try { await pg.close(); } catch {}
    }
    if (this.lockPath) {
      try { fs.unlinkSync(this.lockPath); } catch {}
      this.lockPath = undefined;
    }
  }
}
