// A typed client built from the same route table the server uses.
//
// The point is that a route is written once. Its validators are the *same
// objects* the server validates with, not copies of them, so:
//
//   - the client's request and response types are inferred from those objects,
//     with no parallel interface to maintain and no codegen step to forget;
//   - a change to a schema changes both sides together, and cannot drift;
//   - there is no second list of URLs, so a renamed route is a compile error.
//
// One `call()` serves every method, so the whole client is a few hundred lines
// regardless of how many routes it covers.

import { buildPathFrom, parseTemplate } from "./path";
import {
  isStandardSchema,
  validateOrThrow,
  type Infer,
  type StandardSchemaV1,
} from "./standard-schema";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

/** The methods a route may declare. */
export const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
] as const satisfies readonly HttpMethod[];

// ── Route definitions ───────────────────────────────────────────────────────

/**
 * One route: where it goes, what it accepts, and what it returns.
 *
 * Every validator is optional, because an endpoint legitimately has no body, and
 * an optional field means the route can be declared from as little as a method
 * and a path.
 */
export interface RouteDef {
  readonly method: HttpMethod;
  /** Path with `:name` segments, e.g. "/users/:id". */
  readonly path: string;
  readonly params?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly body?: StandardSchemaV1;
  /**
   * The response shape.
   *
   * Optional, because a route with no declared response should not pretend to
   * return `unknown` — the client falls back to the raw parsed JSON, which is
   * the honest answer.
   */
  readonly response?: StandardSchemaV1<any>;
  /** Whether a request body may be sent. Defaults to true for post/put/patch. */
  readonly hasBody?: boolean;
}

/** Named parameters a path declares, e.g. { id: string } for "/users/:id". */
/**
 * Path parameters as plain strings, read from the path template.
 *
 * An optional segment (`:id?`) yields an optional key named `id`. A required key
 * named `id?` — which a naive slice produced — is a lie for a segment that may be
 * absent, and cannot be indexed sensibly.
 */
export type PathParams<Path extends string> =
  Path extends `${infer _Head}:${infer Param}/${infer Rest}`
    ? { [K in StripOptional<Param> | keyof PathParams<`/${Rest}`>]: string } &
        Partial<Record<StripOptional<Param>, string>>
    : Path extends `${infer _Head}:${infer Param}`
      ? PathParamsOne<Param>
      : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        {};

/** Drops the optional marker from a segment name. */
type StripOptional<Segment extends string> = Segment extends `${infer Name}?` ? Name : Segment;

type PathParamsOne<Segment extends string> = Segment extends `${infer Name}?`
  ? { [K in Name]?: string }
  : { [K in Segment]: string };
/** A route with its declared parts resolved to concrete types. */
export type Route<D extends RouteDef> = {
  method: D["method"];
  path: D["path"];
  params: D["params"] extends StandardSchemaV1 ? Infer<D["params"]> : PathParams<D["path"]>;
  query: D["query"] extends StandardSchemaV1 ? Infer<D["query"]> : undefined;
  body: D["body"] extends StandardSchemaV1 ? Infer<D["body"]> : undefined;
  response: D["response"] extends StandardSchemaV1 ? Infer<D["response"]> : unknown;
  hasBody: boolean;
};

type Routes = Record<string, RouteDef>;

/**
 * Options every call accepts.
 *
 * Separate from the route's own arguments so a route declaring no schemas still
 * has a working signature.
 */
export type TransportOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Skip the response validator.
   *
   * Useful when a route declares a response for documentation but the caller is
   * streaming, or when the endpoint is newer than this client.
   */
  raw?: boolean;
};

/**
 * Arguments accepted by one method.
 *
 * Written as an intersection of conditionals rather than a mapped type over
 * `keyof CallArgs<T>`. `keyof` applied to an unresolved conditional type is empty,
 * so every argument vanished from the signature: the client worked at runtime
 * while accepting nothing useful at compile time.
 *
 * Each part contributes its key only when the route declares that input, so
 * passing a `body` to a route without one is an error rather than a field that is
 * quietly dropped on the floor.
 */
export type MethodArgs<T> = (T extends { params: infer P } ? { params: P } : {}) &
  (T extends { query: infer Q } ? { query: Q } : {}) &
  (T extends { body: infer B } ? { body: B } : {}) &
  TransportOptions;

export type Method<T> = (
  args: MethodArgs<T>,
) => Promise<T extends { response: infer R } ? R : unknown>;

/** `params` when the route declares them, or when its path has any. Otherwise nothing. */
type ParamsArg<D> = D extends { params: infer P }
  ? unknown extends P
    ? {}
    : { params: Infer<P> }
  : D extends { path: infer Path extends string }
    ? [PathParams<Path>] extends [Record<string, never>]
      ? {}
      : { params: PathParams<Path> }
    : {};

/**
 * `query` only when the route declares a validator for it.
 *
 * The key itself becomes optional when every field of the schema is optional —
 * otherwise a route taking an optional filter would force every caller to write
 * `query: {}`.
 */
type QueryArg<D> = D extends { query: infer Q }
  ? unknown extends Q
    ? {}
    : {} extends Infer<Q>
      ? { query?: Infer<Q> }
      : { query: Infer<Q> }
  : {};

/** `body` only when the route declares a validator for it, optional if all fields are. */
type BodyArg<D> = D extends { body: infer B }
  ? unknown extends B
    ? {}
    : {} extends Infer<B>
      ? { body?: Infer<B> }
      : { body: Infer<B> }
  : {};

/**
 * The argument keys a route actually requires.
 *
 * `params` is required when the route declares a validator for it or when its
 * path has a `:name` segment; `query` and `body` are always optional.
 */
type RequiredArgKeys<D> = D extends { params: StandardSchemaV1 }
  ? "params"
  : D extends { path: infer Path extends string }
    ? keyof PathParams<Path> extends never
      ? never
      : "params"
    : never;

/**
 * One method, inferred straight from a route definition.
 *
 * Deliberately not built on {@link Route}: going through a named intermediate
 * type left `R[N]` deferred inside the mapped type, so every signature stayed
 * unresolved and the client rejected correct arguments at compile time while
 * working fine at runtime. Inferring from the definition directly has one fewer
 * layer to defer.
 *
 * Each argument is contributed by its own conditional, so a route without a body
 * has no `body` key at all — passing one is an error rather than a field that is
 * silently discarded.
 */
/** A route's request parts, plus transport options. */
type Args<D> = ParamsArg<D> & QueryArg<D> & BodyArg<D> & TransportOptions;

/** What a call resolves to, when the response validator ran. */
type ResponseOf<D> = D extends { response: infer Res }
  ? unknown extends Res
    ? unknown
    : Infer<Res>
  : unknown;

/**
 * One method, inferred straight from a route definition.
 *
 * Deliberately not built on {@link Route}: going through a named intermediate type
 * left `R[N]` deferred inside the mapped type, so every signature stayed
 * unresolved and the client rejected correct arguments at compile time while
 * working fine at runtime. Inferring from the definition directly has one fewer
 * layer to defer.
 *
 * Written as two overloads rather than one generic signature with a conditional
 * return. The generic version looked equivalent and was not: TypeScript inferred
 * the argument type from the call and never checked it against the route's
 * schema, so a body of the wrong shape passed a clean compile and failed at
 * runtime. Overloads check each case on its own.
 *
 * The second overload is what `raw: true` selects. With the validator switched
 * off nothing is known about the result, so it is typed `unknown` — the one place
 * the client will not claim to know a shape.
 */
export type MethodFor<D extends RouteDef> = [RequiredArgKeys<D>] extends [never]
  ? {
      (args?: Args<D> & { raw?: false }): Promise<ResponseOf<D>>;
      (args: Args<D> & { raw: true }): Promise<unknown>;
    }
  : {
      (args: Args<D> & { raw?: false }): Promise<ResponseOf<D>>;
      (args: Args<D> & { raw: true }): Promise<unknown>;
    };

/**
 * The client object: one method per route, named by its key in the table.
 *
 * `R[N]` is passed straight through. Intersecting it with `RouteDef` to force
 * resolution — the usual trick for a deferred indexed access — collapsed each
 * field's type into `Schema & Schema | undefined`, so every query and body came
 * back `unknown`.
 */
export type Client<R extends Routes> = {
  [N in keyof R]: MethodFor<R[N]>;
};

/**
 * Declares one route.
 *
 * An identity function, so the literal keeps its exact types — including which
 * validators were supplied and which were omitted, which is what makes the
 * conditional types above resolve.
 */
export function route<const D extends RouteDef>(def: D): D {
  return def;
}

/**
 * Declares a table of routes.
 *
 * Also an identity function, for the same reason.
 */
export function defineRoutes<const R extends Routes>(routes: R): R {
  return routes;
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Origin the routes are called against, e.g. "https://api.example.com". */
  baseUrl?: string;
  /**
   * Called with the raw response before it is read.
   *
   * The usual use is a cookie jar, so session auth works the same as it does
   * server-side. Returning headers replaces the default handling.
   */
  onRequest?: (request: Request) => void;
  /**
   * Read the response headers, for pagination cursors and rate-limit counters.
   *
   * Called only on success.
   */
  onResponse?: (response: Response) => void;
  /**
   * What a response should contain.
   *
   * The body is parsed as JSON by default. Set "text" for a plain-text endpoint
   * and "stream" to receive the ReadableStream untouched.
   */
  expect?: "json" | "text" | "stream";
  /** Sent with every request unless the call overrides it. */
  headers?: Record<string, string>;
  /** Passed to fetch, so a client can share a cookie jar or agent. */
  fetch?: typeof globalThis.fetch;
}

export interface CallError extends Error {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Builds a client for a route table.
 *
 * @example
 * ```ts
 * const routes = defineRoutes({
 *   getUser: route({
 *     method: "get",
 *     path: "/users/:id",
 *     params: z.object({ id: z.string() }),
 *     response: UserSchema,
 *   }),
 * });
 *
 * const api = createClient(routes, { baseUrl: "https://api.example.com" });
 * const user = await api.getUser({ params: { id: "42" } }); // typed from UserSchema
 * ```
 */
export function createClient<const R extends Routes>(
  routes: R,
  options: ClientOptions = {},
): Client<R> {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  async function call<D extends RouteDef>(
    def: D,
    args: {
      params?: unknown;
      query?: unknown;
      body?: unknown;
      signal?: AbortSignal;
      headers?: Record<string, string>;
      raw?: boolean;
    },
  ): Promise<unknown> {
    // Validated only where a validator was declared, so a route with no schema
    // still works and simply passes the value through.
    const params =
      def.params && args.params !== undefined
        ? await validateOrThrow(def.params, args.params, "params")
        : args.params;

    const query =
      def.query && args.query !== undefined
        ? await validateOrThrow(def.query, args.query, "query")
        : args.query;

    const body =
      def.body && args.body !== undefined
        ? await validateOrThrow(def.body, args.body, "body")
        : args.body;

    const path = buildPath(def.path, params as Record<string, unknown> | undefined);

    const headers = new Headers({
      ...options.headers,
      ...args.headers,
      accept: "application/json",
    });

    const hasBody = def.hasBody ?? def.method !== "get";
    if (hasBody && body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const url =
      baseUrl +
      path +
      (query === undefined || query === null
        ? ""
        : `?${toQueryString(query as Record<string, unknown>)}`);

    const request = new Request(url, {
      method: def.method.toUpperCase(),
      headers,
      ...(hasBody && body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    options.onRequest?.(request);

    const response = await doFetch(request);

    if (!response.ok) {
      throw await toCallError(response);
    }

    options.onResponse?.(response);

    const expect = options.expect ?? "json";

    if (expect === "stream") return response.body;

    if (expect === "text") {
      const text = await response.text();
      return args.raw || !def.response ? text : validateOrThrow(def.response, text, "response");
    }

    const text = await response.text();

    // An empty body is a legitimate answer (204, or a handler that returned
    // nothing), so it is not a parse failure.
    const parsed: unknown = text === "" ? undefined : safeJsonParse(text);

    if (args.raw || !def.response) return parsed;

    return validateOrThrow(def.response, parsed, "response");
  }

  const client: Record<string, unknown> = {};

  for (const [name, def] of Object.entries(routes)) {
    client[name] = (args: Record<string, unknown> = {}) => call(def, args);
  }

  return client as Client<R>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Substitutes `:name` segments and percent-encodes each value.
 *
 * Encoding per segment rather than the whole path matters: an id containing a
 * slash would otherwise add a path segment, and a value containing `?` or `#`
 * would truncate the URL.
 */
export function buildPath(
  template: string,
  params?: Record<string, unknown>,
): string {
  // The shared builder, not a second one. Written separately it disagreed with the
  // router about optional segments: this version turned ":id?" into the key "id?"
  // and threw for it, so a client could not build a path the server could match.
  return buildPathFrom(parseTemplate(template), params);
}

/** Serialises a query object, dropping empty values and expanding arrays. */
export function toQueryString(query: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;

    // An array becomes repeated keys, which is what every server-side parser
    // already expects, and beats a comma-joined string that has to be split.
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }

    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }

  return parts.join("&");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Returned raw rather than thrown: the response validator, if there is one,
    // produces a far better message than "Unexpected token < in JSON".
    return text;
  }
}

/**
 * Builds an error carrying the status and the server's own message.
 *
 * The body is kept, because "400" tells a caller nothing while
 * `{ error: "Project key already in use" }` tells them exactly what to fix.
 */
async function toCallError(response: Response): Promise<CallError> {
  const text = await response.text().catch(() => "");

  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Kept as text.
  }

  const message =
    (body as { error?: string; message?: string } | null)?.error ??
    (body as { message?: string } | null)?.message ??
    text.slice(0, 200) ??
    "";

  const error = new Error(
    message || `Request failed with status ${response.status}`,
  ) as CallError;

  Object.defineProperties(error, {
    status: { value: response.status, enumerable: true },
    body: { value: body, enumerable: true },
  });

  return error;
}

/** Re-exported so a route table can be typed without importing two modules. */
export type { Infer, StandardSchemaV1 };
export { isStandardSchema };