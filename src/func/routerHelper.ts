import type { Server } from "bun";
import path from "node:path";
import { API } from "../types/api";
import { realtime } from "./realtime";
import { storage } from "./storage";

// Always resolve relative to this file to guarantee correct path regardless of current working directory
const backendDir = path.resolve(import.meta.dir, "../backend");

export const router = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: backendDir,
});

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
 */
function securityHeaders(isHttps: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "0",
  };

  if (isHttps) {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  }

  return headers;
}

/** Returns a copy of `res` with the standard hardening headers applied. */
function withSecurityHeaders(res: Response, isHttps: boolean): Response {
  for (const [key, value] of Object.entries(securityHeaders(isHttps))) {
    res.headers.set(key, value);
  }
  return res;
}

export default async function routers(
  req: Request,
  server: Server<unknown>,
): Promise<Response> {
  const url = new URL(req.url);
  const isHttps =
    url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

  // 1. Realtime endpoint (handles WebSockets or SSE automatically)
  if (url.pathname === "/realtime") {
    const res = await realtime.connect(req, server);
    if (res instanceof Response) return withSecurityHeaders(res, isHttps);
    return undefined as any; // WebSocket upgrade handled by Bun
  }

  // 2. Storage explorer UI, download links, and file streaming
  if (url.pathname.startsWith("/storage")) {
    const res = await storage.handleRequest(req, "/storage");
    return withSecurityHeaders(res, isHttps);
  }

  // 3. Hot-reload routes in development mode so new files (e.g. user/index.ts) are instantly detected
  if (process.env.NODE_ENV !== "production") {
    router.reload();
  }

  // 4. Match Next.js style file-based API routes
  let match = router.match(req);

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
    return withSecurityHeaders(new Response("Not Found", { status: 404 }), isHttps);
  }

  let module: Record<string, unknown>;
  try {
    module = await import(match.filePath);
  } catch (err) {
    console.error(`Failed to load route module ${match.filePath}:`, err);
    return withSecurityHeaders(
      new Response("Internal Server Error", { status: 500 }),
      isHttps,
    );
  }

  const api = resolveApi(module);

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

  const res = await api.handle(req, match.params, basePath);
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
