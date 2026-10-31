// MCP server built into Yatta — serves /mcp next to your normal API.
//
// What it is: an MCP client (a coding assistant, a chat app) points at
// your Yatta URL and can use your app through tools. The tools are not
// hand-written — a collection called "posts" becomes list_posts,
// get_post, create_post, update_post and delete_post on its own.
//
// Transport: JSON-RPC 2.0 over Streamable HTTP, stateless. Every request
// stands alone: no session id, no SSE stream, so a GET is answered 405
// rather than held open waiting for events that will never be sent.
//
// Auth: the same auth as the rest of the app. A caller who is not signed
// in gets a 401 and learns nothing — not even the tool names. Auth tables
// are never exposed, whatever their spelling (see SENSITIVE_COLLECTIONS).
//
// One honest limit: any signed-in user can use the collection tools. Row
// level rules ("this user may only touch their own rows") belong in a
// registered function, which receives the user id and can refuse, or in
// `authorize`. If the data must not be readable by every signed-in user,
// set MCP_ENABLED=0.

/**
 * The slice of a database collection MCP needs.
 *
 * Yatta's own collections satisfy this as they are; anything else with the
 * same five methods can be exposed. Nothing here is called unless a client
 * invokes the matching tool.
 */
export interface McpTable {
  primaryKeyColumn?: string;
  findMany(options: {
    take?: number;
    skip?: number;
  }): Promise<unknown[]> | unknown[];
  findFirst(options: {
    where: Record<string, unknown>;
  }): Promise<unknown | null> | unknown | null;
  insert(data: Record<string, unknown>): Promise<unknown> | unknown;
  update(options: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ changes: number }> | { changes: number };
  delete(options: {
    where: Record<string, unknown>;
  }): Promise<{ changes: number }> | { changes: number };
}

/**
 * A tool you write yourself.
 *
 * Use one when a collection tool is too blunt: a function gets the caller's
 * user id, so it can enforce who may see what.
 */
export interface McpFunction {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (
    args: Record<string, unknown>,
    ctx: { userId: string },
  ) => Promise<unknown> | unknown;
}

/** Everything this app exposes to MCP: collections plus hand-written tools. */
export interface McpSurface {
  tables: Record<string, McpTable>;
  functions: McpFunction[];
}

/** The five operations a collection gets, as seen by `authorize`. */
export type CollectionAction = "list" | "get" | "create" | "update" | "delete";

/**
 * Collections that never become tools, whatever else is configured.
 *
 * Matching ignores case and punctuation (`api_keys`, `apiKeys` and
 * `ApiKeys` are one entry), because the point is to catch the table a
 * developer actually created, not to match a name they would have to
 * remember to spell here. Add to it, and `MCP_ENABLED=0` stays the answer
 * if the whole endpoint should not exist.
 */
export const SENSITIVE_COLLECTIONS = new Set([
  "users",
  "sessions",
  "identities",
  "accounts",
  "verificationtokens",
  "passkeys",
  "authenticators",
  "apikeys",
  "passwords",
  "secrets",
  "twofactor",
  "authtokens",
]);

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SENSITIVE_NORMALIZED = new Set(
  [...SENSITIVE_COLLECTIONS].map(normalizeName),
);

/**
 * Whether a collection name is on the never-expose list.
 *
 * Case and punctuation are ignored, so `verification_tokens` is refused
 * for the same reason `verificationTokens` is.
 */
export function isSensitiveCollection(name: string): boolean {
  return SENSITIVE_NORMALIZED.has(normalizeName(name));
}

/**
 * Build a surface from raw collections, leaving the sensitive ones out.
 *
 * This is the safe default: a table not named here cannot be exposed by
 * accident, because exposure is opt-in per collection rather than a filter
 * applied afterwards.
 *
 * @param functions Tools to add alongside the generated collection tools.
 */
export function surfaceFromTables(
  tables: Record<string, McpTable>,
  functions: McpFunction[] = [],
): McpSurface {
  const kept: Record<string, McpTable> = {};
  for (const [name, table] of Object.entries(tables)) {
    if (!isSensitiveCollection(name)) kept[name] = table;
  }
  return { tables: kept, functions };
}

export interface McpOptions {
  /**
   * Finds the signed-in user for a request, or null when nobody is signed
   * in. The router passes Yatta sessions and OAuth access tokens. Returning
   * null is answered 401 before any tool name is revealed.
   */
  resolveUser: (req: Request) => Promise<string | null>;
  /**
   * The app surface, read fresh on every request, so a collection added
   * later shows up without a restart.
   */
  getSurface: () => Promise<McpSurface> | McpSurface;
  /**
   * Decide per call whether this user may do this to this collection.
   * Returning false is an ordinary tool error, not a crash — the agent is
   * told no and can try something else.
   *
   * This is the only place row-level rules can live; the generated tools
   * themselves have no idea who owns what.
   */
  authorize?: (info: {
    userId: string;
    collection: string;
    action: CollectionAction;
  }) => Promise<boolean> | boolean;
  /**
   * Browser origins allowed to call /mcp, like `["https://app.example.com"]`.
   * A same-origin request and a request with no Origin header are always
   * allowed; an unlisted origin gets a 403.
   */
  allowedOrigins?: string[];
  /** Where the handler is mounted. Default `/mcp`. */
  path?: string;
  /** Reported to clients in `initialize`. Default `yatta`. */
  serverName?: string;
  /** Reported to clients in `initialize`. Default is the framework version. */
  serverVersion?: string;
  /** Sent to clients in `initialize`, and worth using: a sentence about what the tools are for. */
  instructions?: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (
    args: Record<string, unknown>,
    ctx: { userId: string },
  ) => Promise<unknown>;
}

class ToolError extends Error {}

const KNOWN_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const LATEST_PROTOCOL = "2025-06-18";
const MAX_LIST = 100;
const DEFAULT_LIST = 50;
const MAX_BATCH = 100;
const MAX_BODY_BYTES = 1_000_000;
const MAX_TOOL_NAME = 64;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireId(args: Record<string, unknown>): string | number {
  // Support both args.id and args.fields.id for LLM tolerance
  const id =
    args.id ?? (isPlainObject(args.fields) ? args.fields.id : undefined);
  if (typeof id === "string" && id.trim().length > 0) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return id;
  throw new ToolError("id must be a non-empty string or a finite number");
}

function requireFields(
  args: Record<string, unknown>,
  dropKeys: string[] = [],
): Record<string, unknown> {
  let raw: unknown = args.fields;

  // Resilience: If an LLM flattens fields into the root args object
  if (!isPlainObject(raw)) {
    const candidate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (k !== "id" && k !== "fields" && !dropKeys.includes(k)) {
        candidate[k] = v;
      }
    }
    if (Object.keys(candidate).length > 0) {
      raw = candidate;
    } else {
      throw new ToolError("fields must be an object with properties");
    }
  }

  // Prevent prototype pollution
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (dropKeys.includes(key)) continue;
    out[key] = value;
  }
  return { ...out };
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function collectionTools(
  name: string,
  table: McpTable,
  authorize: McpOptions["authorize"],
): ToolDef[] {
  const pk = table.primaryKeyColumn ?? "id";
  // Truncate to ensure prefixes like `delete_` (7 chars) stay within MAX_TOOL_NAME
  const maxBaseLen = MAX_TOOL_NAME - 7;
  const sanitized = safeToolName(name);
  const safe =
    sanitized.length > maxBaseLen ? sanitized.slice(0, maxBaseLen) : sanitized;
  if (!safe) return [];

  async function run<T>(
    userId: string,
    action: CollectionAction,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (authorize && !(await authorize({ userId, collection: name, action }))) {
      throw new ToolError(`Not allowed to ${action} in ${name}`);
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ToolError) throw err;
      console.error(`[mcp] ${action} on "${name}" failed:`, err);
      throw new ToolError(`Could not ${action} in ${name}`);
    }
  }

  return [
    {
      name: `list_${safe}`,
      description: `List rows in the ${name} collection.`,
      inputSchema: objectSchema({
        limit: {
          type: "number",
          description: `Max rows to return (1-${MAX_LIST}, default ${DEFAULT_LIST}).`,
        },
        offset: { type: "number", description: "Rows to skip." },
      }),
      call: (args, ctx) =>
        run(ctx.userId, "list", async () => {
          const limit = clampInt(args.limit, DEFAULT_LIST, 1, MAX_LIST);
          const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
          return table.findMany({ take: limit, skip: offset });
        }),
    },
    {
      name: `get_${safe}`,
      description: `Get one row from ${name} by primary key.`,
      inputSchema: objectSchema(
        { id: { type: ["string", "number"], description: "Primary key" } },
        ["id"],
      ),
      call: (args, ctx) =>
        run(ctx.userId, "get", async () => {
          const id = requireId(args);
          const row = await table.findFirst({ where: { [pk]: id } });
          if (!row) throw new ToolError(`No ${name} row found with that id`);
          return row;
        }),
    },
    {
      name: `create_${safe}`,
      description: `Create a new row in ${name}.`,
      inputSchema: objectSchema(
        {
          fields: { type: "object", description: "Row attributes to create." },
        },
        ["fields"],
      ),
      call: (args, ctx) =>
        run(ctx.userId, "create", async () =>
          table.insert(requireFields(args)),
        ),
    },
    {
      name: `update_${safe}`,
      description: `Update a row in ${name} by primary key.`,
      inputSchema: objectSchema(
        {
          id: { type: ["string", "number"], description: "Primary key" },
          fields: { type: "object", description: "Fields to update." },
        },
        ["id", "fields"],
      ),
      call: (args, ctx) =>
        run(ctx.userId, "update", async () => {
          const id = requireId(args);
          const data = requireFields(args, [pk]);
          if (Object.keys(data).length === 0) {
            throw new ToolError("fields has nothing to change");
          }
          const { changes } = await table.update({
            where: { [pk]: id },
            data,
          });
          return { updated: changes > 0 };
        }),
    },
    {
      name: `delete_${safe}`,
      description: `Delete a row in ${name} by primary key.`,
      inputSchema: objectSchema(
        { id: { type: ["string", "number"], description: "Primary key" } },
        ["id"],
      ),
      call: (args, ctx) =>
        run(ctx.userId, "delete", async () => {
          const id = requireId(args);
          const { changes } = await table.delete({ where: { [pk]: id } });
          return { deleted: changes > 0 };
        }),
    },
  ];
}

type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcOk(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function formatResult(value: unknown) {
  // Pass through if the function returned a valid MCP content object
  if (
    isPlainObject(value) &&
    Array.isArray(value.content) &&
    (value.content.length === 0 || typeof value.content[0]?.type === "string")
  ) {
    return value;
  }
  const text = JSON.stringify(value ?? null, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Build the HTTP handler for the MCP endpoint.
 *
 * @returns A `(req) => Promise<Response>` for a router or `Bun.serve`.
 *
 * @example
 * const mcp = createMCPHandler({
 *   resolveUser: (req) => currentUserId(req),
 *   getSurface: () => surfaceFromTables({ posts: db.posts }),
 * });
 */
export function createMCPHandler(options: McpOptions) {
  const path = (options.path ?? "/mcp").replace(/\/+$/, "") || "/";
  const serverName = options.serverName ?? "yatta";
  const serverVersion = options.serverVersion ?? "1.0.5";

  async function loadTools(): Promise<Map<string, ToolDef>> {
    const surface = await options.getSurface();
    const tools = new Map<string, ToolDef>();

    const add = (tool: ToolDef, source: string): void => {
      if (tool.name.length > MAX_TOOL_NAME || !TOOL_NAME_RE.test(tool.name)) {
        console.warn(
          `[mcp] skipping invalid tool name "${tool.name}" from ${source}`,
        );
        return;
      }
      if (tools.has(tool.name)) {
        console.warn(
          `[mcp] skipping duplicate tool "${tool.name}" from ${source}`,
        );
        return;
      }
      tools.set(tool.name, tool);
    };

    for (const [name, table] of Object.entries(surface.tables)) {
      if (isSensitiveCollection(name)) continue;
      for (const tool of collectionTools(name, table, options.authorize)) {
        add(tool, `collection "${name}"`);
      }
    }

    for (const fn of surface.functions) {
      add(
        {
          name: fn.name,
          description: fn.description,
          inputSchema: fn.inputSchema,
          call: async (args, ctx) => fn.call(args, ctx),
        },
        `function "${fn.name}"`,
      );
    }

    return tools;
  }

  async function route(
    body: RpcRequest,
    method: string,
    id: RpcId,
    userId: string,
    tools: Map<string, ToolDef>,
  ): Promise<Record<string, unknown>> {
    const params = isPlainObject(body.params) ? body.params : {};

    if (method === "initialize") {
      const asked =
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "";
      return rpcOk(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      });
    }

    if (method === "ping") return rpcOk(id, {});
    if (method === "initialized" || method === "notifications/initialized") {
      return rpcOk(id, {});
    }

    if (method === "tools/list") {
      return rpcOk(id, {
        tools: [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const name = params.name;
      if (typeof name !== "string" || !name) {
        return rpcError(id, -32602, "Tool name is required");
      }
      const rawArgs = params.arguments ?? {};
      if (!isPlainObject(rawArgs)) {
        return rpcError(id, -32602, "arguments must be an object");
      }
      const tool = tools.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);

      try {
        const value = await tool.call(rawArgs, { userId });
        return rpcOk(id, formatResult(value));
      } catch (err) {
        return rpcOk(
          id,
          errorResult(
            err instanceof Error && err.message ? err.message : "Tool failed",
          ),
        );
      }
    }

    return rpcError(id, -32601, `Unknown method: ${method}`);
  }

  async function handleOne(
    body: RpcRequest,
    userId: string,
    tools: Map<string, ToolDef>,
  ): Promise<Record<string, unknown> | null> {
    const isNotification = body.id === undefined;
    const idOk =
      body.id === undefined ||
      body.id === null ||
      typeof body.id === "string" ||
      typeof body.id === "number";
    const id: RpcId = idOk ? ((body.id as RpcId | undefined) ?? null) : null;
    const method = body.method;

    if (method === undefined && ("result" in body || "error" in body)) {
      return null;
    }

    if (
      body.jsonrpc !== "2.0" ||
      typeof method !== "string" ||
      !method ||
      !idOk
    ) {
      return isNotification
        ? null
        : rpcError(id, -32600, "Not a valid JSON-RPC 2.0 request");
    }

    if (method.startsWith("notifications/") && isNotification) {
      return null;
    }

    try {
      const reply = await route(body, method, id, userId, tools);
      return isNotification ? null : reply;
    } catch (err) {
      console.error(`[mcp] ${method} unhandled failure:`, err);
      return isNotification ? null : rpcError(id, -32603, "Internal error");
    }
  }

  function getCorsHeaders(
    origin: string | null,
    allowedOrigins?: string[],
  ): Record<string, string> {
    if (!origin) return {};
    const allowAll = allowedOrigins?.includes("*");
    const isAllowed =
      allowAll || (allowedOrigins && allowedOrigins.includes(origin));

    return {
      "Access-Control-Allow-Origin": isAllowed ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Requested-With, Protocol-Version",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }

  function originAllowed(
    req: Request,
    url: URL,
    allowedOrigins?: string[],
  ): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    if (allowedOrigins?.includes("*") || allowedOrigins?.includes(origin)) {
      return true;
    }
    try {
      const originUrl = new URL(origin);
      // Auto-allow matching host:port and localhost development ports
      const isLocalhost =
        (originUrl.hostname === "localhost" ||
          originUrl.hostname === "127.0.0.1") &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1");

      return originUrl.host === url.host || isLocalhost;
    } catch {
      return false;
    }
  }

  async function readBodySafe(req: Request): Promise<string> {
    if (!req.body) return "";
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let result = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        throw new Error("EXCEEDED_MAX_BODY_BYTES");
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const requested = url.pathname.replace(/\/+$/, "") || "/";
    if (requested !== path) {
      return new Response("Not Found", { status: 404 });
    }

    const origin = req.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin, options.allowedOrigins);

    // Browser preflight CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // A GET here is how a client opens the optional SSE stream. This
    // server is stateless and never opens one, and the transport spec
    // says to answer 405 in that case rather than 200 or an empty 200:
    // a client that gets 200 waits for events that never come.
    if (req.method !== "POST") {
      return new Response("Use POST for MCP", {
        status: 405,
        headers: { Allow: "POST, OPTIONS", ...corsHeaders },
      });
    }

    if (!originAllowed(req, url, options.allowedOrigins)) {
      return Response.json(rpcError(null, -32000, "Origin not allowed"), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return Response.json(
        rpcError(null, -32600, "Content-Type must be application/json"),
        { status: 415, headers: corsHeaders },
      );
    }

    let userId: string | null;
    try {
      userId = await options.resolveUser(req);
    } catch (err) {
      console.error("[mcp] resolveUser failed:", err);
      return Response.json(rpcError(null, -32603, "Could not check sign-in"), {
        status: 500,
        headers: corsHeaders,
      });
    }

    if (!userId) {
      return Response.json(rpcError(null, -32000, "Sign in required"), {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", ...corsHeaders },
      });
    }

    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return Response.json(rpcError(null, -32600, "Request too large"), {
        status: 413,
        headers: corsHeaders,
      });
    }

    let raw: string;
    try {
      raw = await readBodySafe(req);
    } catch (err) {
      const isTooLarge =
        err instanceof Error && err.message === "EXCEEDED_MAX_BODY_BYTES";
      return Response.json(
        rpcError(
          null,
          -32600,
          isTooLarge ? "Request too large" : "Could not read body",
        ),
        { status: isTooLarge ? 413 : 400, headers: corsHeaders },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json(rpcError(null, -32700, "Body is not valid JSON"), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Memoize tool catalog once for this entire request/batch
    const tools = await loadTools();

    if (Array.isArray(body)) {
      if (body.length === 0) {
        return Response.json(rpcError(null, -32600, "Empty batch"), {
          status: 400,
          headers: corsHeaders,
        });
      }
      if (body.length > MAX_BATCH) {
        return Response.json(
          rpcError(null, -32600, `Batch too large: max ${MAX_BATCH}`),
          { status: 400, headers: corsHeaders },
        );
      }

      const out: Record<string, unknown>[] = [];
      for (const item of body) {
        if (!isPlainObject(item)) {
          out.push(rpcError(null, -32600, "Not a JSON-RPC request"));
          continue;
        }
        const res = await handleOne(item as RpcRequest, userId, tools);
        if (res) out.push(res);
      }
      // A batch of notifications and replies has no answers to send,
      // and the transport spec asks for 202 Accepted, no body.
      if (out.length === 0) {
        return new Response(null, { status: 202, headers: corsHeaders });
      }
      return Response.json(out, { headers: corsHeaders });
    }

    if (!isPlainObject(body)) {
      return Response.json(rpcError(null, -32600, "Not a JSON-RPC request"), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const res = await handleOne(body as RpcRequest, userId, tools);
    if (!res) {
      // Same rule as the batch path: no reply content, 202 Accepted.
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    return Response.json(res, { headers: corsHeaders });
  };
}

/** The handler `createMCPHandler` returns. */
export type MCPHandler = ReturnType<typeof createMCPHandler>;
