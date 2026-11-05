import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  FileNotFoundError,
  StorageDisk,
  StorageFile,
  createStorage,
  guessContentType,
  sanitizeKey,
  type FileMetadata,
  type IStorageDriver,
  type ListOptions,
  type SignedUrlOptions,
  type UploadInput,
  type UploadOptions,
} from "../types/storage";
import {
  createTieredStorage,
  createTieredStorageFromManager,
  createTieringJobHandler,
  scheduleTiering,
  type TieredStorage,
} from "../types/storage_tiering";
import { Context, createAPI, API } from "../types/api";
import { createCron } from "../types/job";

/**
 * In-memory driver shaped like an S3 disk: same driver interface, no
 * network, no credentials. Used as the cold disk in every test, so no
 * test ever touches a real provider.
 */
class FakeDisk implements IStorageDriver {
  constructor(
    private nowMs: () => number = Date.now,
    private baseUrl = "https://fake-cold.local",
  ) {}
  private files = new Map<
    string,
    {
      bytes: Buffer;
      contentType: string;
      lastModified: Date;
      metadata?: Record<string, string>;
    }
  >();
  /** Counts uploads, so a test can prove a copy happened (or did not). */
  uploads = 0;
  /** Counts deletes, so a test can prove delete ran last (or not at all). */
  deletes = 0;
  /** When set, the next upload throws, simulating an interrupted move. */
  failNextUpload?: Error;

  setMtime(key: string, ms: number): void {
    const entry = this.files.get(sanitizeKey(key));
    if (entry) entry.lastModified = new Date(ms);
  }

  private async readInput(data: UploadInput): Promise<Buffer> {
    if (typeof data === "string") return Buffer.from(data);
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
    if (data instanceof ReadableStream) {
      return Buffer.from(await new Response(data).arrayBuffer());
    }
    if (typeof data === "object" && data !== null) {
      return Buffer.from(JSON.stringify(data));
    }
    return Buffer.from(String(data));
  }

  async upload(
    key: string,
    data: UploadInput,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const clean = sanitizeKey(key);
    if (this.failNextUpload) {
      const err = this.failNextUpload;
      this.failNextUpload = undefined;
      throw err;
    }
    const bytes = await this.readInput(data);
    const contentType = options?.contentType ?? guessContentType(clean);
    this.files.set(clean, {
      bytes,
      contentType,
      lastModified: new Date(this.nowMs()),
      metadata: options?.metadata,
    });
    this.uploads += 1;
    return {
      path: clean,
      size: bytes.length,
      contentType,
      lastModified: new Date(this.nowMs()),
      etag: `"${bytes.length}"`,
      url: this.publicUrl(clean),
      metadata: options?.metadata,
    };
  }

  async download(key: string): Promise<StorageFile> {
    const clean = sanitizeKey(key);
    const entry = this.files.get(clean);
    if (!entry) throw new FileNotFoundError(clean);
    const bytes = entry.bytes;
    return new StorageFile(
      clean,
      bytes.length,
      entry.contentType,
      entry.lastModified,
      () => new Blob([new Uint8Array(bytes)]).stream(),
      (start, end) => new Blob([new Uint8Array(bytes.subarray(start, end))]).stream(),
      `"${bytes.length}"`,
      entry.metadata,
    );
  }

  async head(key: string): Promise<FileMetadata> {
    const clean = sanitizeKey(key);
    const entry = this.files.get(clean);
    if (!entry) throw new FileNotFoundError(clean);
    return {
      path: clean,
      size: entry.bytes.length,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
      etag: `"${entry.bytes.length}"`,
      url: this.publicUrl(clean),
      metadata: entry.metadata,
    };
  }

  async delete(key: string): Promise<void> {
    this.files.delete(sanitizeKey(key));
    this.deletes += 1;
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  async copy(sourceKey: string, destKey: string): Promise<FileMetadata> {
    const src = sanitizeKey(sourceKey);
    const dst = sanitizeKey(destKey);
    if (src === dst) return this.head(src);
    const entry = this.files.get(src);
    if (!entry) throw new FileNotFoundError(src);
    return this.upload(dst, entry.bytes, {
      contentType: entry.contentType,
      metadata: entry.metadata,
    });
  }

  async move(sourceKey: string, destKey: string): Promise<FileMetadata> {
    const meta = await this.copy(sourceKey, destKey);
    await this.delete(sourceKey);
    return meta;
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(sanitizeKey(key));
  }

  async list(options?: ListOptions): Promise<FileMetadata[]> {
    const out: FileMetadata[] = [];
    for (const [key, entry] of this.files) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue;
      out.push({
        path: key,
        size: entry.bytes.length,
        contentType: entry.contentType,
        lastModified: entry.lastModified,
        etag: `"${entry.bytes.length}"`,
        url: this.publicUrl(key),
        metadata: entry.metadata,
      });
    }
    return out.slice(0, options?.limit ?? 1000);
  }

  async signedUrl(key: string, _options?: SignedUrlOptions): Promise<string> {
    return `${this.publicUrl(key)}?sig=test-only`;
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/${sanitizeKey(key)}`;
  }
}

function makeTiered(config: Partial<Parameters<typeof createTieredStorage>[2]> = {}) {
  // One shared clock for the tiered storage and both fake disks, so
  // "stale" is deterministic and tracker time and mtime agree.
  let now = 1000;
  const clock = () => now;
  const hotDriver = new FakeDisk(clock, "https://fake-hot.local");
  const coldDriver = new FakeDisk(clock, "https://fake-cold.local");
  const hot = new StorageDisk(hotDriver);
  const cold = new StorageDisk(coldDriver);
  const tiered = createTieredStorage(hot, cold, {
    staleAfterMs: 1000,
    now: clock,
    ...config,
  });
  return {
    tiered,
    hotDriver,
    coldDriver,
    hot,
    cold,
    setNow: (value: number) => {
      now = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(name: string): string {
  const dir = path.resolve(`./storage/tiering-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("storage tiering", () => {
  it("ctx.storage is available in handlers via createAPI, withStorage, and Context", async () => {
    const { tiered } = makeTiered();
    const api = createAPI({ storage: tiered });
    let seen: unknown;
    api.get(async (ctx) => {
      seen = ctx.storage;
      await ctx.storage!.save("hello.txt", "hello from handler");
      const text = await ctx.storage!.file("hello.txt").text();
      return API.json({ text });
    });
    const res = await api.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello from handler" });
    expect(seen).toBe(tiered);

    // withStorage after construction.
    const api2 = createAPI();
    api2.withStorage(tiered);
    api2.get(async (ctx) => API.json({ hasStorage: !!ctx.storage }));
    expect(await (await api2.handle(new Request("http://localhost/"))).json()).toEqual({ hasStorage: true });

    // Direct Context construction, and middleware assignment.
    const direct = new Context(new Request("http://localhost/x"), {}, { storage: tiered });
    expect(direct.storage).toBe(tiered);
    const bare = new Context(new Request("http://localhost/x"), {});
    expect(bare.storage).toBeUndefined();
    bare.storage = tiered;
    expect(bare.storage).toBe(tiered);
  });

  it("mounted child routers inherit the parent storage when they have none", async () => {
    const { tiered } = makeTiered();
    await tiered.save("shared.txt", "shared");
    const parent = createAPI({ storage: tiered });
    const child = createAPI();
    child.get("/file", async (ctx) => API.json({ text: await ctx.storage!.file("shared.txt").text() }));
    parent.mount("/child", child);
    const res = await parent.handle(new Request("http://localhost/child/file"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "shared" });
  });

  it("a stale file moves local to S3 and still reads back", async () => {
    const { tiered, hotDriver, coldDriver } = makeTiered();
    await tiered.save("old.txt", "old content");
    expect(await tiered.tierOf("old.txt")).toBe("hot");

    const run = await tiered.runOnce(10_000);
    expect(run.moved).toEqual(["old.txt"]);
    expect(await tiered.tierOf("old.txt")).toBe("cold");
    expect(await hotDriver.exists("old.txt")).toBe(false);
    expect(await coldDriver.exists("old.txt")).toBe(true);
    expect(await tiered.file("old.txt").text()).toBe("old content");
    expect(await (await tiered.read("old.txt")).text()).toBe("old content");
  });

  it("a hot file stays local, and a recent read refreshes staleness", async () => {
    const { tiered, setNow } = makeTiered();
    await tiered.save("fresh.txt", "fresh");
    await tiered.save("touched.txt", "touched");

    const run = await tiered.runOnce(1500);
    expect(run.moved).toEqual([]);
    expect(await tiered.tierOf("fresh.txt")).toBe("hot");

    // Read at t=1500 refreshes last access; at t=2400 the file is only
    // 900ms past its last access, under the 1000ms threshold.
    setNow(1500);
    await tiered.file("touched.txt").text();
    const second = await tiered.runOnce(2400);
    expect(second.moved).not.toContain("touched.txt");
    expect(await tiered.tierOf("touched.txt")).toBe("hot");
  });

  it("a file with an old last-modified time ages out even with no access record", async () => {
    const { tiered, hotDriver } = makeTiered();
    // Bypass tiered.save so no access record exists, then backdate it.
    await tiered.hot.file("legacy.txt").put("legacy");
    hotDriver.setMtime("legacy.txt", 0);
    const run = await tiered.runOnce(10_000);
    expect(run.moved).toEqual(["legacy.txt"]);
    expect(await tiered.file("legacy.txt").text()).toBe("legacy");
  });

  it("a failed verification keeps the local file intact and removes the cold copy", async () => {
    const { tiered, hotDriver, coldDriver } = makeTiered({
      verify: async () => false,
    });
    await tiered.save("precious.txt", "do not lose me");
    const run = await tiered.runOnce(10_000);
    expect(run.moved).toEqual([]);
    expect(run.failed.map((f) => f.key)).toEqual(["precious.txt"]);
    expect(await hotDriver.exists("precious.txt")).toBe(true);
    expect(await tiered.file("precious.txt").text()).toBe("do not lose me");
    expect(await coldDriver.exists("precious.txt")).toBe(false);
    expect(coldDriver.uploads).toBe(1);
    expect(hotDriver.deletes).toBe(0);
  });

  it("a failed copy (interrupted move) also leaves the local file intact", async () => {
    const { tiered, coldDriver, hotDriver } = makeTiered();
    await tiered.save("half.txt", "half moved");
    coldDriver.failNextUpload = new Error("S3 went away mid-move");
    const run = await tiered.runOnce(10_000);
    expect(run.moved).toEqual([]);
    expect(run.failed.map((f) => f.key)).toEqual(["half.txt"]);
    expect(await hotDriver.exists("half.txt")).toBe(true);
    expect(await tiered.file("half.txt").text()).toBe("half moved");
  });

  it("a read during a move succeeds, before and after the move completes", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let moveStarted: () => void = () => {};
    const moveEntered = new Promise<void>((resolve) => {
      moveStarted = resolve;
    });
    const { tiered } = makeTiered({
      onBeforeDelete: async () => {
        moveStarted();
        await gate;
      },
    });
    await tiered.save("during.txt", "served mid-move");
    const movePromise = tiered.moveToCold("during.txt");
    await moveEntered;
    // The mover is paused after verification, before delete: hot still
    // holds the file, and tierOf reports the move in progress.
    expect(await tiered.tierOf("during.txt")).toBe("moving");
    expect(await tiered.file("during.txt").text()).toBe("served mid-move");
    releaseGate();
    const result = await movePromise;
    expect(result.moved).toBe(true);
    expect(await tiered.tierOf("during.txt")).toBe("cold");
    expect(await tiered.file("during.txt").text()).toBe("served mid-move");
  });

  it("one file's failed move does not stop the rest of the run", async () => {
    const { tiered } = makeTiered({
      verify: async ({ key }) => key !== "bad.txt",
    });
    await tiered.save("bad.txt", "bad");
    await tiered.save("good.txt", "good");
    const run = await tiered.runOnce(10_000);
    expect(run.moved).toEqual(["good.txt"]);
    expect(run.failed.map((f) => f.key)).toEqual(["bad.txt"]);
    expect(await tiered.file("good.txt").text()).toBe("good");
    expect(await tiered.file("bad.txt").text()).toBe("bad");
  });

  it("promote-back stays off by default, and works when configured", async () => {
    const off = makeTiered();
    await off.tiered.save("cold.txt", "cold content");
    await off.tiered.runOnce(10_000);
    for (let i = 0; i < 5; i++) {
      expect(await off.tiered.file("cold.txt").text()).toBe("cold content");
    }
    expect(await off.tiered.tierOf("cold.txt")).toBe("cold");

    const on = makeTiered({ promoteBack: true, promoteAfterReads: 3 });
    await on.tiered.save("hot-again.txt", "back home");
    await on.tiered.runOnce(10_000);
    expect(await on.tiered.tierOf("hot-again.txt")).toBe("cold");
    expect(await on.tiered.file("hot-again.txt").text()).toBe("back home");
    expect(await on.tiered.file("hot-again.txt").text()).toBe("back home");
    // Third cold read crosses the threshold: the file promotes first,
    // so it is already hot when this read returns.
    expect(await on.tiered.file("hot-again.txt").text()).toBe("back home");
    expect(await on.tiered.tierOf("hot-again.txt")).toBe("hot");
    expect(await on.coldDriver.exists("hot-again.txt")).toBe(false);
    expect(await on.tiered.file("hot-again.txt").text()).toBe("back home");
  });

  it("single-disk setups get no tiering, and two local disks do not activate it", () => {
    const single = createStorage({
      default: "local",
      publicReads: true,
      disks: {
        local: { driver: "local", baseDir: tempDir("single"), publicUrl: "/storage/files" },
      },
    });
    expect(createTieredStorageFromManager(single)).toBeNull();

    const twoLocal = createStorage({
      default: "hot",
      publicReads: true,
      disks: {
        hot: { driver: "local", baseDir: tempDir("hot"), publicUrl: "/storage/files" },
        cold: { driver: "local", baseDir: tempDir("cold"), publicUrl: "/storage/files" },
      },
    });
    expect(createTieredStorageFromManager(twoLocal)).toBeNull();
  });

  it("a local disk plus an S3 disk activates tiering, with no network probe", () => {
    const manager = createStorage({
      default: "local",
      publicReads: true,
      disks: {
        local: { driver: "local", baseDir: tempDir("both"), publicUrl: "/storage/files" },
        s3: {
          driver: "s3",
          bucket: "test-bucket",
          endpoint: "http://127.0.0.1:1",
          accessKeyId: "test-only-key",
          secretAccessKey: "test-only-secret",
        },
      },
    });
    expect(manager.diskNames()).toEqual(["local", "s3"]);
    expect(manager.driverKind("local")).toBe("local");
    expect(manager.driverKind("s3")).toBe("s3");
    const tiered = createTieredStorageFromManager(manager, { staleAfterMs: 1000 });
    expect(tiered).not.toBeNull();
    expect(tiered!.hot).toBe(manager.disk("local"));
    expect(tiered!.cold).toBe(manager.disk("s3"));
  });

  it("saving over a moved file writes hot and drops the stale cold copy", async () => {
    const { tiered, coldDriver } = makeTiered();
    await tiered.save("v.txt", "version one");
    await tiered.runOnce(10_000);
    expect(await tiered.tierOf("v.txt")).toBe("cold");
    await tiered.save("v.txt", "version two");
    expect(await tiered.tierOf("v.txt")).toBe("hot");
    expect(await coldDriver.exists("v.txt")).toBe(false);
    expect(await tiered.file("v.txt").text()).toBe("version two");
  });

  it("deleting removes both copies, and a missing file reads as not found", async () => {
    const { tiered } = makeTiered();
    await tiered.save("gone.txt", "gone");
    await tiered.runOnce(10_000);
    await tiered.delete("gone.txt");
    expect(await tiered.tierOf("gone.txt")).toBe("missing");
    await expect(tiered.file("gone.txt").text()).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("a move never exposes one tenant's file to another, and traversal keys are rejected", async () => {
    const { tiered } = makeTiered();
    await tiered.save("tenant-a/report.txt", "for tenant a only");
    await tiered.save("tenant-b/report.txt", "for tenant b only");
    await tiered.runOnce(10_000);
    expect(await tiered.file("tenant-a/report.txt").text()).toBe("for tenant a only");
    expect(await tiered.file("tenant-b/report.txt").text()).toBe("for tenant b only");
    // file() itself rejects the key synchronously, before any read happens.
    expect(() => tiered.file("tenant-a/../tenant-b/report.txt")).toThrow();
    await expect(tiered.save("../escape.txt", "nope")).rejects.toThrow();
    await expect(tiered.save("tenant-a/../../escape.txt", "nope")).rejects.toThrow();
    // An unsafe key is rejected, not answered as "missing" — fail closed.
    await expect(tiered.exists("../escape.txt")).rejects.toThrow();
  });

  it("tiering moves real local-disk files end to end, verified by content hash", async () => {
    const hotDir = tempDir("real-hot");
    const coldDir = tempDir("real-cold");
    // Disk names must be registered names (the app's augmentation narrows
    // them to "local" | "s3"); both drivers here are local on purpose, so
    // this exercises real local-disk copy-verify-delete end to end.
    const manager = createStorage({
      default: "local",
      publicReads: true,
      disks: {
        local: { driver: "local", baseDir: hotDir, publicUrl: "/storage/files" },
        s3: { driver: "local", baseDir: coldDir, publicUrl: "/storage/files" },
      },
    });
    const tiered = createTieredStorage(manager.disk("local"), manager.disk("s3"), {
      staleAfterMs: 0,
    });
    await tiered.save("real.txt", "real bytes on real disks");
    const run = await tiered.runOnce();
    expect(run.moved).toEqual(["real.txt"]);
    expect(await tiered.file("real.txt").text()).toBe("real bytes on real disks");
    expect(fs.existsSync(path.join(hotDir, "real.txt"))).toBe(false);
    expect(fs.existsSync(path.join(coldDir, "real.txt"))).toBe(true);
  });

  it("the mover runs through the cron scheduler surface and as a job handler", async () => {
    const { tiered, advance } = makeTiered();
    await tiered.save("sched.txt", "scheduled");
    let captured: (() => Promise<void>) | undefined;
    const scheduler = {
      every: (_interval: string, task: () => Promise<void>) => {
        captured = task;
        return "scheduled";
      },
    };
    expect(scheduleTiering(scheduler, tiered, "1h")).toBe("scheduled");
    expect(captured).toBeDefined();
    advance(10_000);
    await captured!();
    expect(await tiered.tierOf("sched.txt")).toBe("cold");

    // The real cron scheduler accepts the same helper (and its timers
    // never keep the process alive on their own, but stop it anyway).
    const { tiered: tieredReal, advance: advanceReal } = makeTiered();
    await tieredReal.save("real-cron.txt", "real cron");
    advanceReal(10_000);
    const cron = createCron();
    scheduleTiering(cron, tieredReal, "1h");
    // A 1h interval does not fire here; stopping proves registration
    // itself is compatible with the real scheduler, and a direct run
    // proves the registered task would move the file.
    cron.stop();
    expect(await tieredReal.runOnce()).toEqual(
      expect.objectContaining({ moved: ["real-cron.txt"] }),
    );

    const { tiered: tiered2, advance: advance2 } = makeTiered();
    await tiered2.save("job.txt", "jobbed");
    advance2(10_000);
    const handler = createTieringJobHandler(tiered2);
    const result = await handler();
    expect(result.moved).toEqual(["job.txt"]);
    expect(await tiered2.file("job.txt").text()).toBe("jobbed");
  });

  it("a signed URL comes from whichever disk holds the file", async () => {
    const { tiered } = makeTiered();
    await tiered.save("signed.txt", "signed");
    expect(await tiered.file("signed.txt").sign()).toContain("fake-hot.local/signed.txt");
    await tiered.runOnce(10_000);
    expect(await tiered.file("signed.txt").sign()).toContain("fake-cold.local/signed.txt");
  });

  it("plain manager save keeps working, and no tiering logging happens on a normal run", async () => {
    const manager = createStorage({
      default: "local",
      publicReads: true,
      disks: {
        local: { driver: "local", baseDir: tempDir("plain"), publicUrl: "/storage/files" },
      },
    });
    const meta = await manager.save("plain.txt", "plain");
    expect(meta.path).toBe("plain.txt");
    expect(await manager.file("plain.txt").text()).toBe("plain");

    const { tiered } = makeTiered();
    await tiered.save("quiet.txt", "quiet");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await tiered.runOnce(10_000);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
});
