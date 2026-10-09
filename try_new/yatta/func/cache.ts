// yatta/func/cache.ts
//
// Two-tier cache: L1 in-process LRU, L2 persisted to SQLite.
import { createCache, SQLiteL2CacheStore } from "yatta.js/cache";

export const cache = createCache({
  maxItems: 20_000,
  defaultTtl: "1h",
  l2Storage: new SQLiteL2CacheStore("Database/cache.db"),
});
