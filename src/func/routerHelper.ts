import type { Server } from "bun";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API, Context, throttledReload } from "../types/api";
import { realtime } from "./realtime";
import { storage } from "./storage";
import { createWebDAVHandler, createStorageDavStore } from "./webdav";
import { createGrpcWebHandler } from "./grpcweb";
import { createDoHHandler } from "./doh";
import { createOAuthServer, clientsFromEnv } from "./oauth";
import { createOIDC } from "./oidc";
import { oauthTokenRateLimit } from "./ratelimit";
import {
  createFileRouter,
  loadRouteModule,
  type FileRouterLike,
} from "./standalone_routes";

// One shared handler so WebDAV locks survive across requests.
// storage.disk() is the raw disk API (upload/download/head/list);
// the manager facade on its own does not expose those methods.
const webdavHandler = createWebDAVHandler(createStorageDavStore(storage.disk()), {
  basePath: "/dav",
});

// gRPC-Web services, shared across requests.
const grpcWebHandler = createGrpcWebHandler();

// DNS over HTTPS (1.0.6) on /dns-query.
const dohHandler = createDoHHandler();

// OAuth 2.0 + OpenID Connect (1.0.6), shared across requests.
// Clients come from OAUTH_CLIENTS (JSON) when set; more can be
// registered in code. The auth engine is loaded lazily inside the
// callbacks so importing this router never pulls the DB in early.
const oauthIssuer = process.env.APP_URL || "http://localhost:4000";
const oauthServer = createOAuthServer({
  issuer: oauthIssuer,
  clients: clientsFromEnv(process.env),
  resolveUser: async (req) => {
    const { auth } = await import("./auth");
    const user = await auth.getUser(req);
    return user?.id ?? null;
  },
});
const oidc = createOIDC({
  issuer: oauthIssuer,
  oauth: oauthServer,
  findUser: async (id) => {
    const { SQLiteAuthStore } = await import("./auth");
    const user = await new SQLiteAuthStore().findUserById(id);
    return user ? { id: user.id, email: user.email } : null;
  },
});
oauthServer.setIdTokenIssuer(oidc.issueIdToken);

// The package version, for the MCP server info: read from package.json
// instead of a hardcoded string that goes stale on every release (the
// MCP endpoint reported 1.0.5 while the package was 1.0.6).
// Read once: the old code called this on every /mcp request, and a
// readFileSync + JSON.parse per request cost ~47µs (measured).
let cachedPkgVersion: string | undefined;
function pkgVersion(): string {
  if (cachedPkgVersion !== undefined) return cachedPkgVersion;
  try {
    const parsed = JSON.parse(readFileSync(path.join(import.meta.dir, "../package.json"), "utf8")) as {
      version?: unknown;
    };
    cachedPkgVersion = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedPkgVersion = "unknown";
  }
  return cachedPkgVersion;
}

// The OAuth token endpoint has no rate limiting of its own, and the
// limiter is a Context middleware — this router is a plain handler, so
// it is invoked here with a fresh Context per request. One shared
// instance: buckets are keyed per route, so /oauth/token and
// /oauth/revoke get separate budgets from the same limiter. 5 requests
// per minute per IP, the `oauthTokenRateLimit()` preset.
const oauthTokenLimiter = oauthTokenRateLimit();
async function withOAuthTokenLimit(
  req: Request,
  next: () => Promise<Response>,
): Promise<Response> {
  let downstream: Response | undefined;
  const result = await oauthTokenLimiter(new Context(req, {}), async () => {
    downstream = await next();
    return downstream;
  });
  if (result instanceof Response) return result;
  if (downstream) return downstream;
  return new Response("Internal Server Error", { status: 500 });
}

// WebFinger answers account-existence questions, so it is scoped to the
// app's own host: without `hosts`, anyone could test whether ANY email
// address, at any domain, has an account here.
function webFingerHosts(): string[] {
  try {
    return [new URL(process.env.APP_URL || "http://localhost:4000").hostname.toLowerCase()];
  } catch {
    return ["localhost"];
  }
}

// WebFinger and MCP handlers, built once and shared across requests.
//
// Both used to be constructed fresh on every request: two dynamic
// imports each (~2.25µs apiece, measured) plus a new handler, a new
// lookup and — for MCP — a package.json read per request. The handlers
// are stateless — the WebFinger lookup reads the auth store per call
// and the MCP handler rebuilds its tool surface per request inside
// loadTools(), so sharing the handler changes no behaviour: a table
// added by a migration still appears on the next /mcp call, because
// getSurface runs per request, not at construction.
//
// Built lazily on first use, not at import time: importing this router
// must not pull the auth engine or the MCP module in early (see #12).
type SharedHandler = (req: Request) => Promise<Response>;
let webfingerHandlerPromise: Promise<SharedHandler> | null = null;
function getWebFingerHandler(): Promise<SharedHandler> {
  if (!webfingerHandlerPromise) {
    webfingerHandlerPromise = (async () => {
      const { createWebFingerHandler, createUserWebFingerLookup } = await import(
        "./webfinger"
      );
      const { SQLiteAuthStore } = await import("./auth");
      return createWebFingerHandler(
        createUserWebFingerLookup({
          findUserByEmail: (email) => new SQLiteAuthStore().findUserByEmail(email),
          appUrl: process.env.APP_URL || "http://localhost:4000",
          hosts: webFingerHosts(),
        }),
      );
    })();
  }
  return webfingerHandlerPromise;
}

let mcpHandlerPromise: Promise<SharedHandler> | null = null;
function getMcpHandler(): Promise<SharedHandler> {
  if (!mcpHandlerPromise) {
    mcpHandlerPromise = (async () => {
      const { createMCPHandler, surfaceFromTables } = await import("./mcp");
      const { db } = await import("./db");
      return createMCPHandler({
        serverVersion: pkgVersion(),
        resolveUser: async (req) => {
          const { auth } = await import("./auth");
          const user = await auth.getUser(req);
          if (user) return user.id;
          const bearer = (req.headers.get("authorization") ?? "").match(
            /^Bearer\s+(.+)$/i,
          );
          const token = bearer?.[1];
          if (token) {
            const info = oauthServer.getAccessToken(token);
            if (info?.userId) return info.userId;
          }
          return null;
        },
        getSurface: () => {
          const tables: Record<string, never> = {};
          const schema = (db as unknown as { schema?: Record<string, unknown> }).schema ?? {};
          for (const name of Object.keys(schema)) {
            tables[name] = (db as unknown as { table: (n: string) => never }).table(name);
          }
          return surfaceFromTables(tables);
        },
      });
    })();
  }
  return mcpHandlerPromise;
}

// Always resolve relative to this file to guarantee correct path regardless of current working directory
const backendDir = path.resolve(import.meta.dir, "../backend");

/**
 * The file router, built on first use — not at import time. A
 * compiled binary sets __yattaStandaloneRoutes after its imports
 * evaluate, so reading the table at module top level would always
 * miss it; and constructing a FileSystemRouter at top level is what
 * used to crash the binary ("Unable to find directory:
 * /$bunfs/backend"). Under `bun run` the table is absent and this
 * is the same file router as before.
 */
let routerInstance: FileRouterLike | null = null;
function getRouter(): FileRouterLike {
  if (!routerInstance) routerInstance = createFileRouter(backendDir);
  return routerInstance;
}

export const router: FileRouterLike = {
  match(req: Request | string) {
    return getRouter().match(req);
  },
  reload() {
    getRouter().reload();
  },
};

// Route modules resolved once in production (see routers() below).
const productionApiCache = new Map<string, API>();

// Parsed URL for the request currently being dispatched, set by main.ts
// next to its requestPathCache: main.ts already parses req.url once for
// /healthz, /readyz and the observe gate, so routers() re-parsing it
// was a second full parse (~230ns) on every app request. Anything
// calling routers() directly (tests, the standalone entry) simply
// misses the cache and parses, exactly as before.
export const requestUrlCache = new WeakMap<Request, URL>();

// Production dispatch cache: a static file route resolves to the same
// API for every request, so repeat hits skip router.match() and both
// fallbacks entirely. Keyed by the requested pathname; the value holds
// the resolved API and the mount basePath, and params are always a fresh
// {} per request (a static match has no params, and a shared object
// would let one request's mutations leak into the next). Negative results
// are cached too — a 404 otherwise re-runs two fallback scans — but the
// map is capped: distinct 404 pathnames are unbounded, and an uncapped
// negative cache would grow with every scan probe. When full it clears
// and repopulates; production routes are static, so nothing is lost
// except a few repeat lookups.
const PRODUCTION_DISPATCH_CAP = 4096;
const PRODUCTION_NOT_FOUND = Symbol("not-found");
const productionDispatchCache = new Map<
  string,
  { api: API; basePath: string | undefined } | typeof PRODUCTION_NOT_FOUND
>();

/**
 * Robustly pulls the API instance out of the imported module.
 * Supports:
 *   - default export: `export default api`
 *   - named export: `export const api = createAPI()`
 *   - ESM / CJS interop wrapping (module.default vs module.default.default)
 *   - Any instance or duck-typed object implementing `.handle()`
 */
function resolveApi(module: Record<string, unknown>): API | undefined {
  const candidate: any =
    module.default ?? module.api ?? (module as any);

  if (!candidate) return undefined;

  if (candidate instanceof API) return candidate;
  if (candidate.default instanceof API) return candidate.default;
  if (typeof candidate.handle === "function") return candidate as API;
  if (candidate.default && typeof candidate.default.handle === "function") {
    return candidate.default as API;
  }

  return undefined;
}

/**
 * Standard hardening headers applied to every routed response.
 *
 * HSTS is only sent over HTTPS: sending it over plain HTTP is ignored by
 * browsers at best, and can lock a local dev origin out of the browser.
 *
 * The two variants are precomputed once at module load instead of being
 * rebuilt on every response — the request path just iterates the pairs.
 */
const SECURITY_HEADERS_HTTP: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-XSS-Protection", "0"],
];

const SECURITY_HEADERS_HTTPS: Array<[string, string]> = [
  ...SECURITY_HEADERS_HTTP,
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

/** Returns a copy of `res` with the standard hardening headers applied. */
function withSecurityHeaders(res: Response, isHttps: boolean): Response {
  const pairs = isHttps ? SECURITY_HEADERS_HTTPS : SECURITY_HEADERS_HTTP;
  for (const [key, value] of pairs) {
    res.headers.set(key, value);
  }
  return res;
}

/**
 * Exact built-in routes, looked up in one Map.get instead of a chain of
 * `===` checks on every request. The exact set is disjoint from the
 * prefix routes below (/storage, /dav, /grpc-web), so checking the map
 * before them changes no dispatch: no pathname can match both. /mcp
 * stays out of the map — it is env-gated and must fall through to file
 * routing when disabled.
 */
type BuiltinHandler = (req: Request, isHttps: boolean) => Promise<Response>;
const EXACT_BUILTINS = new Map<string, BuiltinHandler>([
  [
    "/dns-query",
    async (req, isHttps) =>
      withSecurityHeaders(await dohHandler(req), isHttps),
  ],
  [
    "/.well-known/webfinger",
    async (req, isHttps) =>
      withSecurityHeaders(await (await getWebFingerHandler())(req), isHttps),
  ],
  [
    "/oauth/authorize",
    async (req, isHttps) =>
      withSecurityHeaders(await oauthServer.handleAuthorize(req), isHttps),
  ],
  [
    "/oauth/token",
    async (req, isHttps) =>
      withSecurityHeaders(
        await withOAuthTokenLimit(req, () => oauthServer.handleToken(req)),
        isHttps,
      ),
  ],
  [
    "/oauth/revoke",
    async (req, isHttps) =>
      withSecurityHeaders(
        await withOAuthTokenLimit(req, () => oauthServer.handleRevoke(req)),
        isHttps,
      ),
  ],
  [
    "/oauth/userinfo",
    async (req, isHttps) =>
      withSecurityHeaders(await oidc.handleUserinfo(req), isHttps),
  ],
  [
    "/oauth/jwks",
    async (_req, isHttps) =>
      withSecurityHeaders(oidc.handleJWKS(), isHttps),
  ],
  [
    "/.well-known/openid-configuration",
    async (_req, isHttps) =>
      withSecurityHeaders(oidc.handleDiscovery(), isHttps),
  ],
]);

export default async function routers(
  req: Request,
  server: Server<unknown>,
): Promise<Response> {
  // main.ts already parsed this URL once; reuse it when available.
  const url = requestUrlCache.get(req) ?? new URL(req.url);
  const isHttps =
    url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const isProduction = process.env.NODE_ENV === "production";

  // 1. Realtime endpoint (handles WebSockets or SSE automatically)
  if (url.pathname === "/realtime") {
    const res = await realtime.connect(req, server);
    if (res instanceof Response) return withSecurityHeaders(res, isHttps);
    return undefined as any; // WebSocket upgrade handled by Bun
  }

  // 1b. Exact built-in routes (DoH, WebFinger, OAuth/OIDC): one Map
  // lookup instead of the old chain of `===` checks.
  const builtin = EXACT_BUILTINS.get(url.pathname);
  if (builtin) return builtin(req, isHttps);

  // 2. Storage explorer UI, download links, and file streaming
  if (url.pathname.startsWith("/storage")) {
    const res = await storage.handleRequest(req, "/storage");
    return withSecurityHeaders(res, isHttps);
  }

  // 2b. WebDAV file operations (1.0.6), backed by the storage engine.
  if (url.pathname === "/dav" || url.pathname.startsWith("/dav/")) {
    return withSecurityHeaders(await webdavHandler(req), isHttps);
  }

  // 2c. gRPC-Web unary calls (1.0.6).
  if (url.pathname === "/grpc-web" || url.pathname.startsWith("/grpc-web/")) {
    return withSecurityHeaders(await grpcWebHandler(req), isHttps);
  }

  // 2d. DNS over HTTPS (1.0.6).
  // 2e. WebFinger discovery (1.0.6).
  // 2f. OAuth 2.0 + OpenID Connect (1.0.6).
  // (All handled by the EXACT_BUILTINS map above.)

  // 2g. MCP server (1.0.6): every app serves /mcp, on by default.
  // One line turns it off: MCP_ENABLED=0. Tools come from the app's
  // own database collections (auth tables are never exposed); the
  // caller must be signed in with a Yatta session or an OAuth token
  // from this same server.
  // The handler is built once and shared (see getMcpHandler): building
  // it per request re-imported two modules and re-read package.json
  // (~47µs) every time.
  if (url.pathname === "/mcp" && process.env.MCP_ENABLED !== "0") {
    const handler = await getMcpHandler();
    return withSecurityHeaders(await handler(req), isHttps);
  }

  // 3. Production dispatch cache: a static route's API is already
  // resolved, so skip the file-router match and both fallbacks.
  if (isProduction) {
    const cached = productionDispatchCache.get(url.pathname);
    if (cached === PRODUCTION_NOT_FOUND) {
      return withSecurityHeaders(new Response("Not Found", { status: 404 }), isHttps);
    }
    if (cached) {
      const res = await cached.api.handle(req, {}, cached.basePath, { url });
      return withSecurityHeaders(res, isHttps);
    }
  }

  // 4. Hot-reload routes in development mode so new files (e.g. user/index.ts) are instantly detected.
  // Throttled, not per-request: a full directory scan on every dev request
  // cost ~200µs on top of a ~5µs dispatch.
  if (!isProduction) {
    throttledReload(router);
  }

  // 5. Match Next.js style file-based API routes.
  // The string form matches by pathname: the old match(req) re-parsed
  // req.url inside the router (~120ns) on every request.
  let match = router.match(url.pathname);

  // Fallback A: Try with / without trailing slash
  if (!match) {
    const altPath = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = router.match(altPath);
  }

  // Fallback B: Sub-path directory router (e.g., /user/profile -> /user -> src/backend/user/index.ts)
  let basePath: string | undefined;
  if (!match) {
    const segments = url.pathname.split("/").filter(Boolean);
    // The full pathname itself (and, when it ends with "/", its
    // trailing-slash twin) was already tested by the match and Fallback
    // A above — pop once so the first iteration tests a real parent
    // instead of re-running a match that just missed (~380ns).
    segments.pop();
    while (segments.length > 0) {
      const parentPath = "/" + segments.join("/");
      const candidateMatch = router.match(parentPath);
      if (candidateMatch) {
        match = candidateMatch;
        basePath = parentPath;
        break;
      }
      segments.pop();
    }
  }

  if (!match) {
    if (isProduction) {
      if (productionDispatchCache.size >= PRODUCTION_DISPATCH_CAP) {
        productionDispatchCache.clear();
      }
      productionDispatchCache.set(url.pathname, PRODUCTION_NOT_FOUND);
    }
    return withSecurityHeaders(new Response("Not Found", { status: 404 }), isHttps);
  }

  let api: API | undefined;

  // Route modules, resolved once in production.
  //
  // `loadRouteModule` is a dynamic import: ~3.3µs per request even for an
  // already-loaded module (measured). The API instance a route file exports
  // is stateless across requests (params arrive per request), so resolving
  // it once and reusing it is behaviour-identical — the same precedent as
  // the production-only moduleCache in `routeRequest` (src/types/api.ts).
  // Development keeps the per-request import so edited route files are
  // picked up without a restart.
  if (isProduction) api = productionApiCache.get(match.filePath);
  if (!api) {
    let module: Record<string, unknown>;
    try {
      // In a compiled binary the module is already bundled (see the
      // standalone route table); everywhere else it is loaded from
      // the matched file on disk.
      module = await loadRouteModule(match);
    } catch (err) {
      console.error(`Failed to load route module ${match.filePath}:`, err);
      return withSecurityHeaders(
        new Response("Internal Server Error", { status: 500 }),
        isHttps,
      );
    }

    api = resolveApi(module);
    if (!api) {
      console.error(
        `Route "${match.filePath}" does not export an API instance ` +
          `(created via createAPI()). Got: ${describeExport(module.default ?? module)}. ` +
          `Make sure the file ends with:\n\n` +
          `  const api = createAPI();\n` +
          `  api.get(...);\n` +
          `  export default api;\n`,
      );
      return withSecurityHeaders(
        new Response("Route handler not found", { status: 500 }),
        isHttps,
      );
    }
    if (isProduction) productionApiCache.set(match.filePath, api);
  }

  // A static match has no params, so its dispatch is the same for every
  // request with this pathname — cache it (see the map above). Dynamic
  // matches carry per-request params and are never cached here.
  if (isProduction && Object.keys(match.params).length === 0) {
    if (productionDispatchCache.size >= PRODUCTION_DISPATCH_CAP) {
      productionDispatchCache.clear();
    }
    productionDispatchCache.set(url.pathname, { api, basePath });
  }

  // The URL is already parsed above; hand it to the router so its Context
  // does not parse `req.url` a second time.
  const res = await api.handle(req, match.params, basePath, { url });
  return withSecurityHeaders(res, isHttps);
}

function describeExport(value: unknown): string {
  if (value === undefined) return "undefined (no default export)";
  if (value === null) return "null";
  if (typeof value === "function") {
    return `a function/class (${value.name || "anonymous"}) — did you forget to call createAPI()?`;
  }
  if (typeof value === "object") {
    return `an object with keys [${Object.keys(value as object).join(", ")}]`;
  }
  return typeof value;
}
