// Database factory: createDatabase, the TypedDatabase proxy type, the
// global DB accessor, and the connect() helper.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).

import fs from "node:fs";
import path from "node:path";
import { YattaError } from "./errors";
import { YattaDB } from "./engine";
import type { DatabaseOptions } from "./engine";
import { dbRegistry, getDefaultDatabase, setDefaultDatabase } from "./registry";
import type { DatabaseSchema, InferInsert, InferRow, RegisteredSchema } from "./schema";
import type { Table } from "./table";

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
  if (options.driver === "pglite") {
    // A pglite database must never be cached under a sqlite path key, so
    // this throws before the registry lookup below. Phase 2 implements it.
    throw new YattaError(
      `Driver "pglite" is not available yet — PGlite support lands in Phase 2 of the multi-database build.`,
    );
  }
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