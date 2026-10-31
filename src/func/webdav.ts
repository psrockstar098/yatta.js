// WebDAV (RFC 4918) — file operations over HTTP.
//
// Simple to use: point the handler at a store and mount it on /dav.
// The Yatta storage engine is used through createStorageDavStore().
// For tests, any object that follows DavStore works, such as the
// in-memory store in the test file.
//
// Supported methods: OPTIONS, GET, HEAD, PUT, MKCOL, DELETE,
// MOVE, COPY, LOCK, UNLOCK, PROPFIND (Depth 0 and 1).
// PROPPATCH is not supported and answers 405.

export interface DavEntry {
  // Path inside the DAV tree, like "docs/readme.txt" or "docs".
  path: string;
  isCollection: boolean;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export interface DavFile {
  body: Uint8Array;
  contentType: string;
  lastModified: Date;
}

// The small surface the handler needs from a backing store.
// Paths never start with "/". The root collection is "".
export interface DavStore {
  get(path: string): Promise<DavFile | null>;
  put(path: string, body: Uint8Array, contentType?: string): Promise<void>;
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  isCollection(path: string): Promise<boolean>;
  // Direct children of a collection only, not the whole tree.
  list(path: string): Promise<DavEntry[]>;
  mkdir(path: string): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  move(src: string, dst: string): Promise<void>;
}

interface Lock {
  token: string;
  owner: string;
  expiresAt: number;
}

const DAV_METHODS =
  "OPTIONS, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK, PROPFIND";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Splits a URL path into clean segments. Returns null when the path
// tries to escape the DAV tree (any ".." segment).
function cleanSegments(rawPath: string): string[] | null {
  const parts = rawPath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts;
}

// The parent collection of a path. "" is the root.
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function displayName(path: string): string {
  if (path === "") return "";
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function hrefFor(basePath: string, path: string): string {
  return path === "" ? `${basePath}/` : `${basePath}/${path}`;
}

export interface WebDAVOptions {
  // URL prefix the handler is mounted on, without a trailing slash.
  basePath?: string;
  // How long a lock lasts when the client does not say. Default: 1 hour.
  defaultLockMs?: number;
}

export function createWebDAVHandler(
  store: DavStore,
  options: WebDAVOptions = {},
): (req: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/dav";
  const defaultLockMs = options.defaultLockMs ?? 3_600_000;
  const locks = new Map<string, Lock>();

  function liveLock(path: string): Lock | null {
    const lock = locks.get(path);
    if (!lock) return null;
    if (lock.expiresAt <= Date.now()) {
      locks.delete(path);
      return null;
    }
    return lock;
  }

  // A locked file refuses changes unless the caller shows the lock token,
  // either in an If header or in a Lock-Token header. A lock on a
  // collection covers everything under it too: writing to a child of a
  // locked collection needs the collection's token, not just the
  // child's own lock. Without this, locking a folder would not stop
  // anyone from changing or deleting what is inside it.
  function lockBlocks(req: Request, path: string): boolean {
    const shown = `${req.headers.get("if") ?? ""} ${req.headers.get("lock-token") ?? ""}`;
    let current = path;
    for (;;) {
      const lock = liveLock(current);
      if (lock && !shown.includes(lock.token)) return true;
      if (current === "") return false;
      current = parentOf(current);
    }
  }

  // Every path in a tree: the path itself plus all descendants.
  // Used to check locks before a whole-tree change (DELETE, MOVE).
  async function collectSubtree(path: string): Promise<string[]> {
    const out: string[] = [path];
    if (await store.isCollection(path)) {
      for (const child of await store.list(path)) {
        out.push(...(await collectSubtree(child.path)));
      }
    }
    return out;
  }

  // True when any path in a tree is locked and its token is not shown.
  async function subtreeLocked(req: Request, path: string): Promise<boolean> {
    for (const p of await collectSubtree(path)) {
      if (lockBlocks(req, p)) return true;
    }
    return false;
  }

  async function deleteTree(path: string): Promise<void> {
    if (await store.isCollection(path)) {
      for (const child of await store.list(path)) {
        await deleteTree(child.path);
      }
    }
    await store.delete(path);
  }

  async function copyTree(src: string, dst: string): Promise<void> {
    if (await store.isCollection(src)) {
      await store.mkdir(dst);
      for (const child of await store.list(src)) {
        const name = child.path.slice(src === "" ? 0 : src.length + 1);
        await copyTree(child.path, dst === "" ? name : `${dst}/${name}`);
      }
      return;
    }
    const file = await store.get(src);
    if (!file) throw new Error("copy source missing");
    await store.put(dst, file.body, file.contentType);
  }

  // Reads the Destination header and turns it into a DAV path.
  // Accepts a full URL ("http://host/dav/a.txt") or a plain path.
  function destinationPath(req: Request): string[] | null {
    const raw = req.headers.get("destination");
    if (!raw) return null;
    let pathname: string;
    try {
      pathname = new URL(raw, "http://dav.local").pathname;
    } catch {
      return null;
    }
    if (!pathname.startsWith(basePath)) return null;
    return cleanSegments(pathname.slice(basePath.length));
  }

  function propfindXml(
    base: string,
    entries: DavEntry[],
    locksFor: (path: string) => Lock | null,
  ): string {
    const responses = entries
      .map((entry) => {
        const lock = locksFor(entry.path);
        const props = [
          `<D:displayname>${escapeXml(displayName(entry.path))}</D:displayname>`,
          `<D:getlastmodified>${entry.lastModified.toUTCString()}</D:getlastmodified>`,
          entry.isCollection
            ? `<D:resourcetype><D:collection/></D:resourcetype>`
            : `<D:resourcetype/>`,
        ];
        if (!entry.isCollection) {
          props.push(`<D:getcontentlength>${entry.size}</D:getcontentlength>`);
          if (entry.contentType) {
            props.push(
              `<D:getcontenttype>${escapeXml(entry.contentType)}</D:getcontenttype>`,
            );
          }
        }
        if (lock) {
          props.push(
            `<D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype>` +
              `<D:lockscope><D:exclusive/></D:lockscope>` +
              `<D:depth>infinity</D:depth>` +
              `<D:owner>${escapeXml(lock.owner)}</D:owner>` +
              `<D:timeout>Second-${Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000))}</D:timeout>` +
              `<D:locktoken><D:href>${escapeXml(lock.token)}</D:href></D:locktoken>` +
              `</D:activelock></D:lockdiscovery>`,
          );
        }
        return (
          `<D:response><D:href>${escapeXml(hrefFor(base, entry.path))}</D:href>` +
          `<D:propstat><D:prop>${props.join("")}</D:prop>` +
          `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
        );
      })
      .join("");
    return (
      `<?xml version="1.0" encoding="utf-8" ?>` +
      `<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`
    );
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) {
      return new Response("Not Found", { status: 404 });
    }
    const segments = cleanSegments(url.pathname.slice(basePath.length));
    if (segments === null) {
      return new Response("Path escapes the DAV tree", { status: 400 });
    }
    const path = segments.join("/");
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: { Dav: "1, 2", Allow: DAV_METHODS },
      });
    }

    if (method === "GET" || method === "HEAD") {
      if (await store.isCollection(path)) {
        const children = await store.list(path);
        const body =
          children
            .map((c) => `${c.isCollection ? c.path + "/" : c.path}\n`)
            .join("") || "(empty)\n";
        return new Response(method === "HEAD" ? null : body, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const file = await store.get(path);
      if (!file) return new Response("Not Found", { status: 404 });
      return new Response(method === "HEAD" ? null : (file.body as BodyInit), {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.body.byteLength),
          "Last-Modified": file.lastModified.toUTCString(),
        },
      });
    }

    if (method === "PUT") {
      if (lockBlocks(req, path)) {
        return new Response("Locked", { status: 423 });
      }
      const parent = parentOf(path);
      if (parent !== "" && !(await store.isCollection(parent))) {
        return new Response("Parent collection does not exist", { status: 409 });
      }
      if (await store.isCollection(path)) {
        return new Response("Path is a collection", { status: 405 });
      }
      const existed = await store.exists(path);
      const body = new Uint8Array(await req.arrayBuffer());
      await store.put(
        path,
        body,
        req.headers.get("content-type") ?? undefined,
      );
      return new Response(null, { status: existed ? 204 : 201 });
    }

    if (method === "MKCOL") {
      const body = await req.arrayBuffer();
      if (body.byteLength > 0) {
        return new Response("MKCOL takes no body", { status: 415 });
      }
      const parent = parentOf(path);
      if (parent !== "" && !(await store.isCollection(parent))) {
        return new Response("Parent collection does not exist", { status: 409 });
      }
      if ((await store.exists(path)) || (await store.isCollection(path))) {
        return new Response("Already exists", { status: 405 });
      }
      await store.mkdir(path);
      return new Response(null, { status: 201 });
    }

    if (method === "DELETE") {
      if (!(await store.exists(path)) && !(await store.isCollection(path))) {
        return new Response("Not Found", { status: 404 });
      }
      if (await subtreeLocked(req, path)) {
        return new Response("Locked", { status: 423 });
      }
      await deleteTree(path);
      return new Response(null, { status: 204 });
    }

    if (method === "COPY" || method === "MOVE") {
      const dstSegments = destinationPath(req);
      if (dstSegments === null) {
        return new Response("Missing or bad Destination header", { status: 400 });
      }
      const dst = dstSegments.join("/");
      const isMove = method === "MOVE";
      if (isMove) {
        if (await subtreeLocked(req, path)) {
          return new Response("Source is locked", { status: 423 });
        }
      }
      if (lockBlocks(req, dst)) {
        return new Response("Destination is locked", { status: 423 });
      }
      const srcExists =
        (await store.exists(path)) || (await store.isCollection(path));
      if (!srcExists) return new Response("Not Found", { status: 404 });
      const dstExists =
        (await store.exists(dst)) || (await store.isCollection(dst));
      const overwrite = req.headers.get("overwrite")?.toUpperCase() !== "F";
      if (dstExists && !overwrite) {
        return new Response("Destination exists", { status: 412 });
      }
      const dstParent = parentOf(dst);
      if (dstParent !== "" && !(await store.isCollection(dstParent))) {
        return new Response("Destination parent does not exist", { status: 409 });
      }
      if (dstExists) await deleteTree(dst);
      await copyTree(path, dst);
      if (isMove) await deleteTree(path);
      return new Response(null, { status: dstExists ? 204 : 201 });
    }

    if (method === "LOCK") {
      if (liveLock(path)) {
        return new Response("Already locked", { status: 423 });
      }
      const text = await req.text();
      const ownerMatch =
        text.match(/<[^>]*owner[^>]*>([\s\S]*?)<\/[^>]*owner[^>]*>/i) ??
        text.match(/<D:href>([^<]+)<\/D:href>/i);
      const owner = (ownerMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
      const timeoutMatch = req.headers
        .get("timeout")
        ?.match(/Second-(\d+)/i);
      const ttl = timeoutMatch
        ? Math.min(Number(timeoutMatch[1]) * 1000, 24 * 3_600_000)
        : defaultLockMs;
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      const lock: Lock = {
        token,
        owner,
        expiresAt: Date.now() + ttl,
      };
      locks.set(path, lock);
      const xml =
        `<?xml version="1.0" encoding="utf-8" ?>` +
        `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
        `<D:locktype><D:write/></D:locktype>` +
        `<D:lockscope><D:exclusive/></D:lockscope>` +
        `<D:depth>infinity</D:depth>` +
        `<D:owner>${escapeXml(owner)}</D:owner>` +
        `<D:timeout>Second-${Math.round(ttl / 1000)}</D:timeout>` +
        `<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>` +
        `</D:activelock></D:lockdiscovery></D:prop>`;
      return new Response(xml, {
        status: 200,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Lock-Token": `<${token}>`,
        },
      });
    }

    if (method === "UNLOCK") {
      const raw = req.headers.get("lock-token") ?? "";
      const token = raw.replace(/[<>]/g, "").trim();
      const lock = liveLock(path);
      if (!lock || lock.token !== token) {
        return new Response("Lock token does not match", { status: 409 });
      }
      locks.delete(path);
      return new Response(null, { status: 204 });
    }

    if (method === "PROPFIND") {
      const depth = req.headers.get("depth") ?? "infinity";
      if (depth !== "0" && depth !== "1") {
        return new Response("Only Depth 0 and 1 are supported", { status: 403 });
      }
      const isCol = await store.isCollection(path);
      const file = isCol ? null : await store.get(path);
      if (!isCol && !file) {
        return new Response("Not Found", { status: 404 });
      }
      const entries: DavEntry[] = [
        {
          path,
          isCollection: isCol,
          size: file?.body.byteLength ?? 0,
          lastModified: file?.lastModified ?? new Date(),
          contentType: file?.contentType,
        },
      ];
      if (depth === "1" && isCol) {
        entries.push(...(await store.list(path)));
      }
      return new Response(propfindXml(basePath, entries, liveLock), {
        status: 207,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: DAV_METHODS },
    });
  };
}

// ── Production adapter: Yatta storage engine ─────────────────────────────
// Collections have no real form in a key store, so a collection is marked
// by a small marker file "<path>/.dav-collection". The marker is hidden
// from listings, so it never shows up as a file.

const MARKER = ".dav-collection";

export function createStorageDavStore(storage: {
  upload(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<unknown>;
  download(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    contentType: string;
    lastModified: Date;
  }>;
  head(key: string): Promise<{ size: number; contentType: string; lastModified: Date }>;
  delete(key: string): Promise<void>;
  copy(src: string, dst: string): Promise<unknown>;
  move(src: string, dst: string): Promise<unknown>;
  exists(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<
    Array<{ path: string; size: number; contentType: string; lastModified: Date }>
  >;
}): DavStore {
  const markerKey = (path: string) =>
    path === "" ? MARKER : `${path}/${MARKER}`;
  const isMarker = (key: string) =>
    key === MARKER || key.endsWith(`/${MARKER}`);
  const prefixOf = (path: string) => (path === "" ? "" : `${path}/`);

  async function listAll(path: string) {
    const prefix = prefixOf(path);
    const all = await storage.list({ prefix });
    return all.filter((f) => !isMarker(f.path));
  }

  // Direct children of a collection: one more segment below it.
  async function children(path: string): Promise<DavEntry[]> {
    const prefix = prefixOf(path);
    const files = await listAll(path);
    const byDir = new Map<string, DavEntry>();
    const out: DavEntry[] = [];
    for (const f of files) {
      const rest = f.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        out.push({
          path: f.path,
          isCollection: false,
          size: f.size,
          lastModified: f.lastModified,
          contentType: f.contentType,
        });
      } else {
        const dir = prefix + rest.slice(0, slash);
        if (!byDir.has(dir)) {
          byDir.set(dir, {
            path: dir,
            isCollection: true,
            size: 0,
            lastModified: f.lastModified,
          });
        }
      }
    }
    out.push(...byDir.values());
    return out;
  }

  return {
    async get(path) {
      try {
        const file = await storage.download(path);
        return {
          body: new Uint8Array(await file.arrayBuffer()),
          contentType: file.contentType,
          lastModified: file.lastModified,
        };
      } catch {
        return null;
      }
    },
    async put(path, body, contentType) {
      await storage.upload(path, body, { contentType });
    },
    async delete(path) {
      // Remove the file itself and, for a collection, its marker.
      // Missing keys are fine: deleting twice must not fail.
      for (const key of path === "" ? [] : [path, markerKey(path)]) {
        try {
          await storage.delete(key);
        } catch {
          // Already gone — nothing to do.
        }
      }
      return true;
    },
    async exists(path) {
      if (path === "") return true;
      try {
        await storage.head(path);
        return true;
      } catch {
        return false;
      }
    },
    async isCollection(path) {
      if (path === "") return true;
      if (await storage.exists(markerKey(path))) return true;
      const files = await listAll(path);
      return files.length > 0;
    },
    async list(path) {
      return children(path);
    },
    async mkdir(path) {
      await storage.upload(markerKey(path), new Uint8Array(), {
        contentType: "application/octet-stream",
      });
    },
    async copy(src, dst) {
      await storage.copy(src, dst);
    },
    async move(src, dst) {
      await storage.move(src, dst);
    },
  };
}
