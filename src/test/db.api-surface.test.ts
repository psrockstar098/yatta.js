// API-surface guard for the multi-database ORM refactor (Phase 1, Step 0).
//
// Every name on docs/api-surface.md must still be importable from
// "../types/db" with the same type after src/types/db.ts is split into
// modules with db.ts as a barrel. This test does not test behaviour —
// it tests that the barrel still exports the same names. Keep it as a
// permanent guard; do not delete it at the end of Phase 1.
import { describe, it, expect } from "bun:test";
import {
  YattaError,
  ColumnBuilder,
  col,
  Condition,
  and,
  or,
  connect,
  QueryBuilder,
  Table,
  YattaDB,
  resolveDatabasePath,
  createDatabase,
  DB,
  type Prettify,
  type Register,
  type RegisteredSchema,
  type SQLiteType,
  type ColumnDefinition,
  type TableSchema,
  type DatabaseSchema,
  type InferRow,
  type InferInsert,
  type RelationDefinition,
  type RelationsConfig,
  type FilterOperator,
  type FieldFilter,
  type WhereClause,
  type OrderDirection,
  type OrderBy,
  type FindOptions,
  type PaginateOptions,
  type PaginatedResult,
  type CursorPaginateOptions,
  type CursorPaginatedResult,
  type SearchHit,
  type SearchOptions,
  type UpsertOptions,
  type FieldsProxy,
  type Migration,
  type DatabaseOptions,
  type TypedDatabase,
  type DBFunction,
  type DBProxy,
  // Step 3 (2026-11-24, deliberate addition): the adapter contract is
  // public API. These names are pinned here so the addition is explicit,
  // not accidental drift.
  createAdapter,
  SqliteAdapter,
  SqliteSession,
  type AdapterCapabilities,
  type CompiledFindQuery,
  type CompiledSearchQuery,
  type CompiledUpsertPlan,
  type DatabaseAdapter,
  type DatabaseSession,
  type DriverName,
  type ExecutionMode,
  type IntrospectedColumn,
  type ModeResult,
  type PgliteAdapterOptions,
  type QueryResult,
  type RelationalDriverName,
  type SqliteAdapterOptions,
  type TransactionOptions,
} from "../types/db";

describe("db API surface (refactor guard)", () => {
  it("exports every value name from docs/api-surface.md", () => {
    expect(typeof YattaError).toBe("function");
    expect(typeof ColumnBuilder).toBe("function");
    expect(typeof col).toBe("object");
    expect(typeof Condition).toBe("function");
    expect(typeof and).toBe("function");
    expect(typeof or).toBe("function");
    expect(typeof connect).toBe("function");
    expect(typeof QueryBuilder).toBe("function");
    expect(typeof Table).toBe("function");
    expect(typeof YattaDB).toBe("function");
    expect(typeof resolveDatabasePath).toBe("function");
    expect(typeof createDatabase).toBe("function");
    // DB is a Proxy over a callable: typeof is "function".
    expect(typeof DB).toBe("function");
    // Step 3: the adapter factory and concrete classes.
    expect(typeof createAdapter).toBe("function");
    expect(typeof SqliteAdapter).toBe("function");
    expect(typeof SqliteSession).toBe("function");
  });

  it("exports every type name from docs/api-surface.md (compile-time)", () => {
    // Each assignment below compiles only if the type is exported.
    // The values are never used at runtime.
    const _prettify: Prettify<{ a: 1 }> = { a: 1 };
    const _register: Register = null as unknown as Register;
    const _registered: RegisteredSchema = null as unknown as RegisteredSchema;
    const _sqliteType: SQLiteType = "TEXT";
    const _colDef: ColumnDefinition = null as unknown as ColumnDefinition;
    const _tableSchema: TableSchema = { id: col.id() };
    const _dbSchema: DatabaseSchema = { users: _tableSchema };
    const _inferRow: InferRow<typeof _tableSchema> = null as unknown as InferRow<typeof _tableSchema>;
    const _inferInsert: InferInsert<typeof _tableSchema> = null as unknown as InferInsert<typeof _tableSchema>;
    const _relDef: RelationDefinition = null as unknown as RelationDefinition;
    const _relConfig: RelationsConfig = {};
    const _filterOp: FilterOperator<number> = null as unknown as FilterOperator<number>;
    const _fieldFilter: FieldFilter<number> = 1;
    const _where: WhereClause<{ age: number }> = { age: { gt: 18 } };
    const _orderDir: OrderDirection = "asc";
    const _orderBy: OrderBy<{ age: number }> = { age: "desc" };
    const _findOpts: FindOptions<{ age: number }> = { where: _where };
    const _paginate: PaginateOptions<{ age: number }> = { page: 1, limit: 10 };
    const _paginated: PaginatedResult<{ age: number }> = null as unknown as PaginatedResult<{ age: number }>;
    const _cursorPaginate: CursorPaginateOptions<{ age: number }> = {};
    const _cursorPaginated: CursorPaginatedResult<{ age: number }> = null as unknown as CursorPaginatedResult<{ age: number }>;
    const _hit: SearchHit<{ age: number }> = null as unknown as SearchHit<{ age: number }>;
    const _searchOpts: SearchOptions<{ age: number }> = {};
    const _upsertOpts: UpsertOptions<{ age: number }> = null as unknown as UpsertOptions<{ age: number }>;
    const _fields: FieldsProxy<{ age: number }> = null as unknown as FieldsProxy<{ age: number }>;
    const _migration: Migration = { name: "x", up: () => {} };
    const _dbOpts: DatabaseOptions = { path: ":memory:" };
    const _typedDb: TypedDatabase<typeof _dbSchema> = null as unknown as TypedDatabase<typeof _dbSchema>;
    const _dbFn: DBFunction<typeof _dbSchema> = null as unknown as DBFunction<typeof _dbSchema>;
    const _dbProxy: DBProxy<typeof _dbSchema> = null as unknown as DBProxy<typeof _dbSchema>;
    // Step 3: the adapter contract types (compile-time only).
    const _relDriver: RelationalDriverName = "sqlite";
    const _driver: DriverName = "scylladb";
    const _mode: ExecutionMode = "sync";
    const _modeResult: ModeResult<"sync", number> = 1;
    const _caps: AdapterCapabilities = null as unknown as AdapterCapabilities;
    const _findQ: CompiledFindQuery = {};
    const _upsertPlan: CompiledUpsertPlan = null as unknown as CompiledUpsertPlan;
    const _searchQ: CompiledSearchQuery = { tokens: [], expandedGroups: [], columns: [], typoCorrection: false };
    const _txOpts: TransactionOptions = {};
    const _queryResult: QueryResult = { rows: [], affectedRows: 0 };
    const _introCol: IntrospectedColumn = { name: "id", type: "INTEGER", nullable: false, primaryKey: true };
    const _session: DatabaseSession<"sync"> = null as unknown as DatabaseSession<"sync">;
    const _adapter: DatabaseAdapter<"sync"> = null as unknown as DatabaseAdapter<"sync">;
    const _sqliteOpts: SqliteAdapterOptions = { path: ":memory:" };
    const _pgliteOpts: PgliteAdapterOptions = { dataDir: "/tmp/pg" };
    expect([
      _prettify, _register, _registered, _sqliteType, _colDef, _tableSchema,
      _dbSchema, _inferRow, _inferInsert, _relDef, _relConfig, _filterOp,
      _fieldFilter, _where, _orderDir, _orderBy, _findOpts, _paginate,
      _paginated, _cursorPaginate, _cursorPaginated, _hit, _searchOpts,
      _upsertOpts, _fields, _migration, _dbOpts, _typedDb, _dbFn, _dbProxy,
      _relDriver, _driver, _mode, _modeResult, _caps, _findQ, _upsertPlan,
      _searchQ, _txOpts, _queryResult, _introCol, _session, _adapter,
      _sqliteOpts, _pgliteOpts,
    ].length).toBe(45);
  });
});
