// Column definitions and the type-safe schema builder (col.*).
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).

import { YattaError } from "./errors";

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
  /** Whether this column is the table's time-series timestamp (see `.timeSeries()`). */
  isTimeSeries?: boolean;
  /** Whether the column is indexed for full-text search (see `.searchable()`). */
  isSearchable?: boolean;
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
   * Marks this column as the table's time-series timestamp.
   *
   * A time-series table holds append-mostly rows stamped with a time, and
   * is read back in time order or by time range. Marking the timestamp
   * column gives the table a dedicated index on that column at schema
   * sync, so time-ordered reads and range scans use the index instead of
   * sorting the whole table. A table with no marked column is untouched:
   * the write path is exactly the existing one.
   *
   * Only integer (milliseconds since epoch) and text (ISO timestamp)
   * columns can be marked: those are the two timestamp shapes the schema
   * layer already uses. One marked column per table; rollups read the
   * marked column when a policy does not name its time column.
   *
   * @example
   * ```ts
   * readings: {
   *   id: col.id(),
   *   at: col.integer().timeSeries(),
   *   value: col.real(),
   * },
   * ```
   */
  timeSeries(): ColumnBuilder<V, Optional, IsRef> {
    if (this.def.type !== "INTEGER" && this.def.type !== "TEXT") {
      throw new YattaError(
        "timeSeries() is only for integer or text timestamp columns. " +
          "Store the timestamp as milliseconds since epoch (integer) or an ISO string (text).",
      );
    }
    if (this.def.isJson || this.def.isUuid || this.def.isBoolean) {
      throw new YattaError("timeSeries() cannot mark a JSON, UUID, or boolean column as a timestamp.");
    }
    return this.clone<V, Optional, IsRef>({ isTimeSeries: true });
  }

  /**
   * Marks this column as full-text searchable.
   *
   * Only plain text columns can be searchable: the FTS5 index tokenizes text,
   * so a number, boolean, JSON blob, or auto-generated UUID would index
   * meaningless tokens. Marking one of those is a schema mistake, so it throws
   * here at definition time instead of silently indexing junk.
   *
   * @example
   * ```ts
   * title: col.text().searchable(),
   * body: col.text().searchable(),
   * ```
   */
  searchable(): ColumnBuilder<V, Optional, IsRef> {
    if (this.def.type !== "TEXT" || this.def.isJson || this.def.isUuid) {
      throw new YattaError(
        "searchable() is only for plain text columns. " +
          "Numbers, booleans, JSON columns, and UUID keys cannot be full-text indexed.",
      );
    }
    return this.clone<V, Optional, IsRef>({ isSearchable: true });
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

