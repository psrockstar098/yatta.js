// Universal routes: one function, used two ways.
//
// The usual split is a backend that defines behaviour and a frontend that calls
// it over HTTP, with a hand-written client and a copy of every type in between.
// That copy is the problem. It goes stale quietly, and nothing in the build fails
// when it does.
//
// This removes the copy by making a route a plain function and then choosing how
// to reach it:
//
//   invoke(api, "getUser", { params: { id } })   — calls the function. No HTTP.
//   client(api).getUser({ params: { id } })      — reaches it over HTTP.
//
// Both are the same function object. There is no second definition, no generated
// file, and no type to keep in step, because there is only one place a type is
// written down.
//
// Why the direct call matters: a React Server Component runs on your server, in
// your process, with your database connection. Going out to HTTP and back to
// reach a function in the same process costs a serialization round trip, a
// connection, and a failure mode — for no isolation whatsoever, because the
// caller is not outside your trust boundary. So it does not do that. It calls the
// function.
//
// The browser genuinely is outside, so it goes over HTTP, with the same types.

import { HttpError, type Context, type HandlerResult } from "./api";
import { buildPath, toQueryString, type HttpMethod, type RouteDef } from "./client";
import {
  bySpecificity,
  extractParams as extractPathParams,
  matchesPath as pathMatches,
  parseTemplate,
  readQuery,
  stripBase,
  type ParsedPath,
} from "./path";
import {
  isStandardSchema,
  validateOrThrow,
  type Infer,
  type StandardSchemaV1,
} from "./standard-schema";

// ── Services ───────────────────────────────────────────────────────────────

/**
 * The framework objects a handler can use.
 *
 * Injected rather than imported, so a handler can be called directly, over HTTP,
 * or in a test with a stand-in. An open map by default, because which engines an
 * app uses is its own business.
 */
export interface ServiceMap {
  db?: unknown;
  auth?: unknown;
  realtime?: unknown;
  cache?: unknown;
  jobs?: unknown;
  mail?: unknown;
  storage?: unknown;
  observer?: unknown;
  [name: string]: unknown;
}

/** Services with the engines an app actually has, so handlers get real types. */
export interface Services {
  db: unknown;
  auth: unknown;
  realtime: unknown;
  cache: unknown;
  jobs: unknown;
  mail: unknown;
  storage: unknown;
  observer: unknown;
}

/**
 * A default service set.
 *
 * Reads the framework's singletons lazily. A getter rather than a value, so
 * importing a route file does not start a database connection or a socket — the
 * failure mode being that reading a route table on the server to mount it would
 * spin up everything the app owns.
 */
export function defaultServices(): ServiceMap {
  /*
   * No `require`, and no static import of the engines either.
   *
   * This module is bundled into the browser, because `createClient(app)` needs it.
   * `require` is not defined in an ESM bundle, so it threw a ReferenceError the
   * moment a browser called anything here; a static import would work but would
   * pull every engine's code into the client bundle, which is worse — the whole
   * point of a browser client is not shipping the server.
   *
   * So the engines are neither. A service is whatever the app passed to
   * `createApp`, and a handler that reaches for one the app did not supply gets a
   * clear error naming it, rather than a silent undefined or a bundler crash.
   */
  const missing = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(
            `services.${name} was used but not supplied. Pass it to createApp: ` +
              `createApp(routes, { services: { ${name} } }).`,
          );
        },
        apply: () => {
          throw new Error(`services.${name} was called but not supplied.`);
        },
      },
    ) as never;

  const services: ServiceMap = {};

  for (const name of ENGINE_NAMES) {
    Object.defineProperty(services, name, {
      // A getter so the error is raised on use, not on construction. Reading
      // `services.db` in a handler that never touches it must not throw.
      get: () => missing(name),
      enumerable: true,
      configurable: true,
    });
  }

  return services;
}

/** The engines a service may be named after. */
export const ENGINE_NAMES = [
  "db",
  "auth",
  "realtime",
  "cache",
  "jobs",
  "mail",
  "storage",
  "observer",
] as const;

// ── Route definitions ──────────────────────────────────────────────────────

/** The shape a route declares: method, path, and validators. */
export type RouteSpec = RouteDef;

/** Path parameters as plain strings, read from the path template. */
export type PathParams<Path extends string> = Path extends `${infer _H}:${infer P}/${infer R}`
  ? { [K in StripOptional<P> | keyof PathParams<`/${R}`>]: string } &
      Partial<Record<StripOptional<P>, string>>
  : Path extends `${infer _H}:${infer P}`
    ? PathParamsOne<P>
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {};

/**
 * Drops the optional marker from a segment name.
 *
 * Without it, `:id?` produced a parameter named `"id?"` — a required key for a
 * segment that may be absent, which cannot be indexed sensibly and tells the
 * handler nothing true.
 */
type StripOptional<Segment extends string> = Segment extends `${infer Name}?` ? Name : Segment;

type PathParamsOne<Segment extends string> = Segment extends `${infer Name}?`
  ? { [K in Name]?: string }
  : { [K in Segment]: string };

/** Everything a handler is given. */
export type Input<D extends RouteSpec, S extends ServiceMap> = {
  params: D extends { params: infer P }
    ? unknown extends P
      ? D extends { path: infer Path extends string }
        ? PathParams<Path>
        : Record<string, string>
      : Infer<P>
    : D extends { path: infer Path extends string }
      ? PathParams<Path>
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
  /** The request context, when there is an HTTP request behind this call. */
  ctx: Context<never>;
  /** The framework objects. Typed by the app, so `db` is the real database. */
  services: S;
};

type MaybePromise<T> = T | Promise<T>;

/**
 * A declared route: its spec, its handler, and the handler's return type kept so
 * a direct call can hand it back exactly.
 */
export interface Route<D extends RouteSpec = RouteSpec, S extends ServiceMap = ServiceMap, R = unknown> {
  readonly spec: D;
  /** Replaced once, by `createApp`, with the middleware chain around it. */
  handler: (input: Input<D, S>) => MaybePromise<R>;
  /**
   * Checks that apply to this route only.
   *
   * Run inside the app's own middleware, never instead of it, so a route-level
   * check cannot accidentally shadow a cross-cutting one.
   */
  middleware?: Middleware<S>[];
}

/**
 * Adds middleware to a route.
 *
 * Mutates and returns the route, so it reads as a modifier:
 * `withAuth(defineRoute(...))`.
 */
export function withMiddleware<S extends ServiceMap, D extends RouteSpec, R>(
  route: Route<D, S, R>,
  ...middleware: Middleware<S>[]
): Route<D, S, R> {
  const existing = route.middleware ?? [];
  route.middleware = [...existing, ...middleware];
  return route;
}

/** The value a handler returns when a response schema is declared. */
export type DeclaredOut<D extends RouteSpec> = D extends { response: infer Res }
  ? unknown extends Res
    ? unknown
    : Infer<Res>
  : unknown;

/**
 * Runs before a handler, on both paths.
 *
 * Return a value to answer instead of calling the handler — that is how an auth
 * check rejects. Return `undefined` to continue.
 *
 * The point of it being here rather than only on the transport: a check that lives
 * in HTTP middleware is *not* run by `app.getUser()` or `invoke()`. A Server
 * Component calling a route directly would sail straight past an authorisation
 * check that HTTP enforces, which is the worst possible place for that gap — the
 * code looks guarded and is not.
 */
export type Middleware<S extends ServiceMap = ServiceMap> = (
  input: { name: string; ctx: Context<never>; services: S; args: Record<string, unknown> },
) => unknown | Promise<unknown>;

/**
 * Declares one route.
 *
 * The handler returns a plain value, not a `Response`. That is the change that
 * makes a direct call meaningful: `invoke()` hands back the value itself rather
 * than something that has to be unwrapped from a transport.
 *
 * The return type is constrained to the declared response when there is one, so a
 * handler that drifts from its contract fails here rather than at the browser.
 *
 * @example
 * ```ts
 * const getUser = defineRoute(
 *   { method: "get", path: "/users/:id", params: UserId, response: User },
 *   async ({ params, services }) => {
 *     const user = await services.db.users.findById(params.id);
 *     if (!user) throw new HttpError(404, "No such user");
 *     return user;
 *   },
 * );
 * ```
 */
export function defineRoute<
  const D extends RouteSpec,
  S extends ServiceMap = ServiceMap,
  // A handler may also return a `Response` — for a stream, a file or a redirect.
  // Supported at runtime all along, but the type refused it, so the escape hatch
  // was only reachable by casting away the return type.
  R extends DeclaredOut<D> | Response = DeclaredOut<D>,
>(
  spec: D,
  handler: (input: Input<D, S>) => MaybePromise<R>,
): Route<D, S, R> {
  return { spec, handler };
}

/** A table of routes. */
export type RouteTable = Record<string, Route<RouteSpec, any, any>>;

// ── The app ─────────────────────────────────────────────────────────────────

/**
 * A set of routes plus the services they use.
 *
 * One of these per process on the server, and per request on a server render —
 * never a module-level singleton that outlives a request, which would serve one
 * user's data to the next.
 */
/**
 * One method per route, each callable directly.
 *
 * Derived from the table, so the developer writes routes and nothing else — no
 * wrapper per endpoint, no name string to keep in step, no signature to maintain.
 * The method's argument and return types come from the route itself.
 */
export type DirectMethods<R extends RouteTable> = {
  [K in keyof R & string]: (args?: CallArgs<R[K]["spec"]>) => Promise<CallResult<R[K]>>;
};

export interface App<R extends Record<string, any> = RouteTable> {
  readonly routes: R;
  /** The framework objects handlers are given. */
  readonly services: ServiceMap;
  /** The names in this app. Useful for generating a client or checking coverage. */
  readonly names: readonly (keyof R & string)[];
  /** One route by name. */
  get<K extends keyof R & string>(name: K): R[K];
}

// ── Direct invocation ──────────────────────────────────────────────────────

/** `params` when the route declares them, or when its path names any. */
type ParamsArg<D> = D extends { params: infer P }
  ? unknown extends P
    ? ParamsFromPath<D>
    : { params: Infer<P> }
  : ParamsFromPath<D>;

/** Path-derived parameters, when the route declares no validator for them. */
type ParamsFromPath<D> = D extends { path: infer Path extends string }
  ? [keyof PathParams<Path>] extends [never]
    ? {}
    : { params: PathParams<Path> }
  : {};

/** `query` when the route declares a validator for it. */
type QueryArg<D> = D extends { query: infer Q }
  ? unknown extends Q
    ? {}
    : {} extends Infer<Q>
      ? { query?: Infer<Q> }
      : { query: Infer<Q> }
  : {};

/** `body` when the route declares a validator for it. */
type BodyArg<D> = D extends { body: infer B }
  ? unknown extends B
    ? {}
    : {} extends Infer<B>
      ? { body?: Infer<B> }
      : { body: Infer<B> }
  : {};

/**
 * Arguments for a direct call.
 *
 * What a route accepts, minus the request context: there is no HTTP request,
 * because nothing crossed a network.
 *
 * Each input is contributed only when the route declares it, so passing a body to
 * a route without one is an error rather than a field quietly dropped.
 */
export type CallArgs<D extends RouteSpec> = ParamsArg<D> &
  QueryArg<D> &
  BodyArg<D> & {
    /** A request context, for a direct call made during a request. */
    ctx?: Context<never>;
    /**
     * Cancels the call.
     *
     * Passed through to `fetch` on the HTTP path and readable from `ctx.signal` on
     * both, so a component whose arguments change mid-flight — a search box typed
     * three more characters — can abandon the two answers nobody is waiting for.
     */
    signal?: AbortSignal;
  };

/** What a direct call hands back: the handler's own return type. */
export type CallResult<T> = T extends Route<any, any, infer R> ? Awaited<R> : never;

/**
 * Calls a route as a function. No HTTP, no serialization, no connection pool.
 *
 * This is the point of the whole module. On a server the caller and the handler
 * are in the same process, so a network hop between them buys no isolation and
 * costs a round trip, a socket, and a failure mode.
 *
 * @example
 * ```ts
 * // A Server Component. The handler runs here, with your `db`.
 * const user = await invoke(app, "getUser", { params: { id } });
 *
 * // Type inferred from the handler, not from a shared interface.
 * const name: string = user.name;
 * ```
 */
export async function invoke<
  N extends string,
  D extends RouteSpec,
  S extends ServiceMap,
  R,
>(
  app: App<Record<N, Route<D, S, R>>> & { services: S },
  name: N,
  args: CallArgs<D>,
  options: { ctx?: Context<never>; services?: Partial<S> } = {},
): Promise<Awaited<R>> {
  const route = (app.routes as unknown as Record<string, Route>)[name];
  if (!route) {
    throw new Error(
      `No route named "${name}". This app has: ${Object.keys(app.routes).join(", ")}`,
    );
  }

  const passed = args as { ctx?: Context<never>; signal?: AbortSignal } | undefined;

  const input: Record<string, unknown> = {
    ...(await validateArgs(route.spec, args ?? {})),
    /*
     * The signal rides on the context as well as on its own argument, because that
     * is where a handler looks. A direct call with a signal it cannot see is the
     * same as no signal at all.
     *
     * An explicit ctx wins over the blank one. A Server Component passing the
     * request context through is how a handler reading `ctx.headers` sees the real
     * session; it used to be silently replaced by an empty context, so every header
     * lookup returned undefined rather than failing.
     */
    ctx: (passed?.ctx ?? options.ctx ?? createBlankContext(passed?.signal)) as Context<never>,
    // Per-call services override the app's, so one call can use a transaction or
    // a test double without rebuilding the app. They used to be ignored entirely,
    // which made the option a lie.
    services: { ...app.services, ...options.services } as S,
  };

  return (await route.handler(input as never)) as Awaited<R>;
}

/**
 * Runs a route's validators over a set of arguments.
 *
 * Called on both paths — direct and over HTTP — because a route that validated on
 * one and not the other would accept a value directly that it rejects in
 * production. That is the sort of difference nobody tests for and everybody
 * discovers in production.
 */
async function validateArgs(
  spec: RouteSpec,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  /*
   * `signal` is carried through untouched.
   *
   * It is a transport concern, not schema input: a params validator has no reason
   * to know about it, and a schema that rejected unknown keys would refuse a
   * perfectly legitimate call.
   */
  const passthrough: Record<string, unknown> = {};
  if (args.signal !== undefined) passthrough.signal = args.signal;

  const params =
    spec.params !== undefined && isStandardSchema(spec.params)
      ? await validate(spec.params, args.params ?? {}, "params")
      : (args.params ?? {});

  const query =
    spec.query !== undefined && isStandardSchema(spec.query)
      ? await validate(spec.query, args.query ?? {}, "query")
      : (args.query ?? {});

  const body =
    spec.body !== undefined && isStandardSchema(spec.body)
      ? await validate(spec.body, args.body, "body")
      : args.body;

  return { params, query, body, ...passthrough };
}

/**
 * Validates one part of a call.
 *
 * A `ValidationError` carries its own 400, so nothing here has to recognise one and
 * re-wrap it. That wrapping existed because the validator used to raise a plain
 * Error, which the transport could only see as an unexpected fault: a client's typo
 * came back as an opaque 500 and the message naming the field was swallowed.
 */
async function validate(
  schema: StandardSchemaV1,
  value: unknown,
  prefix: string,
): Promise<unknown> {
  return validateOrThrow(schema, value, prefix);
}

/**
 * A context for a call that has no HTTP request behind it.
 *
 * Shaped like the router's so a handler written for both does not need to know
 * which it got. Every method is absent rather than throwing: a handler that
 * genuinely needs the request should ask, and `ctx.request` being undefined is a
 * clearer answer than a thrown error.
 */
function createBlankContext(signal?: AbortSignal): Context<never> {
  return {
    signal,
    request: undefined,
    req: { method: "DIRECT", url: "direct:", headers: {} },
    params: {},
    state: {},
    query: () => ({}),
    queryAll: () => ({}),
    json: async () => undefined,
    formData: async () => new FormData(),
    cookies: () => ({}),
  } as unknown as Context<never>;
}

/**
 * Builds an app from a table of routes.
 *
 * @example
 * ```ts
 * export const app = createApp({
 *   getUser: defineRoute(
 *     { method: "get", path: "/users/:id", params: UserId, response: User },
 *     async ({ params, services }) => services.db.users.findById(params.id),
 *   ),
 * }, {
 *   // Typed, so a handler's `services.db` is your database.
 *   services: { db, auth, realtime },
 * });
 * ```
 */
export function createApp<const R extends RouteTable, S extends ServiceMap = ServiceMap>(
  routes: R,
  options: { services?: S; name?: string; middleware?: Middleware<S>[] } = {},
): App<R> & DirectMethods<R> & { readonly serviceType: S } {
  const middleware = options.middleware ?? [];
  const routeTable = routes as unknown as Record<string, Route>;

  /*
   * Middleware is bound to each route once, here.
   *
   * Bound rather than run per call, so `mount()` and `invoke()` cannot forget it.
   * The order is outermost-first for each route's own list, and the app's list runs
   * outside it — so a cross-cutting auth check cannot be bypassed by a route
   * declaring its own middleware.
   */
  for (const [name, route] of Object.entries(routeTable)) {
    const own = (route as Route & { middleware?: Middleware<any>[] }).middleware ?? [];
    const chain = [...middleware, ...own].map((fn) => ({ fn, name }));

    if (chain.length === 0) continue;

    const inner = route.handler;

    route.handler = (async (input: any) => {
      const services = input.services as S;
      const ctx = input.ctx as Context<never>;

      // Index advanced in order, so `runNext()` from anywhere resumes after the
      // middleware that called it rather than jumping back to the start.
      let index = -1;

      const runNext = async (): Promise<unknown> => {
        index++;
        const step = chain[index];
        if (!step) return inner(input);

        const answered = await step.fn({
          name,
          ctx,
          services,
          args: input as Record<string, unknown>,
        });

        // A middleware that answered *is* the answer. Skipping this is how an auth
        // check that returns a user instead of throwing still lets the handler run.
        if (answered !== undefined) return answered;

        return runNext();
      };

      return runNext();
    }) as typeof inner;
  }
  // The app's own services take precedence over the lazily-loaded defaults, so an
  // app can supply its own database without every handler having to check which
  // one it got.
  const services = { ...defaultServices(), ...(options.services ?? {}) } as S;

  const table = routes as unknown as Record<string, Route>;

  const app = {
    routes,
    names: Object.keys(routes) as (keyof R & string)[],
    services,

    get(name: string) {
      const route = table[name];
      if (!route) {
        throw new Error(
          `No route named "${name}". This app has: ${Object.keys(routes).join(", ")}`,
        );
      }
      return route;
    },
  };

  /*
   * The direct-call surface, built from the same table.
   *
   * One method per route, named after it. Nothing is declared twice: the argument
   * shape comes from the route's validators and the return shape from the
   * handler, so `app.getUser({ params: { id } })` needs no annotation and cannot
   * fall out of step with the handler.
   *
   * Bound once per route so `const { getUser } = app` works — reading a method off
   * the app and calling it unbound would lose `this`, and the resulting error is
   * `services is undefined` a long way from the cause.
   */
  const surface: Record<string, unknown> = {};

  for (const name of Object.keys(table)) {
    const call = async (args?: Record<string, unknown>) => {
      const route = table[name]!;

      // Validated here for the same reason `invoke` validates: the same value
      // must be accepted or refused whichever way the route is reached.
      const validated = await validateArgs(route.spec, args ?? {});

      return route.handler({
        params: validated.params as never,
        query: validated.query as never,
        body: validated.body,
        // The caller's ctx, when they passed one. A Server Component handing in
        // the request context gets the real session in `ctx.headers`; without this
        // it silently got an empty one.
        ctx: ((args as { ctx?: Context<never> } | undefined)?.ctx ??
          createBlankContext((args as { signal?: AbortSignal } | undefined)?.signal)) as Context<never>,
        services,
      } as never);
    };

    /*
     * Named after its route, deliberately.
     *
     * These are assigned to a computed key, so an anonymous arrow keeps `name`
     * as "". Anything that identifies a call by its function — a cache keyed on
     * the method, a devtools label, a log line — would then see every route as
     * the same one and report one route's result under another's name. Naming
     * them makes the identity real rather than positional.
     */
    Object.defineProperty(call, "name", { value: name, configurable: true });
    surface[name] = call;
  }

  return Object.assign(app, surface) as unknown as App<R> &
    DirectMethods<R> & { readonly serviceType: S };
}

// ── Transport ──────────────────────────────────────────────────────────────

/** A request, as far as the transport layer needs to know. */
export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | ReadableStream | null;
}

export interface TransportOptions {
  /** Stripped before matching, when the mount point is not in the URL. */
  basePath?: string;
  /** Validate each response against its declared schema. Costs one check. */
  validateResponses?: boolean;
  /** Called when no route matches. Defaults to a 404 JSON body. */
  onNotFound?: (req: WireRequest) => WireResponse | Promise<WireResponse>;
  /** Called with a thrown error and the response it became. */
  onError?: (error: unknown, req: WireRequest, response: WireResponse) => void;
}

/**
 * Serves an app over HTTP.
 *
 * The transport. It matches a path, validates the arguments, runs the same
 * handler `invoke` would, and turns the plain value it returns into a response.
 * Nothing about the route is re-declared here.
 *
 * @example
 * ```ts
 * Bun.serve({ fetch: mount(app) });
 * ```
 */
export function mount(app: App<any>, options: TransportOptions = {}): (request: Request) => Promise<Response> {
  const table = routesOf(app);

  /*
   * Compiled once, most specific first.
   *
   * Parsing per request would cost a split and a filter on every call for a result
   * that never changes. Ordering matters for correctness, not speed: `/users/new`
   * has to be tried before `/users/:id`, or a create endpoint quietly becomes a
   * fetch of the user whose id is the literal string "new".
   */
  const entries = Object.entries(table)
    .map(([name, route]) => ({
      name,
      method: route.spec.method.toLowerCase(),
      parsed: parseTemplate(route.spec.path),
      route,
    }))
    .sort((a, b) => bySpecificity(a.parsed, b.parsed));

  return async function handler(request: Request): Promise<Response> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const method = request.method.toUpperCase();
    const path = stripBase(new URL(request.url).pathname, options.basePath);

    const hasBody = method !== "GET" && method !== "HEAD";
    const wire: WireRequest = {
      method,
      url: request.url,
      headers,
      ...(hasBody ? { body: await request.text().catch(() => "") } : {}),
    };

    const matching = entries.filter((entry) => pathMatches(entry.parsed, path));

    const match = matching.find((entry) => entry.method === method.toLowerCase());

    if (!match) {
      // A path that exists but not for this verb is a 405. A 404 tells the
      // caller to go looking for a typo in a path that is correct.
      if (matching.length > 0) {
        return toResponse({
          status: 405,
          headers: {
            "content-type": "application/json",
            allow: [...new Set(matching.map((e) => e.method.toUpperCase()))].join(", "),
          },
          body: JSON.stringify({ error: `${method} is not allowed here` }),
        });
      }

      if (options.onNotFound) return toResponse(await options.onNotFound(wire));

      return toResponse({
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: `No route for ${method} ${path}` }),
      });
    }

    try {
      const value = await runOverHttp(app, match.name, match.route, wire, path);
      const encoded = await encode(value, match.route.spec.response, match.name, options);

      /*
       * A handler that returned a `Response` has already chosen its status and
       * headers.
       *
       * They used to be replaced with a computed status and a bare content-type,
       * so a CSV export arrived as application/json, and every `set-cookie` on the
       * way through — the session cookie on a login response, a refresh token —
       * was silently dropped. The handler said what it wanted and the transport
       * overrode it.
       */
      return toResponse(encoded);
    } catch (err) {
      const failed = errorToResponse(err);
      options.onError?.(err, wire, failed);
      return toResponse(failed);
    }
  };
}

/**
 * Runs a handler for a request that really exists.
 *
 * Same argument validation as a direct call, so a route cannot behave one way
 * when called directly and another way over HTTP. That difference is the sort of
 * bug that only shows up in the path you did not test.
 */
async function runOverHttp(
  app: App<any>,
  name: string,
  route: Route,
  wire: WireRequest,
  path: string,
): Promise<unknown> {
  const spec = route.spec;

  const rawQuery = readQuery(wire.url);

  // The same validator call a direct call makes, over the same schemas. Written
  // once so the two paths cannot drift.
  const { params, query, body } = await validateArgs(spec, {
    params: extractPathParams(parseTemplate(spec.path), path),
    query: rawQuery,
    body: wire.body === undefined || wire.body === "" ? undefined : parseJson(wire.body),
  });

  const ctx = {
    request: wire,
    req: wire,
    params,
    state: {},
    query: () => rawQuery,
    queryAll: () => rawQuery,
    json: async () => (wire.body === undefined ? undefined : parseJson(wire.body)),
    formData: async () => {
      throw new HttpError(415, "This route is JSON. formData() is not available here.");
    },
    cookies: () => ({}),
  } as unknown as Context<never>;

  return route.handler({
    params: params as never,
    query: query as never,
    body: body as never,
    ctx,
    services: app.services,
  } as never);
}

/**
 * Turns a handler's return value into a response.
 *
 * One encoder for everything, because a value that arrives differently depending
 * on its type is how a header ends up set in one path and dropped in another.
 */
async function encode(
  value: unknown,
  response: StandardSchemaV1 | undefined,
  name: string,
  options: TransportOptions,
): Promise<WireResponse> {
  // Passed through untouched. A handler returning a `Response` or a stream has
  // decided its own encoding, and re-encoding would corrupt both — a stream read
  // for inspection is a stream the caller never receives.
  if (value instanceof Response) return responseToWire(value);
  if (value instanceof ReadableStream) {
    return { status: 200, headers: {}, body: value };
  }
  if (value instanceof Uint8Array) {
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: value };
  }

  // Nothing returned is a legitimate answer. Not a 404, not an empty parse error:
  // a delete endpoint that forgets to say "done" should not have to invent a body.
  if (value === undefined) return { status: 204, headers: {}, body: null };

  if (typeof value === "string") {
    return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: value };
  }

  /*
   * Validated before it is serialised, and the validated value is what is sent.
   *
   * It used to be the other way round: the body was stringified first and the
   * validator's result thrown away. Standard Schema validators coerce, strip
   * unknown keys and apply defaults, so the bytes on the wire were the raw
   * handler's — un-sanitised, and different from the shape every client was typed
   * against. A schema that strips a field is how a field quietly reaches
   * production anyway.
   */
  let outgoing: unknown = value;

  if (options.validateResponses && response !== undefined) {
    try {
      outgoing = await validateOrThrow(response, value, `response.${name}`);
    } catch (err) {
      // 500, not 400: the request was fine and the handler was not. Re-thrown as an
      // HttpError so the field name survives — a bare Error is reduced to a
      // generic "Internal error" and the one useful detail is lost.
      throw new HttpError(
        500,
        `Handler for "${name}" returned a value that does not match its response schema — ${(err as Error).message}`,
      );
    }
  }

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(outgoing),
  };
}

/** Copies a web `Response` into the wire shape, keeping its status and headers. */
async function responseToWire(response: Response): Promise<WireResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  /*
   * A stream body is passed through unread.
   *
   * Reading it to inspect the content type would consume it, and the caller would
   * receive an already-drained stream. The type is read from the header, which is
   * what the header is for.
   */
  const contentType = headers["content-type"] ?? "";
  const isText = contentType.includes("json") || contentType.startsWith("text/");

  if (response.body && !isText) {
    return { status: response.status, headers, body: response.body };
  }

  const text = await response.text();

  return {
    status: response.status,
    headers,
    body: text === "" ? null : text,
  };
}


async function responseToBody(response: Response): Promise<string | ReadableStream> {
  const contentType = response.headers.get("content-type") ?? "";
  // Text bodies are read so the response can be rebuilt; a stream cannot be
  // read without consuming it.
  if (contentType.includes("json") || contentType.startsWith("text/")) {
    const text = await response.text();
    return text === "" ? "" : text;
  }
  return response.body ?? "";
}

/**
 * A thrown `HttpError` keeps its status; anything else is a 500.
 *
 * The distinction is the whole point. An `HttpError` is a deliberate answer and its
 * message is meant for the caller. Anything else is a fault, and its message is
 * not echoed — a stack trace in a response leaks paths and internals to whoever
 * happened to trigger it.
 */
function errorToResponse(err: unknown): WireResponse {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }

  /*
   * Anything else that declares a status is taken at its word.
   *
   * A `ValidationError` carries 400 precisely so the transport does not have to know
   * it came from a validator. Matching only on `HttpError` meant that guarantee was
   * unused: a client's typo came back as a 500 "Internal error", which is the exact
   * outcome the class was added to prevent.
   */
  const declared = (err as { status?: unknown } | null)?.status;
  if (typeof declared === "number" && declared >= 400 && declared <= 599) {
    const issues = (err as { issues?: unknown }).issues;
    return {
      status: declared,
      headers: { "content-type": "application/json" },
      // The issues travel with it, so a form can show which fields were wrong
      // rather than only a sentence about the first one.
      body: JSON.stringify({ error: (err as Error).message, ...(issues ? { issues } : {}) }),
    };
  }

  return {
    status: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "Internal error" }),
  };
}

function toResponse(wire: WireResponse): Response {
  // Copied, not passed through: a view over a pooled buffer is not always a valid
  // BodyInit, and the failure is an opaque platform error rather than a bug in
  // the code that caused it.
  const body =
    wire.body instanceof Uint8Array ? new Uint8Array(wire.body) : wire.body;

  return new Response(body, { status: wire.status, headers: wire.headers });
}



function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray % is not worth a 500; the raw text is more useful than an error.
    return value;
  }
}

/**
 * Query parameters as scalars, or arrays where a key really did repeat.
 *
 * Decided by how many values arrived, not by the shape, so `?limit=10` reaches a
 * `{ limit: number }` schema as a string and `?tag=a&tag=b` reaches a
 * `{ tag: string[] }` schema as an array.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Returned as text: a response validator gives a far better message than
    // "Unexpected token < in JSON".
    return text;
  }
}


// ── The browser client ─────────────────────────────────────────────────────

export interface ClientOptions {
  /** Origin the routes are reached through, e.g. "/api" or a full origin. */
  baseUrl?: string;
  /** Sent with every request unless a call overrides it. */
  headers?: Record<string, string>;
  /** Runs before each request: a cookie jar, an auth header. */
  onRequest?: (request: Request) => void;
  /** Runs after a successful response: pagination cursors, rate-limit counters. */
  onResponse?: (response: Response) => void;
  /** Passed to fetch, to share a cookie jar or an agent. */
  fetch?: typeof globalThis.fetch;
  /**
   * Validate a response against its declared schema.
   *
   * On by default. It is the only thing that turns a server that changed into an
   * error naming the field, instead of an `undefined` three components later.
   */
  validateResponses?: boolean;
}

/**
 * A method per route, reached over HTTP.
 *
 * The same names, the same arguments and the same return types as the app's direct
 * methods. Derived from the same table, so there is nothing to keep in step — a
 * renamed route is a compile error here too.
 */
export type HttpMethods<R extends RouteTable> = {
  [K in keyof R & string]: (args?: CallArgs<R[K]["spec"]>) => Promise<DeclaredOut<R[K]["spec"]>>;
};

/** A client for an app. */
export type Client<R extends RouteTable> = HttpMethods<R>;

/**
 * Builds the browser client for an app.
 *
 * This is the other half of the same definition. The app calls handlers in
 * process; this reaches them over HTTP. Both surfaces come from the table, so the
 * developer writes neither.
 *
 * @example
 * ```ts
 * // Server Component — direct, no HTTP.
 * const user = await app.getUser({ params: { id } });
 *
 * // Browser — over HTTP, same shape.
 * const api = createClient(app, { baseUrl: "/api" });
 * const user2 = await api.getUser({ params: { id } });
 * ```
 */
export function createClient<const R extends RouteTable>(
  app: App<R> & DirectMethods<R>,
  options: ClientOptions = {},
): Client<R> {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const table = app.routes as unknown as Record<string, Route>;
  const validate = options.validateResponses ?? true;

  const surface: Record<string, unknown> = {};

  for (const [name, route] of Object.entries(table)) {
    const spec = route.spec;

    const call = async (args?: Record<string, unknown>) => {
      const params = (args?.params ?? {}) as Record<string, unknown>;
      const query = (args?.query ?? {}) as Record<string, unknown>;
      const body = args?.body;

      const hasBody = spec.hasBody ?? spec.method !== "get";

      const url =
        baseUrl +
        buildPath(spec.path, params) +
        (Object.keys(query).length > 0 ? `?${toQueryString(query)}` : "");

      const headers = new Headers({ ...options.headers, accept: "application/json" });
      if (hasBody && body !== undefined) headers.set("content-type", "application/json");

      const signal = (args as { signal?: AbortSignal } | undefined)?.signal;

      const request = new Request(url, {
        method: spec.method.toUpperCase(),
        headers,
        ...(hasBody && body !== undefined ? { body: JSON.stringify(body) } : {}),
        /*
         * Forwarded to fetch.
         *
         * Without it a caller cannot stop a request it no longer wants — a search
         * box that has typed three more characters, or a component that unmounted.
         * The work still completes; only the result is discarded, and the browser
         * keeps the connection busy doing it.
         */
        ...(signal ? { signal } : {}),
      });

      options.onRequest?.(request);

      const response = await doFetch(request);

      if (!response.ok) throw await toCallError(response);

      options.onResponse?.(response);

      const text = await response.text();

      // An empty body is a legitimate answer — nothing returned from a handler is
      // not a parse failure.
      if (text === "") return undefined;

      if (spec.response !== undefined && validate && !isJson(text)) {
        throw new Error(`response.${name}: expected JSON, got ${text.slice(0, 40)}`);
      }

      const parsed: unknown = parseJson(text);

      if (spec.response !== undefined && validate) {
        return validateOrThrow(spec.response, parsed, `response.${name}`);
      }

      return parsed;
    };

    // Same reason as the direct methods: the name is the identity a cache key is
    // built from.
    Object.defineProperty(call, "name", { value: name, configurable: true });
    surface[name] = call;
  }

  return surface as Client<R>;
}

/** Builds an error carrying the status and the server's own message. */
async function toCallError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");

  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Kept as text.
  }

  const message =
    (body as { error?: string } | null)?.error ??
    (body as { message?: string } | null)?.message ??
    text.slice(0, 200);

  const error = new Error(message || `Request failed with status ${response.status}`) as Error & {
    status: number;
    body: unknown;
  };

  Object.defineProperties(error, {
    status: { value: response.status, enumerable: true },
    body: { value: body, enumerable: true },
  });

  return error;
}

function isJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "null";
}

/**
 * Reads the routes off either an app or a bare table.
 *
 * Both accepted because both are natural to have on hand, and a developer should
 * not have to know which one a function expects — or unwrap it at the call site.
 */
export function routesOf(source: App<any> | Record<string, Route>): Record<string, Route> {
  // An app has a `routes` property holding the table; a bare table is the table.
  // That is the whole test. The previous version also sniffed the values for a
  // `spec` key and then returned the wrong one of the two, so `mount()` read the
  // app's own keys as if they were routes and every request failed on a missing
  // `spec`.
  const table = (source as { routes?: Record<string, Route> }).routes;
  return (table ?? source) as Record<string, Route>;
}

export { buildPath, toQueryString, readQuery };
export {
  parseTemplate,
  matchesPath,
  extractParams,
  buildPathFrom,
  bySpecificity,
  PathTemplateError,
  type ParsedPath,
  type Segment,
} from "./path";

export type { HttpMethod, RouteDef };