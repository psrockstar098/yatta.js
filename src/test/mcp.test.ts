import { describe, it, expect } from "bun:test";
import {
  createMCPHandler,
  surfaceFromTables,
  SENSITIVE_COLLECTIONS,
  type McpTable,
} from "../func/mcp";

// Small in-memory table that acts like a Yatta table.
function memoryTable() {
  const rows = new Map<string, Record<string, unknown>>();
  let next = 1;
  let lastTake: number | undefined;
  const table: McpTable = {
    primaryKeyColumn: "id",
    async findMany({ take, skip }) {
      lastTake = take;
      const all = [...rows.values()];
      return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
    },
    async findFirst({ where }) {
      return rows.get(String(where.id)) ?? null;
    },
    async insert(data) {
      const id = String(next++);
      const row = { id, ...data };
      rows.set(id, row);
      return row;
    },
    async update({ where, data }) {
      const row = rows.get(String(where.id));
      if (!row) return { changes: 0 };
      rows.set(String(where.id), { ...row, ...data });
      return { changes: 1 };
    },
    async delete({ where }) {
      return { changes: rows.delete(String(where.id)) ? 1 : 0 };
    },
  };
  return { table, rows, take: () => lastTake };
}

function rpc(body: unknown, user: string | null = "user-1") {
  const { table, rows, take } = memoryTable();
  const handler = createMCPHandler({
    resolveUser: async () => user,
    getSurface: () =>
      surfaceFromTables(
        { posts: table, users: table },
        [
          {
            name: "say_hello",
            description: "Say hello to a name.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            call: async (args, ctx) => `Hello, ${args.name} (from ${ctx.userId})`,
          },
        ],
      ),
  });
  return { handler, rows, take, body };
}

async function post(
  handler: (req: Request) => Promise<Response>,
  payload: unknown,
  method = "POST",
) {
  return handler(
    new Request("http://x/mcp", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(payload) : undefined,
    }),
  );
}

describe("MCP server", () => {
  it("unauthenticated callers get 401 and learn no tool names", async () => {
    const { handler } = rpc(null, null);
    for (const payload of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_posts", arguments: {} },
      },
    ]) {
      const res = await post(handler, payload);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("list_posts");
    }
  });

  it("tools/list reflects the surface, without auth tables", async () => {
    const { handler } = rpc(null);
    const res = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = json.result.tools.map((t) => t.name);
    for (const name of [
      "list_posts",
      "get_posts",
      "create_posts",
      "update_posts",
      "delete_posts",
      "say_hello",
    ]) {
      expect(names).toContain(name);
    }
    expect(names.some((n) => n.includes("users"))).toBe(false);
    expect(SENSITIVE_COLLECTIONS.has("users")).toBe(true);
  });

  it("a tool call works end to end through the endpoint", async () => {
    const { handler } = rpc(null);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await post(handler, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      expect(json.result.isError).toBeUndefined();
      return JSON.parse(json.result.content[0]!.text);
    };
    const created = (await call("create_posts", {
      fields: { title: "Hello" },
    })) as { id: string; title: string };
    expect(created.title).toBe("Hello");
    const listed = (await call("list_posts", {})) as Array<unknown>;
    expect(listed.length).toBe(1);
    const got = (await call("get_posts", { id: created.id })) as {
      title: string;
    };
    expect(got.title).toBe("Hello");
    const updated = (await call("update_posts", {
      id: created.id,
      fields: { title: "Hello again" },
    })) as { updated: boolean };
    expect(updated.updated).toBe(true);
    const deleted = (await call("delete_posts", { id: created.id })) as {
      deleted: boolean;
    };
    expect(deleted.deleted).toBe(true);
    const goneRes = await post(handler, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_posts", arguments: { id: created.id } },
    });
    const gone = (await goneRes.json()) as {
      result: { isError?: boolean };
    };
    expect(gone.result.isError).toBe(true);
  });

  it("a registered function runs with the caller id", async () => {
    const { handler } = rpc(null);
    const res = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "say_hello", arguments: { name: "Ada" } },
    });
    const json = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(json.result.content[0]!.text).toContain("Hello, Ada (from user-1)");
  });

  it("initialize, ping, unknown methods, bad JSON, and batches", async () => {
    const { handler } = rpc(null);
    const init = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const initJson = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(initJson.result.protocolVersion).toBe("2025-06-18");
    expect(initJson.result.serverInfo.name).toBe("yatta");
    const ping = await post(handler, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await ping.json() as { result: unknown }).result).toEqual({});
    const unknown = await post(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect((await unknown.json() as { error: { code: number } }).error.code).toBe(-32601);
    const bad = await handler(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32700);
    const batch = await post(handler, [
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { jsonrpc: "2.0", id: 11, method: "tools/list" },
    ]);
    const batchJson = (await batch.json()) as Array<{ id: number }>;
    expect(batchJson.length).toBe(2);
    expect(batchJson.map((r) => r.id)).toEqual([10, 11]);
    const note = await post(handler, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(note.status).toBe(202);
    const get = await post(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, "GET");
    expect(get.status).toBe(405);
  });

  it("list caps at 100 rows", async () => {
    const { handler, take } = rpc(null);
    await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_posts", arguments: { limit: 500 } },
    });
    expect(take()).toBe(100);
  });

  it("unknown tools fail cleanly without crashing later calls", async () => {
    const { handler } = rpc(null);
    const bad = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32602);
    const ping = await post(handler, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(ping.status).toBe(200);
  });

  it("oversize batches are refused instead of running unbounded", async () => {
    const { handler } = rpc(null);
    const big = Array.from({ length: 101 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    const res = await post(handler, big);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: number } }).error.code).toBe(-32600);
    // A normal batch still runs.
    const ok = await post(handler, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(((await ok.json()) as Array<unknown>).length).toBe(2);
  });

  it("collections that sanitize to one tool name do not duplicate tools", async () => {
    // "a.b" and "a_b" both sanitize to "a_b". Before the fix,
    // tools/list showed each name twice and tools/call always hit
    // the first collection, silently serving the wrong rows.
    const { table } = memoryTable();
    const handler = createMCPHandler({
      resolveUser: async () => "user-1",
      getSurface: () =>
        surfaceFromTables({ "a.b": table, "a_b": table }),
    });
    const res = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const names = (
      (await res.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("list_a_b");
  });
});
