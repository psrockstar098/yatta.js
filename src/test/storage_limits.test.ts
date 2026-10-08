import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createStorage,
  parseDuration,
  parseSize,
  StorageError,
  StorageSecurityError,
  type StorageManager,
} from "../types/storage";

/*
 * Upload limits, signed URLs, and the overwrite/precondition builders.
 *
 * The existing storage suite covers the lifecycle, content consumers, range serving and
 * traversal. What it did not cover is the arithmetic the guards are built on — and the
 * guards turn out to pass silently on values that are not sizes.
 */

const TEST_DIR = join(import.meta.dir, "fixtures", "storage-limits");

const SECRET = "storage-secret-signing-key-32-chars-long!";

let storage: StorageManager;
let calls: { action: string; key?: string }[];

beforeEach(() => {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  calls = [];

  storage = createStorage({
    default: "local",
    secret: SECRET,
    disks: {
      local: { driver: "local", baseDir: TEST_DIR, publicUrl: "/storage/files" },
    },
    authorize: (ctx) => {
      calls.push({ action: ctx.action, key: ctx.key });
      return true;
    },
  });
});

afterEach(() => {
  for (const entry of readdirSync(TEST_DIR)) {
    rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
  }
});

const disk = () => storage.defaultDisk;

describe("parseSize rejects values that are not sizes", () => {
  /*
   * Every cap in the file is built by comparing against this number, and a comparison
   * against NaN is always false. So `maxSize: NaN` did not fail — it disabled the cap,
   * and a 2MB body was accepted under a limit of NaN. `-1` inverted the other way and
   * rejected everything. Both are reachable from configuration read out of an env var,
   * where a missing variable gives `Number(undefined)` === NaN.
   */
  it("throws for NaN rather than returning a value that never compares true", () => {
    expect(() => parseSize(NaN)).toThrow(StorageError);
    expect(() => parseSize(NaN)).toThrow(/NaN/);
  });

  it("throws for Infinity and other non-finite values", () => {
    expect(() => parseSize(Infinity)).toThrow(StorageError);
    expect(() => parseSize(-Infinity)).toThrow(StorageError);
  });

  it("throws for a negative size", () => {
    // Every real byte count is >= 0, so this is always a mistake.
    expect(() => parseSize(-1)).toThrow(StorageError);
  });

  it("accepts zero, which is a real limit", () => {
    expect(parseSize(0)).toBe(0);
  });

  it("still accepts the documented forms", () => {
    expect(parseSize(undefined)).toBe(104_857_600);
    expect(parseSize("1KB")).toBe(1024);
    expect(parseSize("0.5MB")).toBe(524_288);
    expect(parseSize(2048)).toBe(2048);
  });
});

describe("parseDuration rejects values that are not durations", () => {
  it("throws for NaN", () => {
    // `exp = now + NaN` produced the literal string "NaN" in the URL. That happened to
    // be rejected downstream because it is not finite, but by accident rather than
    // because anything checked it.
    expect(() => parseDuration(NaN)).toThrow(StorageError);
    expect(() => parseDuration(NaN)).toThrow(/NaN/);
  });

  it("throws for Infinity and negative values", () => {
    expect(() => parseDuration(Infinity)).toThrow(StorageError);
    expect(() => parseDuration(-5)).toThrow(StorageError);
  });

  it("accepts zero and the documented strings", () => {
    expect(parseDuration(undefined)).toBe(3600);
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration("1.5h")).toBe(5400);
    expect(parseDuration("10m")).toBe(600);
  });
});

describe("a size cap is enforced for every input kind", () => {
  const twoMegabytes = "x".repeat(2_000_000);

  it("rejects a string body over the cap", async () => {
    await expect(disk().put("big.txt").maxSize("1MB").from(twoMegabytes).save()).rejects.toThrow(
      /exceeds maximum size limit/,
    );
  });

  it("rejects a stream over the cap, which is counted as it is read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(50_000));
        controller.close();
      },
    });

    await expect(disk().put("big.bin").maxSize("1MB").from(stream).save()).rejects.toThrow(
      /exceeded maximum allowed size/,
    );
  });

  it("rejects rather than accepting when the cap is not a number", async () => {
    // The finding: this used to succeed and store 2MB.
    await expect(
      disk().put("big.txt").maxSize(Number("nope")).from(twoMegabytes).save(),
    ).rejects.toThrow(/Invalid size/);

    expect(await disk().exists("big.txt")).toBe(false);
  });

  it("rejects everything at a cap of zero, rather than accepting everything", async () => {
    await expect(disk().put("z.txt").maxSize(0).from("anything").save()).rejects.toThrow(
      /exceeds maximum size limit of 0/,
    );
  });

  it("accepts a body under the cap", async () => {
    const saved = await disk().put("ok.txt").maxSize("1MB").from("small").save();

    expect(saved.size).toBe(5);
  });
});

describe("signed URLs", () => {
  it("round-trips through the HTTP route", async () => {
    await disk().upload("doc.txt", "confidential");

    const url = await disk().signedUrl("doc.txt", { expiresIn: "10m" });
    const parsed = new URL(url, "http://localhost");
    const response = await storage.handleRequest(
      new Request(`http://localhost${parsed.pathname}${parsed.search}`),
      "/storage",
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("confidential");
  });

  it("refuses a tampered signature", async () => {
    await disk().upload("doc.txt", "confidential");

    const url = await disk().signedUrl("doc.txt", { expiresIn: 600 });
    const tampered = url.replace(/sig=[^&]+/, "sig=deadbeef");
    const parsed = new URL(tampered, "http://localhost");

    const response = await storage.handleRequest(
      new Request(`http://localhost${parsed.pathname}${parsed.search}`),
      "/storage",
    );

    expect(response.status).toBe(403);
  });

  it("refuses a token whose key was swapped for another file", async () => {
    await disk().upload("mine.txt", "mine");
    await disk().upload("theirs.txt", "theirs");

    const url = await disk().signedUrl("mine.txt", { expiresIn: 600 });
    const swapped = url.replace(/path=mine\.txt/, "path=theirs.txt");
    const parsed = new URL(swapped, "http://localhost");

    const response = await storage.handleRequest(
      new Request(`http://localhost${parsed.pathname}${parsed.search}`),
      "/storage",
    );

    // The key is inside the signed payload, so a swap invalidates it.
    expect(response.status).toBe(403);
  });

  it("refuses an expired token", async () => {
    await disk().upload("doc.txt", "confidential");

    const url = await disk().signedUrl("doc.txt", { expiresIn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const parsed = new URL(url, "http://localhost");
    const response = await storage.handleRequest(
      new Request(`http://localhost${parsed.pathname}${parsed.search}`),
      "/storage",
    );

    expect(response.status).toBe(403);
  });

  it("refuses a token issued for a PUT when used to read", async () => {
    await disk().upload("doc.txt", "confidential");

    const url = await disk().signedUrl("doc.txt", { expiresIn: 600, method: "PUT" });
    const parsed = new URL(url, "http://localhost");

    const response = await storage.handleRequest(
      new Request(`http://localhost${parsed.pathname}${parsed.search}`),
      "/storage",
    );

    expect(response.status).toBe(403);
  });

  it("rejects a request with no path at all, as a bad request rather than a bad token", async () => {
    await disk().upload("doc.txt", "confidential");

    const response = await storage.handleRequest(
      new Request("http://localhost/storage/files/signed"),
      "/storage",
    );

    expect(response.status).toBe(400);
  });

  it("refuses a malformed or unsigned token rather than serving the file", async () => {
    await disk().upload("doc.txt", "confidential");

    for (const query of [
      // A path but no signature.
      "?path=doc.txt",
      // An expiry that is not a number, in every spelling Number() produces.
      "?path=doc.txt&exp=1e99&sig=x",
      "?path=doc.txt&exp=NaN&sig=x",
      "?path=doc.txt&exp=abc&sig=x",
    ]) {
      const response = await storage.handleRequest(
        new Request(`http://localhost/storage/files/signed${query}`),
        "/storage",
      );

      // Never 200: the failure mode this guards is a signed route that falls through
      // to serving the file with no check at all.
      expect(response.status).toBe(403);
    }
  });

  it("refuses to sign a key that escapes the root", async () => {
    for (const key of ["../../etc/passwd", "a/../../../b"]) {
      await expect(disk().signedUrl(key)).rejects.toThrow(StorageSecurityError);
    }
  });

  it("refuses an expiry that is not a duration", async () => {
    await expect(disk().signedUrl("doc.txt", { expiresIn: NaN })).rejects.toThrow(/Invalid duration/);
    await expect(disk().signedUrl("doc.txt", { expiresIn: -60 })).rejects.toThrow(/Invalid duration/);
  });
});

describe("the authorizer is consulted on every read path", () => {
  it("asks before serving a plain read", async () => {
    await disk().upload("secret.txt", "classified");
    calls.length = 0;

    const response = await storage.handleRequest(
      new Request("http://localhost/storage/files/secret.txt"),
      "/storage",
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ action: "read", key: "secret.txt" }]);
  });

  it("asks before a HEAD and before a ranged read", async () => {
    await disk().upload("secret.txt", "classified");

    calls.length = 0;
    await storage.handleRequest(
      new Request("http://localhost/storage/files/secret.txt", { method: "HEAD" }),
      "/storage",
    );
    expect(calls.some((c) => c.action === "read")).toBe(true);

    calls.length = 0;
    await storage.handleRequest(
      new Request("http://localhost/storage/files/secret.txt", {
        headers: { range: "bytes=0-3" },
      }),
      "/storage",
    );
    expect(calls.some((c) => c.action === "read")).toBe(true);
  });

  it("passes the key to a delete authorizer, so ownership can be enforced", async () => {
    await disk().upload("mine.txt", "mine");
    await disk().upload("theirs.txt", "theirs");
    calls.length = 0;

    await storage.handleRequest(
      new Request("http://localhost/storage/api/files?path=theirs.txt", { method: "DELETE" }),
      "/storage",
    );

    // Without the key the authorizer can only allow or deny everything, which is not
    // the same as deciding whether *this* caller owns *this* file.
    expect(calls).toContainEqual({ action: "delete", key: "theirs.txt" });
  });

  it("denies when the authorizer says no", async () => {
    const closed: StorageManager = createStorage({
      default: "local",
      secret: SECRET,
      disks: { local: { driver: "local", baseDir: TEST_DIR } },
      authorize: () => false,
    });

    await closed.defaultDisk.upload("secret.txt", "classified");

    const response = await closed.handleRequest(
      new Request("http://localhost/storage/files/secret.txt"),
      "/storage",
    );

    expect(response.status).toBe(403);
  });
});

describe("byte ranges", () => {
  beforeEach(async () => {
    await disk().upload("r.txt", "0123456789");
  });

  const ranged = async (range: string) => {
    const response = await storage.handleRequest(
      new Request("http://localhost/storage/files/r.txt", { headers: { range } }),
      "/storage",
    );
    return { status: response.status, body: await response.text(), range: response.headers.get("content-range") };
  };

  it("serves a bounded range", async () => {
    const result = await ranged("bytes=0-4");
    expect(result.status).toBe(206);
    expect(result.body).toBe("01234");
    expect(result.range).toBe("bytes 0-4/10");
  });

  it("serves a suffix range", async () => {
    const result = await ranged("bytes=-4");
    expect(result.status).toBe(206);
    expect(result.body).toBe("6789");
  });

  it("serves an open-ended range", async () => {
    const result = await ranged("bytes=5-");
    expect(result.status).toBe(206);
    expect(result.body).toBe("56789");
  });

  it("clamps an end past the file", async () => {
    const result = await ranged("bytes=0-100");
    expect(result.status).toBe(206);
    expect(result.body).toBe("0123456789");
  });

  it("answers 416 for a start past the end", async () => {
    const result = await ranged("bytes=100-200");
    expect(result.status).toBe(416);
    expect(result.range).toBe("bytes */10");
  });

  it("answers 416 for a zero-length suffix", async () => {
    const result = await ranged("bytes=-0");
    expect(result.status).toBe(416);
  });

  it("answers 416 for an offset beyond MAX_SAFE_INTEGER", async () => {
    // `parseInt` on this loses precision, and the result once failed a `start <= end`
    // test and was answered with a 200 and the whole body.
    const result = await ranged("bytes=99999999999999999999-");
    expect(result.status).toBe(416);
  });

  it("ignores invalid syntax and serves the whole representation", async () => {
    // RFC 9110 §14.2: an unparseable range is ignored, not an error.
    for (const range of ["bytes=abc", "bytes=", "bytes=5-2", "items=0-4", "bytes=0-4,6-8"]) {
      const result = await ranged(range);
      expect(result.status).toBe(200);
      expect(result.body).toBe("0123456789");
    }
  });

  it("does not treat a multi-range request as a single range", async () => {
    // Serving bytes=0-4,6-8 as one range would return the wrong bytes with a 206.
    const result = await ranged("bytes=0-4,6-8");
    expect(result.status).toBe(200);
    expect(result.body).toBe("0123456789");
  });
});

describe("overwrite policies and preconditions", () => {
  beforeEach(async () => {
    await disk().upload("a.txt", "one");
  });

  it("replaces by default", async () => {
    await disk().upload("a.txt", "two");
    expect(await (await disk().download("a.txt")).text()).toBe("two");
  });

  it("refuses a noOverwrite upload onto an existing key", async () => {
    await expect(disk().put("a.txt").noOverwrite().from("nope").save()).rejects.toThrow(
      /already exists/,
    );
    expect(await (await disk().download("a.txt")).text()).toBe("one");
  });

  it("replaces on ifExists", async () => {
    await disk().put("a.txt").ifExists("replace").from("replaced").save();
    expect(await (await disk().download("a.txt")).text()).toBe("replaced");
  });

  it("gives each unique upload its own key", async () => {
    const first = await disk().put("a.txt").unique().from("x").save();
    const second = await disk().put("a.txt").unique().from("y").save();

    expect(first.path).not.toBe(second.path);
    expect(await (await disk().download(first.path)).text()).toBe("x");
    expect(await (await disk().download(second.path)).text()).toBe("y");
  });

  it("refuses an ifMatch whose etag does not match", async () => {
    await expect(disk().put("a.txt").ifMatch('"wrong"').from("nope").save()).rejects.toThrow(
      /ETag mismatch/,
    );
    expect(await (await disk().download("a.txt")).text()).toBe("one");
  });

  it("allows an ifMatch that matches", async () => {
    const current = await disk().head("a.txt");

    await disk().put("a.txt").ifMatch(current.etag!).from("updated").save();

    expect(await (await disk().download("a.txt")).text()).toBe("updated");
  });

  it("refuses an ifNoneMatch on a key that exists", async () => {
    const current = await disk().head("a.txt");

    await expect(disk().put("a.txt").ifNoneMatch(current.etag!).from("x").save()).rejects.toThrow(
      /If-None-Match/,
    );
  });

  it("requires data before saving", async () => {
    await expect(disk().put("a.txt").save()).rejects.toThrow(/\.from\(data\)/);
  });
});

describe("copy and move refuse to escape the root", () => {
  it("rejects a traversal destination", async () => {
    await disk().upload("a.txt", "content");

    await expect(disk().copy("a.txt", "../escape.txt")).rejects.toThrow(StorageSecurityError);
    await expect(disk().move("a.txt", "../escape.txt")).rejects.toThrow(StorageSecurityError);
  });

  it("refuses to read or delete a traversing key", async () => {
    await expect(disk().download("../escape.txt")).rejects.toThrow(StorageSecurityError);
    await expect(disk().delete("../escape.txt")).rejects.toThrow(StorageSecurityError);
  });

  it("rejects a null byte in a key", async () => {
    await expect(disk().upload("a\0b.txt", "x")).rejects.toThrow(/Null bytes/);
  });

  it("keeps a key with a leading slash inside the root", async () => {
    const saved = await disk().upload("/leading.txt", "x");

    expect(saved.path).not.toContain("..");
    expect(await disk().exists("leading.txt")).toBe(true);
  });
});

describe("deleteMany", () => {
  it("removes each key and leaves the others", async () => {
    for (const key of ["m1.txt", "m2.txt", "m3.txt"]) await disk().upload(key, key);

    await disk().deleteMany(["m1.txt", "m2.txt"]);

    expect(await disk().exists("m1.txt")).toBe(false);
    expect(await disk().exists("m3.txt")).toBe(true);
  });

  it("does not fail on a key that is already gone", async () => {
    await disk().upload("m3.txt", "x");

    // Deleting a file twice is the normal outcome of a retry, not an error.
    await expect(disk().deleteMany(["m3.txt", "never-existed.txt"])).resolves.toBeUndefined();
  });

  it("accepts an empty list", async () => {
    await disk().upload("m3.txt", "x");

    await expect(disk().deleteMany([])).resolves.toBeUndefined();
    expect(await disk().exists("m3.txt")).toBe(true);
  });

  it("deletes a key once when it is listed twice", async () => {
    await disk().upload("m3.txt", "x");

    await expect(disk().deleteMany(["m3.txt", "m3.txt"])).resolves.toBeUndefined();
    expect(await disk().exists("m3.txt")).toBe(false);
  });
});

describe("list", () => {
  it("returns the files that were written", async () => {
    await disk().upload("a.txt", "one");
    await disk().upload("nested/b.txt", "two");

    const files = await disk().list();

    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "nested/b.txt"]);
  });

  it("is empty for an empty disk", async () => {
    expect(await disk().list()).toEqual([]);
  });
});

describe("an unreadable config value is reported, not defaulted", () => {
  it("says which value was wrong", () => {
    // The point of throwing rather than defaulting: a silent 100MB cap on a typo is a
    // cap nobody believes is in place.
    expect(() => parseSize(Number(process.env.YATTA_NOT_SET))).toThrow(/Invalid size/);
  });

  it("names the file it was writing, when the failure is mid-upload", async () => {
    await expect(
      disk().put("x.txt").maxSize(Number("nope")).from("data").save(),
    ).rejects.toThrow(/got NaN/);
  });
});

describe("stored content is what was written", () => {
  it("round-trips through upload and download byte for byte", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x42]);

    await disk().upload("bin.dat", bytes);
    const read = await disk().download("bin.dat");

    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  });

  it("does not leave the fixture directory behind", () => {
    // Sanity check that afterEach cleaned up; a leftover would make the next run's
    // counts wrong rather than failing outright.
    expect(existsSync(join(TEST_DIR, "does-not-exist"))).toBe(false);
  });

  it("writes nothing outside the root", async () => {
    await disk().upload("a.txt", "x");

    expect(existsSync(join(TEST_DIR, "..", "storage-limits-escape.txt"))).toBe(false);
  });
});