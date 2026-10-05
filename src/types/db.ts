/**
 * ============================================================================
 *  YATTA DB — Fast, Type-Safe, English-Like Embedded SQLite Layer for Bun
 * ============================================================================
 *
 *  OVERVIEW:
 *  Provides an embedded, zero-overhead SQLite database engine powered by `bun:sqlite`
 *  with WAL mode, foreign keys, schema generation, English-like query filtering DSL,
 *  relations (`hasMany`, `belongsTo`), transactions with savepoints, pagination,
 *  and hot-backup/restore capabilities.
 *
 *  KEY EXPORTS:
 *  - `createDatabase(options)`: Factory creating a typed `DatabaseInstance` with tables.
 *  - `connect(options)`: Alias for `createDatabase`.
 *  - `col`: Schema column builder offering:
 *    - `col.id()`, `col.uuid()`: Primary keys (auto-incrementing or UUID).
 *    - `col.text()`, `col.integer()`, `col.real()`, `col.boolean()`: Core primitives.
 *    - `col.json<T>()`: Structured JSON columns serialized/deserialized automatically.
 *    - `col.createdAt()`, `col.updatedAt()`: Automatic ISO timestamp generators.
 *    - Relations: `.references()`, `.hasMany()`, `.belongsTo()`.
 *  - `Table<T>`: CRUD table interface on `db[tableName]`:
 *    - `.insert(data)`: Insert row returning typed record.
 *    - `.insertMany(data[])`: Bulk batch insert in a single transaction.
 *    - `.findById(id)`: O(1) primary key lookup.
 *    - `.findFirst({ where })`: Single row query with filter DSL.
 *    - `.findMany({ where, orderBy, limit, offset })`: Multiple rows query.
 *    - `.updateById(id, data)`: Partial update by primary key.
 *    - `.deleteById(id)`, `.delete({ where })`: Row deletion.
 *    - `.upsert({ where, create, update })`: Atomic insert-or-update.
 *    - `.count({ where })`, `.paginate({ page, pageSize })`: Aggregates & pagination.
 *  - `db.transaction(fn)`: Immediate or deferred transaction with nested savepoints.
 *  - `db.backup(destPath)` & `db.restore(sourcePath)`: Online safe backup & restore.
 *
 *  MODULE AUGMENTATION:
 *  ```ts
 *  declare module "../types/db" {
 *    interface Register {
 *      schema: typeof schema;
 *    }
 *  }
 *  ```
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { col, createDatabase } from "../types/db";
 *
 *  export const schema = {
 *    users: {
 *      id: col.uuid(),
 *      email: col.text().unique(),
 *      name: col.text(),
 *      roles: col.json<string[]>().default(["user"]),
 *      createdAt: col.createdAt(),
 *      updatedAt: col.updatedAt(),
 *    },
 *    posts: {
 *      id: col.id(),
 *      title: col.text(),
 *      authorId: col.text().references("users.id", { onDelete: "CASCADE" }),
 *      createdAt: col.createdAt(),
 *    },
 *  };
 *
 *  export const db = createDatabase({ path: "Database/app.db", schema });
 *
 *  // Querying with English filter DSL:
 *  const user = db.users.insert({ email: "alice@example.com", name: "Alice" });
 *  const found = db.users.findMany({
 *    where: { email: { contains: "alice" }, roles: { in: [["user"], ["admin"]] } }
 *  });
 *  ```
 */

import { Database, type Statement } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────
// 0. Global Schema Registry & Utility Types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Base error class for YattaDB database operations.
 * Automatically formats and captures executed SQL statements for faster debugging.
 */
/**
 * Whether a value is a thenable.
 *
 * Used wherever a synchronous path must refuse a promise rather than silently
 * treat it as a plain return value — which is the failure this codebase has hit
 * twice, in `transaction()` and in `migrate()`.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class YattaError extends Error {
  /**
   * @param message Human-readable error description.
   * @param sql Optional SQL query string that caused the error.
   */
  constructor(message: string, public readonly sql?: string) {
    super(sql ? `${message}\n  SQL: ${sql}` : message);
    this.name = "YattaError";
  }
}

/**
 * Utility type to expand mapped object types into clean, readable tooltips in IDEs.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Global schema registry for declaration merging.
 * Augment this interface in your `db.ts` to get project-wide 100% type-safety for `DB`.
 *
 * @example
 * ```ts
 * declare module "../types/db" {
 *   interface Register {
 *     schema: typeof schema;
 *   }
 * }
 * ```
 */
export interface Register {
  // schema: typeof schema;
}

/**
 * Resolves the active schema type registered via declaration merging,
 * or falls back to generic {@link DatabaseSchema}.
 */
export type RegisteredSchema = Register extends { schema: infer S extends DatabaseSchema }
  ? S
  : DatabaseSchema;

// ──────────────────────────────────────────────────────────────────────────
// 1. Column Definitions & Type-Safe Schema Builder
// ──────────────────────────────────────────────────────────────────────────

/**
 * Supported SQLite underlying column storage affinity types.
 */
export type SQLiteType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

/**
 * Internal schema descriptor capturing column characteristics, constraints, and relational properties.
 */
export interface ColumnDefinition {
  /** Underlying SQLite storage affinity type. */
  type: SQLiteType;
  /** Whether the column serves as the table's primary key. */
  primaryKey?: boolean;
  /** Whether values auto-increment on insert (SQLite INTEGER PRIMARY KEY only). */
  autoIncrement?: boolean;
  /** Whether column rejects null values (`NOT NULL` constraint). */
  notNull?: boolean;
  /** Whether unique constraint/index is applied. */
  unique?: boolean;
  /** Default value expression or constant. */
  defaultValue?: unknown;
  /** Foreign key target reference metadata. */
  references?: { table: string; column: string; onDelete?: string };
  /** Whether an index should be created on this column. */
  isIndex?: boolean;
  /** Whether column is treated as a boolean (mapped between boolean and 0/1 in SQLite). */
  isBoolean?: boolean;
  /** Whether column stores JSON data (automatically serialized/deserialized). */
  isJson?: boolean;
  /** Whether column is auto-generated as a UUID v4 string on insert. */
  isUuid?: boolean;
  /** Whether column automatically refreshes to current timestamp upon updates. */
  touchOnUpdate?: boolean;
  /** Constrained allowed string literal values for CHECK constraint. */
  checkValues?: readonly string[];
}

/**
 * Fluent builder for defining table columns with strong typing and constraint chaining.
 *
 * @template V The TypeScript representation of the column value.
 * @template Optional Whether the column is optional on insert.
 * @template IsRef Whether the column is a foreign key reference.
 */
export class ColumnBuilder<V = unknown, Optional extends boolean = false, IsRef extends boolean = false> {
  /** Internal column configuration definition. */
  readonly def: ColumnDefinition;

  /**
   * Creates a new column builder.
   *
   * @param type SQLite storage type.
   * @param def Additional column properties and constraints.
   */
  constructor(type: SQLiteType, def?: Partial<ColumnDefinition>) {
    this.def = { type, ...def };
  }

  private clone<V2 = V, O2 extends boolean = Optional, R2 extends boolean = IsRef>(
    patch: Partial<ColumnDefinition>,
  ): ColumnBuilder<V2, O2, R2> {
    return new ColumnBuilder<V2, O2, R2>(this.def.type, { ...this.def, ...patch });
  }

  /**
   * Designates this column as the primary key of the table.
   *
   * @throws {@link YattaError} if the column was previously marked as nullable.
   * @returns Column builder configured as primary key.
   */
  primaryKey(): ColumnBuilder<V, Optional, IsRef> {
    if (this.def.notNull === false) {
      throw new YattaError("A primary key column cannot be nullable");
    }
    return this.clone<V, Optional, IsRef>({ primaryKey: true, notNull: true });
  }

  /**
   * Configures automatic sequence incrementation on primary key insert.
   * Only applicable to INTEGER columns.
   *
   * @throws {@link YattaError} if column type is not INTEGER.
   * @returns Column builder configured for auto-increment.
   */
  autoIncrement(): ColumnBuilder<V, true, IsRef> {
    if (this.def.type !== "INTEGER") {
      throw new YattaError(`AUTOINCREMENT is only valid for INTEGER columns, received ${this.def.type}`);
    }
    return this.clone<V, true, IsRef>({ autoIncrement: true, primaryKey: true, notNull: true });
  }

  /**
   * Allows the column to store `NULL` values.
   *
   * @throws {@link YattaError} if column is marked as primary key.
   * @returns Column builder typed as nullable.
   */
  nullable(): ColumnBuilder<V | null, true, IsRef> {
    if (this.def.primaryKey) {
      throw new YattaError("Cannot mark a primary key as nullable");
    }
    return this.clone<V | null, true, IsRef>({ notNull: false });
  }

  /**
   * Enforces a `NOT NULL` constraint on the column.
   *
   * @returns Column builder typed as non-nullable.
   */
  notNull(): ColumnBuilder<NonNullable<V>, false, IsRef> {
    return this.clone<NonNullable<V>, false, IsRef>({ notNull: true });
  }

  /**
   * Adds a `UNIQUE` constraint and index on this column.
   *
   * @returns Column builder with unique constraint.
   */
  unique(): ColumnBuilder<V, Optional, IsRef> {
    return this.clone<V, Optional, IsRef>({ unique: true });
  }

  /**
   * Specifies a default fallback value used when inserting a row without providing this column.
   *
   * @param val Default value to assign.
   * @returns Column builder with default value configured.
   */
  default(val: V): ColumnBuilder<V, true, IsRef> {
    return this.clone<V, true, IsRef>({ defaultValue: val });
  }

  /**
   * Creates an SQLite index on this column for faster queries and lookups.
   *
   * @returns Column builder flagged for index creation.
   */
  index(): ColumnBuilder<V, Optional, IsRef> {
    return this.clone<V, Optional, IsRef>({ isIndex: true });
  }

  /**
   * Establishes a foreign key relationship referencing another table's column.
   *
   * @param target Target in `"tableName.columnName"` format (e.g. `"users.id"`).
   * @param opts Referential action options (e.g. `{ onDelete: "CASCADE" }`).
   * @returns Column builder configured as foreign key reference.
   *
   * @example
   * ```ts
   * authorId: col.text().references("users.id", { onDelete: "CASCADE" })
   * ```
   */
  references(
    target: `${string}.${string}`,
    opts?: { onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" },
  ): ColumnBuilder<V, Optional, true> {
    const parts = target.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new YattaError(`Invalid references target "${target}". Expected "table.column" format.`);
    }
    const [table, column] = parts;

    /*
     * `onDelete: "SET NULL"` forces the column nullable.
     *
     * A NOT NULL column cannot be set to NULL, so `col.text().references(t, {
     * onDelete: "SET NULL" })` used to build a table whose own declared referential
     * action could not execute: deleting the parent raised "Cannot set NULL on
     * NOT NULL column" from inside SQLite, with no hint that the schema was the
     * problem. The two settings contradict each other, so the builder resolves
     * the contradiction rather than accepting it.
     */
    if (opts?.onDelete === "SET NULL") {
      return this.clone<V | null, true, true>({
        references: { table, column, onDelete: opts.onDelete },
        notNull: false,
      });
    }

    return this.clone<V, Optional, true>({ references: { table, column, onDelete: opts?.onDelete } });
  }

  /**
   * Fluent shorthand helper creating a foreign key referencing the `id` column of the specified table.
   *
   * @param table Target table name.
   * @param opts Referential action options (e.g. `{ onDelete: "CASCADE" }`).
   * @returns Column builder configured as foreign key.
   *
   * @example
   * ```ts
   * userId: col.text().belongsTo("users", { onDelete: "CASCADE" })
   * ```
   */
  belongsTo(
    table: string,
    opts?: { onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" },
  ): ColumnBuilder<V, Optional, true> {
    return this.clone<V, Optional, true>({ references: { table, column: "id", onDelete: opts?.onDelete } });
  }
}

/**
 * Schema column builder registry providing factory functions for all supported column types.
 *
 * @example
 * ```ts
 * export const schema = {
 *   users: {
 *     id: col.uuid(),
 *     name: col.text(),
 *     age: col.integer().nullable(),
 *     metadata: col.json<{ theme: string }>(),
 *     createdAt: col.createdAt(),
 *   },
 * };
 * ```
 */
export const col = {
  /**
   * Creates an auto-incrementing integer primary key column.
   *
   * @example
   * ```ts
   * id: col.id()
   * ```
   */
  id: (): ColumnBuilder<number, true, false> =>
    new ColumnBuilder<number, true, false>("INTEGER", { primaryKey: true, autoIncrement: true, notNull: true }),

  /**
   * Creates a text primary key column populated automatically with random UUIDs if not specified.
   *
   * @example
   * ```ts
   * id: col.uuid()
   * ```
   */
  uuid: (): ColumnBuilder<string, true, false> =>
    new ColumnBuilder<string, true, false>("TEXT", { primaryKey: true, notNull: true, isUuid: true }),

  /**
   * Creates a standard text/string column.
   *
   * @example
   * ```ts
   * email: col.text().unique()
   * ```
   */
  text: (): ColumnBuilder<string, false, false> =>
    new ColumnBuilder<string, false, false>("TEXT", { notNull: true }),

  /**
   * Creates a 64-bit integer column.
   *
   * @example
   * ```ts
   * count: col.integer().default(0)
   * ```
   */
  integer: (): ColumnBuilder<number, false, false> =>
    new ColumnBuilder<number, false, false>("INTEGER", { notNull: true }),

  /**
   * Creates a floating point real/number column.
   *
   * @example
   * ```ts
   * price: col.real()
   * ```
   */
  real: (): ColumnBuilder<number, false, false> =>
    new ColumnBuilder<number, false, false>("REAL", { notNull: true }),

  /**
   * Creates a boolean column stored as `0` or `1` in SQLite, automatically mapped to TypeScript booleans.
   *
   * @example
   * ```ts
   * isActive: col.boolean().default(true)
   * ```
   */
  boolean: (): ColumnBuilder<boolean, true, false> =>
    new ColumnBuilder<boolean, true, false>("INTEGER", { notNull: true, isBoolean: true, defaultValue: false }),

  /**
   * Creates a structured JSON column serialized and deserialized automatically to and from JSON text.
   *
   * @template V Deserialized JSON payload shape.
   * @example
   * ```ts
   * tags: col.json<string[]>().default([])
   * ```
   */
  json: <V = unknown>(): ColumnBuilder<V, true, false> =>
    new ColumnBuilder<V, true, false>("TEXT", { notNull: true, isJson: true, defaultValue: "{}" }),

  /**
   * Creates a text column constrained by a SQLite `CHECK` condition to a fixed union of string literals.
   *
   * @param values Readonly array of allowed string literals.
   * @example
   * ```ts
   * role: col.enum(["admin", "user", "guest"])
   * ```
   */
  enum: <const Values extends readonly string[]>(values: Values): ColumnBuilder<Values[number], false, false> =>
    new ColumnBuilder<Values[number], false, false>("TEXT", { notNull: true, checkValues: values }),

  /**
   * Creates an ISO 8601 date string column.
   *
   * @example
   * ```ts
   * publishedAt: col.date().nullable()
   * ```
   */
  date: (): ColumnBuilder<string, false, false> =>
    new ColumnBuilder<string, false, false>("TEXT", { notNull: true }),

  /**
   * Creates a timestamp column automatically populated with SQLite's `CURRENT_TIMESTAMP` on insert.
   *
   * @example
   * ```ts
   * createdAt: col.createdAt()
   * ```
   */
  createdAt: (): ColumnBuilder<string, true, false> =>
    new ColumnBuilder<string, true, false>("TEXT", { notNull: true, defaultValue: "CURRENT_TIMESTAMP" }),

  /**
   * Creates a timestamp column defaulted to `CURRENT_TIMESTAMP` on insert and automatically updated on modifications.
   *
   * @example
   * ```ts
   * updatedAt: col.updatedAt()
   * ```
   */
  updatedAt: (): ColumnBuilder<string, true, false> =>
    new ColumnBuilder<string, true, false>("TEXT", { notNull: true, defaultValue: "CURRENT_TIMESTAMP", touchOnUpdate: true }),
};

/**
 * Represents a table schema mapping column identifiers to their {@link ColumnBuilder} definitions.
 */
export type TableSchema = Record<string, ColumnBuilder<any, any, any>>;

/**
 * Represents the complete database schema mapping table names to their {@link TableSchema}.
 */
export type DatabaseSchema = Record<string, TableSchema>;

// ── Type Inference ─────────────────────────────────────────────────────────

type ColumnValue<C> = C extends ColumnBuilder<infer V, any, any> ? V : never;
type ColumnOptional<C> = C extends ColumnBuilder<any, infer O, any> ? O : false;
type ColumnIsRef<C> = C extends ColumnBuilder<any, any, infer R> ? R : false;

/**
 * Infers the full output row TypeScript type returned when querying a table schema.
 */
export type InferRow<S extends TableSchema> = Prettify<{
  [K in keyof S]: ColumnValue<S[K]>;
}>;

type AliasFor<K extends string> = K extends `${infer Base}Id` ? Base : K extends `${infer Base}_id` ? Base : never;

type RelationAliases<S extends TableSchema> = {
  [K in keyof S as ColumnIsRef<S[K]> extends true ? (K extends string ? AliasFor<K> : never) : never]?:
    ColumnValue<S[K]> | { id: ColumnValue<S[K]> } | Record<string, any>;
};

type BaseInsert<S extends TableSchema> = {
  [K in keyof S as (ColumnOptional<S[K]> extends true ? never : ColumnIsRef<S[K]> extends true ? never : K)]: ColumnValue<S[K]>;
} & {
  [K in keyof S as (ColumnOptional<S[K]> extends true ? K : ColumnIsRef<S[K]> extends true ? K : never)]?: ColumnValue<S[K]>;
};

/**
 * Infers the input payload TypeScript type accepted when inserting a new row into a table schema.
 * Required columns must be supplied; columns with defaults, auto-increments, or UUIDs are optional.
 */
export type InferInsert<S extends TableSchema> = Prettify<BaseInsert<S> & RelationAliases<S>>;

/**
 * Definition of a relationship between two tables for eager loading via `include`.
 */
export type RelationDefinition =
  | { hasMany: string; foreignKey: string }
  | { belongsTo: string; foreignKey: string }
  | { hasOne: string; foreignKey: string };

/**
 * Relational graph configuration dictionary mapping tables and relation names to definitions.
 */
export type RelationsConfig = Record<string, Record<string, RelationDefinition>>;

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
const FILTER_OPS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "in", "notIn",
  "like", "contains", "startsWith", "endsWith",
  "isNull",
]);

interface RuntimeFilterOps {
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
  return new Condition({ kind: "and", items: conds.map((c) => c.node) });
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
  return new Condition({ kind: "or", items: conds.map((c) => c.node) });
}

/**
 * Helper function for connecting existing records in relational operations.
 *
 * @template T Entity type.
 * @param row Record to connect.
 * @returns The unchanged row.
 */
/**
 * Relational linker: attaches an already-loaded record to its parent.
 *
 * Also accepts database options, in which case it builds a database — the two
 * forms are distinguished by shape, since a record has no `path` or `driver`.
 *
 * @example
 * ```ts
 * const db = connect({ path: "./app.db", schema });
 * const post = connect({ ...postRow, author: connect(authorRow) });
 * ```
 */
export function connect<T>(row: T): T;
export function connect<S extends DatabaseSchema>(options?: DatabaseOptions & { schema?: S }): TypedDatabase<S>;
export function connect(input: any): any {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    ("path" in input || "driver" in input || "schema" in input)
  ) {
    return createDatabase(input);
  }
  return input;
}

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

function makeFieldsProxy<Row>(): FieldsProxy<Row> {
  return new Proxy(
    {},
    { get: (_t, prop) => (typeof prop === "string" ? new FieldBuilder(prop) : undefined) },
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
    const clause = typeof clauseOrFn === "function" ? clauseOrFn(makeFieldsProxy<T>()).toWhere() : clauseOrFn;
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

// ──────────────────────────────────────────────────────────────────────────
// 5. Table Gateway
// ──────────────────────────────────────────────────────────────────────────

function deriveAlias(colName: string): string | null {
  if (colName.length > 2 && colName.endsWith("Id")) return colName.slice(0, -2);
  if (colName.length > 3 && colName.endsWith("_id")) return colName.slice(0, -3);
  return null;
}

function escapeLike(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Type-safe CRUD table gateway providing querying, insertions, updates, deletions,
 * aggregations, relational joins, and pagination.
 *
 * @template T Full row record type.
 * @template TInsert Payload accepted for insertions.
 *
 * @example
 * ```ts
 * const user = db.users.insert({ email: "alice@example.com", name: "Alice" });
 * const found = db.users.findById(user.id);
 * db.users.updateById(user.id, { name: "Alice Smith" });
 * ```
 */
export class Table<T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>> {
  /** Map of column definitions belonging to this table. */
  readonly columns: Map<string, ColumnDefinition> = new Map();
  /** The primary key column name for this table (defaults to `"id"`). */
  readonly primaryKeyColumn: string = "id";
  /** Inferred relational foreign key aliases (e.g. `userId` -> `user`). */
  readonly belongsToAliases: Map<string, { column: string; table: string }> = new Map();

  /**
   * Initializes a table gateway instance.
   *
   * @param name Name of the SQLite table.
   * @param db Reference to parent {@link YattaDB} instance.
   * @param schema Optional column schema definitions.
   */
  constructor(
    public readonly name: string,
    private db: YattaDB,
    private schema?: TableSchema,
  ) {
    if (schema) {
      for (const [colName, builder] of Object.entries(schema)) {
        this.columns.set(colName, builder.def);
        if (builder.def.primaryKey) this.primaryKeyColumn = colName;
        if (builder.def.references) {
          const alias = deriveAlias(colName);
          if (alias) this.belongsToAliases.set(alias, { column: colName, table: builder.def.references.table });
        }
      }
    }
  }

  /**
   * Begins a fluent {@link QueryBuilder} with an initial filter clause or English DSL callback.
   *
   * @param clauseOrFn Declarative {@link WhereClause} or English DSL function.
   * @returns Chained {@link QueryBuilder}.
   *
   * @example
   * ```ts
   * const admins = db.users.where((f) => f.role.isEqualTo("admin")).all();
   * ```
   */
  where(clauseOrFn: WhereClause<T> | ((fields: FieldsProxy<T>) => Condition)): QueryBuilder<T> {
    return new QueryBuilder(this).where(clauseOrFn);
  }

  // ── INSERT ───────────────────────────────────────────────────────────────

  /**
   * Inserts a single record into the table and returns the newly created row with generated values.
   *
   * @param data Payload to insert.
   * @returns Persisted entity row.
   * @throws {@link YattaError} if insertion fails or required columns are omitted.
   *
   * @example
   * ```ts
   * const user = db.users.insert({ email: "bob@example.com", name: "Bob" });
   * ```
   */
  insert(data: TInsert): T {
    const payload = this.resolveAliases(data as Record<string, any>);

    for (const [colName, def] of this.columns) {
      if (def.isUuid && payload[colName] === undefined) {
        payload[colName] = crypto.randomUUID();
      }
    }

    const keys = Object.keys(payload);

    /*
     * A row with no explicit columns is legitimate when every column has a
     * default — a pure audit row with a timestamp, for instance. It previously
     * threw "received no data", which made those tables uninsertable.
     */
    if (keys.length === 0) {
      const sql = `INSERT INTO "${this.name.replace(/"/g, '""')}" DEFAULT VALUES RETURNING *;`;
      return this.deserializeRow(this.db.run(sql, [], "get") as any);
    }

    const columns = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => this.serializeValue(k, payload[k]));

    const sql = `INSERT INTO "${this.name.replace(/"/g, '""')}" (${columns}) VALUES (${placeholders}) RETURNING *;`;
    const row = this.db.run(sql, values, "get") as any;
    return this.deserializeRow(row);
  }

  /**
   * Inserts multiple records in a single batch within an atomic SQLite transaction.
   *
   * @param items Array of records to insert.
   * @returns Array of persisted rows.
   *
   * @example
   * ```ts
   * const users = db.users.insertMany([
   *   { email: "user1@example.com" },
   *   { email: "user2@example.com" },
   * ]);
   * ```
   */
  insertMany(items: TInsert[]): T[] {
    if (items.length === 0) return [];
    return this.db.transaction(() => items.map((item) => this.insert(item)));
  }

  // ── FIND ─────────────────────────────────────────────────────────────────

  /**
   * Finds the first row matching the specified criteria, projecting only selected columns.
   *
   * @param options Query criteria with `select` array.
   * @returns Picked record columns or `null` if no match.
   */
  findFirst<K extends keyof T>(options: FindOptions<T, K> & { select: K[] }): Prettify<Pick<T, K>> | null;
  /**
   * Finds the first row matching the specified criteria.
   *
   * @param options Optional query criteria.
   * @returns Full record or `null` if no match.
   */
  findFirst(options?: FindOptions<T, keyof T>): T | null;
  findFirst<K extends keyof T = keyof T, R = Pick<T, K>>(
    options: FindOptions<T, K> = {},
  ): R | null {
    const results = this.findMany({ ...options, take: 1 } as any) as R[];
    return results[0] ?? null;
  }

  /**
   * Shorthand to retrieve the very first row in the table.
   *
   * @returns First row or `null` if table is empty.
   */
  first(): T | null {
    return this.findFirst();
  }

  /**
   * Finds a row by its primary key with selected columns projected.
   *
   * @param id Primary key value.
   * @param options Selection options.
   * @returns Picked record columns or `null` if not found.
   */
  findById<K extends keyof T>(
    id: string | number,
    options: { select: K[]; include?: Record<string, boolean> },
  ): Prettify<Pick<T, K>> | null;
  /**
   * Finds a row by its primary key.
   *
   * @param id Primary key value.
   * @param options Optional relation inclusion options.
   * @returns Full record or `null` if not found.
   */
  findById(
    id: string | number,
    options?: { select?: undefined; include?: Record<string, boolean> },
  ): T | null;
  findById<K extends keyof T = keyof T, R = Pick<T, K>>(
    id: string | number,
    options?: { select?: K[]; include?: Record<string, boolean> },
  ): R | null {
    return this.findFirst({
      where: { [this.primaryKeyColumn]: id } as any,
      select: options?.select,
      include: options?.include,
    } as any) as R | null;
  }

  /**
   * Finds all rows matching the specified criteria, projecting only selected columns.
   *
   * @param options Query criteria with `select` array.
   * @returns Array of picked records.
   */
  findMany<K extends keyof T>(options: FindOptions<T, K> & { select: K[] }): Prettify<Pick<T, K>>[];
  /**
   * Finds all rows matching the specified criteria.
   *
   * @param options Optional query criteria.
   * @returns Array of full records.
   */
  findMany(options?: FindOptions<T, keyof T>): T[];
  findMany<K extends keyof T = keyof T, R = Pick<T, K>>(
    options: FindOptions<T, K> = {},
  ): R[] {
    const { clause, params } = this.buildWhere(options.where);
    const orderSql = this.buildOrderBy(options.orderBy);

    /*
     * SQLite only accepts OFFSET as part of a `LIMIT … OFFSET …` clause, so a
     * bare `OFFSET n` is a syntax error. `skip` on its own is a documented,
     * reasonable thing to write, so it gets `LIMIT -1` — SQLite's "no upper
     * bound" — rather than failing.
     */
    const hasSkip = options.skip !== undefined;
    const limitSql =
      options.take !== undefined
        ? `LIMIT ${Number(options.take)}`
        : hasSkip
          ? "LIMIT -1"
          : "";
    const offsetSql = hasSkip ? `OFFSET ${Number(options.skip)}` : "";

    let selectedCols = "*";
    if (options.select) {
      const cols = new Set(options.select.map(String));
      if (options.include) {
        cols.add(this.primaryKeyColumn);
        for (const relName of Object.keys(options.include)) {
          const auto = this.belongsToAliases.get(relName);
          if (auto) cols.add(auto.column);
          const configured = this.db.relations[this.name]?.[relName];
          if (configured && "foreignKey" in configured && !("hasMany" in configured)) {
            cols.add(configured.foreignKey);
          }
        }
      }
      selectedCols = [...cols].map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    }

    const sql = [
      `SELECT ${selectedCols} FROM "${this.name.replace(/"/g, '""')}"`,
      clause ? `WHERE ${clause}` : "",
      orderSql,
      limitSql,
      offsetSql,
    ]
      .filter(Boolean)
      .join(" ")
      .concat(";");

    const rows = (this.db.run(sql, params, "all") as any[]).map((r) => this.deserializeRow(r));
    if (options.include && rows.length > 0) this.resolveRelations(rows, options.include);
    return rows as unknown as R[];
  }

  // ── UPDATE ───────────────────────────────────────────────────────────────

  private buildSetClause(data: Record<string, any>): { setSql: string; params: any[] } {
    const payload = this.resolveAliases(data);

    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined) {
        delete payload[k];
      }
    }

    for (const [colName, def] of this.columns) {
      if (def.touchOnUpdate && payload[colName] === undefined && Object.keys(payload).length > 0) {
        payload[colName] = new Date().toISOString();
      }
    }

    const keys = Object.keys(payload);
    const setSql = keys.map((k) => `"${k.replace(/"/g, '""')}" = ?`).join(", ");
    const params = keys.map((k) => this.serializeValue(k, payload[k]));
    return { setSql, params };
  }

  /**
   * Updates all rows matching the `where` filter with the provided partial data.
   *
   * @param options Object containing `where` criteria and `data` updates.
   * @returns Object containing the number of modified rows (`changes`).
   *
   * @example
   * ```ts
   * const { changes } = db.users.update({
   *   where: { role: "guest" },
   *   data: { role: "member" },
   * });
   * ```
   */
  update(options: {
    where: WhereClause<T>;
    data: Partial<TInsert | T>;
    /** Required to update every row. An empty `where` is otherwise refused. */
    allowAll?: boolean;
  }): { changes: number } {
    const { setSql, params: setParams } = this.buildSetClause(options.data as Record<string, any>);
    if (!setSql) return { changes: 0 };

    const { clause, params: whereParams } = this.buildWhere(options.where);

    // Same reasoning as delete(): an unfiltered UPDATE rewrites the whole table,
    // usually because a lookup that was meant to narrow it came back empty.
    if (!clause && !options.allowAll) {
      throw new YattaError(
        `update() on "${this.name}" requires a filter. An empty where would update every row — pass { allowAll: true } if that is what you mean.`,
      );
    }

    const sql = `UPDATE "${this.name.replace(/"/g, '""')}" SET ${setSql}${clause ? ` WHERE ${clause}` : ""};`;

    const res = this.db.run(sql, [...setParams, ...whereParams], "run") as { changes: number };
    return { changes: res.changes };
  }

  /**
   * Updates a single record identified by its primary key and returns the updated row.
   *
   * @param id Primary key value.
   * @param data Partial fields to update.
   * @returns Updated row or `null` if not found.
   *
   * @example
   * ```ts
   * const updated = db.users.updateById(1, { name: "New Name" });
   * ```
   */
  updateById(id: string | number, data: Partial<TInsert | T>): T | null {
    const { setSql, params: setParams } = this.buildSetClause(data as Record<string, any>);
    if (!setSql) return this.findById(id);

    const pkCol = `"${this.primaryKeyColumn.replace(/"/g, '""')}"`;
    const sql = `UPDATE "${this.name.replace(/"/g, '""')}" SET ${setSql} WHERE ${pkCol} = ? RETURNING *;`;
    const row = this.db.run(sql, [...setParams, id], "get") as any;
    return row ? this.deserializeRow(row) : null;
  }

  /**
   * Atomically inserts a new row or updates an existing one if a row matching `where` is found.
   *
   * @param options Upsert criteria: `where` condition, `create` payload, and `update` modifications.
   * @returns The newly created or updated row.
   *
   * @example
   * ```ts
   * const user = db.users.upsert({
   *   where: { email: "user@example.com" },
   *   create: { email: "user@example.com", name: "User" },
   *   update: { name: "User Updated" },
   * });
   * ```
   */
  upsert({ where, create, update }: UpsertOptions<T, TInsert>): T {
    return this.db.transaction(() => {
      const existing = this.findFirst({ where });
      if (existing) {
        const id = (existing as any)[this.primaryKeyColumn];
        return this.updateById(id, update) as T;
      }
      const baseCreate: Record<string, any> = { ...create };
      for (const [k, v] of Object.entries(where)) {
        if (baseCreate[k] === undefined && (typeof v !== "object" || v === null || v instanceof Date)) {
          baseCreate[k] = v;
        }
      }
      return this.insert(baseCreate as TInsert);
    });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────

  /**
   * Deletes all rows matching the `where` criteria.
   *
   * @param options Object with `where` filter condition.
   * @returns Object containing the count of deleted rows (`changes`).
   *
   * @example
   * ```ts
   * db.users.delete({ where: { status: "inactive" } });
   * ```
   */
  delete(options: {
    where: WhereClause<T>;
    /** Required to delete every row. An empty `where` is otherwise refused. */
    allowAll?: boolean;
  }): { changes: number } {
    const { clause, params } = this.buildWhere(options.where);

    /*
     * Refuse an unscoped DELETE.
     *
     * `delete({ where: {} })` compiled to `DELETE FROM "users"` and emptied the
     * table. It is an easy call to make by accident — an empty filter is what a
     * failed lookup leaves behind — and the result was silent and total. Making
     * the caller opt in with `allowAll` costs one word and turns a data-loss
     * bug into an explicit decision.
     */
    if (!clause && !options.allowAll) {
      throw new YattaError(
        `delete() on "${this.name}" requires a filter. An empty where would delete every row — pass { allowAll: true } if that is what you mean.`,
      );
    }

    const sql = `DELETE FROM "${this.name.replace(/"/g, '""')}"${clause ? ` WHERE ${clause}` : ""};`;
    const res = this.db.run(sql, params, "run") as { changes: number };
    return { changes: res.changes };
  }

  /**
   * Deletes a single record by its primary key.
   *
   * @param id Primary key value.
   * @returns `true` if a row was deleted, `false` otherwise.
   *
   * @example
   * ```ts
   * const wasDeleted = db.users.deleteById(1);
   * ```
   */
  deleteById(id: string | number): boolean {
    return this.delete({ where: { [this.primaryKeyColumn]: id } as any }).changes > 0;
  }

  // ── COUNT, EXISTS & PAGINATION ───────────────────────────────────────────

  /**
   * Counts the total number of rows matching an optional filter.
   *
   * @param where Optional filter condition.
   * @returns Total row count.
   */
  count(where?: WhereClause<T>): number {
    const { clause, params } = this.buildWhere(where);
    const sql = `SELECT COUNT(*) as count FROM "${this.name.replace(/"/g, '""')}"${clause ? ` WHERE ${clause}` : ""};`;
    return (this.db.run(sql, params, "get") as { count: number }).count;
  }

  /**
   * Checks whether at least one row exists matching the specified criteria.
   *
   * @param where Optional filter condition.
   * @returns `true` if matching row exists, `false` otherwise.
   */
  exists(where?: WhereClause<T>): boolean {
    const { clause, params } = this.buildWhere(where);
    const sql = `SELECT 1 FROM "${this.name.replace(/"/g, '""')}"${clause ? ` WHERE ${clause}` : ""} LIMIT 1;`;
    const res = this.db.run(sql, params, "get");
    return res !== null && res !== undefined;
  }

  /**
   * Performs offset-based pagination on the table.
   *
   * @template R Row projection type.
   * @param options Pagination parameters (`page`, `limit`, `where`, `orderBy`, `include`).
   * @returns {@link PaginatedResult} containing the data slice and total page metrics.
   *
   * @example
   * ```ts
   * const page = db.users.paginate({ page: 2, limit: 20 });
   * console.log(page.data, page.total, page.totalPages);
   * ```
   */
  paginate<R = T>(options: PaginateOptions<T> = {}): PaginatedResult<R> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.max(1, options.limit ?? 10);
    const skip = (page - 1) * limit;

    const total = this.count(options.where);
    const data = this.findMany({
      where: options.where,
      orderBy: options.orderBy,
      take: limit,
      skip,
      include: options.include,
      select: options.select,
    }) as unknown as R[];

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Performs cursor-based keyset pagination, ideal for infinite scroll feeds.
   *
   * @template R Row projection type.
   * @param options Cursor pagination options (`cursor`, `limit`, `where`, etc.).
   * @returns {@link CursorPaginatedResult} containing data and `nextCursor`.
   *
   * @example
   * ```ts
   * const { data, nextCursor, hasMore } = db.posts.cursorPaginate({ limit: 15, cursor });
   * ```
   */
  cursorPaginate<R = T>(options: CursorPaginateOptions<T> = {}): CursorPaginatedResult<R> {
    const limit = Math.max(1, options.limit ?? 10);
    const cursorCol = (options.cursorColumn ?? this.primaryKeyColumn) as string;
    const tieBreaker = (options.tieBreaker ?? this.primaryKeyColumn) as string;
    const direction = (options.orderByDirection ?? "desc").toLowerCase() as "asc" | "desc";

    const userWhere: WhereClause<T> = options.where ? { ...options.where } : {};
    let where: WhereClause<T> = userWhere;

    if (options.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString("utf-8"),
        );

        /*
         * Validate the cursor's shape before building a filter from it.
         *
         * A cursor decoding to `[]` or to non-scalars left `cVal` undefined,
         * which buildWhere dropped — so the query silently became the *first*
         * page again and the caller looped over page one forever. Rejecting a
         * malformed cursor turns an infinite loop into a 400.
         */
        if (!Array.isArray(decoded) || decoded.length < 1) {
          throw new YattaError(
            "Invalid cursor token provided to cursorPaginate()",
          );
        }
        if (decoded.some((v) => v !== null && typeof v === "object")) {
          throw new YattaError(
            "Invalid cursor token provided to cursorPaginate()",
          );
        }

        const [cVal, tbVal] = decoded;

        let cursorCond: WhereClause<T>;
        if (cursorCol === tieBreaker) {
          cursorCond = { [cursorCol]: { [direction === "asc" ? "gt" : "lt"]: cVal } } as any;
        } else {
          cursorCond = {
            OR: [
              { [cursorCol]: { [direction === "asc" ? "gt" : "lt"]: cVal } } as any,
              {
                AND: [
                  { [cursorCol]: cVal },
                  { [tieBreaker]: { [direction === "asc" ? "gt" : "lt"]: tbVal } },
                ],
              } as any,
            ],
          } as any;
        }

        where = Object.keys(userWhere).length > 0
          ? ({ AND: [userWhere, cursorCond] } as WhereClause<T>)
          : cursorCond;
      } catch {
        throw new YattaError("Invalid cursor token provided to cursorPaginate()");
      }
    }

    const orderBy: OrderBy<T>[] = [
      { [cursorCol]: direction } as any,
      ...(cursorCol !== tieBreaker ? [{ [tieBreaker]: direction } as any] : []),
    ];

    const items = this.findMany({
      where,
      orderBy,
      take: limit + 1,
      include: options.include,
    }) as any[];

    const hasMore = items.length > limit;
    const data = (hasMore ? items.slice(0, limit) : items) as R[];

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1] as any;
      const cursorTuple = [lastRow[cursorCol], lastRow[tieBreaker]];
      nextCursor = Buffer.from(JSON.stringify(cursorTuple)).toString("base64url");
    }

    return { data, nextCursor, hasMore };
  }

  // ── RELATION ALIASES ─────────────────────────────────────────────────────

  private resolveAliases(data: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const alias = this.belongsToAliases.get(k);
      if (alias) {
        out[alias.column] = v && typeof v === "object" && "id" in v ? (v as any).id : v;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ── INTERNAL BUILDERS ────────────────────────────────────────────────────

  private buildWhere(where?: WhereClause<T>): { clause: string; params: any[] } {
    if (!where || Object.keys(where).length === 0) return { clause: "", params: [] };

    const clauses: string[] = [];
    const params: any[] = [];

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
      if (key !== "AND" && key !== "OR" && this.columns.size > 0 && !this.columns.has(key)) {
        const known = [...this.columns.keys()].join(", ");
        throw new YattaError(
          `Column "${key}" does not exist on table "${this.name}". Available: ${known}`,
        );
      }

      const safeKey = `"${key.replace(/"/g, '""')}"`;

      if (key === "AND" || key === "OR") {
        if (!Array.isArray(val)) {
          throw new YattaError(`"${key}" condition must be an array of where clauses`);
        }
        if (val.length === 0) {
          clauses.push(key === "OR" ? "0 = 1" : "1 = 1");
          continue;
        }

        const nested = val.map((w) => this.buildWhere(w)).filter((n) => n.clause !== "");
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
              `Unknown filter operator "${opKey}" on "${this.name}.${key}". ` +
                `Supported: ${[...FILTER_OPS].join(", ")}`,
            );
          }
        }

        if (op.eq !== undefined) {
          if (op.eq === null) clauses.push(`${safeKey} IS NULL`);
          else { clauses.push(`${safeKey} = ?`); params.push(this.serializeValue(key, op.eq)); }
        }
        if (op.neq !== undefined) {
          if (op.neq === null) clauses.push(`${safeKey} IS NOT NULL`);
          else { clauses.push(`${safeKey} != ?`); params.push(this.serializeValue(key, op.neq)); }
        }

        if (op.gt !== undefined) { clauses.push(`${safeKey} > ?`); params.push(this.serializeValue(key, op.gt)); }
        if (op.gte !== undefined) { clauses.push(`${safeKey} >= ?`); params.push(this.serializeValue(key, op.gte)); }
        if (op.lt !== undefined) { clauses.push(`${safeKey} < ?`); params.push(this.serializeValue(key, op.lt)); }
        if (op.lte !== undefined) { clauses.push(`${safeKey} <= ?`); params.push(this.serializeValue(key, op.lte)); }

        if (op.like !== undefined) {
          clauses.push(`${safeKey} LIKE ?`);
          params.push(String(op.like));
        }
        if (op.contains !== undefined) {
          clauses.push(`${safeKey} LIKE ? ESCAPE '\\'`);
          params.push(`%${escapeLike(String(op.contains))}%`);
        }
        if (op.startsWith !== undefined) {
          clauses.push(`${safeKey} LIKE ? ESCAPE '\\'`);
          params.push(`${escapeLike(String(op.startsWith))}%`);
        }
        if (op.endsWith !== undefined) {
          clauses.push(`${safeKey} LIKE ? ESCAPE '\\'`);
          params.push(`%${escapeLike(String(op.endsWith))}`);
        }

        if (op.isNull === true) clauses.push(`${safeKey} IS NULL`);
        if (op.isNull === false) clauses.push(`${safeKey} IS NOT NULL`);

        if (op.in !== undefined) {
          if (!Array.isArray(op.in)) throw new YattaError(`"in" filter on "${key}" must be an array`);
          if (op.in.length === 0) {
            clauses.push("0 = 1");
          } else {
            clauses.push(`${safeKey} IN (${op.in.map(() => "?").join(", ")})`);
            params.push(...op.in.map((v) => this.serializeValue(key, v)));
          }
        }
        if (op.notIn !== undefined) {
          if (!Array.isArray(op.notIn)) throw new YattaError(`"notIn" filter on "${key}" must be an array`);
          if (op.notIn.length === 0) {
            clauses.push("1 = 1");
          } else {
            clauses.push(`${safeKey} NOT IN (${op.notIn.map(() => "?").join(", ")})`);
            params.push(...op.notIn.map((v) => this.serializeValue(key, v)));
          }
        }
      } else {
        clauses.push(`${safeKey} = ?`);
        params.push(this.serializeValue(key, val));
      }
    }

    return { clause: clauses.join(" AND "), params };
  }

  private buildOrderBy(orderBy?: OrderBy<T> | OrderBy<T>[]): string {
    if (!orderBy) return "";
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts: string[] = [];

    for (const ord of orders) {
      for (const [column, dir] of Object.entries(ord)) {
        if (this.columns.size > 0 && !this.columns.has(column)) {
          throw new YattaError(`Column "${column}" does not exist on table "${this.name}"`);
        }
        const cleanDir = String(dir).toUpperCase();
        if (cleanDir !== "ASC" && cleanDir !== "DESC") {
          throw new YattaError(`Invalid order direction "${dir}" for column "${column}"`);
        }
        parts.push(`"${column.replace(/"/g, '""')}" ${cleanDir}`);
      }
    }
    return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
  }

  private resolveRelations(rows: any[], include: Record<string, boolean>) {
    const tableRelations = this.db.relations[this.name];

    for (const [relName, enabled] of Object.entries(include)) {
      if (!enabled) continue;
      const configured = tableRelations?.[relName];

      if (configured) {
        if ("hasMany" in configured) {
          const ids = rows.map((r) => r[this.primaryKeyColumn]).filter((v) => v != null);
          if (ids.length === 0) {
            for (const row of rows) row[relName] = [];
            continue;
          }
          const children = this.db.table(configured.hasMany).findMany({ where: { [configured.foreignKey]: { in: ids } } as any });
          const grouped = new Map<any, any[]>();
          for (const child of children) {
            const parentId = (child as any)[configured.foreignKey];
            if (!grouped.has(parentId)) grouped.set(parentId, []);
            grouped.get(parentId)!.push(child);
          }
          for (const row of rows) row[relName] = grouped.get(row[this.primaryKeyColumn]) ?? [];
        } else if ("belongsTo" in configured) {
          // The parent holds the foreign key, so look up the referenced row.
          const targetTable = this.db.table(configured.belongsTo);
          const targetPk = targetTable.primaryKeyColumn;
          const foreignIds = rows.map((r) => r[configured.foreignKey]).filter((v) => v != null);
          if (foreignIds.length === 0) {
            for (const row of rows) row[relName] = null;
            continue;
          }
          const parents = targetTable.findMany({ where: { [targetPk]: { in: foreignIds } } as any });
          const map = new Map(parents.map((p) => [(p as any)[targetPk], p]));
          for (const row of rows) row[relName] = map.get(row[configured.foreignKey]) ?? null;
        } else {
          /*
           * hasOne, not belongsTo.
           *
           * Both branches used to read the foreign key off the *parent* row,
           * but a hasOne child holds the key, not the parent — so the lookup was
           * always undefined and the relation permanently resolved to null. The
           * direction is inverted: query the target table for rows whose
           * foreign key points back at each parent.
           */
          const childTable = this.db.table(configured.hasOne);
          const ids = rows.map((r) => r[this.primaryKeyColumn]).filter((v) => v != null);
          if (ids.length === 0) {
            for (const row of rows) row[relName] = null;
            continue;
          }

          const children = childTable.findMany({
            where: { [configured.foreignKey]: { in: ids } } as any,
          });

          // One row per parent. Several children means the schema does not
          // actually express a hasOne, so keep the first rather than silently
          // picking an arbitrary one per query.
          const firstByParent = new Map<any, any>();
          for (const child of children) {
            const parentId = (child as any)[configured.foreignKey];
            if (!firstByParent.has(parentId)) firstByParent.set(parentId, child);
          }

          const strays = children.length - firstByParent.size;
          for (const row of rows) {
            row[relName] = firstByParent.get(row[this.primaryKeyColumn]) ?? null;
          }
          if (strays > 0) {
            console.warn(
              `[yatta/db] hasOne "${this.name}.${relName}" matched ${strays} extra row(s) — a hasOne should resolve to at most one.`,
            );
          }
        }
        continue;
      }

      const auto = this.belongsToAliases.get(relName);
      if (auto) {
        const targetTable = this.db.table(auto.table);
        const targetPk = targetTable.primaryKeyColumn;
        const foreignIds = rows.map((r) => r[auto.column]).filter((v) => v != null);
        if (foreignIds.length === 0) {
          for (const row of rows) row[relName] = null;
          continue;
        }
        const parents = targetTable.findMany({ where: { [targetPk]: { in: foreignIds } } as any });
        const map = new Map(parents.map((p) => [(p as any)[targetPk], p]));
        for (const row of rows) row[relName] = map.get(row[auto.column]) ?? null;
        continue;
      }

      if (this.db.schema && relName in this.db.schema) {
        const otherTable = this.db.table(relName);
        for (const [colName, def] of otherTable.columns) {
          if (def.references?.table === this.name) {
            const ids = rows.map((r) => r[this.primaryKeyColumn]).filter((v) => v != null);
            if (ids.length === 0) {
              for (const row of rows) row[relName] = [];
              break;
            }
            const children = otherTable.findMany({ where: { [colName]: { in: ids } } as any });
            const grouped = new Map<any, any[]>();
            for (const child of children) {
              const parentId = (child as any)[colName];
              if (!grouped.has(parentId)) grouped.set(parentId, []);
              grouped.get(parentId)!.push(child);
            }
            for (const row of rows) row[relName] = grouped.get(row[this.primaryKeyColumn]) ?? [];
            break;
          }
        }
      }
    }
  }

  private serializeValue(column: string, v: unknown): unknown {
    if (v === undefined) return null;
    const def = this.columns.get(column);

    if (v === null) {
      if (def?.notNull && !def.primaryKey && !def.autoIncrement) {
        throw new YattaError(`Cannot set NULL on NOT NULL column "${column}" in table "${this.name}"`);
      }
      return null;
    }

    if (def?.isBoolean) return v ? 1 : 0;
    if (def?.isJson) {
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof Uint8Array) return v;

    if (typeof v === "object") {
      if (!def) return JSON.stringify(v);
      throw new YattaError(
        `Cannot serialize object for column "${column}" of type ${def.type} in table "${this.name}". Use col.json() for structured data.`,
      );
    }

    return v;
  }

  private deserializeRow(row: any): T {
    if (!row) return row;
    const out: any = { ...row };
    for (const key of Object.keys(out)) {
      const def = this.columns.get(key);
      if (def?.isBoolean) {
        out[key] = out[key] === null ? null : !!out[key];
        continue;
      }
      if (def?.isJson) {
        if (out[key] === null) continue;
        if (typeof out[key] === "string") {
          try { out[key] = JSON.parse(out[key]); } catch { /* leave as-is */ }
        }
        continue;
      }
      if (!def && typeof out[key] === "string" && (out[key].startsWith("{") || out[key].startsWith("["))) {
        try { out[key] = JSON.parse(out[key]); } catch { /* leave as-is */ }
      }
    }
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Main YattaDB Database Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Programmatic migration step definition.
 */
export interface Migration {
  /** Unique migration identifier (e.g. `"20260101_init"`). */
  name: string;
  /** Forward migration execution callback. */
  up: (db: YattaDB) => void | Promise<void>;
  /** Optional rollback migration callback. */
  down?: (db: YattaDB) => void | Promise<void>;
}

/**
 * Configuration options for initializing a {@link YattaDB} instance.
 */
export interface DatabaseOptions {
  /** File system path to the database (e.g. `"Database/app.db"`), or `":memory:"`. */
  path?: string;
  /** Full database table schema definition dictionary. */
  schema?: DatabaseSchema;
  /** Relational associations configuration for eager loading. */
  relations?: RelationsConfig;
  /** Whether to automatically create tables and alter missing columns on startup. Defaults to `true`. */
  autoMigrate?: boolean;
  /** Whether to log executed SQL queries with millisecond execution durations to stdout. */
  debug?: boolean;
  /** If `true`, creates a new instance even if a database at this path is already cached in registry. */
  forceNew?: boolean;
}

/**
 * Core SQLite database engine powered by `bun:sqlite`.
 * Manages connections, WAL mode, prepared statement caching, schema synchronization,
 * transactions, backups, and restores.
 */
export class YattaDB {
  private _sqlite: Database;
  /** Active database schema definition. */
  readonly schema: DatabaseSchema;
  /** Active relational associations graph. */
  readonly relations: RelationsConfig;
  /** Resolved filesystem path to the database file, or `":memory:"`. */
  readonly path: string;
  private readonly debug: boolean;
  private tables = new Map<string, Table<any, any>>();
  private stmtCache = new Map<string, Statement>();
  private static readonly MAX_STMT_CACHE = 500;

  /**
   * Initializes the database connection, enables WAL mode, sets pragmas,
   * and optionally synchronizes the schema.
   *
   * @param options Configuration options.
   */
  constructor(options: DatabaseOptions = {}) {
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

    this._sqlite = new Database(this.path, { create: true });
    this.schema = options.schema ?? {};
    this.relations = options.relations ?? {};
    this.debug = options.debug ?? false;

    this.applyPragmas();

    if (options.autoMigrate !== false && options.schema) this.syncSchema();
  }

  /**
   * Applies connection pragmas required for safe multi-process access.
   *
   * Required when several OS processes (e.g. cluster mode via `SO_REUSEPORT`,
   * or containers sharing a volume) write to the same database file:
   * - `journal_mode = WAL` lets readers proceed while a writer holds the lock.
   * - `busy_timeout` waits for a contended lock instead of throwing SQLITE_BUSY.
   * - `synchronous = NORMAL` is safe under WAL and avoids an fsync per commit.
   *
   * Must be re-applied after any connection is replaced (see `restore()`).
   */
  private applyPragmas(): void {
    this._sqlite.run("PRAGMA journal_mode = WAL;");
    this._sqlite.run("PRAGMA foreign_keys = ON;");
    this._sqlite.run("PRAGMA busy_timeout = 5000;");
    this._sqlite.run("PRAGMA synchronous = NORMAL;");
  }

  /**
   * Explicit resource management disposal hook (`using db = ...`).
   */
  [Symbol.dispose]() {
    this.close();
  }

  /**
   * Direct access to the underlying `bun:sqlite` Database instance.
   */
  get sqlite(): Database {
    return this._sqlite;
  }

  private getOrCreateTable(name: string): Table<any, any> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Table(name, this, this.schema[name]);
      this.tables.set(name, t);
    }
    return t;
  }

  /**
   * Returns a typed {@link Table} gateway for a defined schema table.
   *
   * @template T Row entity type.
   * @template TInsert Insertion payload type.
   * @param name Table name.
   * @throws {@link YattaError} if table is not defined in schema.
   */
  table<T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>>(
    name: string,
  ): Table<T, TInsert> {
    if (this.schema && Object.keys(this.schema).length > 0 && !(name in this.schema)) {
      throw new YattaError(
        `Table "${name}" is not defined in the schema. Use db.unsafeTable("${name}") to query untyped dynamic tables.`,
      );
    }
    return this.getOrCreateTable(name) as Table<T, TInsert>;
  }

  /**
   * Returns a {@link Table} gateway for an arbitrary or dynamically generated table not in the schema.
   *
   * @template T Row entity type.
   * @template TInsert Insertion payload type.
   * @param name Table name.
   */
  unsafeTable<T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>>(
    name: string,
  ): Table<T, TInsert> {
    return this.getOrCreateTable(name) as Table<T, TInsert>;
  }

  /**
   * Finalizes and purges all cached prepared statements.
   */
  clearStatementCache(): void {
    for (const stmt of this.stmtCache.values()) {
      try { stmt.finalize(); } catch {}
    }
    this.stmtCache.clear();
  }

  /**
   * Prepares (or retrieves from LRU cache) and executes an SQL statement with parameters.
   *
   * @param sql SQL query string.
   * @param params Parameter arguments.
   * @param mode Execution mode (`"get"` for single row, `"all"` for all rows, `"run"` for DML).
   * @returns Query result.
   */
  run(sql: string, params: any[] = [], mode: "get" | "all" | "run"): any {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
    } else {
      if (this.stmtCache.size >= YattaDB.MAX_STMT_CACHE) {
        const oldestKey = this.stmtCache.keys().next().value;
        if (oldestKey !== undefined) {
          try { this.stmtCache.get(oldestKey)?.finalize(); } catch {}
          this.stmtCache.delete(oldestKey);
        }
      }
      stmt = this._sqlite.prepare(sql);
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

  /**
   * Executes a callback within an atomic transaction.
   * If the callback throws, the transaction is automatically rolled back.
   *
   * @template R Return type.
   * @param fn Callback receiving transaction context.
   * @returns Value returned from the callback.
   *
   * @example
   * ```ts
   * const result = db.transaction((tx) => {
   *   tx.table("accounts").updateById(fromId, { balance: b1 });
   *   tx.table("accounts").updateById(toId, { balance: b2 });
   *   return true;
   * });
   * ```
   */
  /**
   * Runs `fn` inside a SQLite transaction.
   *
   * `fn` must be synchronous. bun:sqlite commits as soon as the callback
   * returns, so an async callback committed immediately and left its awaited
   * work running outside the transaction — a silent correctness failure, since
   * the caller received a resolved Promise and no error.
   *
   * A thenable return is therefore refused and the transaction rolled back,
   * rather than reported as a success.
   */
  transaction<R>(fn: (tx: this) => R): R {
    const result = this._sqlite.transaction(() => {
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

    return result;
  }

  // ── Raw SQL Suite ────────────────────────────────────────────────────────

  /**
   * Executes a raw SQL query and returns all matching rows.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns Array of resulting rows.
   */
  rawAll<R = any>(sql: string, params: any[] = []): R[] {
    return this.run(sql, params, "all") as R[];
  }

  /**
   * Executes a raw SQL query and returns the first row or `null`.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns Single row or `null`.
   */
  rawGet<R = any>(sql: string, params: any[] = []): R | null {
    return (this.run(sql, params, "get") as R) ?? null;
  }

  /**
   * Executes a raw DML/DDL statement returning affected changes and last inserted row id.
   *
   * @param sql SQL statement.
   * @param params Parameter values.
   * @returns Execution metadata (`lastInsertRowid`, `changes`).
   */
  rawRun(sql: string, params: any[] = []): { lastInsertRowid: number; changes: number } {
    return this.run(sql, params, "run");
  }

  /**
   * Executes raw SQL in the specified execution mode.
   *
   * @template R Row type.
   * @param sql SQL statement.
   * @param params Parameter values.
   * @param mode Execution mode (`"get"`, `"all"`, or `"run"`).
   */
  raw<R = any>(sql: string, params: any[] = [], mode: "get" | "all" | "run" = "all"): any {
    return this.run(sql, params, mode);
  }

  /**
   * Executes raw multi-statement SQL script directly on the database.
   * Clears prepared statement caches.
   *
   * @param sql SQL script.
   */
  exec(sql: string): { lastInsertRowid: number; changes: number } {
    this.clearStatementCache();
    return this._sqlite.run(sql) as unknown as {
      lastInsertRowid: number;
      changes: number;
    };
  }

  /**
   * Performs an SQLite database integrity inspection (`PRAGMA quick_check;`).
   *
   * @returns `true` if database integrity is healthy, `false` otherwise.
   */
  checkIntegrity(): boolean {
    const res = this._sqlite.query("PRAGMA quick_check;").get() as { quick_check: string } | null;
    return res?.quick_check === "ok";
  }

  // ── Safe Migrations ──────────────────────────────────────────────────────

  private buildColumnDefFragment(colName: string, def: ColumnDefinition, mode: "create" | "alter"): string {
    const safeName = colName.replace(/"/g, '""');
    let s = `"${safeName}" ${def.type}`;

    if (mode === "create") {
      if (def.primaryKey) s += " PRIMARY KEY";
      if (def.autoIncrement) s += " AUTOINCREMENT";
    } else if (def.primaryKey) {
      throw new YattaError(`Cannot add PRIMARY KEY column "${colName}" via ALTER TABLE in SQLite.`);
    }

    if (def.notNull) {
      if (mode === "alter" && def.defaultValue === undefined) {
        throw new YattaError(
          `Cannot add NOT NULL column "${colName}" without a default value in SQLite. ` +
            `Add .default(...) or make it .nullable().`,
        );
      }
      s += " NOT NULL";
    }

    if (mode === "create" && def.unique) s += " UNIQUE";
    if (def.defaultValue !== undefined) s += ` DEFAULT ${this.formatDefault(def)}`;
    if (def.references) {
      s += ` REFERENCES "${def.references.table.replace(/"/g, '""')}"("${def.references.column.replace(/"/g, '""')}")`;
      if (def.references.onDelete) s += ` ON DELETE ${def.references.onDelete}`;
    }
    if (def.checkValues?.length) {
      s += ` CHECK("${safeName}" IN (${def.checkValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}))`;
    }

    return s;
  }

  /**
   * Compares the defined TypeScript schema against the live SQLite tables and automatically:
   * 1. Creates missing tables with all specified columns, primary keys, and indexes.
   * 2. Adds newly added columns to existing tables safely via `ALTER TABLE ADD COLUMN`.
   * 3. Creates missing indexes.
   * 4. Validates foreign key integrity.
   */
  syncSchema(): void {
    const schemaHash = crypto.createHash("sha256").update(JSON.stringify(this.schema)).digest("hex").slice(0, 16);

    this._sqlite.run("PRAGMA foreign_keys = OFF;");

    try {
      // BEGIN IMMEDIATE, not the deferred BEGIN that transaction() issues.
      //
      // With a deferred transaction the write lock is acquired lazily, so two
      // processes migrating the same schema concurrently can deadlock. SQLite
      // detects that and returns SQLITE_BUSY *immediately*, without consulting
      // busy_timeout — which surfaced as an intermittent "database is locked"
      // crash on boot when several worker threads mounted the same schema.
      // Taking the write lock up front makes busy_timeout apply as intended.
      this._sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.syncSchemaBody(schemaHash);
        this._sqlite.exec("COMMIT");
      } catch (err) {
        try {
          this._sqlite.exec("ROLLBACK");
        } catch {
          // Already rolled back by SQLite.
        }
        throw err;
      }
    } finally {
      this._sqlite.run("PRAGMA foreign_keys = ON;");
      this.clearStatementCache();
    }
  }

  /**
   * Applies the schema inside an open transaction.
   * Split out from {@link syncSchema} so the lock handling stays readable.
   */
  private syncSchemaBody(schemaHash: string): void {
    {
        this._sqlite.run(`
          CREATE TABLE IF NOT EXISTS "_yatta_migrations" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            hash TEXT,
            applied_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);

        for (const [tableName, tableDef] of Object.entries(this.schema)) {
          const columnSqls: string[] = [];
          const indexSqls: string[] = [];
          const indexedCols = new Set<string>();

          for (const [colName, colBuilder] of Object.entries(tableDef)) {
            const def = colBuilder.def;
            columnSqls.push(this.buildColumnDefFragment(colName, def, "create"));

            if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
              indexedCols.add(colName);
              indexSqls.push(
                `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${colName}" ON "${tableName.replace(/"/g, '""')}" ("${colName.replace(/"/g, '""')}");`,
              );
            }
          }

          this._sqlite.run(`CREATE TABLE IF NOT EXISTS "${tableName.replace(/"/g, '""')}" (${columnSqls.join(", ")});`);

          const existingColumns = (this._sqlite.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all() as any[]).map(
            (c) => c.name,
          );

          for (const [colName, colBuilder] of Object.entries(tableDef)) {
            if (existingColumns.includes(colName)) continue;
            const def = colBuilder.def;

            const fragment = this.buildColumnDefFragment(colName, def, "alter");
            this._sqlite.run(`ALTER TABLE "${tableName.replace(/"/g, '""')}" ADD COLUMN ${fragment};`);

            this._sqlite
              .prepare(`INSERT OR IGNORE INTO "_yatta_migrations" (name, hash) VALUES (?, ?)`)
              .run(`alter:${tableName}.${colName}`, schemaHash);

            if (def.unique) {
              indexSqls.push(
                `CREATE UNIQUE INDEX IF NOT EXISTS "uniq_${tableName}_${colName}" ON "${tableName.replace(/"/g, '""')}" ("${colName.replace(/"/g, '""')}");`,
              );
            }
            if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
              indexedCols.add(colName);
              indexSqls.push(
                `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${colName}" ON "${tableName.replace(/"/g, '""')}" ("${colName.replace(/"/g, '""')}");`,
              );
            }
          }

          for (const idx of indexSqls) this._sqlite.run(idx);
        }

        const violations = this._sqlite.prepare("PRAGMA foreign_key_check;").all();
        if (violations.length > 0) {
          throw new YattaError(`Foreign key integrity check failed after schema sync: ${JSON.stringify(violations)}`);
        }
    }
  }

  /**
   * Applies programmatic migrations tracking applied versions in `_yatta_migrations`.
   *
   * @param migrations Array of {@link Migration} steps to evaluate.
   * @returns Object listing newly applied migration names.
   */
  async migrate(migrations: Migration[]): Promise<{ applied: string[] }> {
    this._sqlite.run(`
      CREATE TABLE IF NOT EXISTS "_yatta_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        hash TEXT,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const appliedRows = this._sqlite.prepare("SELECT name FROM _yatta_migrations").all() as { name: string }[];
    const appliedSet = new Set(appliedRows.map((r) => r.name));
    const newlyApplied: string[] = [];

    for (const m of migrations) {
      if (appliedSet.has(m.name)) continue;

      /*
       * `Migration.up` is typed `(db) => void | Promise<void>`, so a caller can
       * legitimately write an async migration.
       *
       * bun:sqlite commits the instant its transaction callback returns, so
       * wrapping a thenable in `transaction()` committed immediately: the awaited
       * statements ran *after* the commit and after the marker row was written,
       * so the migration was reported as applied even if it never finished, and
       * a throw inside it became an unhandled rejection instead of a rollback.
       *
       * So the two cases are handled separately. `up` is called exactly once,
       * in the branch that can actually honour it:
       *
       *   async  awaited to completion, then the marker recorded. No
       *          transaction — SQLite has no async transaction — so a failure
       *          propagates and leaves no marker, and the migration is retried
       *          on the next run.
       *   sync   body and marker share one real transaction, so a throw rolls
       *          back the schema change too.
       *
       * Asyncness is detected from the function itself rather than by calling
       * and inspecting the result, because calling twice would apply every
       * statement twice.
       */
      const isAsync = m.up.constructor.name === "AsyncFunction";

      if (isAsync) {
        await m.up(this);

        this._sqlite
          .prepare("INSERT INTO _yatta_migrations (name, hash) VALUES (?, ?)")
          .run(m.name, "migration");
      } else {
        this._sqlite.transaction(() => {
          m.up(this);
          this._sqlite
            .prepare("INSERT INTO _yatta_migrations (name, hash) VALUES (?, ?)")
            .run(m.name, "migration");
        })();
      }

      newlyApplied.push(m.name);
    }

    this.clearStatementCache();
    return { applied: newlyApplied };
  }

  private formatDefault(def: ColumnDefinition): string {
    if (def.defaultValue === null) return "NULL";

    if (def.defaultValue === "CURRENT_TIMESTAMP") {
      /*
       * Deliberately not SQLite's bare CURRENT_TIMESTAMP.
       *
       * That produces "2026-01-01 12:00:00" — a space, no `Z`, no
       * milliseconds — while every other write path puts `Date#toISOString()`
       * in the same column, giving "2026-01-01T12:00:00.000Z". The filter DSL
       * compares TEXT lexicographically, and ' ' (0x20) sorts before 'T' (0x54),
       * so a not-yet-updated row from a given day compared *less than* an
       * ISO row from the same day. Ordering and range filters silently lost
       * whichever rows had never been updated.
       *
       * This expression emits exactly the toISOString() format, so one column
       * holds one format.
       *
       * Note: a table created before this fix keeps its old DEFAULT. Change it
       * with `ALTER TABLE t ALTER COLUMN c SET DEFAULT
       * (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, and normalise stored rows.
       */
      return "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
    }
    if (typeof def.defaultValue === "number" || def.isBoolean) {
      return String(def.isBoolean ? (def.defaultValue ? 1 : 0) : def.defaultValue);
    }

    // A structured default must be serialized, not coerced. String(["user"]) is
    // "user", so the column got DEFAULT 'user' and every row written without an
    // explicit value read back as a bare string instead of an array. The value
    // is written as JSON here and parsed by the reader, so it round-trips.
    if (typeof def.defaultValue === "object") {
      return `'${JSON.stringify(def.defaultValue).replace(/'/g, "''")}'`;
    }

    return `'${String(def.defaultValue).replace(/'/g, "''")}'`;
  }

  // ── Atomic Backup & Validated Restore ─────────────────────────────────────

  /**
   * Performs an atomic online backup snapshot of the database using SQLite's `VACUUM INTO`.
   * Safe to run concurrently while readers and writers are active.
   *
   * @param destPath Destination file path for the backup.
   * @returns Object indicating success and destination path.
   *
   * @example
   * ```ts
   * db.backup("Database/backups/backup-2026-01-01.db");
   * ```
   */
  backup(destPath: string): { success: boolean; path: string } {
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
      this._sqlite.run(`VACUUM INTO '${escaped}';`);
      fs.renameSync(tempPath, destPath);
      return { success: true, path: destPath };
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
   *
   * @param backupPath File path to the SQLite backup to restore from.
   * @returns Object indicating success.
   * @throws {@link YattaError} if restore fails or backup is corrupt.
   */
  restore(backupPath: string): { success: boolean } {
    if (!fs.existsSync(backupPath)) throw new YattaError(`Backup file not found: ${backupPath}`);
    if (this.path === ":memory:") throw new YattaError("Cannot restore into an in-memory database.");

    let testDb: Database | null = null;
    try {
      testDb = new Database(backupPath, { readonly: true });
      const check = testDb.query("PRAGMA quick_check;").get() as { quick_check: string } | null;
      if (check?.quick_check !== "ok") {
        throw new Error("Backup file failed integrity check (corrupt or invalid SQLite file)");
      }
    } catch (err: any) {
      throw new YattaError(`Invalid or corrupt backup file: ${err.message}`);
    } finally {
      testDb?.close(true);
    }

    const tempPath = `${this.path}.restore.${Date.now()}`;
    const rollbackPath = `${this.path}.rollback.${Date.now()}`;

    try {
      fs.copyFileSync(backupPath, tempPath);

      this.clearStatementCache();
      this._sqlite.close(true);

      if (fs.existsSync(this.path)) {
        fs.renameSync(this.path, rollbackPath);
      }

      if (fs.existsSync(`${this.path}-wal`)) fs.unlinkSync(`${this.path}-wal`);
      if (fs.existsSync(`${this.path}-shm`)) fs.unlinkSync(`${this.path}-shm`);

      fs.renameSync(tempPath, this.path);

      if (fs.existsSync(rollbackPath)) {
        fs.unlinkSync(rollbackPath);
      }
    } catch (err: any) {
      if (fs.existsSync(rollbackPath)) {
        try { fs.renameSync(rollbackPath, this.path); } catch {}
      }
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new YattaError(`Restore failed and was rolled back: ${err.message}`);
    } finally {
      this._sqlite = new Database(this.path, { create: true });
      this.applyPragmas();
    }

    return { success: true };
  }

  /**
   * Closes the SQLite database connection, frees prepared statements,
   * and unregisters this instance from the global cache.
   */
  close(): void {
    this.clearStatementCache();
    this._sqlite.close(true);

    /*
     * Evict by the underlying handle, not by identity.
     *
     * createDatabase registers the *proxy*, so `registry.get(path) === this`
     * was never true: a closed database stayed in the registry and became the
     * default, and the next createDatabase for that path handed back a closed
     * connection that threw "Cannot use a closed database". Comparing the
     * underlying `_sqlite` handles matches the proxy to its target.
     */
    const registered = dbRegistry.get(this.path) as any;
    if (registered === this || registered?._sqlite === this._sqlite) {
      dbRegistry.delete(this.path);
    }

    const current = getDefaultDatabase() as any;
    if (current === this || current?._sqlite === this._sqlite) {
      setDefaultDatabase(null);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Typed Database Proxy & Global Registry
// ──────────────────────────────────────────────────────────────────────────

/**
 * Type-safe database interface offering table properties (`db.users`),
 * callable table lookup (`db("users")`), and raw SQL / administration methods.
 *
 * @template S Database schema type.
 */
export type TypedDatabase<S extends DatabaseSchema = DatabaseSchema> = YattaDB & {
  readonly [K in keyof S]: Table<InferRow<S[K]>, InferInsert<S[K]>>;
} & {
  <K extends keyof S>(tableName: K): Table<InferRow<S[K]>, InferInsert<S[K]>>;
  (): TypedDatabase<S>;
  (tableName: string): Table<any, any>;
};

const REGISTRY_KEY = Symbol.for("yatta.db.registry");
const DEFAULT_DB_KEY = Symbol.for("yatta.db.default");

const g = globalThis as unknown as {
  [REGISTRY_KEY]?: Map<string, TypedDatabase<any>>;
  [DEFAULT_DB_KEY]?: TypedDatabase<any> | null;
};

if (!g[REGISTRY_KEY]) {
  g[REGISTRY_KEY] = new Map<string, TypedDatabase<any>>();
}
const dbRegistry: Map<string, TypedDatabase<any>> = g[REGISTRY_KEY]!;

function getDefaultDatabase(): TypedDatabase<any> | null {
  return g[DEFAULT_DB_KEY] ?? (dbRegistry.size > 0 ? dbRegistry.values().next().value ?? null : null);
}

function setDefaultDatabase(db: TypedDatabase<any> | null): void {
  g[DEFAULT_DB_KEY] = db;
}

/**
 * Resolves and normalizes an input database path to an absolute filesystem path.
 *
 * @param targetPath Relative or absolute path, or `":memory:"`.
 * @returns Absolute filesystem path or `":memory:"`.
 */
export function resolveDatabasePath(targetPath?: string): string {
  const p = targetPath ?? "Database/app.db";
  if (p === ":memory:") return ":memory:";
  const hasExtension = path.extname(p) !== "";
  const normalized = (!hasExtension || p.endsWith("/") || p.endsWith("\\"))
    ? path.join(p, "app.db")
    : p;
  return path.resolve(process.cwd(), normalized);
}

/** Automatically discovers and loads a database file if not yet imported */
function tryAutoLoadDatabase(): void {
  if (getDefaultDatabase()) return;

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "src", "database", "db.ts"),
    path.join(cwd, "src", "database", "db.js"),
    path.join(cwd, "src", "database", "index.ts"),
    path.join(cwd, "src", "database", "index.js"),
    path.join(cwd, "src", "db.ts"),
    path.join(cwd, "src", "db", "index.ts"),
    path.join(cwd, "database", "db.ts"),
    path.join(cwd, "db.ts"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        require(candidate);
        if (getDefaultDatabase()) break;
      } catch (err) {
        console.warn(`[yatta-db] Note: Auto-loading "${candidate}" encountered:`, err);
      }
    }
  }
}

/**
 * Creates, configures, and synchronizes a type-safe {@link TypedDatabase} instance.
 *
 * Automatically:
 * - Initializes WAL mode and foreign keys in SQLite
 * - Synchronizes schemas, creating missing tables and columns
 * - Returns a typed proxy allowing direct `db.users` table access
 * - Registers the database globally for zero-import `DB` usage
 *
 * @template S Database schema type.
 * @param options Database configuration options.
 * @returns Configured {@link TypedDatabase} instance.
 *
 * @example
 * ```ts
 * import { col, createDatabase } from "./db";
 *
 * export const schema = {
 *   users: {
 *     id: col.uuid(),
 *     name: col.text(),
 *     email: col.text().unique(),
 *     createdAt: col.createdAt(),
 *   },
 * };
 *
 * export const db = createDatabase({
 *   path: "Database/app.db",
 *   schema,
 * });
 *
 * const user = db.users.insert({ name: "Bob", email: "bob@example.com" });
 * ```
 */
export function createDatabase<S extends DatabaseSchema = DatabaseSchema>(
  options: DatabaseOptions & { schema?: S } = {},
): TypedDatabase<S> {
  const resolvedPath = resolveDatabasePath(options.path);

  if (!options.forceNew && dbRegistry.has(resolvedPath)) {
    const cached = dbRegistry.get(resolvedPath) as TypedDatabase<S>;
    setDefaultDatabase(cached as unknown as TypedDatabase<any>);
    return cached;
  }

  const db = new YattaDB(options);

  if (options.schema) {
    for (const tableName of Object.keys(options.schema)) {
      if (tableName in db) {
        throw new YattaError(
          `Table name "${tableName}" collides with a reserved YattaDB property/method. ` +
            `Rename the table, or access it explicitly via db.table("${tableName}") instead.`,
        );
      }
    }
  }

  const targetFn = function (tableName?: string) {
    if (!tableName) return proxy;
    return db.table(tableName);
  };

  const proxy = new Proxy(targetFn, {
    get(_target, prop, receiver) {
      if (prop === "transaction") {
        return function <R>(fn: (tx: TypedDatabase<S>) => R): R {
          return db.transaction(() => fn(proxy as unknown as TypedDatabase<S>));
        };
      }
      if (prop in db) {
        const val = (db as any)[prop];
        return typeof val === "function" ? val.bind(db) : val;
      }
      if (typeof prop === "string" && db.schema && prop in db.schema) {
        return db.table(prop);
      }
      return Reflect.get(db, prop, receiver);
    },
    set(_target, prop, value) {
      (db as any)[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in db || (typeof prop === "string" && !!db.schema && prop in db.schema);
    },
    apply(_target, _thisArg, argArray) {
      const [tableName] = argArray;
      if (!tableName) return proxy;
      return db.table(tableName);
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(db);
    },
  }) as unknown as TypedDatabase<S>;

  dbRegistry.set(resolvedPath, proxy as unknown as TypedDatabase<any>);
  setDefaultDatabase(proxy as unknown as TypedDatabase<any>);

  return proxy;
}

// ──────────────────────────────────────────────────────────────────────────
// 8. 100% Type-Safe DB Accessor via Declaration Merging
// ──────────────────────────────────────────────────────────────────────────

/**
 * Callable signature of the global `DB` accessor.
 *
 * @template S Registered database schema.
 */
export interface DBFunction<S extends DatabaseSchema = RegisteredSchema> {
  <CustomSchema extends DatabaseSchema = S>(): TypedDatabase<CustomSchema>;
  <K extends keyof S>(tableName: K): Table<InferRow<S[K]>, InferInsert<S[K]>>;
  <T extends Record<string, any> = Record<string, any>, TInsert extends Record<string, any> = Partial<T>>(
    tableName: string,
  ): Table<T, TInsert>;
}

/**
 * Combined type of the global `DB` accessor: function call, table property accessors, and YattaDB engine methods.
 *
 * @template S Registered database schema.
 */
export type DBProxy<S extends DatabaseSchema = RegisteredSchema> = DBFunction<S> & {
  readonly [K in keyof S]: Table<InferRow<S[K]>, InferInsert<S[K]>>;
} & YattaDB;

const dbCaller = function (tableOrPath?: string) {
  let activeDb = getDefaultDatabase();
  if (!activeDb) {
    tryAutoLoadDatabase();
    activeDb = getDefaultDatabase();
  }

  if (!activeDb) {
    throw new YattaError(
      `Database has not been initialized yet.\n` +
        `To fix this:\n` +
        `  1. In "src/main.ts", import your database setup: import "./database/db";\n` +
        `  2. Or in this file, import "db" directly: import { db } from "../database/db";`,
    );
  }

  if (!tableOrPath) {
    return activeDb;
  }

  if (dbRegistry.has(tableOrPath)) {
    return dbRegistry.get(tableOrPath);
  }
  const resolved = resolveDatabasePath(tableOrPath);
  if (dbRegistry.has(resolved)) {
    return dbRegistry.get(resolved);
  }

  return activeDb.table(tableOrPath);
};

/**
 * 100% Type-Safe Global Database Accessor.
 *
 * When augmented via `declare module "../types/db" { interface Register { schema: typeof schema } }`,
 * provides complete intellisense and type-safety across all files in your project without needing
 * to pass `db` instances around.
 *
 * @example
 * ```ts
 * import { DB } from "./db";
 *
 * // Direct typed access with full autocomplete:
 * const users = DB.users.findMany();
 * const count = DB.users.count();
 * const table = DB("users");
 * ```
 */
export const DB: DBProxy = new Proxy(dbCaller, {
  apply(_target, _thisArg, argArray) {
    return dbCaller(argArray[0]);
  },
  get(_target, prop, receiver) {
    if (prop === "name" || prop === "length" || prop === "prototype" || prop === Symbol.toPrimitive) {
      return Reflect.get(_target, prop, receiver);
    }

    let activeDb = getDefaultDatabase();
    if (!activeDb) {
      tryAutoLoadDatabase();
      activeDb = getDefaultDatabase();
    }

    if (!activeDb) {
      throw new YattaError(
        `Database has not been initialized yet. Cannot access "DB.${String(prop)}".\n` +
          `To fix this:\n` +
          `  1. In "src/main.ts", import your database setup: import "./database/db";\n` +
          `  2. Or import "db" directly from your database file: import { db } from "../database/db";`,
      );
    }

    return (activeDb as any)[prop];
  },
}) as unknown as DBProxy;