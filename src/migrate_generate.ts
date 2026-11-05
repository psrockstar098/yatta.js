// yatta migrate:generate — diff a live SQLite database against the TypeScript
// models and emit a real migration file in the existing migration format.
//
// The models are the declarative schema passed to `createDatabase` (an object
// of tables whose columns are `col.*` builders). The live schema is read from
// SQLite itself: PRAGMA table_info / foreign_key_list / index_list, plus the
// stored CREATE TABLE text for CHECK constraints and AUTOINCREMENT.
//
// What it emits, and what it refuses:
//   - New tables, new columns, new indexes, and changed column definitions
//     SQLite can express in place (ADD COLUMN, CREATE INDEX) are emitted
//     directly. Anything else goes through a table rebuild: a new table is
//     built from the models, the shared columns are copied over, and the old
//     table is swapped out, so no rows are lost.
//   - Column drops, table drops, and type or primary-key changes are
//     destructive: they are listed prominently and the file is NOT written
//     unless the caller passes --allow-destructive (or answers yes to the
//     interactive prompt). A drop paired with a same-type new column is
//     flagged as a possible rename, because this generator never renames
//     automatically — a rename guessed wrong destroys a column.
//   - Indexes that exist in the database but not in the models are left
//     alone. Dropping a hand-made index the models never mentioned would be
//     a silent performance regression, not a schema fix.
//
// Why rebuild migrations are async:
//   The migration runner wraps a synchronous `up` in a transaction, and
//   SQLite treats `PRAGMA foreign_keys = OFF` as a no-op inside one. A
//   rebuild that renames a table while foreign keys are enforced rewrites
//   child tables' references to the temporary name, and dropping that
//   temporary table then CASCADE-deletes the child rows. An async `up`
//   runs outside the runner's transaction, so it can switch foreign keys
//   off, run its own transaction, and switch them back on — the same shape
//   `syncSchema` uses at boot. A failure rolls back and leaves no marker,
//   so re-running the migration is safe.

import { Database } from "bun:sqlite";

import type { ColumnDefinition, DatabaseSchema } from "./types/db";

// ── Quoting ────────────────────────────────────────────────────────────────

/** Quote an identifier for SQLite. Doubling `"` is what makes this safe. */
export function qIdent(name: string): string {
  if (name.includes("\0")) throw new Error(`Invalid identifier: contains a NUL byte`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for SQLite. */
export function qLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── Live schema ────────────────────────────────────────────────────────────

export interface LiveColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  autoIncrement: boolean;
  /** Raw dflt_value from PRAGMA table_info, or null when there is none. */
  defaultSql: string | null;
  defaultCanonical: string | null;
  unique: boolean;
  /** Name of the unique index backing `unique`, or null for an autoindex. */
  uniqueIndexName: string | null;
  references: { table: string; column: string; onDelete: string } | null;
  checkValues: readonly string[] | null;
}

export interface LiveIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface LiveTable {
  name: string;
  /** Stored CREATE TABLE text, or null when SQLite did not keep one. */
  sql: string | null;
  columns: LiveColumn[];
  indexes: LiveIndex[];
  /** Saved index/trigger SQL for rebuilds (autoindexes have no SQL). */
  savedObjectSql: string[];
  rowCount: number;
}

export interface LiveSchema {
  tables: Record<string, LiveTable>;
}

/**
 * Read the live schema from a SQLite file. Internal tables (`sqlite_*`,
 * `_yatta_migrations`) are skipped: they are framework bookkeeping, not
 * tables the models describe.
 */
export function readLiveSchema(dbPath: string): LiveSchema {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_yatta_migrations' ORDER BY name`)
      .all() as { name: string; sql: string | null }[];
    const tables: Record<string, LiveTable> = {};
    for (const row of rows) {
      tables[row.name] = readLiveTable(db, row.name, row.sql);
    }
    return { tables };
  } finally {
    db.close();
  }
}

function readLiveTable(db: Database, table: string, sql: string | null): LiveTable {
  const info = db.query(`PRAGMA table_info(${qIdent(table)})`).all() as {
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }[];
  const fks = db.query(`PRAGMA foreign_key_list(${qIdent(table)})`).all() as {
    from: string; table: string; to: string; on_delete: string;
  }[];
  const fkByColumn = new Map<string, { table: string; column: string; onDelete: string }>();
  for (const fk of fks) {
    if (!fkByColumn.has(fk.from)) {
      fkByColumn.set(fk.from, { table: fk.table, column: fk.to, onDelete: (fk.on_delete || "NO ACTION").toUpperCase() });
    }
  }

  // Single-column unique indexes, named or autoindex-backed. A named unique
  // index can be dropped; an autoindex (from an inline UNIQUE) cannot, and
  // removing that constraint needs a rebuild instead.
  const uniqueByColumn = new Map<string, string | null>();
  const indexes: LiveIndex[] = [];
  const indexRows = db.query(`PRAGMA index_list(${qIdent(table)})`).all() as {
    name: string; unique: number; origin: string;
  }[];
  for (const idx of indexRows) {
    const cols = db.query(`PRAGMA index_info(${qIdent(idx.name)})`).all() as { name: string }[];
    const columns = cols.map((c) => c.name);
    if (idx.name.startsWith("sqlite_autoindex_")) {
      if (idx.unique === 1 && columns.length === 1) uniqueByColumn.set(columns[0]!, null);
      continue;
    }
    indexes.push({ name: idx.name, columns, unique: idx.unique === 1 });
    if (idx.unique === 1 && columns.length === 1) uniqueByColumn.set(columns[0]!, idx.name);
  }

  const hasAutoIncrement = sql !== null && /AUTOINCREMENT/i.test(sql);
  const columns: LiveColumn[] = info.map((c) => ({
    name: c.name,
    type: (c.type || "").toUpperCase(),
    notNull: c.notnull === 1 || c.pk > 0,
    pk: c.pk > 0,
    autoIncrement: c.pk > 0 && hasAutoIncrement,
    defaultSql: c.dflt_value,
    defaultCanonical: canonicalLiveDefault(c.dflt_value),
    unique: uniqueByColumn.has(c.name),
    uniqueIndexName: uniqueByColumn.get(c.name) ?? null,
    references: fkByColumn.get(c.name) ?? null,
    checkValues: parseCheckValues(sql, c.name),
  }));

  const saved = db
    .query(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all(table) as { sql: string }[];

  let rowCount = 0;
  try {
    const count = db.query(`SELECT COUNT(*) AS c FROM ${qIdent(table)}`).get() as { c: number } | null;
    rowCount = count?.c ?? 0;
  } catch {
    rowCount = 0;
  }

  return {
    name: table,
    sql,
    columns,
    indexes,
    savedObjectSql: saved.map((s) => s.sql),
    rowCount,
  };
}

/** Pull a CHECK("col" IN (...)) list out of stored CREATE TABLE text. */
function parseCheckValues(sql: string | null, column: string): readonly string[] | null {
  if (!sql) return null;
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(`CHECK\\s*\\(\\s*"${escaped}"\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, "i"));
  if (!match) return null;
  // Tokenise quoted strings rather than splitting on commas: a value may
  // itself contain a comma or a parenthesis, and a naive split would then
  // misread the list and report a phantom change on every run.
  const values: string[] = [];
  const tokens = match[1]!.match(/'([^']|'')*'/g);
  if (!tokens) return null;
  for (const token of tokens) {
    values.push(token.slice(1, -1).replace(/''/g, "'"));
  }
  return values;
}

/** Normalise a PRAGMA dflt_value into the same shape as a model default. */
export function canonicalLiveDefault(dflt: string | null): string | null {
  if (dflt === null || dflt === undefined) return null;
  let text = dflt.trim();
  if (text.toUpperCase() === "NULL") return null;
  if (text.toUpperCase() === "CURRENT_TIMESTAMP") return "CURRENT_TIMESTAMP";
  if (/strftime/i.test(text) && /'now'/i.test(text)) return "CURRENT_TIMESTAMP";
  // Expression defaults arrive wrapped in one pair of parentheses.
  if (text.startsWith("(") && text.endsWith(")") && text.length > 2) {
    const inner = text.slice(1, -1).trim();
    if (/^'([^']|'')*'$/.test(inner)) return inner.slice(1, -1).replace(/''/g, "'");
    return inner;
  }
  if (/^'([^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** Normalise a model default into the shape PRAGMA dflt_value normalises to. */
export function canonicalModelDefault(def: ColumnDefinition): string | null {
  const value = def.defaultValue;
  if (value === undefined || value === null) return null;
  if (value === "CURRENT_TIMESTAMP") return "CURRENT_TIMESTAMP";
  if (def.isBoolean) return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Two canonical defaults match, with numeric spellings compared by value. */
function defaultsEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (/^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b)) return Number(a) === Number(b);
  return false;
}

// ── Desired schema (models) ────────────────────────────────────────────────

export interface DesiredColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  autoIncrement: boolean;
  defaultCanonical: string | null;
  unique: boolean;
  isIndex: boolean;
  references: { table: string; column: string; onDelete: string } | null;
  checkValues: readonly string[] | null;
  def: ColumnDefinition;
}

export interface DesiredTable {
  name: string;
  columns: DesiredColumn[];
}

export interface DesiredSchema {
  tables: Record<string, DesiredTable>;
}

/** Validate a loaded module looks like a models schema, then normalise it. */
export function normalizeModelSchema(schema: unknown): DesiredSchema {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Schema export is not an object of tables");
  }
  const tables: Record<string, DesiredTable> = {};
  for (const [tableName, tableDef] of Object.entries(schema as Record<string, unknown>)) {
    if (tableDef === null || typeof tableDef !== "object" || Array.isArray(tableDef)) {
      throw new Error(`Table "${tableName}" is not an object of columns`);
    }
    const columns: DesiredColumn[] = [];
    for (const [colName, builder] of Object.entries(tableDef as Record<string, unknown>)) {
      const def = (builder as { def?: unknown } | null)?.def as ColumnDefinition | undefined;
      if (!def || typeof def.type !== "string") {
        throw new Error(`Column "${tableName}.${colName}" is not a col.* builder (missing .def.type)`);
      }
      const allowed = ["INTEGER", "TEXT", "REAL", "BLOB"];
      if (!allowed.includes(def.type)) {
        throw new Error(`Column "${tableName}.${colName}" has unsupported type "${def.type}"`);
      }
      columns.push({
        name: colName,
        type: def.type,
        notNull: def.notNull === true || def.primaryKey === true,
        pk: def.primaryKey === true,
        autoIncrement: def.autoIncrement === true,
        defaultCanonical: canonicalModelDefault(def),
        unique: def.unique === true,
        isIndex: def.isIndex === true,
        references: def.references
          ? {
              table: def.references.table,
              column: def.references.column,
              onDelete: (def.references.onDelete ?? "NO ACTION").toUpperCase(),
            }
          : null,
        checkValues: def.checkValues ?? null,
        def,
      });
    }
    tables[tableName] = { name: tableName, columns };
  }
  return { tables };
}

// ── Diff ───────────────────────────────────────────────────────────────────

export type ChangeKind =
  | "new-table"
  | "new-column"
  | "changed-column"
  | "new-index"
  | "drop-index"
  | "drop-table"
  | "drop-column";

export interface DiffChange {
  kind: ChangeKind;
  table: string;
  column?: string;
  detail: string;
  destructive: boolean;
  /** True when this change can only be applied by rebuilding the table. */
  rebuild: boolean;
}

export interface SchemaDiff {
  changes: DiffChange[];
  destructive: DiffChange[];
  /** Tables that need a rebuild (grouped so one rebuild covers all their changes). */
  rebuildTables: string[];
}

/** Whether a plain index on these columns already covers the wanted index. */
function liveHasIndex(live: LiveTable, columns: string[], unique: boolean): boolean {
  return live.indexes.some(
    (idx) =>
      idx.columns.length === columns.length &&
      idx.columns.every((c, i) => c === columns[i]) &&
      (idx.unique === unique || (unique === false && idx.unique === true)),
  );
}

/** A type change is gated as destructive: without scanning every row the
 *  generator cannot prove the conversion loses nothing (TEXT '007' into
 *  INTEGER is 7, for example), so it refuses to guess. */
function isLossyTypeChange(from: string, to: string): boolean {
  return from !== to;
}

export function diffSchemas(live: LiveSchema, desired: DesiredSchema): SchemaDiff {
  const changes: DiffChange[] = [];
  const rebuildTables = new Set<string>();

  for (const [tableName, desiredTable] of Object.entries(desired.tables)) {
    const liveTable = live.tables[tableName];
    if (!liveTable) {
      changes.push({
        kind: "new-table",
        table: tableName,
        detail: `Create table ${tableName} with ${desiredTable.columns.length} column(s)`,
        destructive: false,
        rebuild: false,
      });
      continue;
    }

    const liveCols = new Map(liveTable.columns.map((c) => [c.name, c]));
    const desiredCols = new Map(desiredTable.columns.map((c) => [c.name, c]));
    let tableNeedsRebuild = false;

    // Dropped columns are destructive, and a same-type new column beside one
    // is called out as a possible rename rather than silently treated as
    // an unrelated drop plus add.
    for (const liveCol of liveTable.columns) {
      if (desiredCols.has(liveCol.name)) continue;
      const renameHint = desiredTable.columns.some(
        (c) => !liveCols.has(c.name) && c.type === liveCol.type,
      )
        ? " A new column with the same type exists in this table — if this is a rename, write the rename by hand; this generator never renames automatically."
        : "";
      changes.push({
        kind: "drop-column",
        table: tableName,
        column: liveCol.name,
        detail: `Drop column ${tableName}.${liveCol.name} — all values in it are lost.${renameHint}`,
        destructive: true,
        rebuild: false,
      });
    }

    for (const desiredCol of desiredTable.columns) {
      const liveCol = liveCols.get(desiredCol.name);
      if (!liveCol) {
        // ADD COLUMN cannot add a primary key, a NOT NULL column without a
        // default, or an expression default to a table that already has
        // rows — those go through a rebuild instead.
        const needsRebuild =
          desiredCol.pk ||
          (desiredCol.notNull && desiredCol.defaultCanonical === null) ||
          (desiredCol.defaultCanonical === "CURRENT_TIMESTAMP" && liveTable.rowCount > 0);
        if (needsRebuild) tableNeedsRebuild = true;
        changes.push({
          kind: "new-column",
          table: tableName,
          column: desiredCol.name,
          detail: `Add column ${tableName}.${desiredCol.name} (${desiredCol.type}${desiredCol.notNull ? " NOT NULL" : ""})${needsRebuild ? " via table rebuild" : ""}`,
          destructive: false,
          rebuild: needsRebuild,
        });
        continue;
      }

      // Unique-only differences are index operations, not rebuilds — unless
      // the live unique constraint is an autoindex, which cannot be dropped.
      const uniqueDiffers = liveCol.unique !== desiredCol.unique;
      const otherDiffers =
        liveCol.type !== desiredCol.type ||
        liveCol.notNull !== desiredCol.notNull ||
        !defaultsEqual(liveCol.defaultCanonical, desiredCol.defaultCanonical) ||
        liveCol.pk !== desiredCol.pk ||
        liveCol.autoIncrement !== desiredCol.autoIncrement ||
        JSON.stringify(liveCol.references) !== JSON.stringify(desiredCol.references) ||
        JSON.stringify(liveCol.checkValues ?? null) !== JSON.stringify(desiredCol.checkValues ?? null);

      if (uniqueDiffers && !otherDiffers) {
        if (desiredCol.unique) {
          changes.push({
            kind: "new-index",
            table: tableName,
            column: desiredCol.name,
            detail: `Add unique index on ${tableName}.${desiredCol.name}`,
            destructive: false,
            rebuild: false,
          });
        } else if (liveCol.uniqueIndexName) {
          changes.push({
            kind: "drop-index",
            table: tableName,
            column: desiredCol.name,
            detail: `Drop unique index ${liveCol.uniqueIndexName} on ${tableName}.${desiredCol.name}`,
            destructive: false,
            rebuild: false,
          });
        } else {
          // Inline UNIQUE lives in the table definition; only a rebuild
          // can remove it, and it preserves every row while doing so.
          tableNeedsRebuild = true;
          changes.push({
            kind: "changed-column",
            table: tableName,
            column: desiredCol.name,
            detail: `Remove UNIQUE from ${tableName}.${desiredCol.name} via table rebuild`,
            destructive: false,
            rebuild: true,
          });
        }
        continue;
      }

      if (otherDiffers) {
        const typeChanged = liveCol.type !== desiredCol.type;
        const pkChanged = liveCol.pk !== desiredCol.pk;
        const parts: string[] = [];
        if (typeChanged) parts.push(`type ${liveCol.type} -> ${desiredCol.type}`);
        if (liveCol.notNull !== desiredCol.notNull) parts.push(`nullability ${liveCol.notNull ? "NOT NULL" : "nullable"} -> ${desiredCol.notNull ? "NOT NULL" : "nullable"}`);
        if (!defaultsEqual(liveCol.defaultCanonical, desiredCol.defaultCanonical)) parts.push(`default ${liveCol.defaultCanonical ?? "none"} -> ${desiredCol.defaultCanonical ?? "none"}`);
        if (pkChanged) parts.push("primary key membership");
        if (liveCol.autoIncrement !== desiredCol.autoIncrement) parts.push("AUTOINCREMENT");
        if (JSON.stringify(liveCol.references) !== JSON.stringify(desiredCol.references)) parts.push("foreign key");
        if (JSON.stringify(liveCol.checkValues ?? null) !== JSON.stringify(desiredCol.checkValues ?? null)) parts.push("CHECK values");
        if (uniqueDiffers) parts.push(`UNIQUE ${liveCol.unique ? "-> removed" : "-> added"}`);
        if (!liveCol.notNull && desiredCol.notNull) parts.push("WARNING: rows holding NULL in this column will fail the apply — clean them first");
        tableNeedsRebuild = true;
        changes.push({
          kind: "changed-column",
          table: tableName,
          column: desiredCol.name,
          detail: `Rebuild ${tableName}.${desiredCol.name}: ${parts.join(", ")} — rows are copied, not deleted`,
          destructive: typeChanged || pkChanged,
          rebuild: true,
        });
      }
    }

    // Wanted indexes that the live database does not have yet. Unique
    // columns are handled by the uniqueDiffers branch above; this loop only
    // covers plain indexes, and skips tables a rebuild already covers.
    if (!tableNeedsRebuild) {
      for (const desiredCol of desiredTable.columns) {
        if (desiredCol.unique) continue;
        if (!liveCols.has(desiredCol.name)) continue;
        if (desiredCol.isIndex || desiredCol.references) {
          if (!liveHasIndex(liveTable, [desiredCol.name], false)) {
            changes.push({
              kind: "new-index",
              table: tableName,
              column: desiredCol.name,
              detail: `Add index on ${tableName}.${desiredCol.name}`,
              destructive: false,
              rebuild: false,
            });
          }
        }
      }
    }

    if (tableNeedsRebuild) rebuildTables.add(tableName);
  }

  for (const liveName of Object.keys(live.tables)) {
    if (desired.tables[liveName]) continue;
    changes.push({
      kind: "drop-table",
      table: liveName,
      detail: `Drop table ${liveName} — all rows in it are lost`,
      destructive: true,
      rebuild: false,
    });
  }

  return {
    changes,
    destructive: changes.filter((c) => c.destructive),
    rebuildTables: [...rebuildTables],
  };
}

// ── SQL rendering ──────────────────────────────────────────────────────────

function formatModelDefault(def: ColumnDefinition): string {
  if (def.defaultValue === null) return "NULL";
  if (def.defaultValue === "CURRENT_TIMESTAMP") return "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  if (typeof def.defaultValue === "number" || def.isBoolean) {
    return String(def.isBoolean ? (def.defaultValue ? 1 : 0) : def.defaultValue);
  }
  if (typeof def.defaultValue === "object") {
    return qLiteral(JSON.stringify(def.defaultValue));
  }
  return qLiteral(String(def.defaultValue));
}

/** CREATE TABLE column fragment, mirroring the one `syncSchema` writes. */
export function createColumnFragment(colName: string, def: ColumnDefinition): string {
  let s = `${qIdent(colName)} ${def.type}`;
  if (def.primaryKey) s += " PRIMARY KEY";
  if (def.autoIncrement) s += " AUTOINCREMENT";
  if (def.notNull) s += " NOT NULL";
  if (def.unique) s += " UNIQUE";
  if (def.defaultValue !== undefined) s += ` DEFAULT ${formatModelDefault(def)}`;
  if (def.references) {
    s += ` REFERENCES ${qIdent(def.references.table)}(${qIdent(def.references.column)})`;
    if (def.references.onDelete) s += ` ON DELETE ${def.references.onDelete}`;
  }
  if (def.checkValues?.length) {
    s += ` CHECK(${qIdent(colName)} IN (${def.checkValues.map((v) => qLiteral(v)).join(", ")}))`;
  }
  return s;
}

/** ADD COLUMN fragment: SQLite forbids PRIMARY KEY and UNIQUE here. */
export function alterColumnFragment(colName: string, def: ColumnDefinition): string {
  let s = `${qIdent(colName)} ${def.type}`;
  if (def.notNull) s += " NOT NULL";
  if (def.defaultValue !== undefined) s += ` DEFAULT ${formatModelDefault(def)}`;
  if (def.references) {
    s += ` REFERENCES ${qIdent(def.references.table)}(${qIdent(def.references.column)})`;
    if (def.references.onDelete) s += ` ON DELETE ${def.references.onDelete}`;
  }
  if (def.checkValues?.length) {
    s += ` CHECK(${qIdent(colName)} IN (${def.checkValues.map((v) => qLiteral(v)).join(", ")}))`;
  }
  return s;
}

function createTableSql(table: DesiredTable): string {
  return `CREATE TABLE ${qIdent(table.name)} (${table.columns.map((c) => createColumnFragment(c.name, c.def)).join(", ")});`;
}

function indexName(prefix: string, table: string, column: string): string {
  return `${prefix}_${table}_${column}`;
}

/** Statements that create the wanted plain indexes for one desired table.
 *  Unique columns are not listed here: a new or rebuilt table carries them
 *  inline (UNIQUE in the CREATE TABLE), and a unique added to an existing
 *  table goes through the new-index change, not this helper. */
function desiredIndexStatements(table: DesiredTable, live: LiveTable | undefined): string[] {
  const out: string[] = [];
  for (const col of table.columns) {
    if (col.unique) continue;
    if (col.isIndex || col.references) {
      if (!live || !liveHasIndex(live, [col.name], false)) {
        out.push(`CREATE INDEX IF NOT EXISTS ${qIdent(indexName("idx", table.name, col.name))} ON ${qIdent(table.name)} (${qIdent(col.name)});`);
      }
    }
  }
  return out;
}

interface RenderedMigration {
  /** Statements for `up`, in apply order. */
  up: string[];
  /** Statements for `down`, in apply order. */
  down: string[];
  /** True when either side needs a rebuild (so both sides are async). */
  needsRebuild: boolean;
  /** Tables rebuilt by `up`, for the file header. */
  rebuildTables: string[];
}

/**
 * Turn a diff into up/down statements. Tables that need a rebuild get one
 * rebuild each: every column change, new column, and dropped column on that
 * table is folded into the rebuilt definition, so the table is only copied
 * once. Dropped columns on a rebuilt table disappear by omission — their
 * data is not copied — which is why they stay destructive-gated.
 */
export function renderStatements(diff: SchemaDiff, live: LiveSchema, desired: DesiredSchema): RenderedMigration {
  const up: string[] = [];
  const down: string[] = [];
  const rebuildSet = new Set(diff.rebuildTables);
  const droppedColumns = new Map<string, Set<string>>();
  for (const c of diff.changes) {
    if (c.kind === "drop-column" && c.column) {
      if (!droppedColumns.has(c.table)) droppedColumns.set(c.table, new Set());
      droppedColumns.get(c.table)!.add(c.column);
    }
  }

  // Up, in order: new tables, plain adds and index ops, rebuilds, drops.
  for (const change of diff.changes) {
    if (change.kind !== "new-table") continue;
    const table = desired.tables[change.table]!;
    up.push(createTableSql(table));
    up.push(...desiredIndexStatements(table, undefined));
    down.unshift(`DROP TABLE ${qIdent(change.table)};`);
  }

  for (const change of diff.changes) {
    // A new column on a rebuilt table is folded into the rebuild: emitting
    // an ADD COLUMN for it as well would fail with a duplicate column name.
    if (change.kind === "new-column" && !change.rebuild && !rebuildSet.has(change.table)) {
      const table = desired.tables[change.table]!;
      const col = table.columns.find((c) => c.name === change.column)!;
      up.push(`ALTER TABLE ${qIdent(change.table)} ADD COLUMN ${alterColumnFragment(col.name, col.def)};`);
      if (col.unique) {
        up.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${qIdent(indexName("uniq", change.table, col.name))} ON ${qIdent(change.table)} (${qIdent(col.name)});`);
      } else if (col.isIndex || col.references) {
        up.push(`CREATE INDEX IF NOT EXISTS ${qIdent(indexName("idx", change.table, col.name))} ON ${qIdent(change.table)} (${qIdent(col.name)});`);
      }
      // Down runs in array order, and DROP COLUMN refuses a column that an
      // index still covers, so the index drop is unshifted after the column
      // drop and therefore executes first.
      down.unshift(`ALTER TABLE ${qIdent(change.table)} DROP COLUMN ${qIdent(col.name)};`);
      if (col.unique) {
        down.unshift(`DROP INDEX IF EXISTS ${qIdent(indexName("uniq", change.table, col.name))};`);
      } else if (col.isIndex || col.references) {
        down.unshift(`DROP INDEX IF EXISTS ${qIdent(indexName("idx", change.table, col.name))};`);
      }
    }
  }

  for (const change of diff.changes) {
    // Index changes on a rebuilt table are folded into the rebuild itself
    // (desired indexes are recreated after the swap, and the down rebuild
    // restores the old table), so emitting them separately would duplicate
    // work and, for a removed unique index, resurrect it via the saved list.
    if (rebuildSet.has(change.table)) continue;
    if (change.kind === "new-index") {
      const table = desired.tables[change.table]!;
      const col = table.columns.find((c) => c.name === change.column)!;
      const name = indexName(col.unique ? "uniq" : "idx", change.table, col.name);
      const unique = col.unique ? "UNIQUE " : "";
      up.push(`CREATE ${unique}INDEX IF NOT EXISTS ${qIdent(name)} ON ${qIdent(change.table)} (${qIdent(col.name)});`);
      down.unshift(`DROP INDEX IF EXISTS ${qIdent(name)};`);
    }
    if (change.kind === "drop-index") {
      const liveTable = live.tables[change.table]!;
      const liveCol = liveTable.columns.find((c) => c.name === change.column)!;
      const name = liveCol.uniqueIndexName!;
      up.push(`DROP INDEX IF EXISTS ${qIdent(name)};`);
      down.unshift(`CREATE UNIQUE INDEX IF NOT EXISTS ${qIdent(name)} ON ${qIdent(change.table)} (${qIdent(change.column!)});`);
    }
  }

  // Rebuilds: new table from the models, copy the columns both sides share
  // (minus dropped columns), swap, then recreate saved objects and indexes.
  for (const tableName of diff.rebuildTables) {
    const desiredTable = desired.tables[tableName]!;
    const liveTable = live.tables[tableName]!;
    const dropped = droppedColumns.get(tableName) ?? new Set<string>();
    const common = desiredTable.columns
      .filter((c) => liveTable.columns.some((l) => l.name === c.name) && !dropped.has(c.name))
      .map((c) => c.name);
    const colList = common.map((c) => qIdent(c)).join(", ");
    const temp = `_yatta_new_${tableName}`;
    const changedCols = new Set(
      diff.changes
        .filter((c) => c.table === tableName && (c.kind === "changed-column" || c.kind === "new-column" || c.kind === "drop-index"))
        .map((c) => c.column),
    );
    // Saved indexes on changed columns are superseded by the desired
    // indexes below; every other saved object is recreated verbatim.
    const saved = liveTable.savedObjectSql.filter((sql) => {
      const match = sql.match(/ON\s+"((?:[^"]|"")+)"/i);
      if (!match) return true;
      const idxName = match[1]!.replace(/""/g, '"');
      const idx = liveTable.indexes.find((i) => i.name === idxName);
      if (!idx) return true;
      return !idx.columns.some((c) => changedCols.has(c));
    });
    up.push(`DROP TABLE IF EXISTS ${qIdent(temp)};`);
    up.push(`CREATE TABLE ${qIdent(temp)} (${desiredTable.columns.map((c) => createColumnFragment(c.name, c.def)).join(", ")});`);
    if (common.length > 0) up.push(`INSERT INTO ${qIdent(temp)} (${colList}) SELECT ${colList} FROM ${qIdent(tableName)};`);
    up.push(`DROP TABLE ${qIdent(tableName)};`);
    up.push(`ALTER TABLE ${qIdent(temp)} RENAME TO ${qIdent(tableName)};`);
    up.push(...saved);
    up.push(...desiredIndexStatements(desiredTable, { ...liveTable, indexes: [] }));
    // Down rebuilds the table from its stored CREATE TABLE text, which
    // preserves CHECK constraints and AUTOINCREMENT exactly as they were.
    if (liveTable.sql) {
      const downTemp = `_yatta_old_${tableName}`;
      const downSql = liveTable.sql.replace(
        /^CREATE TABLE (IF NOT EXISTS )?"?((?:[^"]|"")*)"?/i,
        (_m, ifNotExists: string | undefined) => `CREATE TABLE ${ifNotExists ?? ""}${qIdent(downTemp)}`,
      );
      const downCommon = liveTable.columns
        .filter((c) => desiredTable.columns.some((d) => d.name === c.name))
        .map((c) => c.name);
      const downList = downCommon.map((c) => qIdent(c)).join(", ");
      const downSteps: string[] = [
        `DROP TABLE IF EXISTS ${qIdent(downTemp)};`,
        `${downSql.endsWith(";") ? downSql : `${downSql};`}`,
      ];
      if (downCommon.length > 0) downSteps.push(`INSERT INTO ${qIdent(downTemp)} (${downList}) SELECT ${downList} FROM ${qIdent(tableName)};`);
      downSteps.push(`DROP TABLE ${qIdent(tableName)};`);
      downSteps.push(`ALTER TABLE ${qIdent(downTemp)} RENAME TO ${qIdent(tableName)};`);
      downSteps.push(...liveTable.savedObjectSql);
      down.unshift(...downSteps);
    }
  }

  // Drops last on the way up, first on the way down.
  for (const change of diff.changes) {
    if (change.kind === "drop-column" && !rebuildSet.has(change.table)) {
      const liveTable = live.tables[change.table]!;
      const liveCol = liveTable.columns.find((c) => c.name === change.column)!;
      up.push(`ALTER TABLE ${qIdent(change.table)} DROP COLUMN ${qIdent(change.column!)};`);
      const back = liveCol.notNull && liveCol.defaultSql === null
        ? null
        : `ALTER TABLE ${qIdent(change.table)} ADD COLUMN ${liveColumnFragment(liveCol)};`;
      if (back) down.unshift(back);
      else down.unshift(`-- NOTE: ${change.table}.${change.column} was NOT NULL without a default, so ADD COLUMN cannot restore it; rebuild the table from its previous definition to roll this back.`);
    }
    if (change.kind === "drop-table") {
      const liveTable = live.tables[change.table]!;
      up.push(`DROP TABLE ${qIdent(change.table)};`);
      if (liveTable.sql) down.unshift(liveTable.sql.endsWith(";") ? liveTable.sql : `${liveTable.sql};`);
    }
  }

  return {
    up,
    down,
    needsRebuild: diff.rebuildTables.length > 0 || downNeedsRebuild(diff, live),
    rebuildTables: diff.rebuildTables,
  };
}

/** Down needs its own rebuild when a dropped NOT NULL column cannot be added back. */
function downNeedsRebuild(diff: SchemaDiff, live: LiveSchema): boolean {
  const rebuildSet = new Set(diff.rebuildTables);
  return diff.changes.some((c) => {
    if (c.kind !== "drop-column" || !c.column || rebuildSet.has(c.table)) return false;
    const col = live.tables[c.table]?.columns.find((l) => l.name === c.column);
    return !!col && col.notNull && col.defaultSql === null;
  });
}

/** ADD COLUMN fragment for a live column (used to restore a dropped column). */
function liveColumnFragment(col: LiveColumn): string {
  let s = `${qIdent(col.name)} ${col.type}`;
  if (col.notNull) s += " NOT NULL";
  if (col.defaultSql !== null) s += ` DEFAULT ${col.defaultSql}`;
  if (col.references) {
    s += ` REFERENCES ${qIdent(col.references.table)}(${qIdent(col.references.column)})`;
    if (col.references.onDelete && col.references.onDelete !== "NO ACTION") s += ` ON DELETE ${col.references.onDelete}`;
  }
  if (col.checkValues?.length) {
    s += ` CHECK(${qIdent(col.name)} IN (${col.checkValues.map((v) => qLiteral(v)).join(", ")}))`;
  }
  return s;
}

// ── File rendering ─────────────────────────────────────────────────────────

export function migrationFileName(name: string): { filename: string; migrationName: string } {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").split(".")[0];
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return { filename: `${timestamp}_${safeName}.ts`, migrationName: `${timestamp}_${safeName}` };
}

function renderBody(statements: string[], asyncBody: boolean): string {
  const runs = statements
    .filter((s) => !s.startsWith("-- NOTE"))
    .map((s) => `    db.run(\`${s.replace(/`/g, "\\`").replace(/\$/g, "\\$")}\`);`)
    .join("\n");
  const notes = statements.filter((s) => s.startsWith("-- NOTE")).map((s) => `    // ${s.slice(3).trim()}`);
  const body = [...notes, runs].filter(Boolean).join("\n");
  if (!asyncBody) return body || "    // No statements.";
  // Async so foreign keys can be switched off outside the runner's
  // transaction; the runner does not wrap an async `up` in one.
  return [
    "    db.run(`PRAGMA foreign_keys = OFF;`);",
    "    try {",
    "      db.run(`BEGIN IMMEDIATE;`);",
    "      try {",
    ...body.split("\n").map((line) => `        ${line}`),
    "        db.run(`COMMIT;`);",
    "      } catch (err) {",
    "        try { db.run(`ROLLBACK;`); } catch {",
    "          // Already rolled back by SQLite.",
    "        }",
    "        throw err;",
    "      }",
    "    } finally {",
    "      db.run(`PRAGMA foreign_keys = ON;`);",
    "    }",
  ].join("\n");
}

/** Render the migration file in the existing format: name, up, down. */
export function renderMigrationFile(
  migrationName: string,
  diff: SchemaDiff,
  rendered: RenderedMigration,
): string {
  // Header lines are `//` comments, so a table or column name containing a
  // newline would end the comment and put raw text into the file — text
  // that runs when the migration is imported. Names come from the
  // developer's own models, but a generated file must never be an injection
  // vector for them, so control characters are stripped from header text.
  // (Statement text is different: it travels inside template literals with
  // backticks and `${` escaped, and identifiers are always quoted.)
  const clean = (line: string): string => line.replace(/[\r\n\x00-\x1f\x7f]/g, " ");
  const header: string[] = [
    `// Migration: ${migrationName}`,
    `// Generated: ${new Date().toISOString()}`,
    `// Generated by \`yatta migrate:generate\` from the models — review it before running \`yatta migrate\`.`,
    `//`,
  ];
  for (const change of diff.changes) {
    header.push(clean(`// ${change.destructive ? "DESTRUCTIVE: " : ""}${change.detail}`));
  }
  if (rendered.needsRebuild) {
    header.push(`//`);
    header.push(`// This migration rebuilds tables (${rendered.rebuildTables.join(", ") || "see down"}): rows are copied to the new definition.`);
    header.push(`// It is async so foreign keys can be switched off outside the runner's transaction — see the note in src/migrate_generate.ts.`);
  }
  if (diff.destructive.length > 0) {
    header.push(`//`);
    header.push(`// DESTRUCTIVE CHANGES: this migration deletes data. It was written only because --allow-destructive was given (or confirmed interactively).`);
  }
  header.push(`//`);
  header.push(`// Down migrations reverse what up does where reversible. Dropped data cannot be restored by down — it is gone.`);

  return `${header.join("\n")}

export default {
  name: "${migrationName}",

  ${rendered.needsRebuild ? "async " : ""}up(db: any) {
${renderBody(rendered.up, rendered.needsRebuild)}
  },

  ${rendered.needsRebuild ? "async " : ""}down(db: any) {
${renderBody(rendered.down, rendered.needsRebuild)}
  },
};
`;
}
