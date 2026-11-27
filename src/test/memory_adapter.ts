// MemoryAdapter — test-only Map-backed DatabaseAdapter<"sync">.
//
// Proves the adapter seam: the DatabaseSession contract from
// src/types/db/adapter.ts can be implemented by a driver with no SQL at
// all. It is NOT a public driver (createAdapter never returns it) and it
// is deliberately honest about what it cannot do: no raw SQL
// (executeRaw/executeBatch throw), no backup/restore, no foreign-key
// enforcement, full-text search is a LIKE-style substring scan, and it is
// single-process only (multiProcessSafe: false).
//
// Transactions are real: a snapshot is taken on entry and restored on
// throw, so a rollback undoes the work. Nested transactions are savepoints
// (one snapshot per level).
//
// The SQL-facing members exist only to satisfy the DatabaseSession contract:
// `dialect`/`compiler` are the real SQLite ones (compiling only — nothing
// is ever executed), `run()` throws like executeRaw does, and
// `ensureSearchIndex`/`clearStatementCache` no-op (a LIKE scan needs no
// index and there are no prepared statements to purge).

import { YattaError } from "../types/db/errors";
import type {
  AdapterCapabilities,
  CompiledFindQuery,
  CompiledSearchQuery,
  CompiledUpsertPlan,
  DatabaseAdapter,
  DatabaseSession,
  IntrospectedColumn,
  QueryResult,
  RelationalDriverName,
  TransactionOptions,
} from "../types/db/adapter";
import type { DatabaseSchema, TableSchema } from "../types/db/schema";
import { FILTER_OPS, type RuntimeFilterOps, type WhereClause } from "../types/db/query";
import type { SqlDialect } from "../types/db/sql_dialect";
import { SqlCompiler } from "../types/db/sql_compiler";
import { SqliteDialect } from "../types/db/adapters/sqlite_dialect";

export const MEMORY_CAPABILITIES: AdapterCapabilities = {
  mode: "sync",
  joins: false,
  foreignKeys: false,
  acidTransactions: true,
  savepoints: true,
  returningClause: true,
  fullTextSearch: "like_fallback",
  vectors: "none",
  backupRestore: "none",
  multiProcessSafe: false,
  maxBindParams: 999,
};

const CLOSED_MESSAGE = "Cannot use a closed database.";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function pkColumnName(schema: TableSchema): string | null {
  for (const [colName, builder] of Object.entries(schema)) {
    if (builder.def.primaryKey) return colName;
  }
  if ("id" in schema) return "id";
  return null;
}

function searchableColumns(schema: TableSchema): string[] {
  return Object.entries(schema)
    .filter(([, builder]) => builder.def.isSearchable)
    .map(([colName]) => colName);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/** SQL LIKE matcher: `%` any run, `_` one char, ASCII case-insensitive. */
function likeMatches(value: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") +
      "$",
    "i",
  );
  return regex.test(value);
}

function valueOf(row: Record<string, unknown>, col: string): unknown {
  const v = row[col];
  return v === undefined ? null : v;
}

function matchesField(value: unknown, filter: unknown): boolean {
  if (filter === null) return value === null;
  if (typeof filter !== "object" || Array.isArray(filter)) return value === filter;
  const ops = filter as RuntimeFilterOps;
  for (const op of Object.keys(ops)) {
    if (!FILTER_OPS.has(op)) {
      throw new YattaError(`Unknown filter operator "${op}".`);
    }
    const expected = (ops as Record<string, unknown>)[op];
    switch (op) {
      case "eq":
        if (value !== expected) return false;
        break;
      case "neq":
        if (value === expected) return false;
        break;
      case "gt":
        if (value === null || !((value as any) > (expected as any))) return false;
        break;
      case "gte":
        if (value === null || !((value as any) >= (expected as any))) return false;
        break;
      case "lt":
        if (value === null || !((value as any) < (expected as any))) return false;
        break;
      case "lte":
        if (value === null || !((value as any) <= (expected as any))) return false;
        break;
      case "like":
        if (typeof value !== "string" || !likeMatches(value, String(expected))) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.toLowerCase().includes(String(expected).toLowerCase()))
          return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.toLowerCase().startsWith(String(expected).toLowerCase()))
          return false;
        break;
      case "endsWith":
        if (typeof value !== "string" || !value.toLowerCase().endsWith(String(expected).toLowerCase()))
          return false;
        break;
      case "isNull":
        if ((value === null) !== Boolean(expected)) return false;
        break;
      case "in":
        if (!Array.isArray(expected) || !(expected as unknown[]).includes(value)) return false;
        break;
      case "notIn":
        if (Array.isArray(expected) && (expected as unknown[]).includes(value)) return false;
        break;
    }
  }
  return true;
}

function matchesWhere(row: Record<string, unknown>, where: WhereClause<any> | undefined): boolean {
  if (!where) return true;
  if (where.AND && !where.AND.every((sub: WhereClause<any>) => matchesWhere(row, sub))) return false;
  if (where.OR && !where.OR.some((sub: WhereClause<any>) => matchesWhere(row, sub))) return false;
  for (const [col, filter] of Object.entries(where)) {
    if (col === "AND" || col === "OR") continue;
    if (!matchesField(valueOf(row, col), filter)) return false;
  }
  return true;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if ((a as any) < (b as any)) return -1;
  if ((a as any) > (b as any)) return 1;
  return 0;
}

type Snapshot = {
  tables: Map<string, Map<string | number, Record<string, unknown>>>;
  nextId: Map<string, number>;
};

export class MemoryAdapter implements DatabaseAdapter<"sync"> {
  // Not a creatable driver: createAdapter never returns "memory". The cast
  // keeps the test-only adapter inside the RelationalDriverName type.
  readonly driver = "memory" as unknown as RelationalDriverName;
  readonly capabilities: AdapterCapabilities = MEMORY_CAPABILITIES;
  /** In-memory only: there is no file, so the path is ":memory:". */
  readonly path = ":memory:";
  /** Real SQLite dialect/compiler (compiling only — see the file header). */
  readonly dialect: SqlDialect = new SqliteDialect();
  readonly compiler: SqlCompiler = new SqlCompiler(this.dialect);
  /** True while a transaction snapshot is on the stack. */
  get inTransaction(): boolean {
    return this.txStack.length > 0;
  }

  private schemas = new Map<string, TableSchema>();
  private tables = new Map<string, Map<string | number, Record<string, unknown>>>();
  private nextId = new Map<string, number>();
  private txStack: Snapshot[] = [];
  private closed = false;

  private ensureOpen(): void {
    if (this.closed) throw new YattaError(CLOSED_MESSAGE);
  }

  private tableRows(table: string): Map<string | number, Record<string, unknown>> {
    const rows = this.tables.get(table);
    if (!rows) throw new YattaError(`Table "${table}" does not exist.`);
    return rows;
  }

  private applyDefaults(table: string, schema: TableSchema, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const [colName, builder] of Object.entries(schema)) {
      if (out[colName] !== undefined) continue;
      const def = builder.def.defaultValue;
      if (def === undefined) continue;
      out[colName] = def === "CURRENT_TIMESTAMP" ? new Date().toISOString() : def;
    }
    const pk = pkColumnName(schema);
    if (pk && out[pk] === undefined) {
      const next = this.nextId.get(table) ?? 1;
      out[pk] = next;
      this.nextId.set(table, next + 1);
    }
    return out;
  }

  ready(): void {
    // No-op: an in-memory store is ready as soon as it exists.
  }

  run(_sql: string, _params?: unknown[], _mode?: "get" | "all" | "run"): unknown {
    throw new YattaError("MemoryAdapter has no SQL execution — it holds rows in Maps, not a database engine.");
  }

  ensureSearchIndex(_table: string, _schema: TableSchema): void {
    // No-op: the LIKE-style substring scan needs no index.
  }

  clearStatementCache(): void {
    // No-op: there are no prepared statements to purge.
  }

  syncSchema(schema: DatabaseSchema): void {
    this.ensureOpen();
    for (const [table, tableSchema] of Object.entries(schema)) {
      this.schemas.set(table, tableSchema);
      if (!this.tables.has(table)) {
        this.tables.set(table, new Map());
        this.nextId.set(table, 1);
      }
    }
  }

  listTables(): string[] {
    this.ensureOpen();
    return [...this.tables.keys()].sort();
  }

  listColumns(table: string): IntrospectedColumn[] {
    this.ensureOpen();
    const schema = this.schemas.get(table);
    if (!schema) return [];
    return Object.entries(schema).map(([name, builder]) => ({
      name,
      type: builder.def.type,
      nullable: !builder.def.notNull,
      primaryKey: !!builder.def.primaryKey,
    }));
  }

  insert(table: string, schema: TableSchema, row: Record<string, unknown>): Record<string, unknown> {
    this.ensureOpen();
    const rows = this.tableRows(table);
    const stored = this.applyDefaults(table, schema, row);
    const pk = pkColumnName(schema);
    const key = pk ? (stored[pk] as string | number) : JSON.stringify(stored);
    if (pk && rows.has(key)) {
      throw new YattaError(`A row with ${pk} = ${String(key)} already exists in "${table}".`);
    }
    if (pk && typeof key === "number") {
      // An explicit id moves the counter past it, so the next auto-assigned
      // id can never collide with a row inserted by hand.
      const next = this.nextId.get(table) ?? 1;
      if (key >= next) this.nextId.set(table, key + 1);
    }
    rows.set(key, { ...stored });
    return { ...stored };
  }

  insertMany(table: string, schema: TableSchema, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    this.ensureOpen();
    return this.transaction(() => rows.map((row) => this.insert(table, schema, row)));
  }

  find(table: string, schema: TableSchema, query: CompiledFindQuery): Record<string, unknown>[] {
    this.ensureOpen();
    const rows = this.tableRows(table);
    let out = [...rows.values()].filter((row) => matchesWhere(row, query.where));
    if (query.orderBy) {
      const keys = query.orderBy.flatMap((o) => Object.entries(o));
      out.sort((a, b) => {
        for (const [col, dir] of keys) {
          const cmp = compareValues(valueOf(a, col), valueOf(b, col));
          if (cmp !== 0) return String(dir).toLowerCase() === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (query.skip) out = out.slice(query.skip);
    if (query.take !== undefined) out = out.slice(0, query.take);
    if (query.select) {
      out = out.map((row) => {
        const projected: Record<string, unknown> = {};
        for (const col of query.select!) projected[col] = valueOf(row, col);
        return projected;
      });
    }
    return out.map((row) => ({ ...row }));
  }

  count(table: string, schema: TableSchema, where?: WhereClause<any>): number {
    this.ensureOpen();
    const rows = this.tableRows(table);
    return [...rows.values()].filter((row) => matchesWhere(row, where)).length;
  }

  update(
    table: string,
    schema: TableSchema,
    where: WhereClause<any>,
    patch: Record<string, unknown>,
  ): Record<string, unknown>[] {
    this.ensureOpen();
    if (Object.keys(patch).length === 0) return [];
    const rows = this.tableRows(table);
    const updated: Record<string, unknown>[] = [];
    for (const [key, row] of rows) {
      if (!matchesWhere(row, where)) continue;
      const next = { ...row, ...patch };
      rows.set(key, next);
      updated.push({ ...next });
    }
    return updated;
  }

  delete(table: string, schema: TableSchema, where: WhereClause<any>): number {
    this.ensureOpen();
    const rows = this.tableRows(table);
    let removed = 0;
    for (const [key, row] of [...rows]) {
      if (!matchesWhere(row, where)) continue;
      rows.delete(key);
      removed++;
    }
    return removed;
  }

  upsert(table: string, schema: TableSchema, plan: CompiledUpsertPlan): Record<string, unknown> {
    this.ensureOpen();
    const found = this.find(table, schema, { where: plan.where, take: 1 });
    if (found.length > 0) {
      const pk = pkColumnName(schema);
      if (!pk) {
        throw new YattaError(`Table "${table}" has no primary key, so upsert cannot find the row to update.`);
      }
      const existing = found[0]!;
      const updated = this.update(table, schema, { [pk]: existing[pk] } as WhereClause<any>, plan.updateRow);
      return updated[0]!;
    }
    return this.insert(table, schema, plan.createRow);
  }

  search(
    table: string,
    schema: TableSchema,
    query: CompiledSearchQuery,
  ): Array<{ row: Record<string, unknown>; rank: number }> {
    this.ensureOpen();
    const rows = this.tableRows(table);
    const cols = query.columns.length > 0 ? query.columns : searchableColumns(schema);
    if (cols.length === 0) {
      throw new YattaError(
        `Table "${table}" has no searchable columns, so it cannot be searched. ` +
          `Mark a text column with .searchable() first.`,
      );
    }
    const hits: Array<{ row: Record<string, unknown>; rank: number }> = [];
    for (const row of rows.values()) {
      if (!matchesWhere(row, query.where)) continue;
      const haystack = cols.map((c) => String(valueOf(row, c) ?? "")).join(" ").toLowerCase();
      let matched = true;
      let occurrences = 0;
      for (const group of query.expandedGroups) {
        let groupMatched = false;
        for (const alternative of group) {
          const phrase = alternative.join(" ").toLowerCase();
          if (phrase.length > 0 && haystack.includes(phrase)) {
            groupMatched = true;
            occurrences += haystack.split(phrase).length - 1;
          }
        }
        if (!groupMatched) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      // Smaller (more negative) rank = more relevant, matching FTS5's bm25 convention.
      hits.push({ row: { ...row }, rank: -occurrences });
    }
    hits.sort((a, b) => a.rank - b.rank);
    if (query.offset) return hits.slice(query.offset, query.limit !== undefined ? query.offset + query.limit : undefined);
    if (query.limit !== undefined) return hits.slice(0, query.limit);
    return hits;
  }

  syncSearchRow(
    _table: string,
    _schema: TableSchema,
    _row: Record<string, unknown>,
    _op: "insert" | "update" | "delete",
  ): void {
    // No index to maintain: search scans the live rows.
  }

  rebuildSearchIndex(_table: string, _schema: TableSchema): void {
    // No index to rebuild: search scans the live rows.
  }

  searchVocabulary(table: string, schema: TableSchema): Set<string> {
    this.ensureOpen();
    const rows = this.tableRows(table);
    const cols = searchableColumns(schema);
    const vocab = new Set<string>();
    for (const row of rows.values()) {
      for (const col of cols) {
        for (const token of tokenize(String(valueOf(row, col) ?? ""))) vocab.add(token);
      }
    }
    return vocab;
  }

  executeRaw(_sql: string, _params?: unknown[]): QueryResult {
    throw new YattaError("MemoryAdapter does not support raw SQL — it has no SQL engine. Use the session methods instead.");
  }

  executeBatch(_sql: string): void {
    throw new YattaError("MemoryAdapter does not support raw SQL — it has no SQL engine. Use the session methods instead.");
  }

  transaction<R>(fn: (txSession: DatabaseSession<"sync">) => R, _options?: TransactionOptions): R {
    this.ensureOpen();
    const snapshot: Snapshot = {
      tables: new Map(
        [...this.tables].map(([name, rows]) => [
          name,
          new Map([...rows].map(([key, row]) => [key, structuredClone(row)])),
        ]),
      ),
      nextId: new Map(this.nextId),
    };
    this.txStack.push(snapshot);
    let result: R;
    try {
      result = fn(this);
    } catch (err) {
      const snapshot = this.txStack.pop()!;
      this.tables = snapshot.tables;
      this.nextId = snapshot.nextId;
      throw err;
    }
    if (isThenable(result)) {
      const snapshot = this.txStack.pop()!;
      this.tables = snapshot.tables;
      this.nextId = snapshot.nextId;
      throw new YattaError(
        "transaction() needs a sync function. A memory transaction saves the work the moment the function returns, so an async function would save before its own awaits finish. Do the async work first, then run the transaction.",
      );
    }
    this.txStack.pop();
    return result;
  }

  withMigrationLock<R>(fn: (session: DatabaseSession<"sync">) => R): R {
    this.ensureOpen();
    // Single process, no file: there is nothing to lock against.
    return fn(this);
  }

  backup(_destPath: string): void {
    throw new YattaError("MemoryAdapter has no backup — it holds no file. Serialize the rows yourself if you need a snapshot.");
  }

  restore(_sourcePath: string): void {
    throw new YattaError("MemoryAdapter has no restore — it holds no file.");
  }

  close(): void {
    this.tables.clear();
    this.schemas.clear();
    this.nextId.clear();
    this.txStack = [];
    this.closed = true;
  }
}
