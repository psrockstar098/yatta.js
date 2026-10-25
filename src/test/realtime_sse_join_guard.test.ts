import { describe, it, expect } from "bun:test";
import { createRealtime } from "../types/realtime";

describe("Security pass 2026-10-25 — SSE authorize.join", () => {
  const sseReq = (topic: string) =>
    new Request(`http://localhost/realtime?topic=${encodeURIComponent(topic)}`, {
      headers: { Accept: "text/event-stream" },
    });

  it("denies an SSE subscription the join guard rejects", async () => {
    const realtime = createRealtime({
      authenticate: () => ({ userId: "u1" }),
      authorize: {
        join: (client, topic) => topic === `user:${(client.data as any).userId}`,
      },
    });
    const res = await realtime.connect(sseReq("user:u2"), undefined as any);
    expect(res instanceof Response ? res.status : res).toBe(403);
  });

  it("allows an SSE subscription the join guard permits", async () => {
    const realtime = createRealtime({
      authenticate: () => ({ userId: "u1" }),
      authorize: {
        join: (client, topic) => topic === `user:${(client.data as any).userId}`,
      },
    });
    const res = await realtime.connect(sseReq("user:u1"), undefined as any);
    expect(res instanceof Response ? res.status : res).toBe(200);
    if (res instanceof Response) await res.body?.cancel().catch(() => {});
  });
});
