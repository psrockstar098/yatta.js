// yatta/backend/_router.ts
//
// Maps request paths to the files in this folder, Next.js style:
//   yatta/backend/index.ts        -> GET /
//   yatta/backend/user/index.ts   -> /user
//   yatta/backend/posts/[id].ts   -> /posts/:id
//
// You rarely need to edit this — add a file and it is picked up.

import path from "node:path";
import { API, throttledReload } from "yatta.js/api";

const fileRouter = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: import.meta.dir,
});

/**
 * Pulls the API instance out of a route module.
 * Supports `export default api`, `export const api`, and CJS interop.
 */
function resolveApi(module: Record<string, unknown>): any {
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

export async function routers(req: Request, server: any): Promise<Response> {
  if (process.env.NODE_ENV !== "production") throttledReload(fileRouter);

  let match = fileRouter.match(req);
  let basePath: string | undefined;

  // Try the trailing-slash variant.
  if (!match) {
    const url = new URL(req.url);
    const alt = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = fileRouter.match(alt);
  }

  // Walk up to a parent directory, e.g. /user/profile -> /user.
  if (!match) {
    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    while (segments.length > 0) {
      const parentPath = "/" + segments.join("/");
      const candidate = fileRouter.match(parentPath);
      if (candidate) {
        match = candidate;
        basePath = parentPath;
        break;
      }
      segments.pop();
    }
  }

  if (!match) return new Response("Not Found", { status: 404 });

  let module: Record<string, unknown>;
  try {
    module = await import(match.filePath);
  } catch (err) {
    console.error(`Failed to load route ${match.filePath}:`, err);
    return new Response("Internal Server Error", { status: 500 });
  }

  const api = resolveApi(module);
  if (!api) {
    console.error(
      `Route "${match.filePath}" must export an API instance:` +
        `\n\n  import { API, createAPI } from "yatta.js/api";\n` +
        `  const api = createAPI();\n` +
        `  api.get(async () => API.json({ ok: true }));\n` +
        `  export default api;\n`,
    );
    return new Response("Route handler not found", { status: 500 });
  }

  const res = await api.handle(req, match.params, basePath);

  // Standard hardening headers.
  const isHttps =
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isHttps) {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return res;
}
