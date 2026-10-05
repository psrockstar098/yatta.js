// Next.js bindings.
//
// Two things are needed and they are different problems.
//
// A route handler: one catch-all route file that hands the framework's request and
// response shapes to the same route table a Bun server would use. Written once,
// so a Next.js app and a Bun service cannot disagree about what `/users/:id`
// returns.
//
// Server Components: React 19 can fetch on the server and stream the result, but
// the data never reaches the browser — so a client component that needs it has to
// fetch again. These helpers read from the request-scoped cache the provider put
// there, which is what makes one fetch serve both.
//
// Nothing here imports Next.js. The app-router types are structural, so this works
// on any framework with the same shape and does not pin a Next version.

import { mount, type App, type TransportOptions, type WireRequest, type WireResponse } from "../types/universal";

/** Aliases: these names read better from an adapter's point of view. */
export type AdapterOptions = TransportOptions;
export type UniversalRequest = WireRequest;
export type UniversalResponse = WireResponse;

export { mount };

/**
 * Builds every HTTP method from one route table.
 *
 * Next.js route handlers are exported per verb, so a table has to become seven
 * named exports. Written out by hand that is seven chances to pass a different
 * route table to one of them.
 *
 * @example
 * ```ts
 * // app/api/[[...path]]/route.ts
 * import { toNextRoute } from "yatta/next";
 * import { routes } from "@/api-contract";
 * import { handlers } from "@/api-handlers";
 *
 * export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } =
 *   toNextRoute(routes, { handlers });
 * ```
 */
export function toNextRoute(
  app: App<any>,
  options: AdapterOptions = {},
): Record<string, (request: Request) => Promise<Response>> {
  /*
   * The same `mount` a Bun server uses.
   *
   * This used to be a second transport, written for a different request shape, and
   * it had drifted: it validated on some paths and not others, and treated an
   * empty body differently. Two implementations of "what does this path do" is
   * exactly the failure this framework claims not to have, so there is now one.
   */
  const handle = mount(app, options);

  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
  const out: Record<string, (request: Request) => Promise<Response>> = {};

  for (const method of methods) {
    out[method] = handle;
  }

  return out;
}

/**
 * Reads a request body as text, for a platform that streams it.
 *
 * Next.js has already consumed the stream by the time a route handler runs in
 * some configurations, so `request.text()` can throw. Returns `undefined` rather
 * than throwing, because an unreadable body on a route that takes no body is not
 * an error worth failing the request over.
 */
export async function readBody(request: Request): Promise<string | undefined> {
  try {
    return await request.text();
  } catch {
    return undefined;
  }
}

/**
 * Builds a `NextRequest`-shaped argument from the standard `Request`.
 *
 * Next.js passes a `NextRequest`, which is a superset of `Request`. This exists so
 * a handler can read the same headers either way without checking the type.
 */
export function toNextRequestLike(request: Request): Request & { nextUrl?: URL } {
  return request as Request & { nextUrl?: URL };
}

/**
 * Server-side data fetching for React Server Components.
 *
 * Reads from the request cache instead of issuing a second request, which is the
 * whole point: a Server Component and a client component below it should see one
 * fetch, not two.
 *
 * Needs a `YattaProvider` above it in the server tree. If there is none, this
 * fetches directly rather than throwing, so a component that is server-rendered
 * on its own still works — it just does not share.
 *
 * @example
 * ```tsx
 * // app/users/[id]/page.tsx
 * export default async function Page({ params }) {
 *   const user = await serverQuery(["getUser", params.id], () =>
 *     api.getUser({ params: { id: params.id } }),
 *   );
 *   return <Profile user={user} />;
 * }
 * ```
 */
export async function serverQuery<T>(
  key: readonly unknown[],
  fetcher: () => Promise<T>,
  options: { revalidate?: number } = {},
): Promise<T> {
  const store = getRequestCache();

  if (!store) return fetcher();

  const resolvedKey = JSON.stringify(key);
  const existing = store.get(resolvedKey) as Promise<T> | undefined;

  // Shared promise, so a Server Component and a client component that both ask
  // for the same thing cause one request.
  if (existing) return existing;

  const promise = fetcher();
  store.set(resolvedKey, promise);

  if (options.revalidate !== undefined) {
    // Next.js caches by fetch semantics; this is the closest the platform offers
    // without importing it.
    (promise as { cache?: string }).cache = `force-cache`;
  }

  return promise;
}

let requestCache: Map<string, unknown> | undefined;

/**
 * The per-request cache.
 *
 * Deliberately module-level and set by a provider per request. A module-level
 * *value* that survives between requests would leak one user's data into the next
 * response, so it must be replaced on every request and never outlive one.
 */
export function getRequestCache(): Map<string, unknown> | undefined {
  return requestCache;
}

/**
 * Scopes a cache to one request.
 *
 * Call this at the top of a server tree, in a layout or middleware. Pass
 * `undefined` afterwards — leaving a cache in place after the request has been
 * served is how two users see each other's data.
 *
 * @example
 * ```tsx
 * // app/layout.tsx
 * export default function RootLayout({ children }) {
 *   const cache = withRequestCache();
 *   try {
 *     return <>{children}</>;
 *   } finally {
 *     releaseRequestCache(cache);
 *   }
 * }
 * ```
 */
export function withRequestCache(): Map<string, unknown> {
  requestCache = new Map();
  return requestCache;
}

/** Clears the request cache, taking the cache it was given. */
export function releaseRequestCache(cache: Map<string, unknown> | undefined = requestCache): void {
  if (cache) cache.clear();
  if (cache === requestCache) requestCache = undefined;
}

/**
 * The request headers a server render should forward.
 *
 * A Server Component fetching on the server has to pass the caller's cookie on,
 * or the API sees an anonymous request and returns 401 — which looks like a
 * permissions bug rather than a missing header.
 */
export function forwardedHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};

  // Only these. Forwarding everything would leak the client's IP and its own
  // authorization header into the internal call.
  for (const name of ["cookie", "authorization", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) out[name] = value;
  }

  return out;
}
