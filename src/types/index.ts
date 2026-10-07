// Yatta API — single entry point for the backend API surface.
//
// This consolidates the previously separate exports:
//   yatta/api, yatta/universal, yatta/client, yatta/rpc, yatta/path, yatta/batcher
//
// One import gives you the router, the universal route definitions, the typed
// client, and the utilities. No more guessing which package has what.

// ── Universal API (primary) ──────────────────────────────────────────────
// The high-level API: define routes once, call directly or over HTTP.
export {
  createApp,
  defineRoute,
  invoke,
  mount,
  createClient,
  withMiddleware,
  ENGINE_NAMES,
  type App,
  type Route,
  type RouteTable,
  type RouteSpec,
  type ServiceMap,
  type Services,
  type Middleware,
  type Input,
  type CallArgs,
  type CallResult,
  type DirectMethods,
  type WireRequest,
} from "./universal";

// ── Core router (low-level) ────────────────────────────────────────────────
// The underlying HTTP router. Most users won't need this directly.
export {
  API,
  Context,
  HttpError,
  ValidationError,
  createAPI,
  routeRequest,
  type RouteParams,
  type ExtractRouteParams,
  type Handler,
  type HandlerResult,
  type ErrorHandler,
  type CookieOptions,
  type CorsOptions,
} from "./api";

// ── Route-table RPC ─────────────────────────────────────────────────────────
// The same table served over HTTP, plus the client that reads it. Kept here rather
// than behind its own subpath: the package now has one entry for the backend API
// surface, and this is part of it.
//
// It was briefly unreachable — the module existed and was tested, but no `exports`
// entry and no barrel re-export pointed at it, so nothing outside the test file could
// import it. `manifest.test.ts` now fails if that happens to any module again.
export {
  serverRoute,
  serve,
  clientFor,
  fail,
  route,
  type ServerRoute,
  type ServerInput,
  type PathParamsOf,
  type ServeOptions,
  type ClientFor,
} from "./rpc";

// ── Path utilities ─────────────────────────────────────────────────────────
export {
  parseTemplate,
  buildPathFrom,
  matchesPath,
  extractParams,
  bySpecificity,
} from "./path";

// ── Batching ───────────────────────────────────────────────────────────────
export {
  DataLoader,
  batchBy,
  withLoaders,
  loaderFor,
} from "./batcher";
