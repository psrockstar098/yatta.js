// Global database registry: path -> TypedDatabase proxy, plus the default
// database used by the global `DB` accessor.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).
// Both the engine (YattaDB.close() evicts itself) and the factory
// (createDatabase caches by path) use it, so it lives on its own to avoid
// an engine <-> factory import cycle. The factory import below is type-only
// and erased at compile time, so there is no runtime cycle.

import path from "node:path";
import type { TypedDatabase } from "./factory";

const REGISTRY_KEY = Symbol.for("yatta.db.registry");
const DEFAULT_DB_KEY = Symbol.for("yatta.db.default");

const g = globalThis as unknown as {
  [REGISTRY_KEY]?: Map<string, TypedDatabase<any>>;
  [DEFAULT_DB_KEY]?: TypedDatabase<any> | null;
};

if (!g[REGISTRY_KEY]) {
  g[REGISTRY_KEY] = new Map<string, TypedDatabase<any>>();
}
export const dbRegistry: Map<string, TypedDatabase<any>> = g[REGISTRY_KEY]!;

export function getDefaultDatabase(): TypedDatabase<any> | null {
  return g[DEFAULT_DB_KEY] ?? (dbRegistry.size > 0 ? dbRegistry.values().next().value ?? null : null);
}

export function setDefaultDatabase(db: TypedDatabase<any> | null): void {
  g[DEFAULT_DB_KEY] = db;
}

/**
 * Resolves and normalizes an input database path to an absolute filesystem path.
 *
 * Lives here (not in factory.ts) so the engine can build driver-aware
 * registry keys without importing the factory — the factory imports the
 * engine, so the reverse import would be a cycle.
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
