// Global database registry: path -> TypedDatabase proxy, plus the default
// database used by the global `DB` accessor.
//
// Split from src/types/db.ts (Phase 1 of the multi-database ORM refactor).
// Both the engine (YattaDB.close() evicts itself) and the factory
// (createDatabase caches by path) use it, so it lives on its own to avoid
// an engine <-> factory import cycle. The factory import below is type-only
// and erased at compile time, so there is no runtime cycle.

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
