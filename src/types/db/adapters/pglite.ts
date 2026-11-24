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
import { PGlite } from "@electric-sql/pglite";
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
  backupRestore: "dump",
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

/** The PGlite instance, shared by the adapter and every session it spawns. */
interface PgHolder {
  pg: PGlite | null;
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

  /** No-op on a plain session; the adapter awaits its init promise. */
  protected async ensureReady(): Promise<void> {}

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
    return this.compiler.decodeRow(columnsOf(schema), inserted);
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
    return rows.map((r) => this.compiler.decodeRow(columnsOf(schema), r));
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
    return this.compiler.decodeValue(row?.count ?? 0, undefined) as number;
  }
