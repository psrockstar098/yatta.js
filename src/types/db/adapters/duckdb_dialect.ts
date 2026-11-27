// DuckDBDialect: the DuckDB implementation of SqlDialect.
//
// Phase 2 of the multi-database ORM refactor. Same questions as
// SqliteDialect, different answers: $n placeholders (proven against
// @duckdb/node-api@2.0.1-r.1 — `connection.runAndReadAll("SELECT $1",
// [42])` binds positionally; `?` also works, but $n matches the
// Postgres dialect and the package README's own examples), BIGINT for
// col.integer() (epoch-ms timestamps overflow INTEGER), real BOOLEAN
// and JSON types, ILIKE for LIKE (DuckDB LIKE is case-sensitive;
// SQLite's is ASCII case-insensitive), explicit NULLS FIRST/LAST to
// match SQLite's default ordering, LIMIT ALL for an unbounded read
// (DuckDB rejects a negative LIMIT: "LIMIT/OFFSET cannot be negative"),
// and a strftime CURRENT_TIMESTAMP default that emits exactly the
// toISOString() format.
//
// Auto-increment is the one place DuckDB needs more than a type:
// DuckDB has no IDENTITY/AUTOINCREMENT syntax (`GENERATED ALWAYS AS
// IDENTITY` is a parser error in this build), so col.id() becomes
// `BIGINT PRIMARY KEY DEFAULT nextval('seq_<table>_<col>')` and the
// adapter creates that sequence before the CREATE TABLE runs. The
// sequence name needs the table, which compileColumnFragment does not
// receive — so compileCreateTableStatements sets a table context
// (setTableContext) while it builds fragments, and the adapter sets
// the same context before its ALTER-TABLE path calls
// compileColumnFragment. The context is only ever read while building
// a fragment for that table, and syncSchema runs sequentially.

import { YattaError } from "../errors";
import type { ColumnDefinition, TableSchema } from "../schema";
import type { CompiledSql, SqlDialect, UpsertPlan } from "../sql_dialect";

const ALLOWED_TYPES = ["INTEGER", "TEXT", "REAL", "BLOB"];
const ALLOWED_ON_DELETE = ["CASCADE", "SET NULL", "RESTRICT"];

/** Sequence name for a table's auto-increment column. Shared with the adapter, which creates it. */
export function duckSequenceName(table: string, colName: string): string {
  return `seq_${table}_${colName}`;
}

export class DuckDBDialect implements SqlDialect {
  readonly name = "duckdb";
  readonly supportsReturning = true;
  readonly likeCaseInsensitiveByDefault = false;

  /** Table whose fragments are being built (see the header note). Null outside a build. */
  private tableContext: string | null = null;

  /** Sets the table context for fragment building (adapter ALTER path). */
  setTableContext(table: string | null): void {
    this.tableContext = table;
  }

  quoteIdent(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  placeholder(index1Based: number): string {
    return `$${index1Based}`;
  }

  mapColumnType(def: ColumnDefinition): string {
    if (def.isBoolean) return "BOOLEAN";
    if (def.isJson) return "JSON";
    if (!ALLOWED_TYPES.includes(def.type)) {
      throw new YattaError(
        `Invalid column type "${def.type}". Expected one of ${ALLOWED_TYPES.join(", ")}.`,
      );
    }
    switch (def.type) {
      case "INTEGER":
        // BIGINT is mandatory: epoch-ms timestamps overflow INTEGER.
        return "BIGINT";
      case "REAL":
        return "DOUBLE";
      case "BLOB":
        return "BLOB";
      case "TEXT":
      default:
        // Covers col.text(), col.uuid(), col.date(), col.enum().
        // DuckDB normalizes TEXT to VARCHAR (information_schema
        // reports VARCHAR), so the dialect spells it VARCHAR.
        return "VARCHAR";
    }
  }

  compileColumnDefault(def: ColumnDefinition): string {
    if (def.defaultValue === undefined) return "";
    if (def.defaultValue === null) return "NULL";

    if (def.defaultValue === "CURRENT_TIMESTAMP") {
      /*
       * Exactly the toISOString() format, for the same reason as the
       * SQLite strftime expression: every other write path puts
       * `Date#toISOString()` in the same column, and the filter DSL
       * compares TEXT lexicographically. DuckDB's strftime %f renders
       * six microsecond digits ("2026-11-27T12:43:06.421157Z"), so the
       * first 23 characters plus 'Z' give the three-digit-millis form
       * ("2026-11-27T12:43:06.426Z"). Verified live against DuckDB
       * 2.0.1: substr(strftime(now(), '%Y-%m-%dT%H:%M:%S.%fZ'), 1, 23)
       * || 'Z' renders exactly that.
       */
      return `(substr(strftime(now(), '%Y-%m-%dT%H:%M:%S.%fZ'), 1, 23) || 'Z')`;
    }
    if (typeof def.defaultValue === "number" || def.isBoolean) {
      return String(def.isBoolean ? (def.defaultValue ? "TRUE" : "FALSE") : def.defaultValue);
    }
    if (def.isJson) {
      const jsonStr =
        typeof def.defaultValue === "string"
          ? def.defaultValue
          : JSON.stringify(def.defaultValue);
      return `'${jsonStr.replace(/'/g, "''")}'::json`;
    }
    // A structured default must be serialized, not coerced (see
    // SqliteDialect.compileColumnDefault for why).
    if (typeof def.defaultValue === "object") {
      return `'${JSON.stringify(def.defaultValue).replace(/'/g, "''")}'`;
    }

    return `'${String(def.defaultValue).replace(/'/g, "''")}'`;
  }

  compileColumnFragment(colName: string, def: ColumnDefinition, mode: "create" | "alter"): string {
    const safeName = colName.replace(/"/g, '""');
    if (def.references?.onDelete && !ALLOWED_ON_DELETE.includes(def.references.onDelete)) {
      throw new YattaError(`Invalid ON DELETE action "${def.references.onDelete}" for "${colName}". Expected one of ${ALLOWED_ON_DELETE.join(", ")}.`);
    }
    let s = `"${safeName}" ${this.mapColumnType(def)}`;

    if (mode === "create") {
      if (def.primaryKey) s += " PRIMARY KEY";
      // No IDENTITY/AUTOINCREMENT in DuckDB: the auto-increment is a
      // sequence default. The adapter creates the sequence before the
      // CREATE TABLE runs; the name is deterministic from table+column.
      if (def.autoIncrement) {
        if (this.tableContext === null) {
          throw new YattaError(
            `Cannot compile auto-increment column "${colName}" without a table context: ` +
              `the sequence name is derived from the table. Build the fragment through ` +
              `compileCreateTableStatements or setTableContext first.`,
          );
        }
        const seq = duckSequenceName(this.tableContext, colName).replace(/'/g, "''");
        s += ` DEFAULT nextval('${seq}')`;
      }
    } else if (def.primaryKey) {
      throw new YattaError(`Cannot add PRIMARY KEY column "${colName}" via ALTER TABLE in DuckDB.`);
    } else if (def.autoIncrement) {
      // ALTER path: same sequence default; the adapter creates the
      // sequence before the ADD COLUMN runs.
      if (this.tableContext === null) {
        throw new YattaError(
          `Cannot compile auto-increment column "${colName}" without a table context: ` +
            `the sequence name is derived from the table. Set it with setTableContext first.`,
        );
      }
      const seq = duckSequenceName(this.tableContext, colName).replace(/'/g, "''");
      s += ` DEFAULT nextval('${seq}')`;
    }

    if (def.notNull) {
      if (mode === "alter" && def.defaultValue === undefined && !def.autoIncrement) {
        throw new YattaError(
          `Cannot add NOT NULL column "${colName}" without a default value in DuckDB. ` +
            `Add .default(...) or make it .nullable().`,
        );
      }
      s += " NOT NULL";
    }

    // An auto-increment column already carries its sequence default
    // above; a second DEFAULT from defaultValue would be a duplicate.
    if (mode === "create" && def.unique) s += " UNIQUE";
    if (def.defaultValue !== undefined && !def.autoIncrement) s += ` DEFAULT ${this.compileColumnDefault(def)}`;
    if (def.references) {
      s += ` REFERENCES "${def.references.table.replace(/"/g, '""')}"("${def.references.column.replace(/"/g, '""')}")`;
      /*
       * Only RESTRICT is spelled out: DuckDB 2.0.1 rejects
       * ON DELETE CASCADE / SET NULL / SET DEFAULT at parse time
       * ("FOREIGN KEY constraints cannot use CASCADE, SET NULL or
       * SET DEFAULT"), in both column-level and table-level form,
       * and the bare REFERENCES behaves as RESTRICT. CASCADE and
       * SET NULL are therefore NOT dropped silently — the adapter
       * emulates them in delete() from the FK registry syncSchema
       * builds, so a portable schema keeps its semantics on the
       * session path (raw-SQL deletes do not cascade; see the
       * adapter header).
       */
      if (def.references.onDelete === "RESTRICT") s += " ON DELETE RESTRICT";
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

    // The auto-increment fragments need the table for their sequence
    // names; the context lives only for the duration of this build.
    this.tableContext = table;
    try {
      for (const [colName, colBuilder] of Object.entries(schema)) {
        const def = colBuilder.def;
        fragments.push(this.compileColumnFragment(colName, def, "create"));

        if ((def.isIndex || def.references) && !def.unique && !indexedCols.has(colName)) {
          indexedCols.add(colName);
          statements.push(this.compileIndexSql(table, colName, "plain"));
        }

        if (def.isTimeSeries) {
          if (!def.isIndex && !indexedCols.has(colName)) {
            indexedCols.add(colName);
            statements.push(this.compileIndexSql(table, colName, "timeseries"));
          }
        }
      }
    } finally {
      this.tableContext = null;
    }

    return [this.compileCreateTableSql(table, fragments), ...statements];
  }

  compileLikePredicate(quotedCol: string, placeholder: string, escape: boolean): string {
    // DuckDB LIKE is case-sensitive; SQLite's LIKE is ASCII
    // case-insensitive, so parity needs ILIKE on both branches.
    // Verified live: 'Hello' LIKE '%hello%' is false, ILIKE is true.
    return escape ? `${quotedCol} ILIKE ${placeholder} ESCAPE '\\'` : `${quotedCol} ILIKE ${placeholder}`;
  }

  compileOrderNulls(dir: "ASC" | "DESC"): string {
    // DuckDB defaults the opposite way to SQLite (ASC → NULLS LAST,
    // DESC → NULLS FIRST), so the ordering is stated explicitly to
    // match SQLite: ASC → NULLS FIRST, DESC → NULLS LAST.
    return dir === "ASC" ? " NULLS FIRST" : " NULLS LAST";
  }

  compileLimitOffset(take: number | undefined, skip: number | undefined): string {
    // DuckDB rejects a negative LIMIT ("LIMIT/OFFSET cannot be
    // negative"), so an unbounded read spells `LIMIT ALL` where
    // SQLite spells `LIMIT -1`. A bare OFFSET is legal with LIMIT ALL.
    const limitSql =
      take !== undefined && take !== -1
        ? `LIMIT ${take}`
        : skip !== undefined
          ? "LIMIT ALL"
          : "";
    const offsetSql = skip !== undefined ? `OFFSET ${skip}` : "";
    return [limitSql, offsetSql].filter(Boolean).join(" ");
  }

  encodeParam(value: unknown, def?: ColumnDefinition): unknown {
    // Driver half of the old Table.serializeValue: the undefined/null
    // handling and the NOT NULL guard live in SqlCompiler.serializeValue,
    // which calls this after those checks. DuckDB takes real booleans
    // (never boolean→1) and real JSON strings.
    if (def?.isBoolean) return Boolean(value);
    if (def?.isJson) {
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value;
    if (value instanceof Uint8Array) return value;
    // A structured value with no column definition (a raw-SQL caller, or a
    // column the schema does not declare) is stored as JSON, as before.
    // With a definition, the compiler rejects non-json objects before
    // this is reached.
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    if (def?.type === "INTEGER" && typeof value === "number" && Number.isInteger(value)) {
      // Bind an INTEGER column's value as a BIGINT, not a DOUBLE:
      // the node-api infers a JS number as DOUBLE, and a DOUBLE
      // parameter loses precision past 2^53. Epoch-ms timestamps and
      // ids stay exact as bigint.
      return BigInt(value);
    }
    return value;
  }

  decodeValue(value: unknown, def?: ColumnDefinition): unknown {
    // Driver half of the old Table.deserializeRow.
    if (value === null || value === undefined) return null;
    if (def?.isBoolean) {
      return !!value;
    }
    if (def?.isJson) {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          /* leave as-is */
        }
      }
      // A JSON value already parsed by the driver passes through.
      return value;
    }
    if (typeof value === "bigint") {
      // BIGINT comes back as a BigInt (the node-api JS converter maps
      // BIGINT → bigint). A value past MAX_SAFE_INTEGER cannot be a JS
      // number without losing precision, so it throws rather than
      // silently corrupting an id or timestamp.
      if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
        return Number(value);
      }
      throw new YattaError(`DuckDB BIGINT value ${value} exceeds JS safe integer precision.`);
    }
    if (value instanceof Date) {
      // A TIMESTAMP read back as a JS Date; the ORM's timestamp
      // columns hold toISOString() strings, so normalize to that.
      return value.toISOString();
    }
    return value;
  }

  compileUpsert(_plan: UpsertPlan): CompiledSql | null {
    // No atomic upsert: the core uses the transactional
    // find-first-then-update/insert fallback, which is the current
    // behaviour for SQLite too. An ON CONFLICT path is a later
    // optimisation.
    return null;
  }
}
