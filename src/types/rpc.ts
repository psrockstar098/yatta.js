// Serving a route table.
//
// The other half of the client: given the same table the client is built from,
// register every route on an API router. One definition then produces the server
// routes *and* the client methods, from the same objects — so a renamed path or a
// changed schema cannot be half-applied.

import {
  createAPI,
  API as ResponseHelpers,
  HttpError,
  type API as Router,
  type Context,
  type HandlerResult,
} from "./api";
import {
  buildPath,
  createClient,
  route,
  defineRoutes,
  isStandardSchema as isStandardSchemaExport,
  type Client,
  type ClientOptions,
  type MethodFor,
  type RouteDef,
  type HttpMethod,
} from "./client";
import {
  isStandardSchema,
  validateOrThrow,
  type Infer,
  type StandardSchemaV1,
} from "./standard-schema";

export { buildPath };

/**
 * A route as the server sees it: the definition plus the handler.
 *
 * `handler` is typed against the route's own validators, so a handler cannot read
 * a body field the schema does not declare — the error appears where it is made
 * rather than at runtime.
 */
export interface ServerRoute<D extends RouteDef> extends RouteDef {
  readonly handler: (
    input: ServerInput<D>,
    ctx: Context<never>,
  ) => HandlerResult | Promise<HandlerResult>;
}

/** Everything a handler is given: validated params, query and body. */
export type ServerInput<D extends RouteDef> = {
  params: D extends { params: infer P }
    ? unknown extends P
      ? Record<string, string>
      : Infer<P>
    : D extends { path: infer Path extends string }
      ? PathParamsOf<Path>
      : Record<string, string>;
  query: D extends { query: infer Q }
    ? unknown extends Q
      ? Record<string, unknown>
      : Infer<Q>
    : Record<string, unknown>;
  body: D extends { body: infer B }
    ? unknown extends B
      ? unknown
      : Infer<B>
    : undefined;
  ctx: Context<never>;
};

/** Path parameters, as plain strings. */
export type PathParamsOf<Path extends string> = Path extends `${infer _}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof PathParamsOf<`/${Rest}`>]: string }
  : Path extends `${infer _}:${infer Param}`
    ? { [K in Param]: string }
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {};

/**
 * Builds a typed client for a served route table.
 *
 * The companion to {@link serve}: same table, other side of the wire. Prefer this
 * over calling `createClient` on a table of served routes, because the returned
 * type is the one whose schemas actually resolve.
 *
 * @example
 * ```ts
 * const api = clientFor(routes, { baseUrl: "/api" });
 * const user = await api.getUser({ params: { id: "42" } });
 * ```
 */
export function clientFor<const R extends Record<string, RouteDef>>(
  routes: R,
  options: ClientOptions = {},
): ClientFor<R> {
  // The cast is confined to this one line. `ClientFor` resolves each route to its
  // bare definition so the schemas stay concrete; `createClient` sees the served
  // routes, whose extra `handler` property leaves the mapped type deferred and
  // every signature unresolved.
  return createClient(routes as never, options) as ClientFor<R>;
}

/** Declares a route with its handler. */
export function serverRoute<const D extends RouteDef>(
  definition: D,
  handler: ServerRoute<D>["handler"],
): ServerRoute<D> {
  return { ...definition, handler };
}

export interface ServeOptions {
  /** Prefix every path is mounted under, e.g. "/api". */
  prefix?: string;
  /**
   * Validate a handler's return value against the route's `response` schema.
   *
   * Off by default because it costs a validation per request. Worth turning on in
   * development: it is the only thing that catches a handler drifting from the
   * shape its clients are typed against.
   */
  validateResponses?: boolean;
  /**
   * Handlers, keyed by route name.
   *
   * Kept separate from the route table on purpose. A table with handlers attached
   * cannot be imported by a browser without dragging the server code — `db`, the
   * auth module, whatever — into the client bundle. Split this way, the contract
   * file holds only paths and schemas, both sides import it, and the handlers
   * stay on the server.
   *
   * A route may instead carry its own handler; one attached inline wins over one
   * given here.
   */
  handlers?: Record<string, (input: any, ctx: Context<never>) => HandlerResult | Promise<HandlerResult>>;
  /** Extra middleware, run before every route. */
  middleware?: Array<(ctx: Context<never>, next: () => Promise<Response>) => Promise<Response>>;
  cors?: Parameters<Router["cors"]>[0];
  /** Rate limiting applied to every route. */
  rateLimit?: { max: number; windowMs: number; key?: (ctx: Context<never>) => string };
}

/**
 * Builds a router that serves a route table.
 *
 * @example
 * ```ts
 * const routes = {
 *   getUser: serverRoute(
 *     { method: "get", path: "/users/:id", params: UserId, response: User },
 *     async ({ params }) => db.users.findById(params.id),
 *   ),
 * };
 *
 * const api = serve(routes, { prefix: "/api" });
 * const client = createClient(routes, { baseUrl });
 * ```
 */
export function serve<const R extends Record<string, RouteDef>>(
  routes: R,
  options: ServeOptions = {},
): Router {
  const api = createAPI(options.prefix ?? "");

  if (options.cors) api.cors(options.cors);

  for (const middleware of options.middleware ?? []) {
    api.use(middleware as never);
  }

  for (const [name, definition] of Object.entries(routes) as Array<
    [string, RouteDef]
  >) {
    const inline = (definition as ServerRoute<RouteDef>).handler;
    const fromMap = options.handlers?.[name];

    const handlerFn = inline ?? fromMap;

    if (!handlerFn) {
      throw new Error(
        `serve(): route "${name}" has no handler. Pass one inline with serverRoute(), or in the handlers option.`,
      );
    }

    const handler = makeHandler(
      name,
      { ...definition, handler: handlerFn } as ServerRoute<RouteDef>,
      options.validateResponses ?? false,
    );

    // Registered through the method-named helpers, which is how a route is
    // normally added; `definition.method` decides which one.
    const method = definition.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    (api[method] as (path: string, h: unknown) => Router)(definition.path, handler);
  }

  return api;
}

/**
 * Wraps one route's handler with validation.
 *
 * The query is validated here too. `ctx.query()` is only a string map — the
 * router parses nothing — so a schema on `query` that nobody applied is a schema
 * that silently does nothing, and the handler receives raw strings where it was
 * typed as receiving numbers.
 *
 * The body is validated always, and the response when asked.
 */
function makeHandler(name: string, route: RouteDef, validateResponse: boolean) {
  return async (ctx: Context<never>): Promise<Response> => {
    const rawQuery = normaliseQuery(ctx.queryAll());

    const query =
      route.query !== undefined && isStandardSchema(route.query)
        ? await validateOrThrow(route.query, rawQuery, "query")
        : rawQuery;

    const body =
      route.body !== undefined && isStandardSchema(route.body)
        ? await validateOrThrow(route.body, await readBody(ctx.req), "body")
        : undefined;

    const result = await (route as ServerRoute<RouteDef>).handler(
      {
        params: (ctx.params ?? {}) as never,
        query: query as never,
        body,
        ctx,
      } as never,
      ctx,
    );

    const response = coerce(result);

    if (validateResponse && route.response !== undefined) {
      const text = await response.clone().text();
      const parsed = text === "" ? undefined : safeParse(text);
      try {
        // Naming the field, so a drifting handler is caught here rather than as
        // undefined in a browser.
        await validateOrThrow(route.response, parsed, `response.${name}`);
      } catch (err) {
        // Re-thrown as an HttpError so the message survives the router's error
        // handling. A bare Error is reduced to a generic 500 and the one piece of
        // information that matters — which field drifted — is lost.
        throw new HttpError(
          500,
          `Handler for "${name}" returned a value that does not match its response schema — ${(err as Error).message}`,
        );
      }
    }

    return response;
  };
}

/**
 * Reads a request body for validation.
 *
 * Text first, then parsed: a JSON body sent with the wrong content-type is still
 * JSON, and rejecting it on the header alone would fail on a request that is
 * perfectly valid.
 */
async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text === "") return undefined;
  return safeParse(text);
}

/**
 * Collapses the repeated-key query representation into arrays where a key really
 * did repeat, and into a scalar where it did not.
 *
 * The router stores every query parameter as an array, so `?limit=10` would reach
 * a schema as `{ limit: ["10"] }` and fail a `{ limit: number }` schema. Split on
 * cardinality rather than guessing from the shape.
 */
function normaliseQuery(raw: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, values] of Object.entries(raw ?? {})) {
    out[key] = values.length === 1 ? values[0] : values;
  }

  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Turns a handler's return value into a Response, as the router would. */
function coerce(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return ResponseHelpers.json(null);

  if (typeof result === "string") return ResponseHelpers.text(result);
  if (typeof result === "number" || typeof result === "boolean") {
    return ResponseHelpers.json(result);
  }

  return ResponseHelpers.json(result as Record<string, unknown>);
}

/** Throws a `HttpError` with a readable message, for use inside a handler. */
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

// ── Types the caller uses ───────────────────────────────────────────────────

/**
 * The client type for a served route table.
 *
 * Takes the same table, so a handler and its client method are two views of one
 * definition rather than two things written twice.
 *
 * Takes the same shape of table as {@link serve}: routes with or without inline
 * handlers. Neither side is widened to `RouteDef` first — doing that made every
 * validator `StandardSchemaV1<any> | undefined`, so `Infer` gave `unknown`, every
 * request body became `unknown` and every response became `any`. The client then
 * accepted any argument and claimed to know nothing, while looking fully typed.
 * A route with an inline handler is unwrapped to its bare definition, and one
 * without is passed through untouched. Both branches are needed: passing a served
 * route through unresolved left every method signature deferred, and unwrapping
 * with a `: RouteDef` fallback widened the schemas away.
 */
export type ClientFor<R extends Record<string, RouteDef>> = Client<{
  [K in keyof R]: R[K] extends ServerRoute<infer D> ? D : R[K];
}>;

/** Re-exported so a route file imports everything it needs from one place. */
export type {
  Client,
  RouteDef,
  HttpMethod,
  Infer,
  StandardSchemaV1,
  Context,
  HandlerResult,
};
export { createClient, route, defineRoutes };
export type { MethodFor };