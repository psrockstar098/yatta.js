// Yatta API — the single entry point for the HTTP surface.
//
// One import gives you the router, the request context, and the error types:
//
//   import { createAPI, API, Context, HttpError } from "yatta.js/api";
//
// This used to also re-export a second, parallel routing layer — `defineRoute`,
// `createApp`, `invoke`, `mount`, `createClient`, plus the RPC, path-parser,
// batching and standard-schema modules that served it. Two routers over one codebase
// is two things to learn and two places for a signature to drift, and the second one
// had no users outside its own tests.
//
// The router is self-contained: `src/types/api.ts` imports nothing but `node:path`.
// If you are looking for path matching, validation or response coercion, it is all in
// there.

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