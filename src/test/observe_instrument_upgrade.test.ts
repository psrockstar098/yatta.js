import { describe, it, expect } from "bun:test";
import { Observer } from "../types/observe";

describe("Security pass 2026-10-25 — instrument() upgrade responses", () => {
  it("does not throw when the handler returns undefined (WebSocket upgrade)", async () => {
    const observer = new Observer({ service: "instrument-upgrade" });
    const handler = observer.instrument(
      async (_req: Request) => undefined as any,
    );
    let result: unknown = "not-called";
    let threw: unknown = null;
    try {
      result = await handler(new Request("http://localhost/realtime"));
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(result).toBeUndefined();
    observer.stop();
  });

  it("still annotates normal responses", async () => {
    const observer = new Observer({ service: "instrument-normal" });
    const handler = observer.instrument(
      async (_req: Request) => new Response("ok", { status: 200 }),
    );
    const res = await handler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBeTruthy();
    observer.stop();
  });
});
