import { describe, it, expect } from "bun:test";
import {
  createWebDAVHandler,
  type DavStore,
  type DavFile,
  type DavEntry,
} from "../func/webdav";

// Small in-memory store for tests. Collections are a set of paths.
function memoryStore(): DavStore {
  const files = new Map<string, DavFile>();
  const dirs = new Set<string>([""]);
  const children = (path: string): DavEntry[] => {
    const prefix = path === "" ? "" : `${path}/`;
    const out: DavEntry[] = [];
    const seenDirs = new Set<string>();
    for (const [key, file] of files) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        out.push({
          path: key,
          isCollection: false,
          size: file.body.byteLength,
          lastModified: file.lastModified,
          contentType: file.contentType,
        });
      } else if (!seenDirs.has(prefix + rest.slice(0, slash))) {
        const dir = prefix + rest.slice(0, slash);
        seenDirs.add(dir);
        out.push({
          path: dir,
          isCollection: true,
          size: 0,
          lastModified: new Date(),
        });
      }
    }
    for (const dir of dirs) {
      if (dir === "" || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest !== "" && !rest.includes("/") && !seenDirs.has(dir)) {
        out.push({ path: dir, isCollection: true, size: 0, lastModified: new Date() });
      }
    }
    return out;
  };
  return {
    async get(path) {
      return files.get(path) ?? null;
    },
    async put(path, body, contentType) {
      files.set(path, {
        body,
        contentType: contentType ?? "application/octet-stream",
        lastModified: new Date(),
      });
    },
    async delete(path) {
      const hadFile = files.delete(path);
      const hadDir = dirs.delete(path);
      if (!hadFile && !hadDir) {
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${path}/`)) files.delete(key);
        }
      }
      return hadFile || hadDir;
    },
    async exists(path) {
      return files.has(path);
    },
    async isCollection(path) {
      if (dirs.has(path)) return true;
      for (const key of files.keys()) {
        if (key.startsWith(`${path}/`)) return true;
      }
      return false;
    },
    async list(path) {
      return children(path);
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async copy(src, dst) {
      const file = files.get(src);
      if (file) files.set(dst, { ...file });
    },
    async move(src, dst) {
      const file = files.get(src);
      if (file) {
        files.set(dst, { ...file });
        files.delete(src);
      }
    },
  };
}

const dav = (store: DavStore) => createWebDAVHandler(store, { basePath: "/dav" });
const req = (url: string, init?: RequestInit) =>
  new Request(url, init);

describe("WebDAV", () => {
  it("PUT then GET returns the same bytes", async () => {
    const handle = dav(memoryStore());
    const put = await handle(
      req("http://x/dav/hello.txt", { method: "PUT", body: "hello dav" }),
    );
    expect(put.status).toBe(201);
    const get = await handle(req("http://x/dav/hello.txt"));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello dav");
  });

  it("PUT over an existing file answers 204", async () => {
    const handle = dav(memoryStore());
    await handle(req("http://x/dav/a.txt", { method: "PUT", body: "one" }));
    const again = await handle(
      req("http://x/dav/a.txt", { method: "PUT", body: "two" }),
    );
    expect(again.status).toBe(204);
    expect(await (await handle(req("http://x/dav/a.txt"))).text()).toBe("two");
  });

  it("MKCOL + PROPFIND lists the collection", async () => {
    const handle = dav(memoryStore());
    const mk = await handle(req("http://x/dav/docs", { method: "MKCOL" }));
    expect(mk.status).toBe(201);
    await handle(req("http://x/dav/docs/note.txt", { method: "PUT", body: "n" }));
    const prop = await handle(
      req("http://x/dav/docs", { method: "PROPFIND", headers: { Depth: "1" } }),
    );
    expect(prop.status).toBe(207);
    const xml = await prop.text();
    expect(xml).toContain("<D:collection/>");
    expect(xml).toContain("note.txt");
  });

  it("PROPFIND Depth 0 answers only the resource itself", async () => {
    const handle = dav(memoryStore());
    await handle(req("http://x/dav/docs", { method: "MKCOL" }));
    await handle(req("http://x/dav/docs/note.txt", { method: "PUT", body: "n" }));
    const prop = await handle(
      req("http://x/dav/docs", { method: "PROPFIND", headers: { Depth: "0" } }),
    );
    const xml = await prop.text();
    expect(xml).not.toContain("note.txt");
    expect(xml).toContain("/dav/docs");
  });

  it("MOVE and COPY work with a Destination header", async () => {
    const handle = dav(memoryStore());
    await handle(req("http://x/dav/a.txt", { method: "PUT", body: "data" }));
    const copy = await handle(
      req("http://x/dav/a.txt", {
        method: "COPY",
        headers: { Destination: "http://x/dav/b.txt" },
      }),
    );
    expect(copy.status).toBe(201);
    expect(await (await handle(req("http://x/dav/b.txt"))).text()).toBe("data");
    const move = await handle(
      req("http://x/dav/a.txt", {
        method: "MOVE",
        headers: { Destination: "http://x/dav/c.txt" },
      }),
    );
    expect(move.status).toBe(201);
    expect((await handle(req("http://x/dav/a.txt"))).status).toBe(404);
    expect(await (await handle(req("http://x/dav/c.txt"))).text()).toBe("data");
  });

  it("DELETE removes a file and a collection tree", async () => {
    const handle = dav(memoryStore());
    await handle(req("http://x/dav/docs", { method: "MKCOL" }));
    await handle(req("http://x/dav/docs/n.txt", { method: "PUT", body: "n" }));
    const del = await handle(req("http://x/dav/docs", { method: "DELETE" }));
    expect(del.status).toBe(204);
    expect((await handle(req("http://x/dav/docs/n.txt"))).status).toBe(404);
  });

  it("LOCK blocks writes until UNLOCK with the token", async () => {
    const handle = dav(memoryStore());
    await handle(req("http://x/dav/f.txt", { method: "PUT", body: "v1" }));
    const lock = await handle(
      req("http://x/dav/f.txt", {
        method: "LOCK",
        body: `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>tester</D:href></D:owner></D:lockinfo>`,
      }),
    );
    expect(lock.status).toBe(200);
    const token = lock.headers.get("Lock-Token") ?? "";
    expect(token).toContain("opaquelocktoken:");
    const blocked = await handle(
      req("http://x/dav/f.txt", { method: "PUT", body: "v2" }),
    );
    expect(blocked.status).toBe(423);
    const unlock = await handle(
      req("http://x/dav/f.txt", {
        method: "UNLOCK",
        headers: { "Lock-Token": token },
      }),
    );
    expect(unlock.status).toBe(204);
    const ok = await handle(
      req("http://x/dav/f.txt", { method: "PUT", body: "v2" }),
    );
    expect(ok.status).toBe(204);
  });

  it("paths that escape the tree are refused", async () => {
    const handle = dav(memoryStore());
    const res = await handle(
      req("http://x/dav/../secret.txt", { method: "GET" }),
    );
    expect([400, 404]).toContain(res.status);
    // Encoded traversal must not read outside either.
    const res2 = await handle(
      req("http://x/dav/%2e%2e/secret.txt", { method: "GET" }),
    );
    expect(res2.status).toBe(404);
  });

  it("OPTIONS lists DAV support", async () => {
    const handle = dav(memoryStore());
    const res = await handle(req("http://x/dav/", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Dav")).toContain("1");
    expect(res.headers.get("Allow")).toContain("PROPFIND");
  });
});
