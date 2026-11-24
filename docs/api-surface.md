# Yatta.js DB public API surface

Frozen 2026-11-24 (Step 0 of the multi-database ORM refactor, Phase 1).
Source: `src/types/db.ts` — every `export` at the top level, extracted
mechanically (`grep -n "^export"`). The public entry point is `yatta.js/db`
(`package.json` exports `"./db": "./src/types/db.ts"`).

Every name on this list must still be importable with the same type after
Phase 1 (the split of `src/types/db.ts` into modules with `db.ts` as a
barrel). `src/test/db.api-surface.test.ts` guards it.

## Step 3 additions (2026-11-24)

The adapter contract is public API: `createAdapter`, the `DatabaseAdapter` /
`DatabaseSession` interfaces, the mode and capability types, the compiled
query shapes, and the per-driver options types (17 names, 43 → 60).
`SqliteAdapter` / `SqliteSession` are exported like `YattaDB` / `Table`
(concrete classes, not just interfaces). `DatabaseOptions` is now a union
(`SqliteDatabaseOptions | PgliteDatabaseOptions`); the members are NOT
exported — users write `DatabaseOptions` only.

## Names (43 unique, 45 export lines — `connect` has 3 overloads)

| Name | Kind | Line |
|---|---|---|
| YattaError | class | 135 |
| Prettify | type | 149 |
| Register | interface | 164 |
| RegisteredSchema | type | 172 |
| SQLiteType | type | 183 |
| ColumnDefinition | interface | 188 |
| ColumnBuilder | class | 228 |
| col | const (builders) | 464 |
| TableSchema | type | 592 |
| DatabaseSchema | type | 597 |
| InferRow | type | 608 |
| InferInsert | type | 629 |
| RelationDefinition | type | 634 |
| RelationsConfig | type | 642 |
| FilterOperator | type | 673 |
| FieldFilter | type | 696 |
| WhereClause | type | 714 |
| OrderDirection | type | 722 |
| OrderBy | type | 725 |
| FindOptions | interface | 733 |
| PaginateOptions | interface | 753 |
| PaginatedResult | interface | 778 |
| CursorPaginateOptions | interface | 796 |
| CursorPaginatedResult | interface | 818 |
| SearchHit | interface | 835 |
| SearchOptions | interface | 845 |
| UpsertOptions | interface | 883 |
| Condition | class | 909 |
| and | function | 963 |
| or | function | 998 |
| connect | function (3 overloads) | 1021–1023 |
| FieldsProxy | type | 1066 |
| QueryBuilder | class | 1135 |
| Table | class | 1445 |
| Migration | interface | 2707 |
| DatabaseOptions | interface | 2719 |
| YattaDB | class | 2746 |
| TypedDatabase | type | 4271 |
| resolveDatabasePath | function | 4306 |
| createDatabase | function | 4378 |
| DBFunction | interface | 4455 |
| DBProxy | type | 4468 |
| DB | const (global proxy) | 4520 |
| createAdapter | function (3 overloads) | src/types/db/adapter.ts |
| SqliteAdapter | class | src/types/db/adapters/sqlite.ts |
| SqliteSession | class | src/types/db/adapters/sqlite.ts |
| RelationalDriverName | type | src/types/db/adapter.ts |
| DriverName | type | src/types/db/adapter.ts |
| ExecutionMode | type | src/types/db/adapter.ts |
| ModeResult | type | src/types/db/adapter.ts |
| AdapterCapabilities | interface | src/types/db/adapter.ts |
| CompiledFindQuery | interface | src/types/db/adapter.ts |
| CompiledUpsertPlan | interface | src/types/db/adapter.ts |
| CompiledSearchQuery | interface | src/types/db/adapter.ts |
| TransactionOptions | interface | src/types/db/adapter.ts |
| QueryResult | interface | src/types/db/adapter.ts |
| IntrospectedColumn | interface | src/types/db/adapter.ts |
| DatabaseSession | interface | src/types/db/adapter.ts |
| DatabaseAdapter | interface | src/types/db/adapter.ts |
| SqliteAdapterOptions | interface | src/types/db/adapter.ts |
| PgliteAdapterOptions | interface | src/types/db/adapter.ts |

## Names (60 unique — 43 frozen at Step 0 + 17 added at Step 3)

## Notes

- `DatabaseOptions` is a union since Step 3: `SqliteDatabaseOptions`
  (`driver?: "sqlite"`, path, schema, relations, autoMigrate, debug,
  searchSynonyms, forceNew) | `PgliteDatabaseOptions` (`driver: "pglite"`,
  dataDir, pool, acquireTimeoutMs, plus the shared fields). The members
  are NOT exported — users write `DatabaseOptions` only. `createDatabase`
  with `driver: "pglite"` throws until Phase 2 implements it.
- There is **no** `MaybePromise` / `TypedDatabase<S, M>` dual-mode type.
  The ORM is fully synchronous today. The mode-generic core (`YattaDB<M>` /
  `Table<M>` with `ModeResult`, so sync callers are unaffected) lands in
  Phase 2 with the first async driver — Phase 1 is the sync seam only.
  The adapter *interface* is already mode-generic (`DatabaseSession<M>`).
- `YattaError` is `constructor(message: string, sql?: string)` — it has
  **no `code` field**. Adapters throw it with a message (and the SQL as
  the second argument where one exists).
- `src/func/db.ts` (the app's default schema + `db` singleton) is a
  separate 93-line file; it re-exports `col`, `createDatabase`, `connect`
  from `src/types/db.ts`.
