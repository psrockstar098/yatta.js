/*
 * Spawned by main_entrypoint.test.ts, never run as a test itself.
 *
 * Boots the real entrypoint, then throws an uncaught exception, so the test can
 * assert a fatal fault exits 1 quickly instead of draining with exit 0. The
 * throw happens one second after the import resolves — by then bootstrap() has
 * run synchronously through registering the fatal handlers.
 */
import { resolve } from "node:path";

await import(resolve(import.meta.dir, "..", "main.ts"));

setTimeout(() => {
  throw new Error("fatal-driver boom");
}, 1000);
