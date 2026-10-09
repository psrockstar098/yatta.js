// yatta/func/routerHelper.ts
//
// Dispatches requests to yatta/backend/** using Bun's file router,
// Next.js style:
//
//   yatta/backend/index.ts        -> GET /
//   yatta/backend/user/index.ts   -> /user
//   yatta/backend/posts/[id].ts   -> /posts/:id
//
// You rarely need to edit this.
import type { Server } from "bun";
import path from "node:path";
import { API, throttledReload } from "yatta.js/api";
import { realtime } from "./realtime";
import { storage } from "./storage";

// Resolved from this file, so it works regardless of cwd.
const backendDir = path.resolve(import.meta.dir, "../backend");

export const router = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: backendDir,
});

/** Pulls the API instance out of a route module (handles default/api/CJS). */
function resolveApi(module: Record<string, unknown>): API | undefined {
  const candidate: any = module.default ?? module.api ?? module;
  if (!candidate) return undefined;
  if (candidate instanceof API) return candidate;
  if (candidate.default instanceof API) return candidate.default;
  if (typeof candidate.handle === "function") return candidate;
  if (candidate.default && typeof candidate.default.handle === "function") {
    return candidate.default;
  }
  return undefined;
}

export default async function routers(
  req: Request,
  server: Server<unknown>,
): Promise<Response> {
  const url = new URL(req.url);
  const isHttps =
    url.protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";

  // 1. Realtime: WebSocket upgrade or SSE, detected automatically.
  if (url.pathname === "/realtime") {
    const res = await realtime.connect(req, server);
    if (res instanceof Response) return applyHeaders(res, isHttps);
    return undefined as any; // upgrade handled by Bun
  }

  // 2. Storage explorer, downloads, and RFC 9110 file streaming.
  if (url.pathname.startsWith("/storage")) {
    const res = await storage.handleRequest(req, "/storage");
    return applyHeaders(res, isHttps);
  }

  // 3. Pick up new route files without a restart during development.
  //
  // A *new* file is picked up; an *edited* one is not, because import() caches the
  // module. Use "bun run dev" (bun --watch) for edits — the two are not
  // interchangeable, and the distinction is not otherwise visible.
  if (process.env.NODE_ENV !== "production") throttledReload(router);

  // 4. Match the route.
  let match = router.match(req);
  let basePath: string | undefined;

  if (!match) {
    const alt = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = router.match(alt);
  }

  if (!match) {
    const segments = url.pathname.split("/").filter(Boolean);
    while (segments.length > 0) {
      const parentPath = "/" + segments.join("/");
      const candidate = router.match(parentPath);
      if (candidate) {
        match = candidate;
        basePath = parentPath;
        break;
      }
      segments.pop();
    }
  }

  if (!match) return applyHeaders(new Response("Not Found", { status: 404 }), isHttps);

  let module: Record<string, unknown>;
  try {
    module = await import(match.filePath);
  } catch (err) {
    console.error(`Failed to load route module ${match.filePath}:`, err);
    return applyHeaders(new Response("Internal Server Error", { status: 500 }), isHttps);
  }

  const api = resolveApi(module);
  if (!api) {
    console.error(
      `Route "${match.filePath}" must export an API instance:\n\n` +
        `  import { API, createAPI } from "yatta.js/api";\n` +
        `  const api = createAPI();\n` +
        `  api.get(async () => API.json({ ok: true }));\n` +
        `  export default api;\n`,
    );
    return applyHeaders(new Response("Route handler not found", { status: 500 }), isHttps);
  }

  const res = await api.handle(req, match.params, basePath);
  return applyHeaders(res, isHttps);
}

/** Standard hardening headers. HSTS only over real HTTPS. */
function applyHeaders(res: Response, isHttps: boolean): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isHttps) {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return res;
}
