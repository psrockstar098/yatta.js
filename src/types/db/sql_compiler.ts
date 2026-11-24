// SqlCompiler: the driver-neutral SQL compiler.
//
// Phase 1 of the multi-database ORM refactor. This is the pre-refactor
// SQL generation from Table (buildWhere, buildOrderBy, buildSetClause,
// findMany/insert/update/delete/count/exists) and YattaDB, extracted
// verbatim and parameterized by a SqlDialect. The compiler is pure: it
// takes a table name, a column map, and the query inputs, and returns
// { sql, params } — it never touches a database connection.
//
// Byte-identical contract: for the SqliteDialect, every statement this
// class produces is character-for-character the statement the old code
// produced for the same input. The tests in src/test/db.compiler.test.ts
// pin that output. If a test fails, the compiler or the dialect is
// wrong — never edit the test to match new behaviour.
//
// Placeholder numbering: Postgres uses $n placeholders, so every
// compile method takes a `startAt` (1-based) and returns `nextParam`
// (the next free number). Methods that build a whole statement thread
// one counter through their parts in parameter order — SET params
// before WHERE params in UPDATE, for example. SQLite ignores the
// numbers (its placeholder is always "?"), so numbering is free for
// the reference dialect and load-bearing for Postgres.
//
// What stays in Table (and is NOT the compiler's job):
//   - resolveAliases / touchOnUpdate / UUID generation (payload shaping)
//   - rowCount validation of take/skip/limit (error messages name the table)
//   - select-list computation (include expands it with relation FK columns)
//   - FTS5 search (Table.search; the adapter owns search in Steps 4-5)
//   - the upsert fallback (find-first-then-update/insert, in Table.upsert)
//   - the allowAll guards on update()/delete() (data-loss protection)

import { YattaError } from "./errors";
import type { ColumnDefinition } from "./schema";
import { FILTER_OPS, type OrderBy, type RuntimeFilterOps, type WhereClause } from "./query";
import type { CompiledSql, SqlDialect } from "./sql_dialect";

/** LIKE wildcards escaped so a user-typed % or _ cannot widen the match. */
export function escapeLike(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface WhereCompilation {
  clause: string;
  params: unknown[];
  nextParam: number;
}

export interface SelectOptions {
  where?: WhereClause<any>;
  orderBy?: OrderBy<any> | OrderBy<any>[];
  /** Already validated by Table.rowCount. */
  take?: number;
  /** Already validated by Table.rowCount. */
  skip?: number;
  /** undefined = `*`. A literal "*" inside the list is quoted, as before. */
  select?: string[];
}

export class SqlCompiler {
  constructor(private readonly dialect: SqlDialect) {}

  // ── Value encoding ─────────────────────────────────────────────────────

  /**
   * Shared half of the old Table.serializeValue: the undefined/null
   * handling, the NOT NULL guard, and the object rejection. The driver
   * half (boolean -> 1/0, JSON stringify, Date -> ISO string) is the
   * dialect's encodeParam, called last.
   */
  serializeValue(tableName: string, column: string, def: ColumnDefinition | undefined, v: unknown): unknown {
    if (v === undefined) return null;

    if (v === null) {
      if (def?.notNull && !def.primaryKey && !def.autoIncrement) {
        throw new YattaError(`Cannot set NULL on NOT NULL column "${column}" in table "${tableName}"`);
      }
      return null;
    }

    if (
      typeof v === "object" &&
      !(v instanceof Date) &&
      !(v instanceof Uint8Array) &&
      !(v instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(v)
    ) {
      if (def && !def.isJson) {
        throw new YattaError(
          `Cannot serialize object for column "${column}" of type ${def.type} in table "${tableName}". Use col.json() for structured data.`,
        );
      }
    }

    return this.dialect.encodeParam(v, def);
  }

  /** Driver half of the old Table.deserializeRow, applied per key. */
  decodeRow(columns: Map<string, ColumnDefinition>, row: any): any {
    if (!row) return row;
    const out: any = { ...row };
    for (const key of Object.keys(out)) {
      out[key] = this.dialect.decodeValue(out[key], columns.get(key));
    }
    return out;
  }

  // ── WHERE ──────────────────────────────────────────────────────────────

  compileWhere(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    where?: WhereClause<any>,
    startAt = 1,
  ): WhereCompilation {
    /*
     * A `where` this function cannot read must not compile to "no filter".
     *
     * `Object.keys(fn)` is `[]`, so a function filter fell through the empty-object
     * branch and every row came back. That is the same failure this function
     * already guards against for operators — "`{ status: { statuss: 'x' } }`
     * silently returned every row" — arriving through a different door.
     * Rejected rather than supported: `WhereClause` documents the object form,
     * and the callback form already has a first-class home in
     * `db.<table>.where(f => …)`.
     */
    if (where !== undefined && where !== null && (typeof where !== "object" || Array.isArray(where))) {
      throw new YattaError(
        `where for "${tableName}" must be an object filter, got ${Array.isArray(where) ? "an array" : typeof where}. ` +
          `A filter that cannot be read used to match every row. Use ` +
          `{ where: { status: "active" } }, or db.${tableName}.where((f) => f.status.isEqualTo("active")).all().`,
      );
    }

    if (!where || Object.keys(where).length === 0) return { clause: "", params: [], nextParam: startAt };

    const clauses: string[] = [];
    const params: unknown[] = [];
    let nextParam = startAt;
    const ph = () => this.dialect.placeholder(nextParam++);

    for (const [key, val] of Object.entries(where)) {
      /*
       * Validate the column before it reaches SQL.
       *
       * SQLite treats a double-quoted identifier that does not resolve to a
       * column as a *string literal*, so `{ emial: "a@b.c" }` compiled to
       * `"emial" = 'a@b.c'`, compared the literal "emial" to the value, and
       * quietly matched nothing. A typo in a filter has to be a loud error, not
       * an empty result set.
       */
      if (key !== "AND" && key !== "OR" && columns.size > 0 && !columns.has(key)) {
        const known = [...columns.keys()].join(", ");
        throw new YattaError(
          `Column "${key}" does not exist on table "${tableName}". Available: ${known}`,
        );
      }

      const safeKey = this.dialect.quoteIdent(key);

      if (key === "AND" || key === "OR") {
        if (!Array.isArray(val)) {
          throw new YattaError(`"${key}" condition must be an array of where clauses`);
        }
        if (val.length === 0) {
          clauses.push(key === "OR" ? "0 = 1" : "1 = 1");
          continue;
        }

        const nested: WhereCompilation[] = [];
        for (const w of val) {
          const compiled = this.compileWhere(tableName, columns, w, nextParam);
          nextParam = compiled.nextParam;
          if (compiled.clause !== "") nested.push(compiled);
        }
        if (nested.length === 0) {
          clauses.push(key === "OR" ? "0 = 1" : "1 = 1");
          continue;
        }

        const joiner = key === "AND" ? " AND " : " OR ";
        clauses.push(nested.length === 1 ? nested[0]!.clause : `(${nested.map((n) => n.clause).join(joiner)})`);
        nested.forEach((n) => params.push(...n.params));
        continue;
      }

      if (val === null) {
        clauses.push(`${safeKey} IS NULL`);
      } else if (
        typeof val === "object" &&
        !Array.isArray(val) &&
        !(val instanceof Date) &&
        // A Buffer is an object whose keys are "0", "1", … so treating it as a
        // set of operators produced `Unknown filter operator "0"`. Typed arrays
        // have the same shape.
        !(val instanceof Uint8Array) &&
        !(val instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(val)
      ) {
        const op = val as RuntimeFilterOps;

        /*
         * An operator this function does not recognise used to contribute
         * nothing, leaving the clause empty — so `{ status: { statuss: "x" } }`
         * silently returned every row. A filter you wrote must either apply or
         * be rejected.
         */
        for (const opKey of Object.keys(op)) {
          if (!FILTER_OPS.has(opKey)) {
            throw new YattaError(
              `Unknown filter operator "${opKey}" on "${tableName}.${key}". ` +
                `Supported: ${[...FILTER_OPS].join(", ")}`,
            );
          }
        }

        if (op.eq !== undefined) {
          if (op.eq === null) clauses.push(`${safeKey} IS NULL`);
          else { clauses.push(`${safeKey} = ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.eq)); }
        }
        if (op.neq !== undefined) {
          if (op.neq === null) clauses.push(`${safeKey} IS NOT NULL`);
          else { clauses.push(`${safeKey} != ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.neq)); }
        }

        if (op.gt !== undefined) { clauses.push(`${safeKey} > ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.gt)); }
        if (op.gte !== undefined) { clauses.push(`${safeKey} >= ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.gte)); }
        if (op.lt !== undefined) { clauses.push(`${safeKey} < ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.lt)); }
        if (op.lte !== undefined) { clauses.push(`${safeKey} <= ${ph()}`); params.push(this.serializeValue(tableName, key, columns.get(key), op.lte)); }

        if (op.like !== undefined) {
          // Goes through the dialect like contains/startsWith/endsWith do:
          // SQLite's LIKE is ASCII case-insensitive, Postgres' LIKE is not,
          // so Postgres needs ILIKE here to match. The hardcoded LIKE this
          // replaced was a Postgres-parity bug, not a SQLite behaviour.
          clauses.push(this.dialect.compileLikePredicate(safeKey, ph(), false));
          params.push(String(op.like));
        }
        if (op.contains !== undefined) {
          clauses.push(this.dialect.compileLikePredicate(safeKey, ph(), true));
          params.push(`%${escapeLike(String(op.contains))}%`);
        }
        if (op.startsWith !== undefined) {
          clauses.push(this.dialect.compileLikePredicate(safeKey, ph(), true));
          params.push(`${escapeLike(String(op.startsWith))}%`);
        }
        if (op.endsWith !== undefined) {
          clauses.push(this.dialect.compileLikePredicate(safeKey, ph(), true));
          params.push(`%${escapeLike(String(op.endsWith))}`);
        }

        if (op.isNull === true) clauses.push(`${safeKey} IS NULL`);
        if (op.isNull === false) clauses.push(`${safeKey} IS NOT NULL`);

        if (op.in !== undefined) {
          if (!Array.isArray(op.in)) throw new YattaError(`"in" filter on "${key}" must be an array`);
          if (op.in.length === 0) {
            clauses.push("0 = 1");
          } else {
            clauses.push(`${safeKey} IN (${op.in.map(() => ph()).join(", ")})`);
            params.push(...op.in.map((v) => this.serializeValue(tableName, key, columns.get(key), v)));
          }
        }
        if (op.notIn !== undefined) {
          if (!Array.isArray(op.notIn)) throw new YattaError(`"notIn" filter on "${key}" must be an array`);
          if (op.notIn.length === 0) {
            clauses.push("1 = 1");
          } else {
            clauses.push(`${safeKey} NOT IN (${op.notIn.map(() => ph()).join(", ")})`);
            params.push(...op.notIn.map((v) => this.serializeValue(tableName, key, columns.get(key), v)));
          }
        }
      } else {
        clauses.push(`${safeKey} = ${ph()}`);
        params.push(this.serializeValue(tableName, key, columns.get(key), val));
      }
    }

    return { clause: clauses.join(" AND "), params, nextParam };
  }

  // ── ORDER BY ───────────────────────────────────────────────────────────

  compileOrderBy(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    orderBy?: OrderBy<any> | OrderBy<any>[],
  ): string {
    if (!orderBy) return "";
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts: string[] = [];

    for (const ord of orders) {
      for (const [column, dir] of Object.entries(ord)) {
        if (columns.size > 0 && !columns.has(column)) {
          throw new YattaError(`Column "${column}" does not exist on table "${tableName}"`);
        }
        const cleanDir = String(dir).toUpperCase();
        if (cleanDir !== "ASC" && cleanDir !== "DESC") {
          throw new YattaError(`Invalid order direction "${dir}" for column "${column}"`);
        }
        parts.push(`"${column.replace(/"/g, '""')}" ${cleanDir}${this.dialect.compileOrderNulls(cleanDir)}`);
      }
    }
    return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
  }

  // ── SELECT ─────────────────────────────────────────────────────────────

  compileSelect(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    options: SelectOptions = {},
  ): CompiledSql {
    const { clause, params, nextParam: _next } = this.compileWhere(tableName, columns, options.where, 1);
    void _next;
    const orderSql = this.compileOrderBy(tableName, columns, options.orderBy);

    // The LIMIT/OFFSET spelling is dialect-owned: SQLite uses LIMIT -1 for
    // an unbounded read, Postgres uses LIMIT ALL (a negative LIMIT is a
    // syntax error there). See SqlDialect.compileLimitOffset.
    const limitOffsetSql = this.dialect.compileLimitOffset(options.take, options.skip);

    const selectedCols = options.select === undefined
      ? "*"
      : options.select.map((c) => this.dialect.quoteIdent(c)).join(", ");

    const sql = [
      `SELECT ${selectedCols} FROM ${this.dialect.quoteIdent(tableName)}`,
      clause ? `WHERE ${clause}` : "",
      orderSql,
      limitOffsetSql,
    ]
      .filter(Boolean)
      .join(" ")
      .concat(";");

    return { sql, params };
  }

  // ── INSERT ─────────────────────────────────────────────────────────────

  compileInsert(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    payload: Record<string, unknown>,
    startAt = 1,
  ): CompiledSql & { nextParam: number } {
    const qt = this.dialect.quoteIdent(tableName);
    const keys = Object.keys(payload);

    if (keys.length === 0) {
      // A row with no explicit columns is legitimate when every column has a
      // default — a pure audit row with a timestamp, for instance.
      return {
        sql: `INSERT INTO ${qt} DEFAULT VALUES${this.dialect.supportsReturning ? " RETURNING *" : ""};`,
        params: [],
        nextParam: startAt,
      };
    }

    let nextParam = startAt;
    const cols = keys.map((k) => this.dialect.quoteIdent(k)).join(", ");
    const placeholders = keys.map(() => this.dialect.placeholder(nextParam++)).join(", ");
    const values = keys.map((k) => this.serializeValue(tableName, k, columns.get(k), payload[k]));

    return {
      sql: `INSERT INTO ${qt} (${cols}) VALUES (${placeholders})${this.dialect.supportsReturning ? " RETURNING *" : ""};`,
      params: values,
      nextParam,
    };
  }

  /**
   * One single-row INSERT per item, each numbered from $1: the current
   * insertMany loops insert() inside one transaction, and the compiler
   * keeps that shape. A dialect that can do a multi-row INSERT does it
   * inside its own session method, not here.
   */
  compileInsertMany(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    items: Record<string, unknown>[],
  ): CompiledSql[] {
    return items.map((item) => this.compileInsert(tableName, columns, item, 1));
  }

  // ── UPDATE / DELETE / COUNT / EXISTS ───────────────────────────────────

  compileSet(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    payload: Record<string, unknown>,
    startAt = 1,
  ): { setSql: string; params: unknown[]; nextParam: number } {
    let nextParam = startAt;
    const keys = Object.keys(payload);
    const setSql = keys.map((k) => `${this.dialect.quoteIdent(k)} = ${this.dialect.placeholder(nextParam++)}`).join(", ");
    const params = keys.map((k) => this.serializeValue(tableName, k, columns.get(k), payload[k]));
    return { setSql, params, nextParam };
  }

  compileUpdate(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    setPayload: Record<string, unknown>,
    where: WhereClause<any>,
    opts: { returning?: boolean; startAt?: number } = {},
  ): CompiledSql {
    const startAt = opts.startAt ?? 1;
    const { setSql, params: setParams, nextParam } = this.compileSet(tableName, columns, setPayload, startAt);
    const { clause, params: whereParams } = this.compileWhere(tableName, columns, where, nextParam);
    const qt = this.dialect.quoteIdent(tableName);
    const returning = opts.returning && this.dialect.supportsReturning ? " RETURNING *" : "";
    const sql = `UPDATE ${qt} SET ${setSql}${clause ? ` WHERE ${clause}` : ""}${returning};`;
    return { sql, params: [...setParams, ...whereParams] };
  }

  compileDelete(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    where: WhereClause<any>,
    startAt = 1,
  ): CompiledSql {
    const { clause, params } = this.compileWhere(tableName, columns, where, startAt);
    const qt = this.dialect.quoteIdent(tableName);
    return { sql: `DELETE FROM ${qt}${clause ? ` WHERE ${clause}` : ""};`, params };
  }

  compileCount(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    where?: WhereClause<any>,
    startAt = 1,
  ): CompiledSql {
    const { clause, params } = this.compileWhere(tableName, columns, where, startAt);
    const qt = this.dialect.quoteIdent(tableName);
    return { sql: `SELECT COUNT(*) as count FROM ${qt}${clause ? ` WHERE ${clause}` : ""};`, params };
  }

  compileExists(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    where?: WhereClause<any>,
    startAt = 1,
  ): CompiledSql {
    const { clause, params } = this.compileWhere(tableName, columns, where, startAt);
    const qt = this.dialect.quoteIdent(tableName);
    return { sql: `SELECT 1 FROM ${qt}${clause ? ` WHERE ${clause}` : ""} LIMIT 1;`, params };
  }

  /** Primary keys of the rows a `where` filter matches, without loading the rows. */
  compilePkSelect(
    tableName: string,
    columns: Map<string, ColumnDefinition>,
    pkColumn: string,
    where: WhereClause<any>,
    startAt = 1,
  ): CompiledSql {
    const { clause, params } = this.compileWhere(tableName, columns, where, startAt);
    const qt = this.dialect.quoteIdent(tableName);
    const pk = this.dialect.quoteIdent(pkColumn);
    return { sql: `SELECT ${pk} AS pk FROM ${qt}${clause ? ` WHERE ${clause}` : ""};`, params };
  }
}
