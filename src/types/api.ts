// /**
//  * ============================================================================
//  *  YATTA API — Type-Safe HTTP API & Middleware Routing Engine for Bun
//  * ============================================================================
//  *
//  *  OVERVIEW:
//  *  Provides lightweight, high-performance HTTP routing, onion middleware pipelines,
//  *  type-safe route parameter extraction, schema validation (Zod, Valibot, ArkType),
//  *  spec-compliant CORS preflight, cookie parsing & encoding, and streaming responses.
//  *
//  *  KEY EXPORTS:
//  *  - `createAPI(path?)`: Factory to instantiate an `API` router instance.
//  *  - `API`: Class managing HTTP method handlers (`.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`),
//  *    middleware (`.use()`), error handling (`.onError()`), and CORS (`.cors()`).
//  *    Supports static response helpers: `API.json()`, `API.text()`, `API.stream()`, `API.cookie()`.
//  *  - `Context`: Rich request wrapper passed into handlers/middleware offering:
//  *    - `ctx.req`: Native `Request` object.
//  *    - `ctx.params`: Typed route parameters inferred from path strings (e.g. `[id]`).
//  *    - `ctx.query()`: Parsed query string dictionary.
//  *    - `ctx.json(schema?)`: Safe body parser with optional validator parsing.
//  *    - `ctx.formData(schema?)`: Multipart/urlencoded parser.
//  *    - `ctx.cookies()`: Request cookies decoded into key-value map.
//  *    - `ctx.state`: Mutable context bag for middleware state sharing (e.g. auth user).
//  *  - `HttpError` & `ValidationError`: Standard status-carrying error classes.
//  *  - `routeRequest(req)`: FileSystemRouter dispatcher for Next.js-style file-based APIs.
//  *
//  *  QUICKSTART / USAGE:
//  *  ```ts
//  *  // src/backend/user/index.ts
//  *  import { API, createAPI } from "../../types/api";
//  *  import { z } from "zod";
//  *
//  *  const api = createAPI();
//  *
//  *  // Middleware
//  *  api.use(async (ctx, next) => {
//  *    ctx.state.startTime = Date.now();
//  *    return await next();
//  *  });
//  *
//  *  // GET /user
//  *  api.get(async (ctx) => {
//  *    return API.json({ user: "Alice", query: ctx.query() });
//  *  });
//  *
//  *  // POST /user
//  *  api.post(async (ctx) => {
//  *    const body = await ctx.json(z.object({ name: z.string() }));
//  *    return API.json({ created: body.name }, { status: 201 });
//  *  });
//  *
//  *  export default api;
//  *  ```
//  */

// // ──────────────────────────────────────────────────────────────────────────
// // Public types
// // ──────────────────────────────────────────────────────────────────────────

// /**
//  * Route parameter map representing key-value pairs extracted from dynamic URL paths.
//  *
//  * @example
//  * ```ts
//  * // For route "/users/[id]" visited at "/users/42"
//  * const params: RouteParams = { id: "42" };
//  * ```
//  */
// export type RouteParams = Record<string, string>;

// /**
//  * Strip Next.js catch-all ellipsis from parameter names (e.g. `...slug` -> `slug`).
//  */
// type CleanParam<P extends string> = P extends `...${infer CatchAll}` ? CatchAll : P;

// /**
//  * Infers typed route parameter dictionary from a path literal string at compile time.
//  * Supports standard dynamic segments like `[id]` and catch-all segments like `[...slug]`.
//  *
//  * @template Path The string literal path type (e.g., `"/orgs/[orgId]/users/[userId]"`).
//  *
//  * @example
//  * ```ts
//  * type Params = ExtractRouteParams<"/orgs/[orgId]/teams/[teamId]">;
//  * // => { orgId: string; teamId: string }
//  * ```
//  */
// export type ExtractRouteParams<Path extends string> =
//   Path extends `${infer _Start}[${infer Param}]${infer Rest}`
//     ? { [K in CleanParam<Param> | keyof ExtractRouteParams<Rest>]: string }
//     : {};

// /**
//  * Schema validator interface compatible with Zod, Valibot, ArkType, or custom parsers.
//  * Must implement a synchronous or throwing `.parse(data: unknown): T` method.
//  *
//  * @template T The validated output type inferred from the schema.
//  *
//  * @example
//  * ```ts
//  * import { z } from "zod";
//  * const userSchema: Validator<{ name: string }> = z.object({ name: z.string() });
//  * const user = await ctx.json(userSchema);
//  * ```
//  */
// export interface Validator<T> {
//   /**
//    * Validates and transforms the incoming data, throwing an error if validation fails.
//    * @param data Raw unvalidated data.
//    * @returns Typed and sanitized value.
//    */
//   parse(data: unknown): T;
// }

// /**
//  * Request handler function executed when an HTTP route is matched.
//  * Receives the typed request {@link Context} and returns a web-standard `Response`.
//  *
//  * @template TParams Inferred or explicit route parameters dictionary.
//  * @param ctx The typed request context containing `req`, `params`, `query()`, `json()`, etc.
//  * @returns A web-standard `Response` or a promise resolving to a `Response`.
//  *
//  * @example
//  * ```ts
//  * const handler: Handler<{ id: string }> = async (ctx) => {
//  *   return API.json({ userId: ctx.params.id });
//  * };
//  * ```
//  */
// export type Handler<TParams extends RouteParams = RouteParams> = (
//   ctx: Context<TParams>,
// ) => Response | Promise<Response>;

// /**
//  * Onion-style middleware function executed in the request pipeline.
//  * Call `await next()` to yield control downstream to subsequent middleware/handlers,
//  * or return early to short-circuit the request pipeline.
//  *
//  * @template TParams Route parameters dictionary.
//  * @param ctx The typed request context.
//  * @param next Function to invoke the next middleware or final route handler in the chain.
//  * @returns A web-standard `Response` or a promise resolving to a `Response`.
//  *
//  * @example
//  * ```ts
//  * api.use(async (ctx, next) => {
//  *   const start = performance.now();
//  *   const response = await next();
//  *   const duration = performance.now() - start;
//  *   response.headers.set("X-Response-Time", `${duration.toFixed(2)}ms`);
//  *   return response;
//  * });
//  * ```
//  */
// export type Middleware<TParams extends RouteParams = RouteParams> = (
//   ctx: Context<TParams>,
//   next: () => Response | Promise<Response>,
// ) => Response | Promise<Response>;

// /**
//  * Centralized error handler invoked when an uncaught error or {@link HttpError} is thrown.
//  *
//  * @template TParams Route parameters dictionary.
//  * @param error The thrown error or exception.
//  * @param ctx The typed request context.
//  * @returns A web-standard `Response` formatted for the client.
//  *
//  * @example
//  * ```ts
//  * api.onError((err, ctx) => {
//  *   console.error("Unhandled route error:", err);
//  *   return API.json({ error: "Something went wrong" }, { status: 500 });
//  * });
//  * ```
//  */
// export type ErrorHandler<TParams extends RouteParams = RouteParams> = (
//   error: unknown,
//   ctx: Context<TParams>,
// ) => Response | Promise<Response>;

// /** Supported HTTP method strings. */
// export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

// /**
//  * Configuration options for generating `Set-Cookie` HTTP response headers.
//  */
// export interface CookieOptions {
//   /**
//    * Max-Age in seconds determining how long the client should store the cookie.
//    * @example 86400 // 24 hours
//    */
//   maxAge?: number;

//   /**
//    * The URL path that must exist in the requested URL for the cookie to be sent.
//    * @default "/"
//    */
//   path?: string;

//   /**
//    * The host/domain to which the cookie will be sent.
//    * @example "example.com"
//    */
//   domain?: string;

//   /**
//    * Forbids client-side JavaScript access via `Document.cookie` to prevent XSS theft.
//    * @default false
//    */
//   httpOnly?: boolean;

//   /**
//    * Ensures the cookie is only transmitted over secure HTTPS connections.
//    * @default false
//    */
//   secure?: boolean;

//   /**
//    * Controls whether the cookie is sent with cross-site requests to mitigate CSRF attacks.
//    * - `"Strict"`: Sent only on first-party requests.
//    * - `"Lax"`: Sent on top-level navigation GET requests.
//    * - `"None"`: Sent across all contexts (requires `secure: true`).
//    * @default "Lax"
//    */
//   sameSite?: "Strict" | "Lax" | "None";
// }

// /**
//  * Configuration options for Cross-Origin Resource Sharing (CORS).
//  */
// export interface CorsOptions {
//   /**
//    * Allowed origin header value (e.g. `"https://example.com"` or `"*"`).
//    * Note: Cannot be `"*"` if {@link credentials} is set to `true`.
//    */
//   origin?: string;

//   /**
//    * List of allowed HTTP methods for CORS requests.
//    * Defaults to all methods registered on the API instance plus `"OPTIONS"`.
//    */
//   methods?: Method[];

//   /**
//    * List of allowed request headers (e.g. `["Content-Type", "Authorization"]`).
//    */
//   headers?: string[];

//   /**
//    * Whether to include `Access-Control-Allow-Credentials: true` to permit cookies/auth tokens.
//    */
//   credentials?: boolean;

//   /**
//    * Maximum duration in seconds that preflight OPTIONS results can be cached by the browser.
//    * @default 86400 // 24 hours
//    */
//   maxAge?: number;
// }

// /**
//  * Thrown to immediately abort handler execution with an explicit HTTP status code.
//  *
//  * @example
//  * ```ts
//  * if (!user) {
//  *   throw new HttpError(404, "User not found", { userId });
//  * }
//  * ```
//  */
// export class HttpError extends Error {
//   /** HTTP response status code (e.g. 400, 401, 403, 404, 500). */
//   status: number;

//   /** Optional arbitrary metadata or validation issues attached to the error. */
//   details?: unknown;

//   /**
//    * @param status HTTP response status code.
//    * @param message Human-readable error message.
//    * @param details Optional additional debug information or validation details.
//    */
//   constructor(status: number, message: string, details?: unknown) {
//     super(message);
//     this.name = "HttpError";
//     this.status = status;
//     this.details = details;
//   }
// }

// /**
//  * Thrown when request body or form parsing/validation fails (HTTP 400 Bad Request).
//  * Carries the underlying validator exception in `.cause`.
//  */
// export class ValidationError extends HttpError {
//   /** The underlying parser or validator error that caused the validation failure. */
//   override cause: unknown;

//   /**
//    * @param cause The underlying error object or validation failure details.
//    */
//   constructor(cause: unknown) {
//     const message = cause instanceof Error ? cause.message : "Invalid request body";
//     super(400, message);
//     this.name = "ValidationError";
//     this.cause = cause;
//   }
// }

// // ──────────────────────────────────────────────────────────────────────────
// // Utilities
// // ──────────────────────────────────────────────────────────────────────────

// function safeDecodeURIComponent(str: string): string {
//   try {
//     return decodeURIComponent(str);
//   } catch {
//     return str;
//   }
// }

// // ──────────────────────────────────────────────────────────────────────────
// // Context
// // ──────────────────────────────────────────────────────────────────────────

// /**
//  * Encapsulates the incoming HTTP request context for route handlers and middleware.
//  * Provides type-safe route parameters, body parsing with validation, query parsing,
//  * cookie parsing, and request-scoped state sharing.
//  *
//  * @template TParams Shape of parsed URL route parameters.
//  *
//  * @example
//  * ```ts
//  * api.get(async (ctx) => {
//  *   const query = ctx.query();
//  *   const userId = ctx.params.id;
//  *   const authUser = ctx.state.user;
//  *   return API.json({ query, userId, authUser });
//  * });
//  * ```
//  */
// export class Context<TParams extends RouteParams = RouteParams> {
//   /** The native web-standard {@link Request} object. */
//   readonly req: Request;

//   /** Strongly-typed route parameters extracted from the URL path. */
//   readonly params: TParams;

//   /** The parsed {@link URL} of the current request. */
//   readonly url: URL;

//   /**
//    * Mutable dictionary for middleware to share request-scoped data
//    * (e.g., authenticated user, timing, trace IDs, permissions).
//    */
//   readonly state: Record<string, unknown> = {};

//   private cachedCookies?: Record<string, string>;
//   private rawBodyParsed = false;
//   private rawBodyData: unknown;
//   private rawFormData?: FormData;

//   /**
//    * Initializes a new request Context.
//    * @param req The incoming HTTP Request.
//    * @param params Extracted route parameters.
//    */
//   constructor(req: Request, params: TParams) {
//     this.req = req;
//     this.params = params;
//     this.url = new URL(req.url);
//   }

//   /**
//    * Returns all query parameters as a key-value dictionary.
//    *
//    * @example
//    * ```ts
//    * // GET /search?q=bun&limit=10
//    * const { q, limit } = ctx.query();
//    * ```
//    */
//   query(): Record<string, string> {
//     return Object.fromEntries(this.url.searchParams.entries());
//   }

//   /**
//    * Parse and optionally validate the JSON request body.
//    * Caches the parsed payload so multiple middleware/handlers can safely read it.
//    *
//    * @template T The expected type of the parsed body.
//    * @param schema Optional schema validator (Zod, Valibot, ArkType) with a `.parse()` method.
//    * @returns The parsed and validated body.
//    * @throws {ValidationError} When the JSON payload is malformed or violates the schema.
//    *
//    * @example
//    * ```ts
//    * // Without schema:
//    * const body = await ctx.json<{ name: string }>();
//    *
//    * // With Zod schema:
//    * import { z } from "zod";
//    * const schema = z.object({ email: z.string().email(), age: z.number().min(18) });
//    * const data = await ctx.json(schema);
//    * ```
//    */
//   async json<T = unknown>(schema?: Validator<T>): Promise<T> {
//     if (!this.rawBodyParsed) {
//       try {
//         this.rawBodyData = await this.req.json();
//         this.rawBodyParsed = true;
//       } catch (err) {
//         throw new ValidationError(err);
//       }
//     }
//     if (!schema) return this.rawBodyData as T;
//     try {
//       return schema.parse(this.rawBodyData);
//     } catch (err) {
//       throw new ValidationError(err);
//     }
//   }

//   /**
//    * Parse and optionally validate `multipart/form-data` or `application/x-www-form-urlencoded`.
//    * Caches the parsed form data across the request lifecycle.
//    *
//    * @template T The expected return type (defaults to standard `FormData`).
//    * @param schema Optional schema validator with a `.parse()` method.
//    * @returns Parsed `FormData` or validated output.
//    * @throws {ValidationError} If parsing or schema validation fails.
//    *
//    * @example
//    * ```ts
//    * const form = await ctx.formData();
//    * const avatarFile = form.get("avatar") as File;
//    * ```
//    */
//   async formData<T = FormData>(schema?: Validator<T>): Promise<T> {
//     if (!this.rawFormData) {
//       try {
//         this.rawFormData = await this.req.formData();
//       } catch (err) {
//         throw new ValidationError(err);
//       }
//     }
//     if (!schema) return this.rawFormData as unknown as T;
//     try {
//       return schema.parse(this.rawFormData);
//     } catch (err) {
//       throw new ValidationError(err);
//     }
//   }

//   /**
//    * Parses and decodes the incoming `Cookie` header into a key-value dictionary.
//    * Safely handles percent-encoded values without throwing on malformed inputs.
//    * Results are cached for subsequent calls.
//    *
//    * @returns Record of cookie names and their decoded values.
//    *
//    * @example
//    * ```ts
//    * const { session_token } = ctx.cookies();
//    * ```
//    */
//   cookies(): Record<string, string> {
//     if (this.cachedCookies) return this.cachedCookies;

//     const header = this.req.headers.get("cookie") ?? "";
//     const out: Record<string, string> = {};

//     for (const pair of header.split(";")) {
//       const trimmed = pair.trim();
//       if (!trimmed) continue;
//       const eq = trimmed.indexOf("=");
//       if (eq === -1) continue;
//       const key = safeDecodeURIComponent(trimmed.slice(0, eq));
//       const value = safeDecodeURIComponent(trimmed.slice(eq + 1));
//       out[key] = value;
//     }

//     this.cachedCookies = out;
//     return out;
//   }

//   /**
//    * Retrieves an incoming HTTP request header value by case-insensitive name.
//    *
//    * @param name Header name (e.g. `"authorization"`, `"user-agent"`).
//    * @returns Header value string or `null` if not present.
//    *
//    * @example
//    * ```ts
//    * const authHeader = ctx.header("Authorization");
//    * ```
//    */
//   header(name: string): string | null {
//     return this.req.headers.get(name);
//   }
// }

// // ──────────────────────────────────────────────────────────────────────────
// // API
// // ──────────────────────────────────────────────────────────────────────────

// /**
//  * Lightweight, high-performance HTTP API router and middleware engine.
//  * Supports method handlers (`get`, `post`, `put`, `patch`, `delete`), sub-route mounting,
//  * onion-style middleware, custom error handling, CORS preflight, and static response helpers.
//  *
//  * @template TParams Route parameters extracted from path definition.
//  *
//  * @example
//  * ```ts
//  * const api = createAPI();
//  *
//  * api.use(async (ctx, next) => {
//  *   console.log(`${ctx.req.method} ${ctx.url.pathname}`);
//  *   return await next();
//  * });
//  *
//  * api.get(async (ctx) => {
//  *   return API.json({ status: "healthy" });
//  * });
//  *
//  * export default api;
//  * ```
//  */
// export class API<TParams extends RouteParams = RouteParams> {
//   /**
//    * The prefix this instance was declared with, e.g. `"/api"`.
//    *
//    * Used as the default base path when a dispatcher does not supply one, so
//    * `createAPI("/api")` actually serves under `/api`.
//    */
//   private readonly declaredPath: string;

//   private routes = new Map<Method, Handler<TParams>>();
//   private subRoutes: Array<{
//     method: Method;
//     path: string;
//     handler: Handler<any>;
//     /** Higher wins when two patterns both match. See `specificityOf`. */
//     specificity: number;
//   }> = [];
//   private mounts: Array<{ prefix: string; router: API<any>; paths: string[] }> = [];

//   /**
//    * Set when this router is mounted and its parent owns error handling.
//    *
//    * A child with no `onError` of its own must rethrow rather than invent a
//    * response, or the parent's centralised error shape is silently skipped for
//    * every mounted feature.
//    */
//   private delegatesErrors = false;
//   private middlewareStack: Middleware<TParams>[] = [];
//   private errorHandler?: ErrorHandler<TParams>;
//   private corsOptions?: CorsOptions;

//   /**
//    * @param path Prefix this router serves under, e.g. `"/api"`. Type inference
//    *   comes from `createAPI`; at runtime it becomes the default base path.
//    */
//   constructor(path = "") {
//     this.declaredPath = path === "/" ? "" : path.replace(/\/$/, "");
//   }

//   // ── Route registration ──────────────────────────────────────────────

//   /**
//    * Registers a GET route handler for the root endpoint of this route module.
//    * @param handler Handler function processing the request.
//    */
//   get(handler: Handler<TParams>): this;
//   /**
//    * Registers a GET route handler for an explicit sub-path.
//    * @param path Sub-path string (e.g. `"/details"`).
//    * @param handler Handler function processing the request.
//    */
//   get(path: string, handler: Handler<any>): this;
//   get(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "GET",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("GET", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers a POST route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   post(handler: Handler<TParams>): this;
//   /**
//    * Registers a POST route handler for an explicit sub-path.
//    * @param path Sub-path string (e.g. `"/checkout"`).
//    * @param handler Handler function processing the request.
//    */
//   post(path: string, handler: Handler<any>): this;
//   post(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "POST",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("POST", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers a PUT route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   put(handler: Handler<TParams>): this;
//   /**
//    * Registers a PUT route handler for an explicit sub-path.
//    * @param path Sub-path string.
//    * @param handler Handler function processing the request.
//    */
//   put(path: string, handler: Handler<any>): this;
//   put(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "PUT",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("PUT", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers a PATCH route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   patch(handler: Handler<TParams>): this;
//   /**
//    * Registers a PATCH route handler for an explicit sub-path.
//    * @param path Sub-path string.
//    * @param handler Handler function processing the request.
//    */
//   patch(path: string, handler: Handler<any>): this;
//   patch(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "PATCH",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("PATCH", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers a DELETE route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   delete(handler: Handler<TParams>): this;
//   /**
//    * Registers a DELETE route handler for an explicit sub-path.
//    * @param path Sub-path string.
//    * @param handler Handler function processing the request.
//    */
//   delete(path: string, handler: Handler<any>): this;
//   delete(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "DELETE",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("DELETE", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers a HEAD route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   head(handler: Handler<TParams>): this;
//   /**
//    * Registers a HEAD route handler for an explicit sub-path.
//    * @param path Sub-path string.
//    * @param handler Handler function processing the request.
//    */
//   head(path: string, handler: Handler<any>): this;
//   head(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "HEAD",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("HEAD", pathOrHandler);
//     }
//     return this;
//   }

//   /**
//    * Registers an OPTIONS route handler for the root endpoint.
//    * @param handler Handler function processing the request.
//    */
//   options(handler: Handler<TParams>): this;
//   /**
//    * Registers an OPTIONS route handler for an explicit sub-path.
//    * @param path Sub-path string.
//    * @param handler Handler function processing the request.
//    */
//   options(path: string, handler: Handler<any>): this;
//   options(pathOrHandler: string | Handler<TParams>, maybeHandler?: Handler<any>): this {
//     if (typeof pathOrHandler === "string") {
//       this.subRoutes.push({
//         method: "OPTIONS",
//         path: pathOrHandler,
//         handler: maybeHandler!,
//         specificity: specificityOf(pathOrHandler),
//       });
//     } else {
//       this.routes.set("OPTIONS", pathOrHandler);
//     }
//     return this;
//   }

//   // ── Middleware & Errors ─────────────────────────────────────────────

//   /**
//    * Attaches an onion-style middleware to the API execution pipeline.
//    * Middleware executes in the order added before reaching the route handler.
//    *
//    * @param middleware Middleware function receiving `ctx` and `next()`.
//    * @returns Current API instance for fluent chaining.
//    *
//    * @example
//    * ```ts
//    * api.use(async (ctx, next) => {
//    *   const token = ctx.header("Authorization");
//    *   if (!token) throw new HttpError(401, "Missing token");
//    *   return await next();
//    * });
//    * ```
//    */
//   use(middleware: Middleware<TParams>): this {
//     this.middlewareStack.push(middleware);
//     return this;
//   }

//   /**
//    * Registers a custom centralized error handler for this API instance.
//    * Catches errors thrown inside middleware or route handlers.
//    *
//    * @param handler Error handler function.
//    * @returns Current API instance for fluent chaining.
//    *
//    * @example
//    * ```ts
//    * api.onError((err, ctx) => {
//    *   if (err instanceof ValidationError) {
//    *     return API.json({ errors: err.details }, { status: 400 });
//    *   }
//    *   return API.json({ error: "Internal Error" }, { status: 500 });
//    * });
//    * ```
//    */
//   onError(handler: ErrorHandler<TParams>): this {
//     this.errorHandler = handler;
//     return this;
//   }

//   /**
//    * Mounts another API instance under a path prefix.
//    *
//    * The child keeps its own handlers, middleware, CORS and error handling, and
//    * path parameters are extracted from the child's own route patterns:
//    *
//    *   ```ts
//    *   const posts = createAPI();
//    *   posts.get("/:id", (ctx) => ctx.json({ id: ctx.params.id }));
//    *
//    *   const api = createAPI("/api");
//    *   api.mount("/posts", posts);   // GET /api/posts/:id
//    *   ```
//    *
//    * Longer prefixes are matched first, so mounting `/posts/recent` before
//    * `/posts` gives the specific route priority.
//    *
//    * @param prefix Path prefix to mount at, e.g. `"/posts"`.
//    * @param router The API instance to delegate to.
//    * @returns Current API instance for fluent chaining.
//    */
//   mount(prefix: string, router: API<any>): this {
//     const clean = prefix === "/" ? "" : prefix.replace(/\/$/, "");

//     // Recorded so the request can be matched and its parameters extracted
//     // against the child's own patterns rather than guessed at here.
//     const paths = [
//       ...Array.from(router.routes.keys()).map(() => "/"),
//       ...router.subRoutes.map((r) => r.path),
//     ];

//     router.delegatesErrors = true;
//     this.mounts.push({ prefix: clean, router, paths });
//     // Deepest prefix first: /posts/recent must win over /posts.
//     this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);

//     return this;
//   }

//   /**
//    * Enables CORS headers on all route responses and automatically handles OPTIONS preflights.
//    *
//    * @param options Configuration for allowed origins, headers, methods, credentials, and maxAge.
//    * @returns Current API instance for fluent chaining.
//    *
//    * @example
//    * ```ts
//    * api.cors({
//    *   origin: "https://myfrontend.com",
//    *   credentials: true,
//    *   methods: ["GET", "POST", "DELETE"],
//    * });
//    * ```
//    */
//   cors(options: CorsOptions = {}): this {
//     this.corsOptions = options;
//     return this;
//   }

//   // ── Static response helpers ─────────────────────────────────────────

//   /**
//    * Creates a JSON HTTP `Response` with `Content-Type: application/json; charset=utf-8`.
//    *
//    * @template T The data type to serialize.
//    * @param data The JavaScript value or object to JSON-encode.
//    * @param init Optional response initialization options (status, headers, etc.).
//    * @returns Standard `Response` object.
//    *
//    * @example
//    * ```ts
//    * return API.json({ success: true, count: 5 }, { status: 200 });
//    * ```
//    */
//   static json<T>(data: T, init: ResponseInit = {}): Response {
//     const headers = new Headers(init.headers);
//     if (!headers.has("Content-Type")) {
//       headers.set("Content-Type", "application/json; charset=utf-8");
//     }
//     return new Response(JSON.stringify(data), { ...init, headers });
//   }

//   /**
//    * Creates a plain text HTTP `Response` with `Content-Type: text/plain; charset=utf-8`.
//    *
//    * @param data Text string content.
//    * @param init Optional response initialization options.
//    * @returns Standard `Response` object.
//    *
//    * @example
//    * ```ts
//    * return API.text("OK", { status: 200 });
//    * ```
//    */
//   static text(data: string, init: ResponseInit = {}): Response {
//     const headers = new Headers(init.headers);
//     if (!headers.has("Content-Type")) {
//       headers.set("Content-Type", "text/plain; charset=utf-8");
//     }
//     return new Response(data, { ...init, headers });
//   }

//   /**
//    * Creates a streaming HTTP `Response` from a `ReadableStream`.
//    *
//    * @param body The `ReadableStream` providing streaming data chunks.
//    * @param init Optional response initialization options (headers, status).
//    * @returns Standard streaming `Response`.
//    *
//    * @example
//    * ```ts
//    * return API.stream(stream, {
//    *   headers: { "Content-Type": "text/event-stream" }
//    * });
//    * ```
//    */
//   static stream(body: ReadableStream, init: ResponseInit = {}): Response {
//     return new Response(body, init);
//   }

//   /**
//    * Formats a name-value pair into a standard `Set-Cookie` header value string.
//    *
//    * @param name Cookie name.
//    * @param value Cookie string value.
//    * @param options Cookie options (maxAge, path, domain, httpOnly, secure, sameSite).
//    * @returns Formatted cookie header string.
//    *
//    * @example
//    * ```ts
//    * const cookieStr = API.cookie("auth_token", token, {
//    *   httpOnly: true,
//    *   secure: true,
//    *   maxAge: 3600,
//    *   sameSite: "Lax"
//    * });
//    * ```
//    */
//   static cookie(name: string, value: string, options: CookieOptions = {}): string {
//     let result = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

//     if (options.maxAge !== undefined) result += `; Max-Age=${options.maxAge}`;
//     if (options.path) result += `; Path=${options.path}`;
//     if (options.domain) result += `; Domain=${options.domain}`;
//     if (options.httpOnly) result += "; HttpOnly";
//     if (options.secure) result += "; Secure";
//     if (options.sameSite) result += `; SameSite=${options.sameSite}`;

//     return result;
//   }

//   /**
//    * Attaches one or more `Set-Cookie` header strings to an existing `Response`.
//    * Correctly handles null-body statuses like 204 No Content or 304 Not Modified.
//    *
//    * @param response Original `Response` object.
//    * @param cookies Array of formatted cookie strings (e.g. from `API.cookie()`).
//    * @returns New `Response` containing the attached `Set-Cookie` headers.
//    *
//    * @example
//    * ```ts
//    * const cookie = API.cookie("session", id, { httpOnly: true });
//    * return API.withCookies(API.json({ ok: true }), [cookie]);
//    * ```
//    */
//   static withCookies(response: Response, cookies: string[]): Response {
//     const headers = new Headers(response.headers);
//     for (const cookie of cookies) headers.append("Set-Cookie", cookie);

//     const isNullBody = response.status === 204 || response.status === 304 || response.status === 205;
//     return new Response(isNullBody ? null : response.body, {
//       status: response.status,
//       statusText: response.statusText,
//       headers,
//     });
//   }

//   // ── CORS Response Builder ───────────────────────────────────────────

//   private applyCors(response: Response, req: Request): Response {
//     const options = this.corsOptions ?? {};
//     const headers = new Headers(response.headers);
//     const reqOrigin = req.headers.get("origin");

//     if (options.credentials) {
//       // Spec: Access-Control-Allow-Origin cannot be "*" when credentials are true
//       headers.set("Access-Control-Allow-Origin", options.origin ?? reqOrigin ?? "*");
//       headers.set("Access-Control-Allow-Credentials", "true");
//       headers.append("Vary", "Origin");
//     } else {
//       headers.set("Access-Control-Allow-Origin", options.origin ?? "*");
//     }

//     const allowedMethods = options.methods
//       ? options.methods.join(", ")
//       : [...new Set([...this.routes.keys(), "OPTIONS"])].join(", ");
//     headers.set("Access-Control-Allow-Methods", allowedMethods);

//     if (options.headers) {
//       headers.set("Access-Control-Allow-Headers", options.headers.join(", "));
//     } else {
//       const reqHeaders = req.headers.get("access-control-request-headers");
//       if (reqHeaders) headers.set("Access-Control-Allow-Headers", reqHeaders);
//     }

//     headers.set("Access-Control-Max-Age", String(options.maxAge ?? 86400));

//     const isNullBody = response.status === 204 || response.status === 304 || response.status === 205;
//     return new Response(isNullBody ? null : response.body, {
//       status: response.status,
//       statusText: response.statusText,
//       headers,
//     });
//   }

//   // ── Error Dispatcher ────────────────────────────────────────────────

//   private async dispatchError(error: unknown, ctx: Context<TParams>): Promise<Response> {
//     if (this.errorHandler) {
//       try {
//         return await this.errorHandler(error, ctx);
//       } catch (handlerErr) {
//         console.error("Error within custom onError handler:", handlerErr);
//       }
//     }

//     // A mounted router rethrows so the parent's onError still applies.
//     if (this.delegatesErrors) throw error;

//     if (error instanceof HttpError) {
//       return API.json(
//         { error: error.message, ...(error.details ? { details: error.details } : {}) },
//         { status: error.status },
//       );
//     }

//     // Subsystems throw their own error types — AuthError carries a status,
//     // as do the db and job errors. They are not HttpError, but they know their
//     // HTTP status, and treating them as unknown would turn every 401 into a 500
//     // and hide the message. Checked structurally so the router does not have to
//     // import a subsystem, and so a 4xx/5xx range check rejects a stray `status`.
//     const status = httpStatusOf(error);
//     if (status !== undefined) {
//       const details = (error as { details?: unknown }).details;
//       return API.json(
//         { error: (error as Error).message, ...(details ? { details } : {}) },
//         { status },
//       );
//     }

//     console.error(error);
//     return API.json({ error: "Internal Server Error" }, { status: 500 });
//   }

//   // ── Request Execution ───────────────────────────────────────────────

//   /**
//    * Processes an incoming HTTP `Request`, executes middleware pipeline, matches route handlers,
//    * handles sub-routes and errors, and applies CORS headers.
//    *
//    * @param req The raw incoming HTTP Request.
//    * @param params Extracted path parameters.
//    * @param basePath Optional base path prefix if mounted as a sub-router.
//    * @returns Promise resolving to the final HTTP `Response`.
//    */
//  async handle(req: Request, params: TParams, basePath?: string): Promise<Response> {
//     const ctx = new Context<TParams>(req, params);
//     const method = req.method.toUpperCase() as Method;

//     // This instance's own view of the path: a parent passes the prefix it
//     // mounted us under, and failing that we fall back to the path declared in
//     // `createAPI("/api")`.
//     const url = new URL(req.url);
//     const path = stripPrefix(url.pathname, basePath ?? (this.declaredPath || undefined));

//     // Assigned by exactly one branch below; the mount loop breaks once it has.
//     let response: Response | undefined;

//     // 1. Check for automatic preflight handling if CORS is enabled
//     if (method === "OPTIONS" && this.corsOptions && !this.routes.has("OPTIONS")) {
//       response = new Response(null, { status: 204 });
//     } else {
//       let handler = this.routes.get(method);

//       // Mounted sub-routers, before the 404/405 fallback below. Longest prefix
//       // first, so /posts/recent beats /posts.
//       for (const { prefix, router, paths } of this.mounts) {
//         const rest = restPath(path, prefix);
//         if (rest === null) continue;

//         const mountParams = extractParams(rest, paths);
//         // No pattern matched, so this mount does not own the request and the
//         // parent's own routes still get a chance.
//         if (mountParams === null) continue;

//         // The child sees only its own paths; `basePath` lets it recognise
//         // that it is mounted and skip CORS/error handling duplication.
//         const scoped = new Request(atPath(req.url, prefix, rest), req);

//         let childResponse: Response;
//         try {
//           childResponse = await router.handle(scoped, mountParams, prefix);
//         } catch (err) {
//           // The child has no error handler of its own; ours decides.
//           childResponse = await this.dispatchError(err, ctx);
//         }

//         // The parent's CORS wins if it has any, otherwise the child's stands.
//         response = this.corsOptions
//           ? this.applyCors(childResponse, req)
//           : childResponse;
//         break;
//       }

//       if (!response) {
//         // Check sub-routes if any registered. Patterns are matched with `:name`
//         // segments, which is what a mounted router's paths use.
//         if (this.subRoutes.length > 0) {
//           let matchedParams: Record<string, string> | null = null;

//           // Most specific first, so a literal segment always beats a parameter:
//           // GET /users/slow must not be swallowed by GET /users/:id, whatever
//           // order the two were registered in.
//           const candidates = this.subRoutes
//             .filter((r) => r.method === method)
//             .sort((a, b) => b.specificity - a.specificity);

//           const matched = candidates.find((r) => {
//             if (r.path === path || (r.path === "/" && (path === "" || path === "/"))) {
//               return true;
//             }
//             const params = matchPattern(r.path, path);
//             if (params) matchedParams = params;
//             return params !== null;
//           });

//           if (matched) {
//             handler = matched.handler;
//             if (matchedParams) Object.assign(params, matchedParams);
//           }
//         }

//         if (handler) {
//           try {
//             response = await this.runMiddleware(ctx, handler);
//           } catch (error) {
//             response = await this.dispatchError(error, ctx);
//           }
//         }
//       }
//     }

//     // Nothing matched: no routes at all is a 404, otherwise the path exists
//     // for other verbs only.
//     if (!response) {
//       const allowed = [
//         ...new Set([...this.routes.keys(), ...this.subRoutes.map((r) => r.method)]),
//       ];
//       response =
//         allowed.length === 0
//           ? API.json({ error: "Not Found" }, { status: 404 })
//           : API.json(
//               { error: "Method Not Allowed" },
//               { status: 405, headers: { Allow: allowed.join(", ") } },
//             );
//     }

//     // 2. Wrap all exit paths (success, preflight, 404, 405, and 500) with CORS if configured
//     return this.corsOptions ? this.applyCors(response, req) : response;
//   }

//   private async runMiddleware(
//     ctx: Context<TParams>,
//     handler: Handler<TParams>,
//   ): Promise<Response> {
//     let index = -1;

//     const dispatch = async (position: number): Promise<Response> => {
//       if (position <= index) {
//         throw new Error("next() called multiple times in one middleware");
//       }
//       index = position;

//       if (position === this.middlewareStack.length) {
//         return await handler(ctx);
//       }

//       const middleware = this.middlewareStack[position]!;
//       return middleware(ctx, () => dispatch(position + 1));
//     };

//     return dispatch(0);
//   }
// }

// // ──────────────────────────────────────────────────────────────────────────
// // Factory functions
// // ──────────────────────────────────────────────────────────────────────────

// /**
//  * Factory creating a typed {@link API} router instance.
//  * When provided with a path literal, statically infers route parameter names
//  * (e.g. `createAPI("/users/[id]")` infers `ctx.params.id`).
//  *
//  * @template Path Route path pattern literal containing parameters like `[id]` or `[...slug]`.
//  * @param path Optional route path pattern to infer typed parameters.
//  * @returns A configured `API` instance.
//  *
//  * @example
//  * ```ts
//  * // 1. Unparameterized router
//  * const api = createAPI();
//  * api.get((ctx) => API.json({ ok: true }));
//  *
//  * // 2. Typed parameterized router
//  * const userApi = createAPI("/users/[id]");
//  * userApi.get((ctx) => {
//  *   // ctx.params.id is statically typed as string
//  *   return API.json({ userId: ctx.params.id });
//  * });
//  * ```
//  */
// /**
//  * How specific a route pattern is, as a sortable number.
//  *
//  * Scored per segment, most-significant first, so `/users/slow` (literal,
//  * literal) outranks `/users/:id` (literal, param) outranks `/users/:a/:b`.
//  * Without this, matching was registration-order dependent and a param route
//  * declared first silently shadowed every static route below it.
//  */
// function specificityOf(pattern: string): number {
//   const segments = pattern.split("/").filter(Boolean);

//   return segments.reduce((score, segment) => {
//     // Base 3: literal > param > wildcard. Multiplied by 3 per depth so a more
//     // specific earlier segment always dominates a less specific later one.
//     const rank = segment.startsWith("**") ? 1 : segment.startsWith(":") ? 2 : 3;
//     return score * 3 + rank;
//   }, 1);
// }

// /**
//  * An HTTP status carried by an arbitrary error, or undefined when it has none.
//  *
//  * Deliberately structural: `yatta/auth`, `yatta/db` and `yatta/jobs` each
//  * define their own error base class, and none of them extends `HttpError`.
//  * Requiring them to would couple every subsystem to the router.
//  */
// function httpStatusOf(error: unknown): number | undefined {
//   if (!error || typeof error !== "object") return undefined;

//   const candidate =
//     (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;

//   // Range-checked: a stray `status` field on a domain error (a job state, a
//   // queue position) must not be mistaken for an HTTP status.
//   if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
//     return candidate;
//   }
//   return undefined;
// }

// /**
//  * The path with `prefix` removed, or null when the path is not under it.
//  * A prefix only matches whole segments: `/posts` must not swallow `/postscript`.
//  */
// function restPath(pathname: string, prefix: string): string | null {
//   if (prefix === "") return pathname || "/";
//   if (pathname === prefix) return "/";
//   if (!pathname.startsWith(prefix + "/")) return null;
//   return pathname.slice(prefix.length) || "/";
// }

// /** Remove a mount prefix from a path, or return it unchanged when absent. */
// function stripPrefix(pathname: string, prefix: string | undefined): string {
//   if (!prefix) return pathname || "/";
//   return restPath(pathname, prefix) ?? pathname;
// }

// /**
//  * Match `rest` against the child's route patterns and pull out `:params`.
//  *
//  * Returns null when no pattern matches, so the caller can fall through to the
//  * next mount instead of handing the child a request it will 404 on.
//  */
// function extractParams(rest: string, paths: string[]): Record<string, string> | null {
//   for (const pattern of paths) {
//     // The bare mount root is the child's root handler, which declares no path.
//     if (pattern === "/") {
//       if (rest === "/" || rest === "") return {};
//       continue;
//     }
//     const params = matchPattern(pattern, rest);
//     if (params) return params;
//   }

//   return null;
// }

// /**
//  * Match a route pattern such as `"/users/:id"` against a concrete path.
//  *
//  * Returns the extracted `:name` parameters, or null when the pattern does not
//  * apply. Only whole segments match, so `/:id` never captures `a/b`.
//  */
// function matchPattern(pattern: string, path: string): Record<string, string> | null {
//   const pSegs = pattern.split("/").filter(Boolean);
//   const rSegs = path.split("/").filter(Boolean);
//   if (pSegs.length !== rSegs.length) return null;

//   const params: Record<string, string> = {};

//   for (let i = 0; i < pSegs.length; i++) {
//     const p = pSegs[i]!;
//     const r = rSegs[i]!;

//     if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(r);
//     else if (p !== r) return null;
//   }

//   return params;
// }

// /**
//  * Strip `prefix` from the URL so a mounted router sees its own paths.
//  * The query string is preserved.
//  */
// function atPath(url: string, prefix: string, rest: string): string {
//   const u = new URL(url);
//   u.pathname = prefix === "" ? rest : `${prefix}${rest}`;
//   return u.toString();
// }

// export function createAPI<Path extends string>(
//   path?: Path,
// ): API<ExtractRouteParams<Path>>;
// export function createAPI(): API<RouteParams>;
// export function createAPI(path?: string): API<any> {
//   return new API(path);
// }

// // ──────────────────────────────────────────────────────────────────────────
// // Router glue
// // ──────────────────────────────────────────────────────────────────────────

// import path from "node:path";

// const backendDir = path.resolve(import.meta.dir, "../backend");

// // Initialized at boot, can be reloaded in development
// const fileRouter = new Bun.FileSystemRouter({
//   style: "nextjs",
//   dir: backendDir,
// });

// // Cache imported API instances in production to avoid dynamic import overhead
// const moduleCache = new Map<string, API<any>>();

// /**
//  * Dispatches an incoming HTTP `Request` through Bun's FileSystemRouter to matching backend route files.
//  * Supports Next.js-style file-based routing convention (`src/backend/...`).
//  *
//  * @param req Incoming HTTP Request.
//  * @returns Response produced by the matched route handler or 404/500 response.
//  */
// export async function routeRequest(req: Request): Promise<Response> {
//   if (process.env.NODE_ENV !== "production") {
//     fileRouter.reload();
//   }

//   let match = fileRouter.match(req);
//   let basePath: string | undefined;

//   if (!match) {
//     const url = new URL(req.url);
//     const altPath = url.pathname.endsWith("/")
//       ? url.pathname.slice(0, -1) || "/"
//       : url.pathname + "/";
//     match = fileRouter.match(altPath);

//     if (!match) {
//       const segments = url.pathname.split("/").filter(Boolean);
//       while (segments.length > 0) {
//         const parentPath = "/" + segments.join("/");
//         const candidateMatch = fileRouter.match(parentPath);
//         if (candidateMatch) {
//           match = candidateMatch;
//           basePath = parentPath;
//           break;
//         }
//         segments.pop();
//       }
//     }
//   }

//   if (!match) {
//     return API.json({ error: "Not Found" }, { status: 404 });
//   }

//   let api = moduleCache.get(match.filePath);

//   if (!api || process.env.NODE_ENV !== "production") {
//     const module = await import(match.filePath);
//     const candidate: any = module.default ?? module.api ?? module;
//     api =
//       candidate instanceof API
//         ? candidate
//         : (candidate?.default instanceof API
//             ? candidate.default
//             : (typeof candidate?.handle === "function" ? candidate : candidate?.default));

//     if (api && process.env.NODE_ENV === "production") {
//       moduleCache.set(match.filePath, api);
//     }
//   }

//   if (!api || typeof api.handle !== "function") {
//     return API.json({ error: "Route handler not found" }, { status: 500 });
//   }

//   return api.handle(req, match.params, basePath);
// }

// ============================================================================

import path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type RouteParams = Record<string, string>;

type CleanParam<P extends string> = P extends `...${infer CatchAll}`
  ? CatchAll
  : P;

export type ExtractRouteParams<Path extends string> =
  Path extends `${infer _Start}[${infer Param}]${infer Rest}`
    ? { [K in CleanParam<Param> | keyof ExtractRouteParams<Rest>]: string }
    : Path extends `${infer _Start}:${infer Param}/${infer Rest}`
      ? { [K in Param | keyof ExtractRouteParams<`/${Rest}`>]: string }
      : Path extends `${infer _Start}:${infer Param}`
        ? { [K in Param]: string }
        : {};

export interface Validator<T> {
  parse(data: unknown): T;
}

/**
 * What a handler may return.
 *
 * Anything here is coerced into a Response by the router. Returning `undefined`
 * type-checks but is rejected at runtime, because a handler that returns nothing
 * is a bug rather than an empty success.
 */
export type HandlerResult =
  | Response
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | undefined;

export type Handler<TParams extends RouteParams = RouteParams> = (
  ctx: Context<TParams>,
) => HandlerResult | Promise<HandlerResult>;

export type Middleware<TParams extends RouteParams = RouteParams> = (
  ctx: Context<TParams>,
  next: () => Response | Promise<Response>,
) => Response | Promise<Response>;

export type ErrorHandler<TParams extends RouteParams = RouteParams> = (
  error: unknown,
  ctx: Context<TParams>,
) => Response | Promise<Response>;

export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface CorsOptions {
  origin?:
    | string
    | string[]
    | ((origin: string, req: Request) => boolean | string);
  methods?: Method[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  override cause: unknown;

  constructor(cause: unknown) {
    let message = "Invalid request body";
    let details: unknown = undefined;

    if (cause && typeof cause === "object") {
      if ("message" in cause && typeof (cause as any).message === "string") {
        message = (cause as any).message;
      }
      if ("issues" in cause) {
        details = (cause as any).issues;
      } else if ("errors" in cause) {
        details = (cause as any).errors;
      } else if ("details" in cause) {
        details = (cause as any).details;
      }
    } else if (cause instanceof Error) {
      message = cause.message;
    }

    super(400, message, details);
    this.name = "ValidationError";
    this.cause = cause;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────

function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function sanitizeHeaderValue(val: string): string {
  return val.replace(/[\r\n;]/g, "").trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────────────────────────────────

export class Context<TParams extends RouteParams = RouteParams> {
  readonly req: Request;
  readonly params: TParams;
  readonly url: URL;
  readonly state: Record<string, unknown> = {};

  private cachedCookies?: Record<string, string>;
  private rawBodyParsed = false;
  private rawBodyData: unknown;
  private rawFormData?: FormData;

  constructor(req: Request, params: TParams) {
    this.req = req;
    this.params = params;
    this.url = new URL(req.url);
  }

  /**
   * Query parameters as strings.
   *
   * Built on a null-prototype object. A plain `{}` inherits from
   * `Object.prototype`, so `?constructor=1` found the inherited `constructor`, decided
   * the key was already set, and `query().constructor` came back as a function
   * instead of a parameter. `?__proto__=1` was worse: it reached the prototype
   * itself. Both are reachable by anyone who can send a URL, and `__proto__` is a
   * prototype-pollution primitive, not a crash.
   */
  query(): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    for (const [key, value] of this.url.searchParams.entries()) {
      if (out[key] === undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * Query parameters as arrays, one entry per repetition.
   *
   * Null-prototype for the same reason as {@link query}. The crash was worse here:
   * `if (!out[key]) out[key] = []` skipped the assignment for `constructor`, because
   * the inherited value was truthy, and then `.push` was called on a function — so
   * `?constructor=1` was a 500 on *every* route, and `?toString=1` or
   * `?hasOwnProperty=1` were too.
   */
  queryAll(): Record<string, string[]> {
    const out: Record<string, string[]> = Object.create(null);
    for (const [key, value] of this.url.searchParams.entries()) {
      if (out[key] === undefined) out[key] = [];
      out[key].push(value);
    }
    return out;
  }

  private checkBodySize(maxBytes = 10 * 1024 * 1024) {
    const cl = this.req.headers.get("content-length");
    if (cl && parseInt(cl, 10) > maxBytes) {
      throw new HttpError(413, `Payload Too Large: exceeded ${maxBytes} bytes`);
    }
  }

  async json<T = unknown>(
    schema?: Validator<T>,
    options?: { maxBytes?: number },
  ): Promise<T> {
    const maxBytes = options?.maxBytes ?? 10 * 1024 * 1024;
    this.checkBodySize(maxBytes);
    if (!this.rawBodyParsed) {
      try {
        this.rawBodyData = await this.req.json();
        this.rawBodyParsed = true;
        // Verify actual size after parsing (Content-Length can be spoofed or omitted
        // with chunked encoding). This prevents OOM from oversized bodies.
        const bodySize = JSON.stringify(this.rawBodyData).length;
        if (bodySize > maxBytes) { throw new HttpError(413, `Payload Too Large: exceeded ${maxBytes} bytes`); }  
      } catch (err) {
        throw new ValidationError(err);
      }
    }
    if (!schema) return this.rawBodyData as T;
    try {
      return schema.parse(this.rawBodyData);
    } catch (err) {
      throw new ValidationError(err);
    }
  }

  async formData<T = FormData>(
    schema?: Validator<T>,
    options?: { maxBytes?: number },
  ): Promise<T> {
    this.checkBodySize(options?.maxBytes);
    if (!this.rawFormData) {
      try {
        this.rawFormData = await this.req.formData();
      } catch (err) {
        throw new ValidationError(err);
      }
    }
    if (!schema) return this.rawFormData as unknown as T;

    // Convert FormData to object for schema validators like Zod
    const dataObj: Record<string, any> = {};
    for (const [key, value] of this.rawFormData.entries()) {
      if (key in dataObj) {
        if (Array.isArray(dataObj[key])) {
          dataObj[key].push(value);
        } else {
          dataObj[key] = [dataObj[key], value];
        }
      } else {
        dataObj[key] = value;
      }
    }

    try {
      return schema.parse(dataObj);
    } catch (err) {
      throw new ValidationError(err);
    }
  }

  cookies(): Record<string, string> {
    if (this.cachedCookies) return this.cachedCookies;

    const header = this.req.headers.get("cookie") ?? "";
    // Null-prototype. A cookie named `__proto__` would otherwise be assigned
    // *through* the prototype rather than as a key, so it silently vanished from
    // `Object.keys` — and `ctx.cookies().__proto__` returned the prototype instead of
    // the cookie. The same hazard as `query()`, reached by a header this time.
    const out: Record<string, string> = Object.create(null);

    for (const pair of header.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = safeDecodeURIComponent(trimmed.slice(0, eq));
      const value = safeDecodeURIComponent(trimmed.slice(eq + 1));
      out[key] = value;
    }

    this.cachedCookies = out;
    return out;
  }

  header(name: string): string | null {
    return this.req.headers.get(name);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// API Router
// ──────────────────────────────────────────────────────────────────────────

export class API<TParams extends RouteParams = RouteParams> {
  private readonly declaredPath: string;
  private routes = new Map<Method, Handler<TParams>>();
  private subRoutes: Array<{
    method: Method;
    path: string;
    handler: Handler<any>;
    specificity: number;
  }> = [];
  private mounts: Array<{ prefix: string; router: API<any> }> = [];

  private middlewareStack: Middleware<TParams>[] = [];
  private errorHandler?: ErrorHandler<TParams>;
  private corsOptions?: CorsOptions;

  // Cache: request method -> pre-filtered (incl. HEAD->GET fallback) and
  // pre-sorted (specificity descending) sub-routes. Rebuilt lazily after
  // any route registration; avoids re-filtering/re-sorting per request.
  private routeCache = new Map<Method, typeof this.subRoutes>();
  // Cache: request method -> exact request path -> the handler the matching
  // loop would select, with its params. O(1) hit for static-path requests.
  // Built lazily from the sorted candidates; invalidated on registration.
  private exactRouteCache = new Map<
    Method,
    Map<string, { handler: Handler<any>; params: Record<string, string>; routePath: string }>
  >();

  constructor(path = "") {
    this.declaredPath = path === "/" ? "" : path.replace(/\/$/, "");
  }

  get(handler: Handler<TParams>): this;
  get(path: string, handler: Handler<any>): this;
  get(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "GET",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("GET", pathOrHandler);
    }
    return this;
  }

  post(handler: Handler<TParams>): this;
  post(path: string, handler: Handler<any>): this;
  post(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "POST",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("POST", pathOrHandler);
    }
    return this;
  }

  put(handler: Handler<TParams>): this;
  put(path: string, handler: Handler<any>): this;
  put(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "PUT",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("PUT", pathOrHandler);
    }
    return this;
  }

  patch(handler: Handler<TParams>): this;
  patch(path: string, handler: Handler<any>): this;
  patch(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "PATCH",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("PATCH", pathOrHandler);
    }
    return this;
  }

  delete(handler: Handler<TParams>): this;
  delete(path: string, handler: Handler<any>): this;
  delete(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "DELETE",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("DELETE", pathOrHandler);
    }
    return this;
  }

  head(handler: Handler<TParams>): this;
  head(path: string, handler: Handler<any>): this;
  head(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "HEAD",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("HEAD", pathOrHandler);
    }
    return this;
  }

  options(handler: Handler<TParams>): this;
  options(path: string, handler: Handler<any>): this;
  options(
    pathOrHandler: string | Handler<TParams>,
    maybeHandler?: Handler<any>,
  ): this {
    if (typeof pathOrHandler === "string") {
      this.subRoutes.push({
        method: "OPTIONS",
        path: pathOrHandler,
        handler: maybeHandler!,
        specificity: specificityOf(pathOrHandler),
      });
      this.invalidateRouteCache();
    } else {
      this.routes.set("OPTIONS", pathOrHandler);
    }
    return this;
  }

  use(middleware: Middleware<TParams>): this {
    this.middlewareStack.push(middleware);
    return this;
  }

  onError(handler: ErrorHandler<TParams>): this {
    this.errorHandler = handler;
    return this;
  }

  mount(prefix: string, router: API<any>): this {
    const clean = prefix === "/" ? "" : prefix.replace(/\/$/, "");
    this.mounts.push({ prefix: clean, router });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
    return this;
  }

  /**
   * Drop the precomputed route caches. Called on every route registration;
   * the caches are rebuilt lazily on the next request.
   */
  private invalidateRouteCache(): void {
    this.routeCache.clear();
    this.exactRouteCache.clear();
  }

  /**
   * Sub-routes eligible for `method` (HEAD also sees GET routes),
   * pre-sorted by specificity descending — the exact order the matching
   * loop iterates. Cached per method; invalidated on registration.
   */
  private getCandidates(method: Method): typeof this.subRoutes {
    let list = this.routeCache.get(method);
    if (!list) {
      list = this.subRoutes
        .filter(
          (r) =>
            r.method === method || (method === "HEAD" && r.method === "GET"),
        )
        .sort((a, b) => b.specificity - a.specificity);
      this.routeCache.set(method, list);
    }
    return list;
  }

  /**
   * Exact-path winners for `method`: request path -> the handler (plus
   * params) the matching loop would select for that exact path. The winner
   * is resolved by simulating the original first-match-wins scan over the
   * specificity-sorted candidates, so parameterized and wildcard routes
   * that outrank a static route keep their precedence.
   */
  private getExactCache(
    method: Method,
  ): Map<string, { handler: Handler<any>; params: Record<string, string>; routePath: string }> {
    let map = this.exactRouteCache.get(method);
    if (!map) {
      map = new Map();
      const candidates = this.getCandidates(method);
      const seen = new Set<string>();
      for (const cand of candidates) {
        if (!isStaticPath(cand.path)) continue;
        // Mirror the "/" special case in the matching loop.
        const keys = cand.path === "/" ? ["/", ""] : [cand.path];
        for (const key of keys) {
          if (seen.has(key)) continue;
          seen.add(key);
          for (const w of candidates) {
            let params: Record<string, string> | null;
            if (
              w.path === key ||
              (w.path === "/" && (key === "" || key === "/"))
            ) {
              params = {};
            } else {
              params = matchPattern(w.path, key);
            }
            if (params !== null) {
              map.set(key, {
                handler: w.handler,
                params,
                routePath: w.path,
              });
              break;
            }
          }
        }
      }
      this.exactRouteCache.set(method, map);
    }
    return map;
  }

  cors(options: CorsOptions = {}): this {
    this.corsOptions = options;
    return this;
  }

  static json<T>(data: T, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    return new Response(JSON.stringify(data), { ...init, headers });
  }

  static text(data: string, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "text/plain; charset=utf-8");
    }
    return new Response(data, { ...init, headers });
  }

  static stream(body: ReadableStream, init: ResponseInit = {}): Response {
    return new Response(body, init);
  }

  static cookie(
    name: string,
    value: string,
    options: CookieOptions = {},
  ): string {
    const safeName = encodeURIComponent(sanitizeHeaderValue(name));
    const safeValue = encodeURIComponent(sanitizeHeaderValue(value));
    const pathVal = sanitizeHeaderValue(options.path ?? "/");
    let sameSite = options.sameSite ?? "Lax";
    let secure = options.secure ?? false;

    if (sameSite === "None") {
      secure = true;
    }

    let result = `${safeName}=${safeValue}; Path=${pathVal}`;
    if (options.maxAge !== undefined)
      result += `; Max-Age=${Math.floor(options.maxAge)}`;
    if (options.domain)
      result += `; Domain=${sanitizeHeaderValue(options.domain)}`;
    if (options.httpOnly ?? false) result += "; HttpOnly";
    if (secure) result += "; Secure";
    result += `; SameSite=${sameSite}`;

    return result;
  }

  static withCookies(response: Response, cookies: string[]): Response {
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);

    const isNullBody =
      response.status === 204 ||
      response.status === 304 ||
      response.status === 205;
    return new Response(isNullBody ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  collectAllMethods(): Set<Method> {
    const set = new Set<Method>(this.routes.keys());
    for (const r of this.subRoutes) set.add(r.method);
    for (const m of this.mounts) {
      for (const meth of m.router.collectAllMethods()) set.add(meth);
    }
    return set;
  }

  getAllowedMethodsForPath(path: string): Set<Method> {
    const allowed = new Set<Method>();

    /*
     * A handler registered without a path is a catch-all and matches any
     * path, so its methods are allowed everywhere. Restricting them to "/"
     * made an unsupported verb on a real path answer 404 instead of 405 with
     * an Allow header.
     */
    for (const m of this.routes.keys()) allowed.add(m);

    for (const sub of this.subRoutes) {
      if (sub.path === path || matchPattern(sub.path, path) !== null) {
        allowed.add(sub.method);
      }
    }

    for (const m of this.mounts) {
      const rest = restPath(path, m.prefix);
      if (rest !== null) {
        const childAllowed = m.router.getAllowedMethodsForPath(rest);
        for (const meth of childAllowed) allowed.add(meth);
      }
    }

    if (allowed.has("GET")) {
      allowed.add("HEAD");
    }

    return allowed;
  }

  private applyCors(response: Response, req: Request): Response {
    const options = this.corsOptions ?? {};
    const headers = new Headers(response.headers);
    const reqOrigin = req.headers.get("origin");

    let allowOrigin: string | null = null;
    let shouldVaryOrigin = false;

    if (typeof options.origin === "function") {
      if (reqOrigin) {
        const res = options.origin(reqOrigin, req);
        if (typeof res === "string") {
          allowOrigin = res;
        } else if (res === true) {
          allowOrigin = reqOrigin;
        }
        shouldVaryOrigin = true;
      }
    } else if (Array.isArray(options.origin)) {
      if (reqOrigin && options.origin.includes(reqOrigin)) {
        allowOrigin = reqOrigin;
      }
      shouldVaryOrigin = true;
    } else if (typeof options.origin === "string") {
      if (options.origin === "*") {
        if (!options.credentials) {
          allowOrigin = "*";
        }
      } else {
        allowOrigin = options.origin;
        if (reqOrigin) shouldVaryOrigin = true;
      }
    } else if (!options.credentials) {
      allowOrigin = "*";
    }

    if (allowOrigin) {
      headers.set("Access-Control-Allow-Origin", allowOrigin);
      if (options.credentials) {
        headers.set("Access-Control-Allow-Credentials", "true");
      }
      if (shouldVaryOrigin) {
        headers.append("Vary", "Origin");
      }
    }

    const allowedMethods = options.methods
      ? options.methods.join(", ")
      : [...this.collectAllMethods(), "OPTIONS", "HEAD"].join(", ");
    headers.set("Access-Control-Allow-Methods", allowedMethods);

    if (options.headers) {
      headers.set("Access-Control-Allow-Headers", options.headers.join(", "));
    } else {
      const reqHeaders = req.headers.get("access-control-request-headers");
      if (reqHeaders) headers.set("Access-Control-Allow-Headers", reqHeaders);
    }

    if (options.exposeHeaders && options.exposeHeaders.length > 0) {
      headers.set(
        "Access-Control-Expose-Headers",
        options.exposeHeaders.join(", "),
      );
    }

    headers.set("Access-Control-Max-Age", String(options.maxAge ?? 86400));

    const isNullBody =
      response.status === 204 ||
      response.status === 304 ||
      response.status === 205;
    return new Response(isNullBody ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async dispatchError(
    error: unknown,
    ctx: Context<TParams>,
    isMounted = false,
  ): Promise<Response> {
    if (this.errorHandler) {
      try {
        return await this.errorHandler(error, ctx);
      } catch (handlerErr) {
        console.error("Error within custom onError handler:", handlerErr);
      }
    }

    if (isMounted) throw error;

    if (error instanceof HttpError) {
      return API.json(
        {
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        { status: error.status },
      );
    }

    const status = httpStatusOf(error);
    if (status !== undefined) {
      const details = (error as { details?: unknown }).details;
      return API.json(
        { error: (error as Error).message, ...(details ? { details } : {}) },
        { status },
      );
    }

    console.error(error);
    return API.json({ error: "Internal Server Error" }, { status: 500 });
  }

  /**
  * Coerces whatever a handler returned into a Response.
  *
  * Handlers were previously required to return a Response, and the return
  * value was passed straight to Bun. A handler that returned a plain object —
  * an easy slip when a route ends in a database insert rather than an
  * `API.json(...)` — produced a **200 with an empty body** and no error
  * anywhere. The request looked successful and the data had vanished.
  *
  * Now:
  *   Response                     passthrough
  *   plain object / array         JSON 200
  *   string / ReadableStream      sent as the body
  *   undefined / null             a 500 naming the route, because a handler
  *                               that returns nothing is a bug and must not
  *                               read as an empty success
  */
  private coerceResponse(result: unknown, where: string): Response {
   if (result instanceof Response) return result;

   if (result === undefined || result === null) {
     throw new HttpError(
       500,
       `Handler for ${where} returned nothing. Return API.json(...), a Response, or a value to serialise.`,
     );
   }

   if (
     typeof result === "object" &&
     !(result instanceof ReadableStream) &&
     !(result instanceof Blob) &&
     !(result instanceof ArrayBuffer) &&
     !(result instanceof Uint8Array)
   ) {
     return Response.json(result);
   }

   return new Response(result as BodyInit);
  }

  async handle(
    req: Request,
    params: TParams = {} as TParams,
    basePath?: string,
    options?: { isMounted?: boolean },
  ): Promise<Response> {
    const ctx = new Context<TParams>(req, params);
    const method = req.method.toUpperCase() as Method;
    const url = new URL(req.url);

    const effectiveBase = basePath ?? (this.declaredPath || undefined);
    const path = stripPrefix(url.pathname, effectiveBase);

    let response: Response | undefined;

    // 1. CORS Preflight
    if (
      method === "OPTIONS" &&
      this.corsOptions &&
      !this.routes.has("OPTIONS")
    ) {
      response = new Response(null, { status: 204 });
      return this.applyCors(response, req);
    }

    // 2. Wrap whole execution pipeline in parent's middleware
    try {
      response = await this.runMiddleware(ctx, async (c) => {
        // A. A handler registered without a path is this router's catch-all.
        //
        // Restricting it to "/" was a silent breaking change: `api.get(fn)`
        // then mounted under a prefix answered 404 for every request that was
        // not the mount root, and existing apps broke with no error at
        // registration time.
        if (this.routes.has(method)) {
          return this.coerceResponse(
            await this.routes.get(method)!(c),
            `${method} ${path}`,
          );
        }

        // B. Check sub-routes. Candidates are pre-filtered by method and
        // pre-sorted by specificity (cached; see getCandidates).
        const candidates = this.getCandidates(method);
        if (candidates.length > 0) {
          // Fast path: O(1) exact-path lookup. The cached hit is the exact
          // winner the scan below would select (same specificity order, same
          // match condition), so middleware, params, HEAD handling, CORS and
          // error dispatch all behave identically.
          const hit = this.getExactCache(method).get(path);
          if (hit) {
            Object.assign(c.params, hit.params);
            // Coerce first: reading `.body` on a plain object is undefined,
            // so the HEAD branch below tested vacuously and produced a
            // Response with an undefined status.
            const hitRes = this.coerceResponse(
              await hit.handler(c),
              `${method} ${hit.routePath}`,
            );
            if (method === "HEAD" && hitRes.body !== null) {
              return new Response(null, {
                status: hitRes.status,
                statusText: hitRes.statusText,
                headers: hitRes.headers,
              });
            }
            return hitRes;
          }

          for (const cand of candidates) {
            let matchedParams: Record<string, string> | null = null;
            if (
              cand.path === path ||
              (cand.path === "/" && (path === "" || path === "/"))
            ) {
              matchedParams = {};
            } else {
              matchedParams = matchPattern(cand.path, path);
            }

            if (matchedParams !== null) {
              Object.assign(c.params, matchedParams);
              // Coerce first: reading `.body` on a plain object is undefined,
              // so the HEAD branch below tested vacuously and produced a
              // Response with an undefined status.
              const res = this.coerceResponse(
                await cand.handler(c),
                `${method} ${cand.path}`,
              );
              if (method === "HEAD" && res.body !== null) {
                return new Response(null, {
                  status: res.status,
                  statusText: res.statusText,
                  headers: res.headers,
                });
              }
              return res;
            }
          }
        }

        // C. Check mounted sub-routers dynamically
        //
        // Prefer a mount that actually declares the requested method. Returning
        // from the first mount that merely had *some* route for the path meant
        // that mounting several routers at the same prefix silently shadowed each
        // other: a router holding `GET /tasks/:id/comments` claimed the path, and
        // a later router's `POST` on the same path was never consulted and
        // answered 405.
        for (const mount of this.mounts) {
          const rest = restPath(path, mount.prefix);
          if (rest === null) continue;

          const allowed = mount.router.getAllowedMethodsForPath(rest);
          if (allowed.size === 0) continue;

          /*
           * Not this verb. Skipping rather than returning leaves the 405 to
           * section E, which unions the methods across *every* mount — so the
           * Allow header lists what the whole application accepts for this path,
           * not just what one router happened to claim first.
           */
          if (!allowed.has(method as Method)) continue;

          const nextBase =
            (effectiveBase ? effectiveBase.replace(/\/$/, "") : "") +
            mount.prefix;
          try {
            return await mount.router.handle(req, c.params, nextBase, {
              isMounted: true,
            });
          } catch (err) {
            return await this.dispatchError(err, c, options?.isMounted);
          }
        }

        // D. Fallback: Auto-HEAD on root route
        if (
          method === "HEAD" &&
          (path === "/" || path === "") &&
          this.routes.has("GET")
        ) {
          // Coerce before reading `.status`: a handler that returned a plain
          // object made this build a Response with an undefined status.
          const getRes = this.coerceResponse(
            await this.routes.get("GET")!(c),
            "HEAD " + path,
          );
          return new Response(null, {
            status: getRes.status,
            statusText: getRes.statusText,
            headers: getRes.headers,
          });
        }

        // E. 404 vs 405
        const allowedMethods = this.getAllowedMethodsForPath(path);
        if (allowedMethods.size === 0) {
          return API.json({ error: "Not Found" }, { status: 404 });
        }

        return API.json(
          { error: "Method Not Allowed" },
          { status: 405, headers: { Allow: [...allowedMethods].join(", ") } },
        );
      });
    } catch (error) {
      response = await this.dispatchError(error, ctx, options?.isMounted);
    }

    return this.corsOptions ? this.applyCors(response!, req) : response!;
  }

  private async runMiddleware(
    ctx: Context<TParams>,
    handler: Handler<TParams>,
  ): Promise<Response> {
    let index = -1;

    const dispatch = async (position: number): Promise<Response> => {
      if (position <= index) {
        throw new Error("next() called multiple times in one middleware");
      }
      index = position;

      if (position === this.middlewareStack.length) {
        // Coerced here as well: this is the path every middleware-wrapped
        // handler takes, so coercing only at the call sites would miss them.
        return this.coerceResponse(await handler(ctx), "handler");
      }

      const middleware = this.middlewareStack[position]!;
      return middleware(ctx, () => dispatch(position + 1));
    };

    return dispatch(0);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Route matching and specificity
// ──────────────────────────────────────────────────────────────────────────

/**
 * True when a route pattern contains no parameters or wildcards, so it can
 * only match one exact request path. Mirrors the segment kinds ranked in
 * `specificityOf` (static = 3, param = 2, wildcard = 1).
 */
function isStaticPath(pattern: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  return segments.every(
    (s) =>
      s !== "**" &&
      !s.startsWith(":") &&
      !(s.startsWith("[") && s.endsWith("]")),
  );
}

function specificityOf(pattern: string): number {
  const segments = pattern.split("/").filter(Boolean);

  return segments.reduce((score, segment) => {
    let rank = 3;
    if (
      segment === "**" ||
      (segment.startsWith("[...") && segment.endsWith("]"))
    ) {
      rank = 1;
    } else if (
      segment.startsWith(":") ||
      (segment.startsWith("[") && segment.endsWith("]"))
    ) {
      rank = 2;
    }
    return score * 3 + rank;
  }, 1);
}

function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const candidate =
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;

  if (
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 400 &&
    candidate <= 599
  ) {
    return candidate;
  }
  return undefined;
}

function restPath(pathname: string, prefix: string): string | null {
  if (prefix === "") return pathname || "/";
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(prefix + "/")) return null;
  return pathname.slice(prefix.length) || "/";
}

function stripPrefix(pathname: string, prefix: string | undefined): string {
  if (!prefix) return pathname || "/";
  return restPath(pathname, prefix) ?? pathname;
}

function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pSegs = pattern.split("/").filter(Boolean);
  const rSegs = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;

    if (p === "**" || (p.startsWith("[...") && p.endsWith("]"))) {
      const name = p === "**" ? "wildcard" : p.slice(4, -1);
      const rest = rSegs.slice(i);
      const decodedRest: string[] = [];
      for (const seg of rest) {
        try {
          decodedRest.push(decodeURIComponent(seg));
        } catch {
          return null;
        }
      }
      params[name] = decodedRest.join("/");
      return params;
    }

    if (i >= rSegs.length) return null;
    const r = rSegs[i]!;

    if (p.startsWith(":") && p.length > 1) {
      try {
        params[p.slice(1)] = decodeURIComponent(r);
      } catch {
        return null;
      }
    } else if (p.startsWith("[") && p.endsWith("]")) {
      try {
        params[p.slice(1, -1)] = decodeURIComponent(r);
      } catch {
        return null;
      }
    } else if (p !== r) {
      return null;
    }
  }

  if (rSegs.length > pSegs.length) return null;
  return params;
}

// ──────────────────────────────────────────────────────────────────────────
// Factory functions & Router glue
// ──────────────────────────────────────────────────────────────────────────

/**
 * Factory creating a typed API router instance.
 */
export function createAPI<Path extends string>(
  path?: Path,
): API<ExtractRouteParams<Path>>;
export function createAPI(): API<RouteParams>;
export function createAPI(path?: string): API<any> {
  return new API(path);
}

let fileRouterInstance: any = null;

function getFileRouter() {
  if (
    !fileRouterInstance &&
    typeof Bun !== "undefined" &&
    Bun.FileSystemRouter
  ) {
    try {
      const backendDir = path.resolve(import.meta.dir, "../backend");
      fileRouterInstance = new Bun.FileSystemRouter({
        style: "nextjs",
        dir: backendDir,
      });
    } catch {
      fileRouterInstance = null;
    }
  }
  return fileRouterInstance;
}

const moduleCache = new Map<string, API<any>>();

export async function routeRequest(req: Request): Promise<Response> {
  const router = getFileRouter();
  if (!router) {
    return API.json(
      { error: "File-system router not initialized" },
      { status: 404 },
    );
  }

  if (process.env.NODE_ENV === "development") {
    router.reload();
  }

  let match = router.match(req);
  let basePath: string | undefined;

  if (!match) {
    const url = new URL(req.url);
    const altPath = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1) || "/"
      : url.pathname + "/";
    match = router.match(altPath);

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
  }

  if (!match) {
    return API.json({ error: "Not Found" }, { status: 404 });
  }

  let api = moduleCache.get(match.filePath);

  if (!api || process.env.NODE_ENV !== "production") {
    const module = await import(match.filePath);
    const candidate: any = module.default ?? module.api ?? module;
    api =
      candidate instanceof API
        ? candidate
        : candidate?.default instanceof API
          ? candidate.default
          : typeof candidate?.handle === "function"
            ? candidate
            : candidate?.default;

    if (api && process.env.NODE_ENV === "production") {
      moduleCache.set(match.filePath, api);
    }
  }

  if (!api || typeof api.handle !== "function") {
    return API.json({ error: "Route handler not found" }, { status: 500 });
  }

  return api.handle(req, match.params, basePath);
}
