// src/func/standalone_routes.ts — the file router for compiled binaries.
//
// A scaffolded app routes requests with a `Bun.FileSystemRouter` over
// `yatta/backend/`. That works under `bun run`, but a compiled binary
// has no backend directory on disk: every module is bundled into one
// file, so `import.meta.dir` is `/$bunfs/root` and the router throws
// "Unable to find directory" at startup — the binary dies before it
// serves anything.
//
// `yatta build --standalone` therefore bakes the route table into the
// binary (see build_standalone.ts): it lists the backend routes with
// Bun's own FileSystemRouter, imports each route file so it is bundled
// as code, and sets the table on `globalThis` as
// `__yattaStandaloneRoutes`. The router built here matches against
// that table instead of scanning a directory. Nothing is read from
// `$bunfs` at runtime — an embedded `.ts` file loads untranspiled
// there, so it could not be imported by path anyway.
//
// The table is set by the generated entry after its imports evaluate,
// so it must be read lazily (on the first request), never at module
// top level — `createFileRouter` reads it when called, and the
// callers cache the router per module.

/** One file-based route, as the build bakes it into the binary. */
export interface StandaloneRoute {
  /** Next.js-style pattern, e.g. "/" or "/posts/[id]". */
  pattern: string;
  /** Route file, relative to the project root (never absolute). */
  file: string;
  /** The already-bundled module namespace. */
  module: unknown;
}

/** What `match()` returns: the Bun shape, plus the bundled module. */
export interface StandaloneRouteMatch {
  filePath: string;
  params: Record<string, string>;
  kind: string;
  name: string;
  module?: unknown;
}

/** The surface the dispatchers use: `match` and `reload`, nothing else. */
export interface FileRouterLike {
  match(req: Request | string): StandaloneRouteMatch | null;
  reload(): void;
}

/** The route table the standalone build baked in, or null under `bun run`. */
export function standaloneRoutes(): StandaloneRoute[] | null {
  const routes = (globalThis as unknown as Record<string, unknown>).__yattaStandaloneRoutes;
  return Array.isArray(routes) ? (routes as StandaloneRoute[]) : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Matches a pathname against one Next.js-style pattern, or null. */
function matchStandalonePattern(
  pattern: string,
  pathSegs: string[],
): Record<string, string> | null {
  const patternSegs = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  let j = 0;
  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i]!;
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      // Catch-all: takes the rest of the path (at least one segment).
      if (j >= pathSegs.length) return null;
      params[seg.slice(4, -1)] = pathSegs.slice(j).map(decodeSegment).join("/");
      return params;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      if (j >= pathSegs.length) return null;
      params[seg.slice(1, -1)] = decodeSegment(pathSegs[j]!);
      j++;
      continue;
    }
    if (pathSegs[j] !== seg) return null;
    j++;
  }
  return j === pathSegs.length ? params : null;
}

/**
 * The file router for a compiled binary: matches against the route
 * table the build baked in. Exact routes win; among dynamic routes
 * the one with the fewest parameters wins, then the longest pattern.
 */
function manifestRouter(routes: StandaloneRoute[]): FileRouterLike {
  return {
    match(req: Request | string): StandaloneRouteMatch | null {
      const raw = typeof req === "string" ? req : new URL(req.url).pathname;
      let pathname: string;
      try {
        pathname = decodeURIComponent(raw);
      } catch {
        pathname = raw;
      }
      const clean = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
      for (const route of routes) {
        if (route.pattern === clean) {
          return {
            filePath: route.file,
            params: {},
            kind: "exact",
            name: route.pattern,
            module: route.module,
          };
        }
      }
      const pathSegs = clean.split("/").filter(Boolean);
      let best: {
        route: StandaloneRoute;
        params: Record<string, string>;
        score: [number, number];
      } | null = null;
      for (const route of routes) {
        const params = matchStandalonePattern(route.pattern, pathSegs);
        if (params === null) continue;
        const dyn = (route.pattern.match(/\[/g) || []).length;
        const score: [number, number] = [dyn, -route.pattern.split("/").length];
        if (
          best === null ||
          score[0] < best.score[0] ||
          (score[0] === best.score[0] && score[1] < best.score[1])
        ) {
          best = { route, params, score };
        }
      }
      if (best === null) return null;
      return {
        filePath: best.route.file,
        params: best.params,
        kind: "dynamic",
        name: best.route.pattern,
        module: best.route.module,
      };
    },
    reload(): void {
      // The table is fixed at build time; there is nothing to rescan.
    },
  };
}

/** A router that never matches: file routes do not exist in this binary. */
function emptyRouter(): FileRouterLike {
  return {
    match(): null {
      return null;
    },
    reload(): void {},
  };
}

/**
 * The file router for a backend directory: the baked-in table when
 * the binary has one, the filesystem router under `bun run`, and a
 * never-matching router when a binary was built without a backend
 * directory (there are no file routes to serve, so requests 404
 * instead of crashing on a directory that does not exist).
 *
 * Read lazily by the callers — the table is set after the entry's
 * imports evaluate, so calling this at module top level would always
 * miss it.
 */
export function createFileRouter(backendDir: string): FileRouterLike {
  const routes = standaloneRoutes();
  if (routes !== null) return manifestRouter(routes);
  if (typeof import.meta.dir === "string" && import.meta.dir.startsWith("/$bunfs")) {
    return emptyRouter();
  }
  return new Bun.FileSystemRouter({
    style: "nextjs",
    dir: backendDir,
  }) as unknown as FileRouterLike;
}

/**
 * Loads the module behind a match: the bundled module in a compiled
 * binary, the matched file on disk under `bun run`.
 */
export async function loadRouteModule(
  match: StandaloneRouteMatch,
): Promise<Record<string, unknown>> {
  if (match.module !== undefined) return match.module as Record<string, unknown>;
  return (await import(match.filePath)) as Record<string, unknown>;
}
