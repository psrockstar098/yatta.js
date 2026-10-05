import { createCache, SQLiteL2CacheStore } from "../types/cache_queue";

export const cache = createCache({
  maxItems: 20_000,
  defaultTtl: "1h",
  l2Storage: new SQLiteL2CacheStore("Database/cache.db"),
});
