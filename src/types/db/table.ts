// Type-safe CRUD table gateway.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).

import crypto from "node:crypto";
import { YattaError } from "./errors";
import type { ColumnDefinition, Prettify, TableSchema } from "./schema";
import {
  QueryBuilder,
  buildFieldsProxy,
  type Condition,
  type CursorPaginatedResult,
  type CursorPaginateOptions,
  type FieldsProxy,
  type FindOptions,
  type OrderBy,
  type PaginatedResult,
  type PaginateOptions,
  type SearchHit,
  type SearchOptions,
  type UpsertOptions,
  type WhereClause,
} from "./query";
import { correctTypo, normalizeSynonyms, tokenizeText } from "./search";
import type { YattaDB } from "./engine";
import {
  allResults,
  chainResult,
  modeValue,
  runSequential,
  type CompiledSearchQuery,
  type ExecutionMode,
  type ModeResult,
} from "./adapter";

// ──────────────────────────────────────────────────────────────────────────
// 5. Table Gateway
// ──────────────────────────────────────────────────────────────────────────

function deriveAlias(colName: string): string | null {
  if (colName.length > 2 && colName.endsWith("Id")) return colName.slice(0, -2);
  if (colName.length > 3 && colName.endsWith("_id")) return colName.slice(0, -3);
  return null;
}

/**
 * Clamps a page or limit to a usable positive integer.
 *
 * `Math.max(1, NaN)` is `NaN`, so `{ page: Number(req.query.page) }` — the ordinary
 * shape when the parameter is absent — carried NaN into the offset and surfaced as
 * SQLite complaining about a column named NaN. A non-finite value now takes the
 * documented default, and a fractional one is floored instead of becoming a fractional
 * OFFSET.
 */
function pageCount(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.floor(value));
}

/**
 * Type-safe CRUD table gateway providing querying, insertions, updates, deletions,
 * aggregations, relational joins, and pagination.
 *
 * Generic over the execution mode `M`: `"sync"` for SQLite (every method
 * returns its plain value, exactly as before) and `"async"` for PGlite,
 * Turso, DuckDB, and SurrealDB (every method returns a Promise). The mode
 * follows the driver, so sync callers keep sync types and async callers
 * are forced by TypeScript to await.
 *
 * Two execution paths, chosen by the adapter's capabilities:
 * - `compilerSql` drivers (SQLite, PGlite, Turso, DuckDB): Table compiles
 *   SQL through the dialect's compiler and executes it via `db.run`, as
 *   before. Search uses the FTS5 SQL path when `fullTextSearch` is
 *   `"fts5"`, and the adapter's `search()` otherwise.
 * - SurrealDB (`compilerSql: false`): its dialect refuses every
 *   SQL-emitting compiler method, so Table uses the session's
 *   `insert` / `find` / `count` / `update` / `delete` / `search`
 *   methods with dialect-neutral `Compiled*` shapes instead. Full-text
 *   index maintenance is a no-op there (the engine maintains its own
 *   BM25 indexes), so the FTS sync calls below resolve immediately.
 *
 * @template T Full row record type.
 * @template TInsert Payload accepted for insertions.
 * @template M Execution mode (`"sync"` or `"async"`).
 *
 * @example
 * ```ts
 * const user = db.users.insert({ email: "alice@example.com", name: "Alice" });
 * const found = db.users.findById(user.id);
 * db.users.updateById(user.id, { name: "Alice Smith" });
 * ```
 */
export class Table<
  T extends Record<string, any> = Record<string, any>,
  TInsert extends Record<string, any> = Partial<T>,
  M extends ExecutionMode = "sync",
> {
  /** Map of column definitions belonging to this table. */
  readonly columns: Map<string, ColumnDefinition> = new Map();
  /**
   * Searchable column names for this table, fixed at construction.
   *
   * Cached here, not re-derived per write, so a table with no searchable
   * columns takes its old write path with one length check and nothing
   * else: no schema scan, no SQL, no FTS table. Search is opt-in by
   * declaration, and undeclared tables pay nothing for it.
   */
  private readonly ftsColumns: string[] = [];
  /** The primary key column name for this table (defaults to `"id"`). */
  readonly primaryKeyColumn: string = "id";
  /** Inferred relational foreign key aliases (e.g. `userId` -> `user`). */
  readonly belongsToAliases: Map<string, { column: string; table: string }> = new Map();
  /**
   * Prebuilt fields DSL proxy for `where()` callbacks (see
   * `buildFieldsProxy`): one Proxy per table, one FieldBuilder per
   * declared column, built once at construction instead of a new Proxy
   * per query.
   */
  readonly fieldsProxy: FieldsProxy<T>;

  /**
   * Initializes a table gateway instance.
   *
   * @param name Name of the SQLite table.
   * @param db Reference to parent {@link YattaDB} instance.
   * @param schema Optional column schema definitions.
   */
  constructor(
    public readonly name: string,
    private db: YattaDB<M>,
    private schema?: TableSchema,
  ) {
    if (schema) {
      for (const [colName, builder] of Object.entries(schema)) {
        this.columns.set(colName, builder.def);
        if (builder.def.isSearchable) this.ftsColumns.push(colName);
        if (builder.def.primaryKey) this.primaryKeyColumn = colName;
        if (builder.def.references) {
          const alias = deriveAlias(colName);
          if (alias) this.belongsToAliases.set(alias, { column: colName, table: builder.def.references.table });
        }
      }
    }
    this.fieldsProxy = buildFieldsProxy<T>(this.columns);
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
  where(clauseOrFn: WhereClause<T> | ((fields: FieldsProxy<T>) => Condition)): QueryBuilder<T, T, M> {
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
  insert(data: TInsert): ModeResult<M, T> {
    const payload = this.resolveAliases(data as Record<string, any>);

    for (const [colName, def] of this.columns) {
      if (def.isUuid && payload[colName] === undefined) {
        payload[colName] = crypto.randomUUID();
      }
    }

    // Row write and index sync share one transaction, so an FTS error
    // (e.g. a corrupt index) rolls the row back instead of leaving a
    // landed row behind a failed insert — a retry would otherwise create
    // a duplicate or a UNIQUE error. The statement itself comes from the
    // compiler, which also handles the empty-payload DEFAULT VALUES case.
    if (!this.db.adapter.capabilities.compilerSql) {
      // SurrealDB: no runnable SQL — the session builds SurrealQL itself.
      return this.db.transaction(() => {
        return chainResult(this.db.mode, this.db.session.insert(this.name, this.requireSchema(), payload), (row) => {
          const decoded = this.deserializeRow(row);
          return chainResult(this.db.mode, this.syncFtsInsert(decoded), () => decoded);
        });
      });
    }
    const { sql, params } = this.db.compiler.compileInsert(this.name, this.columns, payload);
    return this.db.transaction(() => {
      return chainResult(this.db.mode, this.db.run(sql, params, "get"), (raw) => {
        const row = this.deserializeRow(raw as any);
        return chainResult(this.db.mode, this.syncFtsInsert(row), () => row);
      });
    });
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
  insertMany(items: TInsert[]): ModeResult<M, T[]> {
    if (items.length === 0) return modeValue(this.db.mode, []);
    return this.db.transaction(() => {
      return allResults(
        this.db.mode,
        items.map((item) => this.insert(item)),
      );
    });
  }

  // ── FIND ─────────────────────────────────────────────────────────────────

  /**
   * Finds the first row matching the specified criteria, projecting only selected columns.
   *
   * @param options Query criteria with `select` array.
   * @returns Picked record columns or `null` if no match.
   */
  findFirst<K extends keyof T>(options: FindOptions<T, K> & { select: K[] }): ModeResult<M, Prettify<Pick<T, K>> | null>;
  /**
   * Finds the first row matching the specified criteria.
   *
   * @param options Optional query criteria.
   * @returns Full record or `null` if no match.
   */
  findFirst(options?: FindOptions<T, keyof T>): ModeResult<M, T | null>;
  findFirst<K extends keyof T = keyof T, R = Pick<T, K>>(
    options: FindOptions<T, K> = {},
  ): ModeResult<M, R | null> {
    return chainResult(
      this.db.mode,
      this.findMany({ ...options, take: 1 } as any) as ModeResult<M, R[]>,
      (results) => results[0] ?? null,
    );
  }

  /**
   * Shorthand to retrieve the very first row in the table.
   *
   * @returns First row or `null` if table is empty.
   */
  first(): ModeResult<M, T | null> {
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
  ): ModeResult<M, Prettify<Pick<T, K>> | null>;
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
  ): ModeResult<M, T | null>;
  findById<K extends keyof T = keyof T, R = Pick<T, K>>(
    id: string | number,
    options?: { select?: K[]; include?: Record<string, boolean> },
  ): ModeResult<M, R | null> {
    return this.findFirst({
      where: { [this.primaryKeyColumn]: id } as any,
      select: options?.select,
      include: options?.include,
    } as any) as ModeResult<M, R | null>;
  }

  /**
   * Finds all rows matching the specified criteria, projecting only selected columns.
   *
   * @param options Query criteria with `select` array.
   * @returns Array of picked records.
   */
  findMany<K extends keyof T>(options: FindOptions<T, K> & { select: K[] }): ModeResult<M, Prettify<Pick<T, K>>[]>;
  /**
   * Finds all rows matching the specified criteria.
   *
   * @param options Optional query criteria.
   * @returns Array of full records.
   */
  findMany(options?: FindOptions<T, keyof T>): ModeResult<M, T[]>;
  findMany<K extends keyof T = keyof T, R = Pick<T, K>>(
    options: FindOptions<T, K> = {},
  ): ModeResult<M, R[]> {
    // The select list is computed here (validation + include expansion need
    // the relations graph); the statement itself comes from the compiler.
    let select: string[] | undefined;
    if (options.select) {
      const cols = new Set(options.select.map(String));
      // Validate like where/orderBy do: SQLite silently reads a
      // double-quoted unknown identifier in a SELECT list as a string
      // literal, so a typo used to return literal text instead of erroring.
      if (this.columns.size > 0) {
        for (const c of cols) {
          if (c !== "*" && !this.columns.has(c)) {
            const known = [...this.columns.keys()].join(", ");
            throw new YattaError(
              `Unknown column "${c}" in select for "${this.name}". Known columns: ${known}.`,
            );
          }
        }
      }
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
      select = [...cols];
    }

    if (!this.db.adapter.capabilities.compilerSql) {
      // SurrealDB: the session builds the SurrealQL itself.
      return chainResult(
        this.db.mode,
        this.db.session.find(this.name, this.requireSchema(), {
          where: options.where,
          orderBy: options.orderBy
            ? Array.isArray(options.orderBy)
              ? options.orderBy
              : [options.orderBy]
            : undefined,
          select,
          take: options.take !== undefined ? this.rowCount(options.take, "take", true) : undefined,
          skip: options.skip !== undefined ? this.rowCount(options.skip, "skip", false) : undefined,
        }),
        (found) => {
          const rows = found.map((r) => this.deserializeRow(r));
          if (options.include && rows.length > 0) {
            return chainResult(this.db.mode, this.resolveRelations(rows, options.include), () => rows as unknown as R[]);
          }
          return rows as unknown as R[];
        },
      );
    }

    const { sql, params } = this.db.compiler.compileSelect(this.name, this.columns, {
      where: options.where,
      orderBy: options.orderBy,
      take: options.take !== undefined ? this.rowCount(options.take, "take", true) : undefined,
      skip: options.skip !== undefined ? this.rowCount(options.skip, "skip", false) : undefined,
      select,
    });

    return chainResult(this.db.mode, this.db.run(sql, params, "all"), (rawRows) => {
      const rows = (rawRows as any[]).map((r) => this.deserializeRow(r));
      if (options.include && rows.length > 0) {
        return chainResult(this.db.mode, this.resolveRelations(rows, options.include), () => rows as unknown as R[]);
      }
      return rows as unknown as R[];
    });
  }

  // ── FULL-TEXT SEARCH ─────────────────────────────────────────────────────

  /**
   * Full-text search over the table's `.searchable()` columns, ranked by
   * SQLite FTS5's `bm25()`.
   *
   * Honest limits, stated here because they shape results:
   * - FTS5 has no typo tolerance of its own. With the default `typo: true`,
   *   each query word that is not in the indexed vocabulary is corrected
   *   against that vocabulary (trigram similarity plus edit distance) before
   *   the match runs, so "laptp" finds "laptop". A word with no close
   *   vocabulary neighbour keeps its spelling and matches nothing.
   * - The query is tokenized before it reaches FTS5, so FTS5 operators,
   *   wildcards, and column prefixes typed into the query are treated as
   *   words or dropped — never as syntax. Search input cannot inject SQL
   *   or FTS5 query syntax. Operator words (`and`/`or`/`not`) are dropped
   *   and every remaining term is ANDed, so there is no OR search in v1.
   * - `rank` on each hit is the raw `bm25()` value: negative, smaller is
   *   more relevant, meaningful only for ordering within this query.
   *
   * @example
   * ```ts
   * const hits = db.products.search("laptp");
   * // hits[0].row is the laptop row, hits[0].rank its bm25 value.
   * ```
   */
  search(query: string, options: SearchOptions<T> = {}): ModeResult<M, SearchHit<T>[]> {
    const searchable = this.ftsColumns;
    if (searchable.length === 0) {
      throw new YattaError(
        `Table "${this.name}" has no searchable columns. ` +
          `Mark a text column with .searchable() to make the table searchable.`,
      );
    }

    const restricted = options.columns ? options.columns.map(String) : null;
    if (restricted) {
      for (const c of restricted) {
        if (!searchable.includes(c)) {
          throw new YattaError(
            `Column "${c}" on table "${this.name}" is not searchable. ` +
              `Searchable columns: ${searchable.join(", ")}. ` +
              `Non-searchable columns are never searched, and naming one here is refused rather than silently ignored.`,
          );
        }
        // Column names enter the MATCH expression as an FTS5 column filter,
        // so they must be plain identifiers — a name carrying syntax could
        // break out of the filter. Schema names are normally plain already;
        // this refuses the exotic case loudly instead of building bad syntax.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) {
          throw new YattaError(
            `Column "${c}" on table "${this.name}" cannot be used as a search column filter because its name is not a plain identifier.`,
          );
        }
      }
    }

    const limit = options.limit !== undefined ? this.rowCount(options.limit, "limit", true) : undefined;
    const offset = options.offset !== undefined ? this.rowCount(options.offset, "offset", false) : 0;

    // FTS5 operator words carry no meaning here — the query is rebuilt from
    // tokens, and every remaining token is ANDed. Dropping them (instead of
    // letting "or" become an unmatchable search term) means "laptop or mouse"
    // searches for rows matching both words, and a payload like
    // `" OR 1=1 --` cannot smuggle operators into the MATCH expression.
    const tokens = tokenizeText(query).filter((t) => t !== "and" && t !== "or" && t !== "not");
    if (tokens.length === 0) return modeValue(this.db.mode, []);

    // Creates (or repairs) the index on first use, so a table opened with
    // autoMigrate off, or a database file copied in from elsewhere, still
    // searches correctly instead of failing on a missing FTS table.
    return chainResult(this.db.mode, this.db.ensureSearchIndex(this.name), () => {
      const useTypo = options.typo !== false;
      return chainResult(
        this.db.mode,
        useTypo ? this.db.ftsVocabulary(this.name) : modeValue(this.db.mode, new Set<string>()),
        (vocabulary) => {
          const synonyms = new Map([...this.db.searchSynonyms(), ...normalizeSynonyms(options.synonyms)]);

          // One group per token: the typo-corrected spelling plus its
          // synonym phrases. The adapter ANDs groups and ORs alternatives
          // inside a group, in its own index dialect (FTS5 MATCH for
          // SQLite/Turso, tsvector for PGlite, LIKE for DuckDB, BM25 for
          // SurrealDB) — Table never builds index SQL itself.
          const expandedGroups: string[][][] = [];
          for (const token of tokens) {
            const corrected = useTypo && !vocabulary.has(token) ? correctTypo(token, vocabulary) ?? token : token;
            const alternatives = new Map<string, string[]>();
            alternatives.set(corrected, [corrected]);
            for (const key of [corrected, token]) {
              for (const phrase of synonyms.get(key) ?? []) alternatives.set(phrase.join(" "), phrase);
            }
            expandedGroups.push([...alternatives.values()]);
          }

          const compiled: CompiledSearchQuery = {
            tokens,
            expandedGroups,
            columns: restricted ?? [],
            where: options.where,
            limit,
            offset: options.offset !== undefined ? offset : undefined,
            typoCorrection: useTypo,
          };
          return chainResult(
            this.db.mode,
            this.db.session.search(this.name, this.requireSchema(), compiled),
            (hits) => {
              if (hits.length === 0) return [];
              const rows = hits.map((h) => this.deserializeRow(h.row));
              const out = (): SearchHit<T>[] => hits.map((h, i) => ({ row: rows[i]!, rank: h.rank }));
              if (options.include) {
                return chainResult(this.db.mode, this.resolveRelations(rows, options.include), out);
              }
              return out();
            },
          );
        },
      );
    });
  }

  /**
   * Rebuilds this table's full-text index from its current rows.
   * The escape hatch for rows changed outside the Table write paths
   * (raw SQL, a copied database file): those writes do not sync the index.
   */
  rebuildSearchIndex(): ModeResult<M, void> {
    return this.db.rebuildSearchIndex(this.name);
  }

  /** Writes one row into the FTS index, or does nothing when the table is not searchable. */
  private syncFtsRow(row: T | null | undefined): ModeResult<M, void> {
    if (!row) return modeValue(this.db.mode, undefined);
    if (this.ftsColumns.length === 0) return modeValue(this.db.mode, undefined);
    return this.db.ftsUpsert(this.name, (row as any)[this.primaryKeyColumn], row as any);
  }

  /**
   * Writes a freshly inserted row into the FTS index. Unlike `syncFtsRow`
   * this skips the DELETE: a row that just inserted has no prior FTS
   * entry, and the DELETE is a full FTS scan (`__yatta_pk` is UNINDEXED),
   * so it dominated insert cost on large tables (~2.7 ms at 10k rows).
   * A stale entry for a re-inserted pk can only exist after rows were
   * changed outside the Table paths; the next search's count check
   * rebuilds the index in that case.
   */
  private syncFtsInsert(row: T | null | undefined): ModeResult<M, void> {
    if (!row) return modeValue(this.db.mode, undefined);
    if (this.ftsColumns.length === 0) return modeValue(this.db.mode, undefined);
    return this.db.ftsInsert(this.name, (row as any)[this.primaryKeyColumn], row as any);
  }

  /** Removes one primary key from the FTS index, or does nothing when the table is not searchable. */
  private syncFtsDelete(pk: string | number): ModeResult<M, void> {
    if (this.ftsColumns.length === 0) return modeValue(this.db.mode, undefined);
    return this.db.ftsDelete(this.name, pk);
  }

  /** Primary keys of the rows a `where` filter matches, without loading the rows. */
  private ftsPkValuesForWhere(where: WhereClause<T>): ModeResult<M, (string | number)[]> {
    if (!this.db.adapter.capabilities.compilerSql) {
      // SurrealDB: no runnable SQL — read the matching rows' keys
      // through the session instead (delete() needs them for its
      // FTS cleanup; the rows themselves are not returned).
      return chainResult(
        this.db.mode,
        this.db.session.find(this.name, this.requireSchema(), { where, select: [this.primaryKeyColumn] }),
        (rows) => rows.map((r) => r[this.primaryKeyColumn] as string | number),
      );
    }
    const { sql, params } = this.db.compiler.compilePkSelect(this.name, this.columns, this.primaryKeyColumn, where);
    return chainResult(this.db.mode, this.db.run(sql, params, "all"), (found) => (found as any[]).map((r) => r.pk));
  }

  // ── UPDATE ───────────────────────────────────────────────────────────────

  /**
   * Resolves relation aliases, drops undefined values, and stamps
   * touchOnUpdate columns. The SET SQL itself comes from the compiler
   * (compileUpdate), which takes this resolved payload.
   */
  private resolveSetPayload(data: Record<string, any>): Record<string, any> {
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

    return payload;
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
  }): ModeResult<M, { changes: number }> {
    const payload = this.resolveSetPayload(options.data as Record<string, any>);
    if (Object.keys(payload).length === 0) return modeValue(this.db.mode, { changes: 0 });

    // Same reasoning as delete(): an unfiltered UPDATE rewrites the whole table,
    // usually because a lookup that was meant to narrow it came back empty.
    if (!this.db.adapter.capabilities.compilerSql) {
      if (this.isEmptyWhereClause(options.where) && !options.allowAll) {
        throw new YattaError(
          `update() on "${this.name}" requires a filter. An empty where would update every row — pass { allowAll: true } if that is what you mean.`,
        );
      }
    } else {
      const { clause } = this.buildWhere(options.where);
      if (!clause && !options.allowAll) {
        throw new YattaError(
          `update() on "${this.name}" requires a filter. An empty where would update every row — pass { allowAll: true } if that is what you mean.`,
        );
      }
    }

    // The update may change what a row matches (or its searchable text), so
    // the affected keys are captured before the write: afterwards the old
    // filter may no longer match the updated rows, and their keys would be
    // unrecoverable. Keys only, not full rows.
    const searchable = this.ftsColumns.length > 0;
    return chainResult(
      this.db.mode,
      searchable ? this.ftsPkValuesForWhere(options.where) : modeValue(this.db.mode, [] as (string | number)[]),
      (affectedPks) => {
        if (!this.db.adapter.capabilities.compilerSql) {
          // SurrealDB: the session returns the updated rows, so the index
          // sync reindexes each new row and drops entries for keys that
          // moved (a primary-key change) or vanished.
          return this.db.transaction(() => {
            return chainResult(
              this.db.mode,
              this.db.session.update(this.name, this.requireSchema(), options.where, payload),
              (updatedRows) => {
                const newPks = new Set(updatedRows.map((r) => String(r[this.primaryKeyColumn])));
                const tasks = updatedRows.map((raw) => () => this.syncFtsRow(this.deserializeRow(raw)));
                for (const oldPk of affectedPks) {
                  if (!newPks.has(String(oldPk))) tasks.push(() => this.syncFtsDelete(oldPk));
                }
                return chainResult(this.db.mode, runSequential(this.db.mode, tasks), () => ({
                  changes: updatedRows.length,
                }));
              },
            );
          });
        }

        // The where is compiled twice — once for the allowAll guard above and
        // once inside compileUpdate. Both are the same pure compilation of the
        // same input; the guard needs the clause before the statement exists.
        const { sql, params } = this.db.compiler.compileUpdate(this.name, this.columns, payload, options.where);

        // Row write and index sync share one transaction, like insert(): an
        // FTS error must not leave updated rows behind a failed update.
        return this.db.transaction(() => {
          return chainResult(this.db.mode, this.db.run(sql, params, "run"), (res) => {
            if (!searchable) return { changes: (res as { changes: number }).changes };
            // A primary-key change moves the row's index entry: reindex under the
            // new key and drop the old one, or the old entry would point at a row
            // that no longer exists under that key.
            const resolved = this.resolveAliases(options.data as Record<string, any>);
            const pkChanged = resolved[this.primaryKeyColumn] !== undefined;
            return chainResult(
              this.db.mode,
              runSequential(
                this.db.mode,
                affectedPks.map((oldPk) => () => {
                  const newPk = pkChanged ? resolved[this.primaryKeyColumn] : oldPk;
                  return chainResult(this.db.mode, this.findById(newPk), (row) => {
                    if (row) {
                      return chainResult(this.db.mode, this.syncFtsRow(row), () => {
                        if (String(newPk) !== String(oldPk)) return this.syncFtsDelete(oldPk);
                        return modeValue(this.db.mode, undefined);
                      });
                    }
                    return this.syncFtsDelete(oldPk);
                  });
                }),
              ),
              () => ({ changes: (res as { changes: number }).changes }),
            );
          });
        });
      },
    );
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
  updateById(id: string | number, data: Partial<TInsert | T>): ModeResult<M, T | null> {
    const payload = this.resolveSetPayload(data as Record<string, any>);
    if (Object.keys(payload).length === 0) return this.findById(id);

    if (!this.db.adapter.capabilities.compilerSql) {
      // SurrealDB: the session returns the updated rows directly.
      return this.db.transaction(() => {
        return chainResult(
          this.db.mode,
          this.db.session.update(this.name, this.requireSchema(), { [this.primaryKeyColumn]: id } as any, payload),
          (updatedRows) => {
            const row = updatedRows.length > 0 ? this.deserializeRow(updatedRows[0]!) : null;
            if (row) {
              return chainResult(this.db.mode, this.syncFtsRow(row), () => {
                if (String((row as any)[this.primaryKeyColumn]) !== String(id)) {
                  return chainResult(this.db.mode, this.syncFtsDelete(id), () => row);
                }
                return row;
              });
            }
            return chainResult(this.db.mode, this.syncFtsDelete(id), () => null);
          },
        );
      });
    }

    const { sql, params } = this.db.compiler.compileUpdate(
      this.name,
      this.columns,
      payload,
      { [this.primaryKeyColumn]: id } as any,
      { returning: true },
    );
    // Row write and index sync share one transaction, like insert().
    return this.db.transaction(() => {
      return chainResult(this.db.mode, this.db.run(sql, params, "get"), (raw) => {
        const row = raw ? this.deserializeRow(raw as any) : null;
        if (row) {
          return chainResult(this.db.mode, this.syncFtsRow(row), () => {
            if (String((row as any)[this.primaryKeyColumn]) !== String(id)) {
              return chainResult(this.db.mode, this.syncFtsDelete(id), () => row);
            }
            return row;
          });
        }
        return chainResult(this.db.mode, this.syncFtsDelete(id), () => null);
      });
    });
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
  upsert({ where, create, update }: UpsertOptions<T, TInsert>): ModeResult<M, T> {
    return this.db.transaction(() => {
      return chainResult(this.db.mode, this.findFirst({ where }), (existing) => {
        if (existing) {
          const id = (existing as any)[this.primaryKeyColumn];
          return this.updateById(id, update) as ModeResult<M, T>;
        }
        const baseCreate: Record<string, any> = { ...create };
        for (const [k, v] of Object.entries(where)) {
          if (baseCreate[k] === undefined && (typeof v !== "object" || v === null || v instanceof Date)) {
            baseCreate[k] = v;
          }
        }
        return this.insert(baseCreate as TInsert);
      });
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
  }): ModeResult<M, { changes: number }> {
    if (!this.db.adapter.capabilities.compilerSql) {
      if (this.isEmptyWhereClause(options.where) && !options.allowAll) {
        throw new YattaError(
          `delete() on "${this.name}" requires a filter. An empty where would delete every row — pass { allowAll: true } if that is what you mean.`,
        );
      }
    } else {
      const { clause } = this.buildWhere(options.where);

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
    }

    // Rows first, index second, inside one transaction. The old code
    // deleted the FTS entries before the rows: a row delete that then
    // failed (e.g. an FK RESTRICT violation) left live rows unsearchable.
    // The affected keys are captured before the write (afterwards the
    // filter may no longer match), and the transaction rolls the row
    // delete back if the index sync fails.
    return chainResult(
      this.db.mode,
      this.ftsColumns.length > 0 ? this.db.ftsTableExists(this.name) : modeValue(this.db.mode, false),
      (indexExists) => {
        const searchable = this.ftsColumns.length > 0 && indexExists;
        return chainResult(
          this.db.mode,
          searchable ? this.ftsPkValuesForWhere(options.where) : modeValue(this.db.mode, [] as (string | number)[]),
          (affectedPks) => {
            if (!this.db.adapter.capabilities.compilerSql) {
              // SurrealDB: the session deletes and returns the count; the
              // engine-managed index needs no per-row cleanup, so the
              // affected keys are only captured (and deleted) when an
              // index table exists — which it never does here.
              return this.db.transaction(() => {
                return chainResult(
                  this.db.mode,
                  this.db.session.delete(this.name, this.requireSchema(), options.where),
                  (deleted) => {
                    return chainResult(
                      this.db.mode,
                      runSequential(this.db.mode, affectedPks.map((pk) => () => this.syncFtsDelete(pk))),
                      () => ({ changes: deleted }),
                    );
                  },
                );
              });
            }

            // The where is compiled twice — once for the allowAll guard above and
            // once here. Both are the same pure compilation of the same input; the
            // guard needs the clause before the statement exists.
            const { sql, params } = this.db.compiler.compileDelete(this.name, this.columns, options.where);

            return this.db.transaction(() => {
              return chainResult(this.db.mode, this.db.run(sql, params, "run"), (res) => {
                return chainResult(
                  this.db.mode,
                  runSequential(this.db.mode, affectedPks.map((pk) => () => this.syncFtsDelete(pk))),
                  () => ({ changes: (res as { changes: number }).changes }),
                );
              });
            });
          },
        );
      },
    );
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
  deleteById(id: string | number): ModeResult<M, boolean> {
    return chainResult(this.db.mode, this.delete({ where: { [this.primaryKeyColumn]: id } as any }), (res) => res.changes > 0);
  }

  // ── COUNT, EXISTS & PAGINATION ───────────────────────────────────────────

  /**
   * Counts the total number of rows matching an optional filter.
   *
   * @param where Optional filter condition.
   * @returns Total row count.
   */
  count(where?: WhereClause<T>): ModeResult<M, number> {
    if (!this.db.adapter.capabilities.compilerSql) {
      return this.db.session.count(this.name, this.requireSchema(), where);
    }
    const { sql, params } = this.db.compiler.compileCount(this.name, this.columns, where);
    return chainResult(this.db.mode, this.db.run(sql, params, "get"), (res) => (res as { count: number }).count);
  }

  /**
   * Checks whether at least one row exists matching the specified criteria.
   *
   * @param where Optional filter condition.
   * @returns `true` if matching row exists, `false` otherwise.
   */
  exists(where?: WhereClause<T>): ModeResult<M, boolean> {
    if (!this.db.adapter.capabilities.compilerSql) {
      // No session exists() — a count of 1 answers the same question.
      return chainResult(this.db.mode, this.db.session.count(this.name, this.requireSchema(), where), (n) => n > 0);
    }
    const { sql, params } = this.db.compiler.compileExists(this.name, this.columns, where);
    return chainResult(this.db.mode, this.db.run(sql, params, "get"), (res) => res !== null && res !== undefined);
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
  paginate<R = T>(options: PaginateOptions<T> = {}): ModeResult<M, PaginatedResult<R>> {
    const page = pageCount(options.page, 1);
    const limit = pageCount(options.limit, 10);
    const skip = (page - 1) * limit;

    return chainResult(this.db.mode, this.count(options.where), (total) => {
      return chainResult(
        this.db.mode,
        this.findMany({
          where: options.where,
          orderBy: options.orderBy,
          take: limit,
          skip,
          include: options.include,
          select: options.select,
        }) as unknown as ModeResult<M, R[]>,
        (data) => ({ data, total, page, limit, totalPages: Math.ceil(total / limit) }),
      );
    });
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
  cursorPaginate<R = T>(options: CursorPaginateOptions<T> = {}): ModeResult<M, CursorPaginatedResult<R>> {
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
        // A 1-element cursor with distinct cursor/tie-breaker columns
        // leaves tbVal undefined, which buildWhere drops — so the
        // tie-breaker clause vanishes and a page can repeat rows.
        // Cursors minted by this method always carry both values.
        if (
          cursorCol !== tieBreaker &&
          decoded.length < 2
        ) {
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
    }) as ModeResult<M, any[]>;

    return chainResult(this.db.mode, items, (found) => {
      const hasMore = found.length > limit;
      const data = (hasMore ? found.slice(0, limit) : found) as R[];

      let nextCursor: string | null = null;
      if (hasMore && data.length > 0) {
        const lastRow = data[data.length - 1] as any;
        const cursorTuple = [lastRow[cursorCol], lastRow[tieBreaker]];
        nextCursor = Buffer.from(JSON.stringify(cursorTuple)).toString("base64url");
      }

      return { data, nextCursor, hasMore };
    });
  }

  // ── RELATION ALIASES ─────────────────────────────────────────────────────

  /**
   * The table's schema, required by the session path: the session's
   * `insert` / `find` / `update` / `delete` / `count` methods need column
   * definitions (primary key, types, searchability). A schemaless table
   * can only run on a `compilerSql` driver, where the compiler builds
   * SQL from the payload itself.
   */
  private requireSchema(): TableSchema {
    if (!this.schema) {
      throw new YattaError(
        `Table "${this.name}" has no schema, so it cannot run on "${this.db.adapter.driver}": ` +
          `the session methods need column definitions. Define the table in the schema, or use a SQL driver.`,
      );
    }
    return this.schema;
  }

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
    // SQL text lives in the compiler now (sql_compiler.ts). Kept as a thin
    // delegate because update()/delete() need the compiled clause for their
    // allowAll guards before the statement itself exists.
    const { clause, params } = this.db.compiler.compileWhere(this.name, this.columns, where);
    return { clause, params };
  }

  /**
   * Whether a where clause matches everything: the allowAll guard for the
   * session path, which has no compiler to ask. An empty object, or an
   * AND/OR of nothing, or a NOT of nothing, matches all rows.
   */
  private isEmptyWhereClause(where: WhereClause<any> | undefined): boolean {
    if (!where || typeof where !== "object") return true;
    const keys = Object.keys(where);
    if (keys.length === 0) return true;
    return keys.every((k) => {
      if (k === "AND" || k === "OR") {
        const v = (where as any)[k];
        return Array.isArray(v) && v.length === 0;
      }
      if (k === "NOT") {
        const v = (where as any)[k];
        return !v || (typeof v === "object" && Object.keys(v).length === 0);
      }
      return false;
    });
  }

  /**
   * Validates a `take`/`skip` value and renders it for direct interpolation.
   *
   * These two are spliced into the SQL text rather than bound, and `Number()` will
   * happily produce `NaN` from the string "abc". Every other spliced value in this
   * file — column names, sort directions, filter operators — is checked, and these two
   * were not, so a typo in a query parameter surfaced as SQLite talking about itself:
   * `{ skip: "abc" }` gave "no such column: NaN" and `{ skip: "1.7" }` gave "datatype
   * mismatch" plus the full statement.
   *
   * `take: -1` stays legal because it is SQLite's own "no upper bound" and is the idiom
   * for an unbounded read.
   */
  private rowCount(value: unknown, field: string, allowUnlimited: boolean): number {
    const n = typeof value === "number" ? value : Number(value);

    if (typeof value === "boolean" || value === null || value === "" || !Number.isFinite(n)) {
      throw new YattaError(`${field} on "${this.name}" must be a finite number, got ${n}.`);
    }

    if (allowUnlimited && n === -1) return -1;

    if (!Number.isInteger(n) || n < 0) {
      throw new YattaError(
        `${field} on "${this.name}" must be an integer of 0 or more` +
          `${allowUnlimited ? " (or -1 for no limit)" : ""}, got ${n}.`,
      );
    }

    return n;
  }

  private resolveRelations(rows: any[], include: Record<string, boolean>): ModeResult<M, void> {
    const tableRelations = this.db.relations[this.name];

    // One task per relation, run in order: each relation's findMany is a
    // ModeResult, so the grouping work after it chains onto the fetch.
    const tasks: (() => ModeResult<M, void>)[] = [];
    for (const [relName, enabled] of Object.entries(include)) {
      if (!enabled) continue;
      const configured = tableRelations?.[relName];

      if (configured) {
        if ("hasMany" in configured) {
          tasks.push(() => {
            const ids = rows.map((r) => r[this.primaryKeyColumn]).filter((v) => v != null);
            if (ids.length === 0) {
              for (const row of rows) row[relName] = [];
              return modeValue(this.db.mode, undefined);
            }
            return chainResult(
              this.db.mode,
              this.db.table(configured.hasMany).findMany({ where: { [configured.foreignKey]: { in: ids } } as any }),
              (children) => {
                const grouped = new Map<any, any[]>();
                for (const child of children) {
                  const parentId = (child as any)[configured.foreignKey];
                  if (!grouped.has(parentId)) grouped.set(parentId, []);
                  grouped.get(parentId)!.push(child);
                }
                for (const row of rows) row[relName] = grouped.get(row[this.primaryKeyColumn]) ?? [];
              },
            );
          });
        } else if ("belongsTo" in configured) {
          tasks.push(() => {
            // The parent holds the foreign key, so look up the referenced row.
            const targetTable = this.db.table(configured.belongsTo);
            const targetPk = targetTable.primaryKeyColumn;
            const foreignIds = rows.map((r) => r[configured.foreignKey]).filter((v) => v != null);
            if (foreignIds.length === 0) {
              for (const row of rows) row[relName] = null;
              return modeValue(this.db.mode, undefined);
            }
            return chainResult(
              this.db.mode,
              targetTable.findMany({ where: { [targetPk]: { in: foreignIds } } as any }),
              (parents) => {
                const map = new Map(parents.map((p) => [(p as any)[targetPk], p]));
                for (const row of rows) row[relName] = map.get(row[configured.foreignKey]) ?? null;
              },
            );
          });
        } else {
          tasks.push(() => {
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
              return modeValue(this.db.mode, undefined);
            }
            return chainResult(
              this.db.mode,
              childTable.findMany({ where: { [configured.foreignKey]: { in: ids } } as any }),
              (children) => {
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
              },
            );
          });
        }
        continue;
      }

      const auto = this.belongsToAliases.get(relName);
      if (auto) {
        tasks.push(() => {
          const targetTable = this.db.table(auto.table);
          const targetPk = targetTable.primaryKeyColumn;
          const foreignIds = rows.map((r) => r[auto.column]).filter((v) => v != null);
          if (foreignIds.length === 0) {
            for (const row of rows) row[relName] = null;
            return modeValue(this.db.mode, undefined);
          }
          return chainResult(
            this.db.mode,
            targetTable.findMany({ where: { [targetPk]: { in: foreignIds } } as any }),
            (parents) => {
              const map = new Map(parents.map((p) => [(p as any)[targetPk], p]));
              for (const row of rows) row[relName] = map.get(row[auto.column]) ?? null;
            },
          );
        });
        continue;
      }

      if (this.db.schema && relName in this.db.schema) {
        const otherTable = this.db.table(relName);
        for (const [colName, def] of otherTable.columns) {
          if (def.references?.table === this.name) {
            tasks.push(() => {
              const ids = rows.map((r) => r[this.primaryKeyColumn]).filter((v) => v != null);
              if (ids.length === 0) {
                for (const row of rows) row[relName] = [];
                return modeValue(this.db.mode, undefined);
              }
              return chainResult(
                this.db.mode,
                otherTable.findMany({ where: { [colName]: { in: ids } } as any }),
                (children) => {
                  const grouped = new Map<any, any[]>();
                  for (const child of children) {
                    const parentId = (child as any)[colName];
                    if (!grouped.has(parentId)) grouped.set(parentId, []);
                    grouped.get(parentId)!.push(child);
                  }
                  for (const row of rows) row[relName] = grouped.get(row[this.primaryKeyColumn]) ?? [];
                },
              );
            });
            break;
          }
        }
      }
    }
    return runSequential(this.db.mode, tasks);
  }

  private deserializeRow(row: any): T {
    // Decoding lives in the dialect now (decodeValue); this stays as the
    // call site for insert/findMany/updateById.
    return this.db.compiler.decodeRow(this.columns, row);
  }
}
