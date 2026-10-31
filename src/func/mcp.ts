// MCP server built into Yatta — every Yatta app serves /mcp next to its
// normal API, with no extra install and no plugin.
//
// What it is, in plain terms: an AI agent (a coding assistant, a chat
// app, any MCP client) points at your Yatta URL and can use your app
// through tools. The tools are not hand-written: they are made from
// your app's own surface — its database collections and the functions
// you register. A collection called "posts" becomes list_posts,
// get_post, create_post, update_post, and delete_post automatically.
//
// How to use it: nothing to set up. Start your Yatta app and point an
// MCP client at http://localhost:4000/mcp. One line turns it off:
// MCP_ENABLED=0.
//
// Transport: MCP JSON-RPC over streamable HTTP (plain JSON answers to
// POST requests). No SSE stream, no session id: the server is
// stateless, so every request stands on its own.
//
// Auth: the same auth as the rest of the app. The caller must already
// be signed in (a Yatta session or an OAuth access token from this
// same server). A caller who is not signed in gets a 401 and learns
// nothing — not even the tool names. Auth tables (users, sessions,
// api keys, and friends) are never turned into tools, no matter what.
// One honest limit: any signed-in user can use the exposed collection
// tools. Row-level rules (this user may only touch their own rows)
// belong in registered functions, which get the user id and can say
// no. If your app must not expose its data to every signed-in user,
// turn the endpoint off with MCP_ENABLED=0.

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

// A function the developer registers as a tool. It gets the caller's
// user id, so it can enforce its own rules.
export interface McpFunction {
  name: string;
  description: string;
  // JSON Schema for the arguments object. Keep it small and plain.
  inputSchema: Record<string, unknown>;
  call: (
    args: Record<string, unknown>,
    ctx: { userId: string },
  ) => Promise<unknown> | unknown;
}

export interface McpSurface {
  tables: Record<string, McpTable>;
  functions: McpFunction[];
}

// Auth tables are never exposed as tools, even if someone asks.
export const SENSITIVE_COLLECTIONS = new Set([
  "users",
  "sessions",
  "identities",
  "verificationTokens",
  "passkeys",
  "apiKeys",
]);

// Builds a surface from raw tables, leaving the sensitive ones out.
export function surfaceFromTables(
  tables: Record<string, McpTable>,
  functions: McpFunction[] = [],
): McpSurface {
  const kept: Record<string, McpTable> = {};
  for (const [name, table] of Object.entries(tables)) {
    if (!SENSITIVE_COLLECTIONS.has(name)) kept[name] = table;
  }
  return { tables: kept, functions };
}

export interface McpOptions {
  // Finds the signed-in user for a request. Return null when nobody
  // is signed in. The router passes Yatta sessions and OAuth tokens.
  resolveUser: (req: Request) => Promise<string | null>;
  // The app surface. Read fresh on every tools/list call, so an app
  // that adds a collection later shows it without a restart.
  getSurface: () => Promise<McpSurface> | McpSurface;
  // URL path the handler is mounted on. Default: /mcp.
  path?: string;
  // Shown to clients as the server name and version.
  serverName?: string;
  serverVersion?: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, ctx: { userId: string }) => Promise<unknown>;
}

const KNOWN_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const LATEST_PROTOCOL = "2025-06-18";
const MAX_LIST = 100;

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
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

// Turns one collection into its five tools.
function collectionTools(name: string, table: McpTable): ToolDef[] {
  const pk = table.primaryKeyColumn ?? "id";
  const safe = safeToolName(name);
  if (!safe) return [];
  return [
    {
      name: `list_${safe}`,
      description: `List rows in the ${name} collection.`,
      inputSchema: objectSchema({
        limit: { type: "number", description: "How many rows, at most 100." },
        offset: { type: "number", description: "How many rows to skip." },
      }),
      call: async (args) => {
        const limit = Math.min(
          MAX_LIST,
          Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50),
        );
        const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
        return table.findMany({ take: limit, skip: offset });
      },
    },
    {
      name: `get_${safe}`,
      description: `Get one row from the ${name} collection by id.`,
      inputSchema: objectSchema({ id: { type: ["string", "number"] } }, ["id"]),
      call: async (args) => {
        const row = await table.findFirst({ where: { [pk]: args.id } });
        if (!row) throw new Error(`No ${name} row with that id`);
        return row;
      },
    },
    {
      name: `create_${safe}`,
      description: `Create a row in the ${name} collection.`,
      inputSchema: objectSchema(
        { fields: { type: "object", description: "The row to create." } },
        ["fields"],
      ),
      call: async (args) =>
        table.insert((args.fields as Record<string, unknown>) ?? {}),
    },
    {
      name: `update_${safe}`,
      description: `Update a row in the ${name} collection by id.`,
      inputSchema: objectSchema(
        {
          id: { type: ["string", "number"] },
          fields: { type: "object", description: "The fields to change." },
        },
        ["id", "fields"],
      ),
      call: async (args) => {
        const { changes } = await table.update({
          where: { [pk]: args.id },
          data: (args.fields as Record<string, unknown>) ?? {},
        });
        return { updated: changes > 0 };
      },
    },
    {
      name: `delete_${safe}`,
      description: `Delete a row in the ${name} collection by id.`,
      inputSchema: objectSchema({ id: { type: ["string", "number"] } }, ["id"]),
      call: async (args) => {
        const { changes } = await table.delete({ where: { [pk]: args.id } });
        return { deleted: changes > 0 };
      },
    },
  ];
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcOk(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function createMCPHandler(options: McpOptions) {
  const path = options.path ?? "/mcp";
  const serverName = options.serverName ?? "yatta";
  const serverVersion = options.serverVersion ?? "1.0.5";

  async function buildTools(): Promise<ToolDef[]> {
    const surface = await options.getSurface();
    const tools: ToolDef[] = [];
    const seen = new Set<string>();
    for (const [name, table] of Object.entries(surface.tables)) {
      for (const tool of collectionTools(name, table)) {
        tools.push(tool);
        seen.add(tool.name);
      }
    }
    for (const fn of surface.functions) {
      // A function name that collides with a collection tool loses:
      // two tools with one name would confuse every client.
      if (seen.has(fn.name)) {
        console.warn(`[mcp] skipping function "${fn.name}": name is taken`);
        continue;
      }
      seen.add(fn.name);
      tools.push({
        name: fn.name,
        description: fn.description,
        inputSchema: fn.inputSchema,
        call: (args, ctx) => Promise.resolve(fn.call(args, ctx)),
      });
    }
    return tools;
  }

  async function handleOne(
    body: RpcRequest,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const id = body.id ?? null;
    const isNotification = body.id === undefined;
    const method = body.method ?? "";
    if (method.startsWith("notifications/")) return null;
    if (body.jsonrpc !== "2.0" || !method) {
      return isNotification ? null : rpcError(id, -32600, "Not a JSON-RPC request");
    }
    if (method === "initialize") {
      const asked = (body.params?.protocolVersion as string | undefined) ?? "";
      return rpcOk(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: serverVersion },
      });
    }
    if (method === "ping") return rpcOk(id, {});
    if (method === "tools/list") {
      const tools = await buildTools();
      return rpcOk(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    if (method === "tools/call") {
      const params = body.params ?? {};
      const name = params.name as string | undefined;
      if (!name) return rpcError(id, -32602, "Tool name is required");
      const tools = await buildTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments as Record<string, unknown>) ?? {};
      try {
        const value = await tool.call(args, { userId });
        return rpcOk(id, textResult(value));
      } catch (err) {
        // Tool failures are answers, not crashes: the client sees
        // isError and the message, and the server stays up.
        return rpcOk(id, errorResult(err instanceof Error ? err.message : "Tool failed"));
      }
    }
    return rpcError(id, -32601, `Unknown method: ${method}`);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return new Response("Not Found", { status: 404 });
    }
    if (req.method !== "POST") {
      return new Response("Use POST for MCP", { status: 405 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Body is not JSON"), { status: 400 });
    }
    // Auth comes before anything else: an unsigned caller learns
    // nothing, not even the tool names.
    const userId = await options.resolveUser(req);
    if (!userId) {
      const id =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? ((body as RpcRequest).id ?? null)
          : null;
      return Response.json(
        rpcError(id, -32000, "Sign in to Yatta first"),
        { status: 401 },
      );
    }
    if (Array.isArray(body)) {
      const out: Record<string, unknown>[] = [];
      for (const item of body) {
        if (item === null || typeof item !== "object") {
          out.push(rpcError(null, -32600, "Not a JSON-RPC request"));
          continue;
        }
        const res = await handleOne(item as RpcRequest, userId);
        if (res) out.push(res);
      }
      if (out.length === 0) return new Response(null, { status: 202 });
      return Response.json(out);
    }
    if (body === null || typeof body !== "object") {
      return Response.json(rpcError(null, -32600, "Not a JSON-RPC request"), {
        status: 400,
      });
    }
    const res = await handleOne(body as RpcRequest, userId);
    if (!res) return new Response(null, { status: 202 });
    return Response.json(res);
  };
}

export type MCPHandler = ReturnType<typeof createMCPHandler>;
