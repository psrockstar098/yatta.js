// SqliteDialect: the SQLite implementation of SqlDialect.
//
// Phase 1 of the multi-database ORM refactor. Every method here is the
// pre-refactor behaviour from src/types/db.ts (now split into
// src/types/db/engine.ts and src/types/db/table.ts), moved verbatim:
// buildColumnDefFragment, formatDefault, the syncSchemaBody index
// creation, and the driver halves of serializeValue/deserializeRow.
// The byte-identical SQL tests in src/test/db.compiler.test.ts pin it:
// if a method here changes its output, a test fails, and the test is
// right — the dialect is wrong.
//
// Postgres (Phase 2) implements the same interface in
// adapters/postgres_dialect.ts with different answers for the same
// questions: $n placeholders, BIGINT for col.integer(), ILIKE for LIKE,
// explicit NULLS FIRST/LAST to match SQLite's default ordering, and a
// to_char CURRENT_TIMESTAMP default that emits the toISOString() format.

import { YattaError } from "../errors";
import type { ColumnDefinition, TableSchema } from "../schema";
import type { CompiledSql, SqlDialect, UpsertPlan } from "../sql_dialect";

const ALLOWED_TYPES = ["INTEGER", "TEXT", "REAL", "BLOB"];
const ALLOWED_ON_DELETE = ["CASCADE", "SET NULL", "RESTRICT"];

export class SqliteDialect implements SqlDialect {
  readonly name = "sqlite";
  readonly supportsReturning = true;
  readonly likeCaseInsensitiveByDefault = true;

  quoteIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  placeholder(_index1Based: number): string {
    return "?";
  }

  mapColumnType(def: ColumnDefinition): string {
    if (!ALLOWED_TYPES.includes(def.type)) {
      throw new YattaError(
        `Invalid column type "${def.type}". Expected one of ${ALLOWED_TYPES.join(", ")}.`,
      );
    }
    return def.type;
  }

  compileColumnDefault(def: ColumnDefinition): string {
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

  compileColumnFragment(colName: string, def: ColumnDefinition, mode: "create" | "alter"): string {
    const safeName = colName.replace(/"/g, '""');
    // Runtime whitelist: TypeScript narrows these, but a JS caller, an `as any`
    // cast, or a dynamically loaded schema can pass anything, and both values
    // used to be interpolated into DDL verbatim.
    if (!ALLOWED_TYPES.includes(def.type)) {
      throw new YattaError(`Invalid column type "${def.type}" for "${colName}". Expected one of ${ALLOWED_TYPES.join(", ")}.`);
    }
    if (def.references?.onDelete && !ALLOWED_ON_DELETE.includes(def.references.onDelete)) {
      throw new YattaError(`Invalid ON DELETE action "${def.references.onDelete}" for "${colName}". Expected one of ${ALLOWED_ON_DELETE.join(", ")}.`);
    }
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
    if (def.defaultValue !== undefined) s += ` DEFAULT ${this.compileColumnDefault(def)}`;
    if (def.references) {
      s += ` REFERENCES "${def.references.table.replace(/"/g, '""')}"("${def.references.column.replace(/"/g, '""')}")`;
      if (def.references.onDelete) s += ` ON DELETE ${def.references.onDelete}`;
    }
    if (def.checkValues?.length) {
      s += ` CHECK("${safeName}" IN (${def.checkValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}))`;
    }

    return s;
  }

  compileCreateTableSql(table: string, columnFragments: string[]): string {
    return `CREATE TABLE IF NOT EXISTS "${table.replace(/"/g, '""')}" (${columnFragments.join(", ")});`;
  }

  compileAddColumnSql(table: string, fragment: string): string {
    return `ALTER TABLE "${table.replace(/"/g, '""')}" ADD COLUMN ${fragment};`;
  }

  compileIndexSql(table: string, colName: string, kind: "plain" | "timeseries" | "unique"): string {
    const t = table.replace(/"/g, '""');
    const c = colName.replace(/"/g, '""');
    if (kind === "unique") {
      const uniqName = `uniq_${table}_${colName}`.replace(/"/g, '""');
      return `CREATE UNIQUE INDEX IF NOT EXISTS "${uniqName}" ON "${t}" ("${c}");`;
    }
    if (kind === "timeseries") {
      const tsIdxName = `idx_timeseries_${table}_${colName}`.replace(/"/g, '""');
      return `CREATE INDEX IF NOT EXISTS "${tsIdxName}" ON "${t}" ("${c}");`;
    }
    const idxName = `idx_${table}_${colName}`.replace(/"/g, '""');
    return `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${t}" ("${c}");`;
  }

  compileCreateTableStatements(table: string, schema: TableSchema): [string, ...string[]] {
    const fragments: string[] = [];
    const statements: string[] = [];
    const indexedCols = new Set<string>();

    for (const [colName, colBuilder] of Object.entries(schema)) {
      const def = colBuilder.def;
      fragments.push(this.compileColumnFragment(colName, def, "create"));

      if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
        indexedCols.add(colName);
        statements.push(this.compileIndexSql(table, colName, "plain"));
      }

      // A marked time-series column gets its own time-ordered index,
      // unless .index() already put one on the same column: two
      // identical indexes would double the write cost for no gain.
      if (def.isTimeSeries) {
        if (!def.isIndex && !indexedCols.has(colName)) {
          indexedCols.add(colName);
          statements.push(this.compileIndexSql(table, colName, "timeseries"));
        }
      }
    }

    return [this.compileCreateTableSql(table, fragments), ...statements];
  }

  compileLikePredicate(quotedCol: string, placeholder: string, escape: boolean): string {
    return escape ? `${quotedCol} LIKE ${placeholder} ESCAPE '\\'` : `${quotedCol} LIKE ${placeholder}`;
  }

  compileOrderNulls(_dir: "ASC" | "DESC"): string {
    // SQLite's default already matches the current SQL: NULLS FIRST on ASC,
    // NULLS LAST on DESC. Emit nothing — the byte-identical tests pin this.
    return "";
  }

  compileLimitOffset(take: number | undefined, skip: number | undefined): string {
    /*
     * SQLite only accepts OFFSET as part of a `LIMIT … OFFSET …` clause, so a
     * bare `OFFSET n` is a syntax error. `skip` on its own is a documented,
     * reasonable thing to write, so it gets `LIMIT -1` — SQLite's "no upper
     * bound" — rather than failing. `take: -1` is the same idiom.
     */
    const limitSql =
      take !== undefined
        ? `LIMIT ${take}`
        : skip !== undefined
          ? "LIMIT -1"
          : "";
    const offsetSql = skip !== undefined ? `OFFSET ${skip}` : "";
    return [limitSql, offsetSql].filter(Boolean).join(" ");
  }

  encodeParam(value: unknown, def?: ColumnDefinition): unknown {
    // Driver half of the old Table.serializeValue: the undefined/null
    // handling and the NOT NULL guard live in SqlCompiler.serializeValue,
    // which calls this after those checks.
    if (def?.isBoolean) return value ? 1 : 0;
    if (def?.isJson) {
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Uint8Array) return value;
    // A structured value with no column definition (a raw-SQL caller, or a
    // column the schema does not declare) is stored as JSON, as before.
    // With a definition, the compiler rejects non-json objects before
    // this is reached.
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    return value;
  }

  decodeValue(value: unknown, def?: ColumnDefinition): unknown {
    // Driver half of the old Table.deserializeRow.
    if (def?.isBoolean) {
      return value === null ? null : !!value;
    }
    if (def?.isJson) {
      if (value === null) return null;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          /* leave as-is */
        }
      }
      return value;
    }
    if (!def && typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        return JSON.parse(value);
      } catch {
        /* leave as-is */
      }
    }
    return value;
  }

  compileUpsert(_plan: UpsertPlan): CompiledSql | null {
    // No atomic upsert: the core uses the transactional
    // find-first-then-update/insert fallback, which is the current
    // behaviour. An ON CONFLICT path is a later optimisation.
    return null;
  }
}
