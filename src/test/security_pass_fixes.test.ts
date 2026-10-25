import { describe, it, expect, beforeEach } from "bun:test";
import { createStorage, parseDuration } from "../types/storage";
import { GranularRateLimiter, MemoryRateLimitStore } from "../types/auth";
import { mkdir, writeFile, rm } from "node:fs/promises";

describe("Security pass 2026-10-25 — storage + limiter fixes", () => {
  const base = "/tmp/yatta-pass-storage";
  beforeEach(async () => {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    await writeFile(base + "/public.txt", "PUBLIC");
  });

  it("single-disk form honours authorize (deny reads)", async () => {
    const storage: any = createStorage({
      driver: "local",
      baseDir: base,
      authorize: () => false,
    } as any);
    const res = await storage.handleRequest(
      new Request("http://localhost/storage/files/public.txt"),
      "/storage",
    );
    expect(res.status).toBe(403);
  });

  it("single-disk form honours security.signedUrls (direct reads off)", async () => {
    const storage: any = createStorage({
      driver: "local",
      baseDir: base,
      security: { signedUrls: true },
      secret: "test-secret-123",
    } as any);
    const res = await storage.handleRequest(
      new Request("http://localhost/storage/files/public.txt"),
      "/storage",
    );
    expect(res.status).toBe(403);
  });

  it("parseDuration throws on unparseable strings instead of silently defaulting", () => {
    expect(() => parseDuration("1hh" as any)).toThrow();
    expect(() => parseDuration("-1h" as any)).toThrow();
    expect(() => parseDuration("banana" as any)).toThrow();
    expect(parseDuration("1.5h")).toBe(5400);
    expect(parseDuration(undefined)).toBe(3600);
  });

  it("failures during an active lockout do not extend it", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new GranularRateLimiter(store, {
      login: { maxAttempts: 2, windowSec: 60, lockoutSec: 60 },
    } as any);
    await limiter.recordFailure("login", "1.2.3.4");
    await limiter.recordFailure("login", "1.2.3.4");
    const locked = await store.get("rl:login:ip:1.2.3.4");
    expect(locked?.lockoutUntil).toBeGreaterThan(Date.now());
    const firstLockout = locked!.lockoutUntil!;
    await limiter.recordFailure("login", "1.2.3.4");
    await limiter.recordFailure("login", "1.2.3.4");
    const still = await store.get("rl:login:ip:1.2.3.4");
    expect(still?.lockoutUntil).toBe(firstLockout);
  });
});
