import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createStorage,
  LocalStorageDriver,
  StorageFile,
  sanitizeKey,
  parseDuration,
  parseSize,
  guessContentType,
  verifyMagicBytes,
  safeConstantTimeEqual,
  escapeHtml,
  FileNotFoundError,
  StorageSecurityError,
  type FileMetadata,
} from "../types/storage";
import fs from "node:fs";
import path from "node:path";

describe("Yatta Storage — High-Performance Storage Layer", () => {
  const TEST_DIR = path.resolve("./storage/test_uploads");
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

    storage = createStorage({
      default: "local",
      secret: "storage-secret-signing-key-32-chars-long!",
      disks: {
        local: {
          driver: "local",
          baseDir: TEST_DIR,
          publicUrl: "/storage/files",
        },
      },
    });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should guarantee FileMetadata structural contracts", () => {
      const meta: FileMetadata = {
        path: "avatars/user.png",
        size: 1024,
        contentType: "image/png",
        lastModified: new Date(),
        etag: '"400-18e0"',
        url: "/storage/files/avatars/user.png",
        metadata: { userId: "123" },
      };

      expect(meta.path).toBe("avatars/user.png");
      expect(meta.size).toBe(1024);
      expect(meta.contentType).toBe("image/png");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should block path traversal and invalid keys in sanitizeKey()", () => {
      expect(() => sanitizeKey("")).toThrow(StorageSecurityError);
      expect(() => sanitizeKey("dir/..")).toThrow(StorageSecurityError);
      expect(() => sanitizeKey("/.")).toThrow(StorageSecurityError);
      expect(sanitizeKey("/folder/sub/file.txt")).toBe("folder/sub/file.txt");
      // Traversal is rejected, not rewritten. Stripping "../../../etc/passwd"
      // down to "etc/passwd" would silently resolve it to a different file and
      // let two distinct keys collide on one object; failing loudly is both
      // safer and closer to what the caller meant.
      expect(() => sanitizeKey("../../../etc/passwd")).toThrow(
        /Path traversal/,
      );
    });

    it("should reject null bytes in file keys", () => {
      expect(() => sanitizeKey("evil\0.txt")).toThrow(/Null bytes/);
    });

    it("should verify binary magic bytes for image and document formats", () => {
      // Valid PNG header: 89 50 4E 47
      const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(verifyMagicBytes(validPng, "image/png")).toBe(true);

      // Invalid PNG spoofed as plain text
      const fakePng = new TextEncoder().encode("Not a real PNG header");
      expect(verifyMagicBytes(fakePng, "image/png")).toBe(false);

      // Valid JPEG header: FF D8 FF
      const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      expect(verifyMagicBytes(validJpeg, "image/jpeg")).toBe(true);

      // Valid PDF header: 25 50 44 46 (%PDF)
      const validPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      expect(verifyMagicBytes(validPdf, "application/pdf")).toBe(true);
    });

    it("should compare tokens with constant-time equality without leaking timing data", () => {
      expect(safeConstantTimeEqual("secret123", "secret123")).toBe(true);
      expect(safeConstantTimeEqual("secret123", "secret999")).toBe(false);
      // Handles mismatched length safely without exception
      expect(safeConstantTimeEqual("short", "longer_string_here")).toBe(false);
    });

    it("should escape malicious characters in escapeHtml()", () => {
      const malicious = '<script>alert("xss")</script>&foo=\'bar\'';
      const escaped = escapeHtml(malicious);

      expect(escaped).not.toContain("<script>");
      expect(escaped).toContain("&lt;script&gt;");
      expect(escaped).toContain("&quot;xss&quot;");
      expect(escaped).toContain("&#039;bar&#039;");
    });

    it("should throw FileNotFoundError when accessing non-existent files", async () => {
      await expect(storage.defaultDisk.download("ghost_file.txt")).rejects.toThrow(FileNotFoundError);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should parse human-readable durations and sizes accurately", () => {
      expect(parseDuration("30s")).toBe(30);
      expect(parseDuration("5m")).toBe(300);
      expect(parseDuration("2h")).toBe(7200);
      expect(parseDuration("1d")).toBe(86400);

      expect(parseSize("512B")).toBe(512);
      expect(parseSize("10KB")).toBe(10 * 1024);
      expect(parseSize("5MB")).toBe(5 * 1024 * 1024);
      expect(parseSize("2GB")).toBe(2 * 1024 * 1024 * 1024);
    });

    it("should detect correct MIME types from file extensions", () => {
      expect(guessContentType("photo.jpg")).toBe("image/jpeg");
      expect(guessContentType("vector.svg")).toBe("image/svg+xml");
      expect(guessContentType("doc.pdf")).toBe("application/pdf");
      expect(guessContentType("data.json")).toBe("application/json");
      expect(guessContentType("music.mp3")).toBe("audio/mpeg");
      expect(guessContentType("archive.zip")).toBe("application/zip");
    });

    it("should support StorageFile content consumers (.text, .json, .buffer, .arrayBuffer)", async () => {
      const payload = { framework: "Yatta", version: 2 };
      await storage.defaultDisk.upload("data.json", payload);

      const file = await storage.defaultDisk.download("data.json");
      expect(await file.json<{ framework: string; version: number }>()).toEqual(payload);
      expect(await file.text()).toContain('"framework": "Yatta"');

      const buf = await file.buffer();
      expect(Buffer.isBuffer(buf)).toBe(true);

      const ab = await file.arrayBuffer();
      expect(ab.byteLength).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should complete full file lifecycle: upload -> head -> copy -> move -> delete", async () => {
      const key = "documents/test.txt";
      const copyKey = "documents/test_copy.txt";
      const moveKey = "archive/test_moved.txt";
      const disk = storage.defaultDisk;

      // 1. UPLOAD
      const uploaded = await disk.upload(key, "Hello World from Yatta Storage", {
        metadata: { author: "Developer" },
      });
      expect(uploaded.size).toBe(30);
      expect(uploaded.path).toBe(key);

      // 2. HEAD (Metadata check)
      const head = await disk.head(key);
      expect(head.size).toBe(30);
      expect(head.metadata?.author).toBe("Developer");

      // 3. COPY
      const copied = await disk.copy(key, copyKey);
      expect(await disk.exists(copyKey)).toBe(true);
      expect(copied.metadata?.author).toBe("Developer");

      // 4. MOVE
      await disk.move(copyKey, moveKey);
      expect(await disk.exists(copyKey)).toBe(false);
      expect(await disk.exists(moveKey)).toBe(true);

      // 5. DELETE
      await disk.delete(key);
      await disk.delete(moveKey);
      expect(await disk.exists(key)).toBe(false);
      expect(await disk.exists(moveKey)).toBe(false);
    });

    it("should support fluent FileRef and virtual folder scoping", async () => {
      // Fluent file API
      await storage.file("fluent.txt").put("Fluent content");
      expect(await storage.file("fluent.txt").exists()).toBe(true);
      expect(await storage.file("fluent.txt").text()).toBe("Fluent content");
      await storage.file("fluent.txt").delete();
      expect(await storage.file("fluent.txt").exists()).toBe(false);

      // Folder API
      const userFolder = storage.folder("users/42");
      await userFolder.file("avatar.png").put("fake-avatar-bytes");
      expect(await storage.defaultDisk.exists("users/42/avatar.png")).toBe(true);

      const file = await userFolder.file("avatar.png").read();
      expect(await file.text()).toBe("fake-avatar-bytes");

      await userFolder.file("avatar.png").delete();
      expect(await storage.defaultDisk.exists("users/42/avatar.png")).toBe(false);
    });

    it("should generate and verify signed download URLs", async () => {
      await storage.defaultDisk.upload("secure/contract.pdf", "Confidential Agreement");

      const signedUrl = await storage.defaultDisk.signedUrl("secure/contract.pdf", { expiresIn: "10m" });
      expect(signedUrl).toContain("sig=");
      expect(signedUrl).toContain("exp=");

      const req = new Request(`http://localhost${signedUrl}`);
      const res = await storage.handleRequest(req, "/storage");

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Confidential Agreement");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (RFC 9110 Range & Caching)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests (RFC 9110 Range & Caching)", () => {
    const content = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36 bytes
    const fileName = "stream_test.txt";

    beforeEach(async () => {
      await storage.defaultDisk.upload(fileName, content, { contentType: "text/plain" });
    });

    it("should serve standard 200 response with proper headers", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const res = file.serve();

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("36");
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(res.headers.get("ETag")).toBeDefined();
      expect(await res.text()).toBe(content);
    });

    it("should serve HTTP 206 Partial Content for single byte range (bytes=0-9)", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const req = new Request("http://localhost/file", {
        headers: { Range: "bytes=0-9" },
      });

      const res = file.serve(req);
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 0-9/36");
      expect(res.headers.get("Content-Length")).toBe("10");

      const chunk = await res.text();
      expect(chunk).toBe("0123456789");
    });

    it("should serve HTTP 206 for suffix byte range (bytes=-10)", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const req = new Request("http://localhost/file", {
        headers: { Range: "bytes=-10" },
      });

      const res = file.serve(req);
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 26-35/36");
      expect(res.headers.get("Content-Length")).toBe("10");

      const chunk = await res.text();
      expect(chunk).toBe("QRSTUVWXYZ");
    });

    it("should return HTTP 416 Range Not Satisfiable for out-of-bounds ranges", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const req = new Request("http://localhost/file", {
        headers: { Range: "bytes=100-200" },
      });

      const res = file.serve(req);
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe("bytes */36");
    });

    it("should return HTTP 304 Not Modified when ETag matches If-None-Match", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const etag = file.etag!;

      const req = new Request("http://localhost/file", {
        headers: { "If-None-Match": etag },
      });

      const res = file.serve(req);
      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
    });

    it("should handle HEAD requests by omitting body and keeping headers", async () => {
      const file = await storage.defaultDisk.download(fileName);
      const req = new Request("http://localhost/file", { method: "HEAD" });

      const res = file.serve(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("36");
      expect(res.body).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should perform parallel uploads concurrently without staging conflicts", async () => {
      const count = 25;
      const uploads = Array.from({ length: count }).map(async (_, idx) => {
        const key = `concur/file_${idx}.txt`;
        const body = `Content of file number ${idx} with unique payload ${Date.now()}`;
        return storage.defaultDisk.upload(key, body);
      });

      const results = await Promise.all(uploads);
      expect(results.length).toBe(count);

      // Verify all uploaded files exist and match their expected content
      for (let i = 0; i < count; i++) {
        const file = await storage.defaultDisk.download(`concur/file_${i}.txt`);
        expect(await file.text()).toContain(`Content of file number ${i}`);
      }
    });
  });
});
