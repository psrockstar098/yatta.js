// SqlDialect: the per-driver SQL surface.
//
// Phase 1 of the multi-database ORM refactor. The core (SqlCompiler,
// Table, YattaDB) never writes driver SQL directly: every identifier,
// placeholder, type, default, DDL fragment, LIKE predicate, and value
// conversion goes through the dialect for the active driver. SQLite is
// the reference implementation (adapters/sqlite_dialect.ts); PGlite
// implements the same interface in Phase 2.
//
// Shape: f2 from the Gemini multi-db design (see
// ~/workspace/yatta-106-gemini-multidb-findings.md), with three additions
// the real code needs and f2 does not declare:
//   - compileColumnFragment / compileCreateTableSql / compileAddColumnSql /
//     compileIndexSql: the granular DDL pieces syncSchema needs for its
//     ALTER-TABLE path (f2 only has the whole-table
//     compileCreateTableStatements, which the CREATE path uses).
//   - compileLikePredicate takes an `escape` flag: the real buildWhere
//     emits plain `LIKE ?` for op.like and `LIKE ? ESCAPE '\'` for
//     contains/startsWith/endsWith. One method cannot express both.
//   - compileOrderNulls returns the suffix to append after ASC/DESC
//     ("" for SQLite, which emits nothing — byte-identical current SQL;
//     " NULLS FIRST"/" NULLS LAST" for Postgres, which defaults the
//     opposite way to SQLite and must match it explicitly).
//   - compileLimitOffset owns the LIMIT/OFFSET spelling: SQLite's
//     unbounded read is `LIMIT -1`, Postgres rejects a negative LIMIT
//     and spells it `LIMIT ALL`.
//
// compileUpsert returns null when the dialect has no atomic upsert: the
// core then falls back to the transactional find-first-then-update/insert
// path, which is the current behaviour for SQLite. Both dialects return
// null in Phase 1/2; an atomic ON CONFLICT path is a later optimisation,
// not a behaviour change, and must prove itself against the fallback
// before it replaces it.

import type { ColumnDefinition, TableSchema } from "./schema";

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

/** Inputs to an atomic upsert, when a dialect implements one. */
export interface UpsertPlan {
  table: string;
  columns: Map<string, ColumnDefinition>;
  /** The `where` that identifies the conflicting row. */
  where: Record<string, unknown>;
  /** Row to insert when no row matches. */
  create: Record<string, unknown>;
  /** Changes to apply when a row matches. */
  update: Record<string, unknown>;
}

export interface SqlDialect {
  /** Driver key, as used by createAdapter / DatabaseOptions ("sqlite", "pglite"). */
  readonly name: string;
  /** Whether `INSERT ... RETURNING *` / `UPDATE ... RETURNING *` is supported. */
  readonly supportsReturning: boolean;
  /** Whether the driver's LIKE is case-insensitive by default (SQLite: ASCII yes; Postgres LIKE: no). */
  readonly likeCaseInsensitiveByDefault: boolean;

  /** Quote an identifier ("users" -> "users" with embedded quotes doubled). */
  quoteIdent(ident: string): string;
  /** Placeholder for the n-th bound parameter (1-based): "?" for SQLite, "$n" for Postgres. */
  placeholder(index1Based: number): string;

  /** Storage type for a column definition (INTEGER/TEXT/REAL/BLOB for SQLite; BIGINT/BOOLEAN/JSONB/... for Postgres). */
  mapColumnType(def: ColumnDefinition): string;
  /** SQL literal for a column's DEFAULT (including the CURRENT_TIMESTAMP expression). */
  compileColumnDefault(def: ColumnDefinition): string;
  /** One `"col" TYPE [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT ...] [REFERENCES ...] [CHECK ...]` fragment. */
  compileColumnFragment(colName: string, def: ColumnDefinition, mode: "create" | "alter"): string;
  /** `CREATE TABLE IF NOT EXISTS "t" (<fragments>);` */
  compileCreateTableSql(table: string, columnFragments: string[]): string;
  /** `ALTER TABLE "t" ADD COLUMN <fragment>;` */
  compileAddColumnSql(table: string, fragment: string): string;
  /** `CREATE [UNIQUE] INDEX IF NOT EXISTS "idx_..." ON "t" ("col");` */
  compileIndexSql(table: string, colName: string, kind: "plain" | "timeseries" | "unique"): string;
  /** Whole-table DDL for a fresh table: CREATE TABLE plus its indexes, in schema order. First element is always the CREATE TABLE statement. */
  compileCreateTableStatements(table: string, schema: TableSchema): [string, ...string[]];

  /** LIKE predicate for one column: plain `LIKE ?` (op.like) or `LIKE ? ESCAPE '\'` (contains/startsWith/endsWith). */
  compileLikePredicate(quotedCol: string, placeholder: string, escape: boolean): string;
  /** NULLS suffix to append after ASC/DESC ("" when the driver's default already matches SQLite's). */
  compileOrderNulls(dir: "ASC" | "DESC"): string;
  /**
   * LIMIT/OFFSET clause for a page. SQLite spells an unbounded read
   * `LIMIT -1`; Postgres rejects a negative LIMIT, so it spells the same
   * read `LIMIT ALL` (and allows a bare OFFSET). `take: -1` is the
   * caller's "no upper bound" and is unbounded on both.
   */
  compileLimitOffset(take: number | undefined, skip: number | undefined): string;

  /** Driver-level encoding of one bound value (boolean -> 1/0 for SQLite, identity for Postgres; JSON stringify; Date -> ISO string). */
  encodeParam(value: unknown, def?: ColumnDefinition): unknown;
  /** Driver-level decoding of one read value (0/1 -> boolean and JSON parse for SQLite; INT8 string -> number and TIMESTAMPTZ Date -> ISO string for Postgres). */
  decodeValue(value: unknown, def?: ColumnDefinition): unknown;

  /** Atomic upsert, or null to use the transactional find+update/insert fallback. */
  compileUpsert(plan: UpsertPlan): CompiledSql | null;
}
