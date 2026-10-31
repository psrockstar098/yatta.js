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
//
// Security: this handler does NOT decide who may use it. Pass
// `authenticate`, or mount it behind your own auth. Without one, anyone
// who can reach the URL can read, write and delete everything in the
// tree. Locks live in memory in this process only.
//
// Two behaviours worth knowing before you debug a client:
//   - A LOCK with no body is a refresh, not a new lock: it needs the
//     token in an If header, or it is refused.
//   - Anything not on INLINE_SAFE_TYPES downloads rather than displays,
//     because a PUT file is attacker-controlled content on your origin.

/** One path in the tree, with the metadata PROPFIND reports. */
export interface DavEntry {
  // Path inside the DAV tree, like "docs/readme.txt" or "docs".
  path: string;
  isCollection: boolean;
  size: number;
  lastModified: Date;
  contentType?: string;
}

/** A file as the store returns it: the bytes plus what a browser needs. */
export interface DavFile {
  body: Uint8Array;
  contentType: string;
  lastModified: Date;
}

/**
 * The small surface the handler needs from a backing store.
 *
 * Paths never start with "/" and the root collection is `""`. Copy and
 * move a whole collection only turn up as a `mkdir` plus per-file calls,
 * except `move` on a single file, so a store that can rename cheaply
 * should — reading a large file into memory to move it is the handler's
 * fallback, not a requirement.
 */
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
  // Optional: size and dates of one path WITHOUT reading its body.
  // Without it, HEAD and PROPFIND on a file have to load the whole
  // file into memory just to learn its size.
  stat?(path: string): Promise<DavEntry | null>;
}

/**
 * An error with an HTTP status, for a store that needs to say no.
 *
 * `throw new DavError(403, "reserved name")` reaches the client as that
 * status and message. Any other thrown error is logged and answered 500,
 * so an internal detail never becomes the response body.
 */
export class DavError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DavError";
    this.status = status;
  }
}

interface Lock {
  token: string;
  owner: string;
  expiresAt: number;
}

const DAV_METHODS =
  "OPTIONS, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK, PROPFIND";
const WRITE_METHODS = new Set([
  "PUT",
  "MKCOL",
  "DELETE",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
]);
const MAX_LOCK_BODY = 64 * 1024;
const MAX_LOCK_MS = 24 * 3_600_000;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Splits a URL path into clean, DECODED segments. Returns null for a
// path that is not allowed: a ".." segment, a segment that contains a
// slash, backslash or control character once decoded ("..%2F" would
// otherwise turn into a path separator), or an absurdly long path.
//
// Decoding matters: clients send "my file.txt" as "my%20file.txt".
// Before, the raw "%20" was used as the stored name, so names were
// wrong and anything with "%" or "#" in it could not round-trip.
function cleanSegments(rawPath: string): string[] | null {
  const out: string[] = [];
  for (const raw of rawPath.split("/")) {
    if (raw === "" || raw === ".") continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === "" || part === "." || part === "..") return null;
    if (/[\\/\u0000-\u001f\u007f]/.test(part)) return null;
    if (part.length > 255) return null;
    out.push(part);
  }
  if (out.length > 64) return null;
  return out;
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

// Encodes each segment, so names with spaces, "%", "#" or "?" make
// valid URLs. Collections end in a slash, which Windows and several
// other clients expect.
function hrefFor(
  basePath: string,
  path: string,
  isCollection: boolean,
): string {
  if (path === "") return `${basePath}/`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${basePath}/${encoded}${isCollection ? "/" : ""}`;
}

// Files a browser may show inline. Everything else is sent as a
// download. This is an allowlist on purpose: the earlier blocklist of
// "active" types missed ones like application/rdf+xml and
// text/xsl, which browsers also run as documents. An attacker who can
// PUT a file must not be able to make it run on the app origin
// (stored XSS through /dav).
const INLINE_SAFE_TYPES =
  /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain|application\/json)\s*(;|$)/i;

/**
 * How the handler behaves. Everything is optional; the defaults are a
 * `/dav` mount with no authentication, which is only safe when something
 * in front of it authenticates.
 */
export interface WebDAVOptions {
  // URL prefix the handler is mounted on, without a trailing slash.
  basePath?: string;
  // How long a lock lasts when the client does not say. Default: 1 hour.
  defaultLockMs?: number;
  // Decides who may use the tree. Return true to allow, false for a
  // 401, or return your own Response (a redirect, a 403). Runs for
  // every method, OPTIONS included.
  authenticate?: (
    req: Request,
  ) => Promise<boolean | Response> | boolean | Response;
  // Refuse every method that changes something.
  readOnly?: boolean;
  // Largest upload accepted, in bytes. Default 100 MB. The store takes
  // the whole file as one buffer, so this is also a memory limit.
  maxBodyBytes?: number;
}

// Reads a request body, but gives up (null) past `limit` bytes so a
// huge or endless upload cannot fill memory.
async function readBody(
  req: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Build the WebDAV handler for a store.
 *
 * @param store Where the bytes live. Use `createStorageDavStore(storage)`
 * to back it with the Yatta storage engine, or your own for tests.
 * @returns A `(req) => Promise<Response>` for a router or `Bun.serve`.
 *
 * @example
 * import { storage } from "yatta.js/storage";
 *
 * const dav = createWebDAVHandler(createStorageDavStore(storage), {
 *   basePath: "/dav",
 *   authenticate: async (req) => Boolean(await sessionUserId(req)),
 * });
 */
export function createWebDAVHandler(
  store: DavStore,
  options: WebDAVOptions = {},
): (req: Request) => Promise<Response> {
  const basePath = (options.basePath ?? "/dav").replace(/\/+$/, "");
  const defaultLockMs = options.defaultLockMs ?? 3_600_000;
  const maxBody = options.maxBodyBytes ?? 100 * 1024 * 1024;
  const locks = new Map<string, Lock>();

  // "/davx" is not inside "/dav". Before, a plain startsWith let it in
  // and treated it as the file "x" at the root.
  function inMount(pathname: string): boolean {
    return pathname === basePath || pathname.startsWith(`${basePath}/`);
  }

  function liveLock(path: string): Lock | null {
    const lock = locks.get(path);
    if (!lock) return null;
    if (lock.expiresAt <= Date.now()) {
      locks.delete(path);
      return null;
    }
    return lock;
  }

  function purgeExpiredLocks(): void {
    const now = Date.now();
    for (const [path, lock] of locks) {
      if (lock.expiresAt <= now) locks.delete(path);
    }
  }

  // Forgets the locks on a path and everything under it. Called after
  // a DELETE or MOVE: a lock belongs to the resource, and left behind
  // it would lock whatever is created at that path next.
  function dropLocks(path: string): void {
    for (const key of [...locks.keys()]) {
      if (key === path || path === "" || key.startsWith(`${path}/`))
        locks.delete(key);
    }
  }

  // Lock tokens the caller shows, from the If header (and Lock-Token).
  // Parsed as tokens, not searched as text, and a negated condition
  // like (Not <token>) does not count as showing it.
  function shownTokens(req: Request): Set<string> {
    const tokens = new Set<string>();
    const ifHeader = (req.headers.get("if") ?? "").replace(
      /Not\s*<[^>]*>/gi,
      "",
    );
    for (const m of ifHeader.matchAll(/<([^>]+)>/g)) tokens.add(m[1]!);
    const lockToken = (req.headers.get("lock-token") ?? "")
      .replace(/[<>]/g, "")
      .trim();
    if (lockToken) tokens.add(lockToken);
    return tokens;
  }

  // A locked file refuses changes unless the caller shows the lock token.
  // A lock on a collection covers everything under it too: writing to a
  // child of a locked collection needs the collection's token, not just
  // the child's own lock. Without this, locking a folder would not stop
  // anyone from changing or deleting what is inside it.
  function lockBlocks(shown: Set<string>, path: string): boolean {
    let current = path;
    for (;;) {
      const lock = liveLock(current);
      if (lock && !shown.has(lock.token)) return true;
      if (current === "") return false;
      current = parentOf(current);
    }
  }

  // Any live lock on this path or above it, whoever holds it.
  function lockedAbove(path: string): boolean {
    let current = path;
    for (;;) {
      if (liveLock(current)) return true;
      if (current === "") return false;
      current = parentOf(current);
    }
  }

  // Any live lock strictly below this path.
  function lockedBelow(path: string): boolean {
    for (const key of [...locks.keys()]) {
      if (
        (path === "" ? key !== "" : key.startsWith(`${path}/`)) &&
        liveLock(key)
      ) {
        return true;
      }
    }
    return false;
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
  async function subtreeLocked(
    shown: Set<string>,
    path: string,
  ): Promise<boolean> {
    for (const p of await collectSubtree(path)) {
      if (lockBlocks(shown, p)) return true;
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
    // The store copies a file itself. Before, every file was read into
    // memory and written back, which is slow and big for large files.
    await store.copy(src, dst);
  }

  // Size and dates of one path, without reading a file body when the
  // store can say them directly.
  async function statOf(path: string): Promise<DavEntry | null> {
    if (store.stat) return store.stat(path);
    if (await store.isCollection(path)) {
      return { path, isCollection: true, size: 0, lastModified: new Date() };
    }
    const file = await store.get(path);
    if (!file) return null;
    return {
      path,
      isCollection: false,
      size: file.body.byteLength,
      lastModified: file.lastModified,
      contentType: file.contentType,
    };
  }

  // Reads the Destination header and turns it into a DAV path.
  // Accepts a full URL ("http://host/dav/a.txt") or a plain path.
  // Guards: the path must be exactly under the mount point (so
  // "/davx" cannot sneak in as "x"), and an absolute URL must point
  // at this same server (another host's path is not silently reused
  // as a local path). The host is compared, not the scheme, because a
  // proxy that ends TLS makes the request http while the client's
  // Destination says https.
  function destinationPath(req: Request): string[] | null {
    const raw = req.headers.get("destination");
    if (!raw) return null;
    let isAbsolute = false;
    try {
      new URL(raw);
      isAbsolute = true;
    } catch {
      isAbsolute = false;
    }
    let target: URL;
    try {
      target = new URL(raw, req.url);
    } catch {
      return null;
    }
    if (isAbsolute && target.host !== new URL(req.url).host) return null;
    const pathname = target.pathname;
    if (!inMount(pathname)) return null;
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
          // Tells clients that exclusive write locks are available.
          `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>` +
            `<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`,
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
          `<D:response><D:href>${escapeXml(hrefFor(base, entry.path, entry.isCollection))}</D:href>` +
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

  function lockXml(lock: Lock, ttlMs: number): string {
    return (
      `<?xml version="1.0" encoding="utf-8" ?>` +
      `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
      `<D:locktype><D:write/></D:locktype>` +
      `<D:lockscope><D:exclusive/></D:lockscope>` +
      `<D:depth>infinity</D:depth>` +
      `<D:owner>${escapeXml(lock.owner)}</D:owner>` +
      `<D:timeout>Second-${Math.round(ttlMs / 1000)}</D:timeout>` +
      `<D:locktoken><D:href>${escapeXml(lock.token)}</D:href></D:locktoken>` +
      `</D:activelock></D:lockdiscovery></D:prop>`
    );
  }

  function lockTtl(req: Request): number {
    const match = req.headers.get("timeout")?.match(/Second-(\d+)/i);
    if (!match) return defaultLockMs;
    // At least a second: "Second-0" made a lock that was dead on arrival.
    return Math.min(Math.max(Number(match[1]) * 1000, 1000), MAX_LOCK_MS);
  }

  async function handle(
    req: Request,
    path: string,
    method: string,
  ): Promise<Response> {
    const shown = shownTokens(req);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          Dav: "1, 2",
          Allow: DAV_METHODS,
          // Makes Microsoft's WebDAV client use DAV rather than guess.
          "MS-Author-Via": "DAV",
        },
      });
    }

    if (options.readOnly && WRITE_METHODS.has(method)) {
      return new Response("Read-only", { status: 403 });
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
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const headers: Record<string, string> = {
        // Never sniffed into something executable, and even if a
        // browser did run it, the sandbox gives it no origin.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      };
      let contentType: string;
      let body: Uint8Array | null = null;
      if (method === "HEAD") {
        // HEAD must not read the whole file into memory.
        const entry = await statOf(path);
        if (!entry || entry.isCollection)
          return new Response("Not Found", { status: 404 });
        contentType = entry.contentType || "application/octet-stream";
        headers["Content-Length"] = String(entry.size);
        headers["Last-Modified"] = entry.lastModified.toUTCString();
      } else {
        const file = await store.get(path);
        if (!file) return new Response("Not Found", { status: 404 });
        contentType = file.contentType || "application/octet-stream";
        body = file.body;
        headers["Content-Length"] = String(file.body.byteLength);
        headers["Last-Modified"] = file.lastModified.toUTCString();
      }
      headers["Content-Type"] = contentType;
      // Anything not on the safe list downloads instead of displaying.
      if (!INLINE_SAFE_TYPES.test(contentType)) {
        headers["Content-Disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(displayName(path))}`;
      }
      return new Response(body as BodyInit | null, { status: 200, headers });
    }

    if (method === "PUT") {
      // Partial PUT is not supported, and RFC 7231 says to refuse it
      // rather than store a fragment as the whole file.
      if (req.headers.get("content-range")) {
        return new Response("Content-Range is not supported on PUT", {
          status: 501,
        });
      }
      if (lockBlocks(shown, path)) {
        return new Response("Locked", { status: 423 });
      }
      const parent = parentOf(path);
      if (parent !== "" && !(await store.isCollection(parent))) {
        return new Response("Parent collection does not exist", {
          status: 409,
        });
      }
      if (await store.isCollection(path)) {
        return new Response("Path is a collection", { status: 405 });
      }
      const existed = await store.exists(path);
      if (existed && req.headers.get("if-none-match")?.trim() === "*") {
        return new Response("Already exists", { status: 412 });
      }
      const body = await readBody(req, maxBody);
      if (body === null)
        return new Response("Upload too large", { status: 413 });
      await store.put(path, body, req.headers.get("content-type") ?? undefined);
      return new Response(null, { status: existed ? 204 : 201 });
    }

    if (method === "MKCOL") {
      // Before, MKCOL ignored locks, so a folder could be created
      // inside a locked collection.
      if (lockBlocks(shown, path)) {
        return new Response("Locked", { status: 423 });
      }
      const body = await readBody(req, 0);
      if (body === null) {
        return new Response("MKCOL takes no body", { status: 415 });
      }
      const parent = parentOf(path);
      if (parent !== "" && !(await store.isCollection(parent))) {
        return new Response("Parent collection does not exist", {
          status: 409,
        });
      }
      if ((await store.exists(path)) || (await store.isCollection(path))) {
        return new Response("Already exists", { status: 405 });
      }
      await store.mkdir(path);
      return new Response(null, { status: 201 });
    }

    if (method === "DELETE") {
      if (path === "") {
        return new Response("Cannot delete the root collection", {
          status: 403,
        });
      }
      if (!(await store.exists(path)) && !(await store.isCollection(path))) {
        return new Response("Not Found", { status: 404 });
      }
      if (await subtreeLocked(shown, path)) {
        return new Response("Locked", { status: 423 });
      }
      await deleteTree(path);
      dropLocks(path);
      return new Response(null, { status: 204 });
    }

    if (method === "COPY" || method === "MOVE") {
      const dstSegments = destinationPath(req);
      if (dstSegments === null) {
        return new Response("Missing or bad Destination header", {
          status: 400,
        });
      }
      const dst = dstSegments.join("/");
      const isMove = method === "MOVE";
      // The root collection cannot be copied, moved, or replaced: copying
      // it would copy the whole tree, and a destination inside the source
      // would recurse forever (the copy creates the folder it then copies).
      if (path === "" || dst === "") {
        return new Response("Cannot copy or move the root collection", {
          status: 403,
        });
      }
      if (dst === path || dst.startsWith(`${path}/`)) {
        return new Response("Destination is inside the source", {
          status: 403,
        });
      }
      // The other way round: replacing a folder that contains the
      // source deletes the source before it is copied. Before, MOVE
      // /a/b onto /a lost the data.
      if (path.startsWith(`${dst}/`)) {
        return new Response("Source is inside the destination", {
          status: 403,
        });
      }
      const srcIsCollection = await store.isCollection(path);
      const srcExists = srcIsCollection || (await store.exists(path));
      if (!srcExists) return new Response("Not Found", { status: 404 });
      const depth = req.headers.get("depth")?.toLowerCase() ?? "infinity";
      if (depth !== "0" && depth !== "infinity") {
        return new Response("Depth must be 0 or infinity", { status: 400 });
      }
      if (
        isMove &&
        (depth !== "infinity" || (await subtreeLocked(shown, path)))
      ) {
        return depth !== "infinity"
          ? new Response("MOVE needs Depth infinity", { status: 400 })
          : new Response("Source is locked", { status: 423 });
      }
      const dstExists =
        (await store.exists(dst)) || (await store.isCollection(dst));
      // Replacing a destination deletes everything under it, so every
      // lock in that tree must be respected, not only the top one.
      const dstLocked = dstExists
        ? await subtreeLocked(shown, dst)
        : lockBlocks(shown, dst);
      if (dstLocked) {
        return new Response("Destination is locked", { status: 423 });
      }
      const overwrite = req.headers.get("overwrite")?.toUpperCase() !== "F";
      if (dstExists && !overwrite) {
        return new Response("Destination exists", { status: 412 });
      }
      const dstParent = parentOf(dst);
      if (dstParent !== "" && !(await store.isCollection(dstParent))) {
        return new Response("Destination parent does not exist", {
          status: 409,
        });
      }
      if (dstExists) await deleteTree(dst);
      if (isMove && !srcIsCollection) {
        await store.move(path, dst);
      } else if (!isMove && srcIsCollection && depth === "0") {
        // COPY with Depth: 0 copies the folder alone, not its contents.
        await store.mkdir(dst);
      } else {
        await copyTree(path, dst);
        if (isMove) await deleteTree(path);
      }
      if (isMove) dropLocks(path);
      if (dstExists) dropLocks(dst);
      return new Response(null, { status: dstExists ? 204 : 201 });
    }

    if (method === "LOCK") {
      purgeExpiredLocks();
      const raw = await readBody(req, MAX_LOCK_BODY);
      if (raw === null)
        return new Response("Request too large", { status: 413 });
      const text = new TextDecoder().decode(raw);
      const ttl = lockTtl(req);

      // No body means "keep my lock alive": Word and Finder send this
      // before the lock runs out. Before, it got "423 Already locked".
      if (text.trim() === "") {
        const existing = liveLock(path);
        if (existing && shown.has(existing.token)) {
          existing.expiresAt = Date.now() + ttl;
          return new Response(lockXml(existing, ttl), {
            status: 200,
            headers: {
              "Content-Type": "application/xml; charset=utf-8",
              "Lock-Token": `<${existing.token}>`,
            },
          });
        }
        return new Response("LOCK needs a body, or a lock token to refresh", {
          status: 400,
        });
      }

      // A lock covers the whole tree below it, so it conflicts with a
      // lock on this path, above it, or anywhere below it. Before,
      // only an exact match was refused, so anyone could lock a file
      // inside a folder someone else had locked.
      if (lockedAbove(path) || lockedBelow(path)) {
        return new Response("Already locked", { status: 423 });
      }
      const parent = parentOf(path);
      if (parent !== "" && !(await store.isCollection(parent))) {
        return new Response("Parent collection does not exist", {
          status: 409,
        });
      }
      const ownerMatch =
        text.match(/<[^>]*owner[^>]*>([\s\S]*?)<\/[^>]*owner[^>]*>/i) ??
        text.match(/<D:href>([^<]+)<\/D:href>/i);
      const owner = (ownerMatch?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .slice(0, 1000);
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      const lock: Lock = { token, owner, expiresAt: Date.now() + ttl };
      locks.set(path, lock);
      return new Response(lockXml(lock, ttl), {
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
        // RFC 4918 §9.1: the precondition name tells clients why.
        return new Response(
          `<?xml version="1.0" encoding="utf-8" ?>` +
            `<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`,
          {
            status: 403,
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          },
        );
      }
      // Size and dates without loading the file.
      const entry = await statOf(path);
      if (!entry) return new Response("Not Found", { status: 404 });
      const entries: DavEntry[] = [entry];
      if (depth === "1" && entry.isCollection) {
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
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!inMount(url.pathname)) {
      return new Response("Not Found", { status: 404 });
    }
    const segments = cleanSegments(url.pathname.slice(basePath.length));
    if (segments === null) {
      return new Response("Bad path", { status: 400 });
    }
    const path = segments.join("/");
    const method = req.method.toUpperCase();

    if (options.authenticate) {
      let verdict: boolean | Response;
      try {
        verdict = await options.authenticate(req);
      } catch (err) {
        console.error("[webdav] authenticate failed:", err);
        return new Response("Internal Server Error", { status: 500 });
      }
      if (verdict instanceof Response) return verdict;
      if (!verdict) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="dav"' },
        });
      }
    }

    // A failing store used to escape as an unhandled error. Now the
    // client gets a clean status and the detail stays in the log.
    try {
      return await handle(req, path, method);
    } catch (err) {
      if (err instanceof DavError) {
        return new Response(err.message, { status: err.status });
      }
      console.error(`[webdav] ${method} ${path} failed:`, err);
      return new Response("Internal Server Error", { status: 500 });
    }
  };
}

// ── Production adapter: Yatta storage engine ─────────────────────────────
// Collections have no real form in a key store, so a collection is marked
// by a small marker file "<path>/.dav-collection". The marker is hidden
// from listings, so it never shows up as a file. The name is reserved:
// clients cannot create, read or overwrite it as a file.

const MARKER = ".dav-collection";

/**
 * Back WebDAV with the Yatta storage engine.
 *
 * A key-value store has no real folders, so a collection is recorded as a
 * marker file, `<path>/.dav-collection`. The name is reserved: a client
 * cannot create, read, overwrite or list it as an ordinary file.
 *
 * @param storage Anything shaped like `yatta.js/storage`'s engine — the
 * same object, not an adapter around it.
 */
export function createStorageDavStore(storage: {
  upload(
    key: string,
    data: Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>;
  download(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    contentType: string;
    lastModified: Date;
  }>;
  head(
    key: string,
  ): Promise<{ size: number; contentType: string; lastModified: Date }>;
  delete(key: string): Promise<void>;
  copy(src: string, dst: string): Promise<unknown>;
  move(src: string, dst: string): Promise<unknown>;
  exists(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<
    Array<{
      path: string;
      size: number;
      contentType: string;
      lastModified: Date;
    }>
  >;
}): DavStore {
  const markerKey = (path: string) =>
    path === "" ? MARKER : `${path}/${MARKER}`;
  const isMarker = (key: string) =>
    key === MARKER || key.endsWith(`/${MARKER}`);
  const prefixOf = (path: string) => (path === "" ? "" : `${path}/`);
  const reserved = () => new DavError(403, `${MARKER} is a reserved name`);

  // Everything stored under a collection, markers included.
  async function listAll(path: string) {
    return storage.list({ prefix: prefixOf(path) });
  }

  // Direct children of a collection: one more segment below it.
  async function children(path: string): Promise<DavEntry[]> {
    const prefix = prefixOf(path);
    const all = await listAll(path);
    const byDir = new Map<string, DavEntry>();
    const out: DavEntry[] = [];
    for (const f of all) {
      const rest = f.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        // The collection's own marker, or a plain file.
        if (isMarker(f.path)) continue;
        out.push({
          path: f.path,
          isCollection: false,
          size: f.size,
          lastModified: f.lastModified,
          contentType: f.contentType,
        });
      } else {
        // A marker below a subfolder still makes that subfolder appear.
        // Before, markers were dropped first, so an empty folder made
        // with MKCOL was missing from its parent's listing.
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

  async function isCollection(path: string): Promise<boolean> {
    if (path === "") return true;
    if (isMarker(path)) return false;
    if (await storage.exists(markerKey(path))) return true;
    return (await listAll(path)).length > 0;
  }

  async function exists(path: string): Promise<boolean> {
    if (path === "") return true;
    if (isMarker(path)) return false;
    try {
      await storage.head(path);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async get(path) {
      if (isMarker(path) || !(await exists(path))) return null;
      // Only "missing" is null. Before, any failure (storage down, a
      // permissions error) was swallowed and reported as 404.
      const file = await storage.download(path);
      return {
        body: new Uint8Array(await file.arrayBuffer()),
        contentType: file.contentType,
        lastModified: file.lastModified,
      };
    },
    async put(path, body, contentType) {
      if (isMarker(path)) throw reserved();
      await storage.upload(path, body, { contentType });
    },
    async delete(path) {
      if (path === "" || isMarker(path)) return false;
      // Remove the file itself and, for a collection, its marker. Real
      // storage errors now surface; before, every failure was
      // swallowed and DELETE reported success with the data still there.
      let deleted = false;
      if (await storage.exists(path)) {
        await storage.delete(path);
        deleted = true;
      }
      if (await storage.exists(markerKey(path))) {
        await storage.delete(markerKey(path));
        deleted = true;
      }
      return deleted;
    },
    exists,
    isCollection,
    async list(path) {
      return children(path);
    },
    async mkdir(path) {
      if (isMarker(path)) throw reserved();
      await storage.upload(markerKey(path), new Uint8Array(), {
        contentType: "application/octet-stream",
      });
    },
    async copy(src, dst) {
      if (isMarker(src) || isMarker(dst)) throw reserved();
      await storage.copy(src, dst);
    },
    async move(src, dst) {
      if (isMarker(src) || isMarker(dst)) throw reserved();
      await storage.move(src, dst);
    },
    async stat(path) {
      if (path === "") {
        return { path, isCollection: true, size: 0, lastModified: new Date() };
      }
      if (isMarker(path)) return null;
      try {
        const info = await storage.head(path);
        return {
          path,
          isCollection: false,
          size: info.size,
          lastModified: info.lastModified,
          contentType: info.contentType,
        };
      } catch {
        // Not a file: it may still be a collection.
      }
      if (await isCollection(path)) {
        return { path, isCollection: true, size: 0, lastModified: new Date() };
      }
      return null;
    },
  };
}
