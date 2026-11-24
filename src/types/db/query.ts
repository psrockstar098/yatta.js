// Query filters, the English WHERE DSL (Condition / and / or), the fields
// proxy (FieldsProxy) and the fluent QueryBuilder.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).

import { YattaError } from "./errors";
import type { ColumnDefinition, Prettify } from "./schema";
import type { Table } from "./table";

// ──────────────────────────────────────────────────────────────────────────
// 2. Query Filters & Operators
// ──────────────────────────────────────────────────────────────────────────

type BaseFilterOps<T> = {
  eq?: T; neq?: T;
  in?: T[]; notIn?: T[];
  isNull?: boolean;
};
type TextFilterOps = {
  like?: string; contains?: string; startsWith?: string; endsWith?: string;
};
type NumericFilterOps<T> = {
  gt?: T; gte?: T; lt?: T; lte?: T;
};

/**
 * Operator filters available for field comparisons in a {@link WhereClause}.
 * Provides comparison operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `isNull`).
 *
 * Range operators are offered on string columns as well as numeric ones. That
 * is not a loosening for its own sake: `buildWhere` compiles `gt`/`gte`/`lt`/
 * `lte` for any column, and SQLite compares TEXT by storage class, so
 * `dueDate: { gte: "2026-01-01T00:00:00Z" }` is a correct range query against a
 * `col.date()` column — ISO-8601 sorts lexicographically. Previously the
 * operator set for a string was TextFilterOps only, so every date range had to
 * be cast away or rewritten as a string `contains`, and a genuinely numeric
 * comparison on a string column was wrongly flagged as a type error.
 */
export type FilterOperator<T> = BaseFilterOps<T>
  & (T extends string ? TextFilterOps : {})
  & (T extends number ? NumericFilterOps<T> : {})
  & (T extends string ? NumericFilterOps<T> : {});

/** Every operator key `buildWhere` knows how to compile. */
export const FILTER_OPS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "in", "notIn",
  "like", "contains", "startsWith", "endsWith",
  "isNull",
]);

export interface RuntimeFilterOps {
  eq?: unknown; neq?: unknown; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown;
  in?: unknown[]; notIn?: unknown[];
  like?: string; contains?: string; startsWith?: string; endsWith?: string;
  isNull?: boolean;
}

/**
 * Condition applied to a single column: direct literal match, operator filter object, or `null`.
 */
export type FieldFilter<T> = T | FilterOperator<T> | null;

/**
 * Declarative WHERE clause supporting field conditions, boolean logical groupings (`AND`, `OR`), and nested filters.
 *
 * @example
 * ```ts
 * {
 *   status: "active",
 *   email: { contains: "@gmail.com" },
 *   age: { gte: 18 },
 *   OR: [
 *     { role: "admin" },
 *     { verified: true },
 *   ],
 * }
 * ```
 */
export type WhereClause<T = Record<string, any>> = {
  [K in keyof T]?: FieldFilter<T[K]>;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
};

/** Direction for sorting results: ascending or descending. */
export type OrderDirection = "asc" | "desc" | "ASC" | "DESC";

/** Ordering specification mapping column names to sort directions. */
export type OrderBy<T = Record<string, any>> = { [K in keyof T]?: OrderDirection };

/**
 * Query options for searching and fetching table rows.
 *
 * @template T Row entity type.
 * @template K Selected column keys.
 */
export interface FindOptions<T = any, K extends keyof T = keyof T> {
  /** Filter conditions to restrict rows. */
  where?: WhereClause<T>;
  /** Column sorting criteria. */
  orderBy?: OrderBy<T> | OrderBy<T>[];
  /** Maximum number of records to return. */
  take?: number;
  /** Number of records to skip (offset). */
  skip?: number;
  /** Specific columns to project/select. */
  select?: K[];
  /** Eager-loaded relational associations to populate. */
  include?: Record<string, boolean>;
}

/**
 * Pagination options for offset-based queries.
 *
 * @template T Row entity type.
 */
export interface PaginateOptions<T = any> {
  /** Page number (1-indexed). Defaults to 1. */
  page?: number;
  /** Number of records per page. Defaults to 10. */
  limit?: number;
  /** Filter conditions. */
  where?: WhereClause<T>;
  /** Sorting criteria. */
  orderBy?: OrderBy<T> | OrderBy<T>[];
  /** Eager-loaded relations. */
  include?: Record<string, boolean>;
  /**
   * Columns to return.
   *
   * Omitted before, so `paginate({ select: [...] })` quietly returned every
   * column — the projection was silently ignored rather than rejected.
   */
  select?: (keyof T)[];
}

/**
 * Envelope containing paginated records and metadata.
 *
 * @template T Row entity type.
 */
export interface PaginatedResult<T> {
  /** Array of records for the requested page. */
  data: T[];
  /** Total count of records matching the filter. */
  total: number;
  /** Current page number (1-indexed). */
  page: number;
  /** Number of records per page. */
  limit: number;
  /** Total number of pages available. */
  totalPages: number;
}

/**
 * Options for cursor-based (keyset) pagination, ideal for infinite scroll feeds.
 *
 * @template T Row entity type.
 */
export interface CursorPaginateOptions<T = any> {
  /** Base64-encoded cursor token from a previous page. */
  cursor?: string;
  /** Primary column to sort and paginate on (defaults to primary key). */
  cursorColumn?: keyof T;
  /** Secondary tie-breaker column to ensure deterministic sorting. */
  tieBreaker?: keyof T;
  /** Number of items to fetch. Defaults to 10. */
  limit?: number;
  /** Filter conditions. */
  where?: WhereClause<T>;
  /** Sort order direction. Defaults to `"desc"`. */
  orderByDirection?: "asc" | "desc";
  /** Eager-loaded relations. */
  include?: Record<string, boolean>;
}

/**
 * Envelope containing cursor-paginated data and next page token.
 *
 * @template T Row entity type.
 */
export interface CursorPaginatedResult<T> {
  /** Page of records. */
  data: T[];
  /** Base64 token for fetching the next page, or `null` if no further records exist. */
  nextCursor: string | null;
  /** Whether additional records exist beyond this page. */
  hasMore: boolean;
}

/**
 * One ranked full-text search hit.
 *
 * `rank` is SQLite FTS5's real `bm25()` value for the match — not a score
 * invented by Yatta. It is negative, and smaller means more relevant; hits
 * are returned most relevant first (ascending rank). Do not rescale it into
 * a 0–1 score: the raw value is only meaningful for ordering within one query.
 */
export interface SearchHit<T> {
  /** The matched row, deserialized like any other query result. */
  row: T;
  /** The FTS5 `bm25()` value for this row in this query. Smaller is better. */
  rank: number;
}

/**
 * Options for `table.search()`.
 */
export interface SearchOptions<T = any> {
  /** Maximum hits to return. Omitted means all matches, most relevant first. */
  limit?: number;
  /** Hits to skip, for paging through ranked results. Defaults to 0. */
  offset?: number;
  /**
   * Restrict the search to these columns. Every named column must be
   * searchable; naming a non-searchable column throws instead of silently
   * searching nothing. Omitted means all searchable columns.
   */
  columns?: (keyof T)[];
  /**
   * Extra rows the search must match, applied after ranking (an AND filter).
   * The ranking itself still comes from the FTS5 match alone.
   */
  where?: WhereClause<T>;
  /** Eager-loaded relations, same shape as `findMany({ include })`. */
  include?: Record<string, boolean>;
  /**
   * Synonym map for this query only, merged over the database-level map
   * (see `DatabaseOptions.searchSynonyms`). A key expands to its values:
   * searching "laptop" also matches "notebook" when the map says so.
   */
  synonyms?: Record<string, string | string[]>;
  /**
   * Whether typo correction runs (default `true`). With it off, only exact
   * FTS5 token matches count — a typo'd query then returns nothing, which
   * is FTS5's honest behaviour, not a bug.
   */
  typo?: boolean;
}

/**
 * Configuration options for atomic insert-or-update (upsert) operations.
 *
 * @template T Row entity type.
 * @template TInsert Insertion payload type.
 */
export interface UpsertOptions<T, TInsert = Partial<T>> {
  /** Matching criteria to determine if the record exists. */
  where: WhereClause<T>;
  /** Payload to insert if no matching record is found. */
  create: TInsert;
  /** Partial updates to apply if the record already exists. */
  update: Partial<TInsert | T>;
}

// ──────────────────────────────────────────────────────────────────────────
// 3. English-Language WHERE DSL
// ──────────────────────────────────────────────────────────────────────────

type CondNode =
  | { kind: "leaf"; field: string; op: string; value: unknown }
  | { kind: "and" | "or"; items: CondNode[] };

/**
 * Represents a composable filter predicate node in the English-like filtering DSL.
 * Supports chaining via `.and()` and `.or()` and compiles directly into a {@link WhereClause}.
 *
 * @example
 * ```ts
 * const condition = f.age.isGreaterThan(18).and(f.status.isEqualTo("active"));
 * ```
 */
export class Condition {
  /**
   * Internal constructor creating a condition tree node.
   * @param node The AST node representing this condition.
   */
  constructor(public readonly node: CondNode) {}

  /**
   * Combines this condition with another using a logical `AND`.
   *
   * @param other The other condition to combine with.
   * @returns A combined {@link Condition}.
   */
  and(other: Condition): Condition {
    return new Condition({ kind: "and", items: [this.node, other.node] });
  }

  /**
   * Combines this condition with another using a logical `OR`.
   *
   * @param other The other condition to combine with.
   * @returns A combined {@link Condition}.
   */
  or(other: Condition): Condition {
    return new Condition({ kind: "or", items: [this.node, other.node] });
  }

  /**
   * Compiles this condition tree into a standard declarative {@link WhereClause}.
   *
   * @returns Compiled where clause object.
   */
  toWhere(): WhereClause<any> {
    return compileCondNode(this.node);
  }
}

function compileCondNode(node: CondNode): WhereClause<any> {
  if (node.kind === "leaf") return { [node.field]: { [node.op]: node.value } } as any;
  if (node.kind === "and") return { AND: node.items.map(compileCondNode) } as any;
  return { OR: node.items.map(compileCondNode) } as any;
}

/**
 * Combines multiple conditions with a logical `AND`.
 *
 * @param conds List of conditions to combine.
 * @returns Combined {@link Condition}.
 *
 * @example
 * ```ts
 * and(f.age.isGreaterThan(21), f.country.isEqualTo("US"))
 * ```
 */
export function and(...conds: Condition[]): Condition {
  return new Condition({ kind: "and", items: condNodes(conds, "and") });
}

/**
 * Extracts the AST nodes, rejecting anything that is not a {@link Condition}.
 *
 * Without the check, `and({ age: { gt: 1 } }, …)` — the object form `where` takes —
 * put `undefined` into the tree and failed later with "undefined is not an object
 * (evaluating 'node.kind')", which names neither the argument nor the alternative.
 */
function condNodes(conds: Condition[], fn: string): CondNode[] {
  return conds.map((c, i) => {
    if (!(c instanceof Condition)) {
      throw new YattaError(
        `${fn}() argument ${i + 1} is ${c === null ? "null" : typeof c}, not a Condition. ` +
          `Build conditions from the field proxy inside where: ` +
          `where((f) => ${fn}(f.age.isGreaterThan(18), f.age.isLessThan(65))).`,
      );
    }
    return c.node;
  });
}

/**
 * Combines multiple conditions with a logical `OR`.
 *
 * @param conds List of conditions to combine.
 * @returns Combined {@link Condition}.
 *
 * @example
 * ```ts
 * or(f.role.isEqualTo("admin"), f.role.isEqualTo("moderator"))
 * ```
 */
export function or(...conds: Condition[]): Condition {
  return new Condition({ kind: "or", items: condNodes(conds, "or") });
}

/**
 * Helper function for connecting existing records in relational operations.
 *
 * @template T Entity type.
 * @param row Record to connect.
 * @returns The unchanged row.
 */
interface BaseFieldOps<V> {
  isEqualTo(value: V): Condition;
  isNot(value: V): Condition;
  isIn(values: V[]): Condition;
  isNotIn(values: V[]): Condition;
  isNull(): Condition;
  isNotNull(): Condition;
}

interface TextFieldOps<V extends string = string> extends BaseFieldOps<V> {
  contains(substring: string): Condition;
  startsWith(prefix: string): Condition;
  endsWith(suffix: string): Condition;
  like(pattern: string): Condition;
}

interface NumericFieldOps<V extends number = number> extends BaseFieldOps<V> {
  isGreaterThan(value: V): Condition;
  isGreaterOrEqualTo(value: V): Condition;
  isLessThan(value: V): Condition;
  isLessOrEqualTo(value: V): Condition;
}

type FieldFor<V> = V extends string ? TextFieldOps<V> : V extends number ? NumericFieldOps<V> : BaseFieldOps<V>;

/**
 * Proxy object providing English comparison methods for each column in a row.
 * Available in `table.where((f) => ...)` callbacks.
 *
 * @template Row Table row entity type.
 */
export type FieldsProxy<Row> = { [K in keyof Row]-?: FieldFor<NonNullable<Row[K]>> };

class FieldBuilder {
  constructor(private field: string) {}
  private leaf(op: string, value: unknown): Condition {
    return new Condition({ kind: "leaf", field: this.field, op, value });
  }
  isEqualTo(v: unknown) { return this.leaf("eq", v); }
  isNot(v: unknown) { return this.leaf("neq", v); }
  isGreaterThan(v: unknown) { return this.leaf("gt", v); }
  isGreaterOrEqualTo(v: unknown) { return this.leaf("gte", v); }
  isLessThan(v: unknown) { return this.leaf("lt", v); }
  isLessOrEqualTo(v: unknown) { return this.leaf("lte", v); }
  isIn(v: unknown[]) { return this.leaf("in", v); }
  isNotIn(v: unknown[]) { return this.leaf("notIn", v); }
  isNull() { return this.leaf("isNull", true); }
  isNotNull() { return this.leaf("isNull", false); }
  contains(s: string) { return this.leaf("contains", s); }
  startsWith(s: string) { return this.leaf("startsWith", s); }
  endsWith(s: string) { return this.leaf("endsWith", s); }
  like(p: string) { return this.leaf("like", p); }
}

// One fields DSL proxy per table, built once at Table construction:
// a FieldBuilder per declared column, cached in a Map. FieldBuilder is
// stateless (it holds only the field name; every operator call builds a
// fresh Condition), so sharing one instance per column across queries
// is safe. Undeclared columns fall back to a fresh FieldBuilder, so
// tables with columns added after construction — and dynamic tables
// with no schema — behave exactly as before. The old code built a new
// Proxy per QueryBuilder.where() call (its only caller) and a new
// FieldBuilder per column access.
export function buildFieldsProxy<Row>(
  columns: Map<string, ColumnDefinition>,
): FieldsProxy<Row> {
  const builders = new Map<string, FieldBuilder>();
  for (const colName of columns.keys()) {
    builders.set(colName, new FieldBuilder(colName));
  }
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        typeof prop === "string"
          ? (builders.get(prop) ?? new FieldBuilder(prop))
          : undefined,
    },
  ) as any;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Fluent Query Builder
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fluent query builder for constructing, filtering, sorting, selecting, and executing queries.
 *
 * @template T Source entity row type.
 * @template TResult The projected return record type.
 *
 * @example
 * ```ts
 * const activeUsers = db.users
 *   .where((f) => f.status.isEqualTo("active"))
 *   .orderBy({ createdAt: "desc" })
 *   .take(10)
 *   .all();
 * ```
 */
export class QueryBuilder<T extends Record<string, any> = Record<string, any>, TResult = T> {
  private opts: FindOptions<T> = {};

  /**
   * Initializes a query builder targeting a specific table.
   *
   * @param table The {@link Table} instance being queried.
   */
  constructor(private readonly table: Table<T, any>) {}

  /**
   * Adds filter criteria to the query using either a declarative {@link WhereClause}
   * or an English DSL callback `(f) => f.fieldName.isGreaterThan(...)`.
   * Multiple `.where()` calls are combined with logical `AND`.
   *
   * @param clauseOrFn Filter object or DSL function.
   * @returns Current query builder for chaining.
   *
   * @example
   * ```ts
   * query.where((f) => f.age.isGreaterOrEqualTo(21));
   * query.where({ role: "member" });
   * ```
   */
  where(clauseOrFn: WhereClause<T> | ((fields: FieldsProxy<T>) => Condition)): this {
    const clause = typeof clauseOrFn === "function" ? clauseOrFn(this.table.fieldsProxy).toWhere() : clauseOrFn;
    if (!this.opts.where) {
      this.opts.where = clause;
    } else {
      this.opts.where = { AND: [this.opts.where, clause] } as WhereClause<T>;
    }
    return this;
  }

  /**
   * Applies sort ordering criteria to the query.
   *
   * @param order Ordering configuration (e.g. `{ createdAt: "desc" }`).
   * @returns Current query builder for chaining.
   */
  orderBy(order: OrderBy<T> | OrderBy<T>[]): this {
    this.opts.orderBy = order;
    return this;
  }

  /**
   * Sets the maximum number of rows to return (`LIMIT`).
   *
   * @param n Maximum number of rows.
   * @returns Current query builder for chaining.
   */
  take(n: number): this {
    this.opts.take = n;
    return this;
  }

  /**
   * Alias for {@link QueryBuilder.take}. Sets the maximum number of rows to return.
   *
   * @param n Maximum row limit.
   * @returns Current query builder for chaining.
   */
  limit(n: number): this {
    return this.take(n);
  }

  /**
   * Sets the number of rows to skip (`OFFSET`).
   *
   * @param n Number of rows to bypass.
   * @returns Current query builder for chaining.
   */
  skip(n: number): this {
    this.opts.skip = n;
    return this;
  }

  /**
   * Projects only the specified subset of columns, narrowing the resulting TypeScript type.
   *
   * @template K Column keys to project.
   * @param fields Array of column names to select.
   * @returns Query builder typed to the picked fields.
   *
   * @example
   * ```ts
   * const users = db.users.where({ role: "admin" }).select(["id", "email"]).all();
   * // users: { id: string; email: string }[]
   * ```
   */
  select<K extends keyof T>(fields: K[]): QueryBuilder<T, Prettify<Pick<T, K>>> {
    this.opts.select = fields as any;
    return this as any;
  }

  /**
   * Eagerly loads relational associations on the returned records.
   *
   * @template Inc Populated relations type.
   * @param relations Dictionary of relation names mapped to `true`.
   * @returns Query builder typed to include related data.
   *
   * @example
   * ```ts
   * const usersWithPosts = db.users.where({ id }).include({ posts: true }).all();
   * ```
   */
  include<Inc extends Record<string, any> = Record<string, any>>(
    relations: Record<string, boolean>,
  ): QueryBuilder<T, Prettify<TResult & Inc>> {
    this.opts.include = relations;
    return this as any;
  }

  /**
   * Executes the query and returns all matching rows as an array.
   *
   * @returns Array of resulting records.
   */
  all(): TResult[] {
    return this.table.findMany(this.opts) as unknown as TResult[];
  }

  /**
   * Executes the query and returns the first matching row, or `null` if none found.
   *
   * @returns The first matching record or `null`.
   */
  first(): TResult | null {
    return this.table.findFirst(this.opts) as unknown as TResult | null;
  }

  /**
   * Counts the total number of rows matching the query filters.
   *
   * @returns Count of matching records.
   */
  count(): number {
    return this.table.count(this.opts.where);
  }

  /**
   * Checks whether at least one row matches the query filter.
   *
   * @returns `true` if at least one matching row exists, `false` otherwise.
   */
  exists(): boolean {
    return this.table.exists(this.opts.where);
  }

  /**
   * Executes an offset-based paginated query returning rows and pagination metadata.
   *
   * @param page 1-indexed page number (default: 1).
   * @param limit Records per page (default: 10).
   * @returns {@link PaginatedResult} containing the data and page stats.
   */
  paginate(page = 1, limit = 10): PaginatedResult<TResult> {
    return this.table.paginate({ ...this.opts, page, limit }) as any;
  }
}
