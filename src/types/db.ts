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
 *  - `db.vectors`: Vector search (see `src/types/vectors.ts`): store embeddings
 *    and search by cosine similarity, backed by sqlite-vec when a `vec0`
 *    binary is loadable, plain SQLite otherwise. Text embeddings are
 *    optional and lazy (see `src/types/vectors_embed.ts`).
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

// Public entry point for the database layer (yatta.js/db).
// The implementation lives in src/types/db/*; this file only re-exports
// the public names (see docs/api-surface.md). Internal helpers are NOT
// re-exported here even though the modules export them for each other.

export { YattaError } from "./db/errors";
export {
  ColumnBuilder,
  col,
  type ColumnDefinition,
  type DatabaseSchema,
  type InferInsert,
  type InferRow,
  type Prettify,
  type Register,
  type RegisteredSchema,
  type RelationDefinition,
  type RelationsConfig,
  type SQLiteType,
  type TableSchema,
} from "./db/schema";
export {
  Condition,
  QueryBuilder,
  and,
  or,
  type CursorPaginatedResult,
  type CursorPaginateOptions,
  type FieldFilter,
  type FieldsProxy,
  type FilterOperator,
  type FindOptions,
  type OrderBy,
  type OrderDirection,
  type PaginateOptions,
  type PaginatedResult,
  type SearchHit,
  type SearchOptions,
  type UpsertOptions,
  type WhereClause,
} from "./db/query";
export { Table } from "./db/table";
export {
  YattaDB,
  type DatabaseOptions,
  type Migration,
} from "./db/engine";
export {
  DB,
  connect,
  createDatabase,
  resolveDatabasePath,
  type AsyncDBFunction,
  type AsyncDBProxy,
  type AsyncTypedDatabase,
  type DBFunction,
  type DBProxy,
  type TypedDatabase,
} from "./db/factory";
export {
  DuckDBAdapter,
  DuckDBSession,
  PGliteAdapter,
  PGliteSession,
  SqliteAdapter,
  SqliteSession,
  SurrealDBAdapter,
  SurrealDBSession,
  TursoAdapter,
  TursoSession,
  createAdapter,
  type AdapterCapabilities,
  type CompiledFindQuery,
  type CompiledSearchQuery,
  type CompiledUpsertPlan,
  type DatabaseAdapter,
  type DatabaseSession,
  type DriverName,
  type DuckDBAdapterOptions,
  type ExecutionMode,
  type IntrospectedColumn,
  type ModeResult,
  type PgliteAdapterOptions,
  type QueryResult,
  type RelationalDriverName,
  type SqliteAdapterOptions,
  type SurrealDBAdapterOptions,
  type TransactionOptions,
  type TursoAdapterOptions,
} from "./db/adapter";
