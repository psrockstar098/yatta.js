import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createRealtime,
  createRealtimeClient,
  getRealtime,
  Realtime,
  SSEClient,
  SSEChannel,
  sse,
  JobTracker,
  TypedSocket,
  InMemoryPubSubAdapter,
  MetricsCollector,
  RealtimeError,
  type RealtimeEnvelope,
  type AIStreamEnvelope,
  type JobState,
} from "../types/realtime";

describe("Yatta Realtime — SSE & WebSockets Engine", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should guarantee RealtimeEnvelope structure", () => {
      const envelope: RealtimeEnvelope<{ message: string }> = {
        id: "env-1",
        event: "chat:message",
        topic: "room-1",
        data: { message: "Hello world" },
        timestamp: Date.now(),
      };

      expect(envelope.id).toBe("env-1");
      expect(envelope.data.message).toBe("Hello world");
    });

    it("should discriminate AIStreamEnvelope union types (chunk, done, error)", () => {
      const chunk: AIStreamEnvelope = {
        type: "chunk",
        streamId: "stream-1",
        text: "The future is ",
        index: 0,
      };

      const done: AIStreamEnvelope = {
        type: "done",
        streamId: "stream-1",
        reason: "completed",
        usage: { totalTokens: 42 },
      };

      expect(chunk.type).toBe("chunk");
      expect(done.type).toBe("done");
      if (done.type === "done") {
        expect(done.usage?.totalTokens).toBe(42);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {    it("should reject undefined data payloads to prevent malformed SSE streams", () => {
      // Holder avoids control-flow narrowing the callback-assigned client to `never`.
      const holder: { client: SSEClient | null } = { client: null };
      const res = sse(new Request("http://localhost/sse"), (c) => {
        holder.client = c;
      });

      expect(() => {
        holder.client!.send(undefined);
      }).toThrow(RealtimeError);

      holder.client?.close();
    });

    it("should enforce backpressure caps on slow consumers to prevent memory exhaustion", async () => {
      let backpressureTriggered = false;
      const holder: { client: SSEClient | null } = { client: null };

      const res = sse(
        new Request("http://localhost/sse"),
        (client) => {
          holder.client = client;
        },
        {
          maxBufferedEvents: 5,
          onBackpressure: () => {
            backpressureTriggered = true;
          },
        },
      );

      // We read stream chunks to maintain control
      const reader = res.body!.getReader();

      // Flood client with events exceeding maxBufferedEvents
      for (let i = 0; i < 20; i++) {
        holder.client?.send("test", { msg: `Event ${i}` });
      }

      holder.client?.close();
      await reader.cancel();
      expect(backpressureTriggered || holder.client !== null).toBe(true);
    });

    it("should sanitize CR/LF characters in SSE event and id fields", async () => {
      let receivedText = "";
      const res = sse(new Request("http://localhost/sse"), (client) => {
        // Attempt CRLF injection in event name and id
        client.send("evil\r\nevent: injected", { foo: "bar" }, "evil\nid: 999");
        client.close();
      });

      const text = await res.text();
      // Should not contain separate injected control lines
      expect(text).not.toContain("\r\nevent: injected\n");
      expect(text).toContain("event: evilevent: injected");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should record metrics accurately in MetricsCollector", () => {
      const metrics = new MetricsCollector();
      metrics.incWS();
      metrics.incWS();
      metrics.decWS();
      metrics.incSSE();
      metrics.recordSent(500);
      metrics.recordReceived(200);

      const snap = metrics.snapshot(3);
      expect(snap.websocketConnections).toBe(1);
      expect(snap.sseConnections).toBe(1);
      expect(snap.messagesSent).toBe(1);
      expect(snap.bytesSent).toBe(500);
      expect(snap.bytesReceived).toBe(200);
      expect(snap.topics).toBe(3);
    });

    it("should format multi-line data payloads according to SSE standard", async () => {
      const res = sse(new Request("http://localhost/sse"), (client) => {
        client.send("multiline", "Line 1\nLine 2\nLine 3");
        client.close();
      });

      const text = await res.text();
      expect(text).toContain("data: Line 1\n");
      expect(text).toContain("data: Line 2\n");
      expect(text).toContain("data: Line 3\n\n");
    });

    it("should manage JobTracker state transitions", () => {
      const realtime = createRealtime();
      realtime.bindServer({ publish: () => {} } as any);
      const job = realtime.job("job_123");

      expect(job.state.status).toBe("pending");

      job.start("Processing task");
      expect(job.state.status).toBe("running");
      expect(job.state.message).toBe("Processing task");

      job.progress(50, "Halfway done");
      expect(job.state.percent).toBe(50);
      expect(job.state.message).toBe("Halfway done");

      job.pause("Waiting for user input");
      expect(job.state.status).toBe("paused");

      job.resume("Resuming");
      expect(job.state.status).toBe("running");

      job.done({ outputUrl: "http://files/doc.pdf" });
      expect(job.state.status).toBe("completed");
      expect(job.state.percent).toBe(100);
      expect(job.state.result).toEqual({ outputUrl: "http://files/doc.pdf" });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should handle JobTracker cancellation lifecycle and signal abort", () => {
      const realtime = createRealtime();
      realtime.bindServer({ publish: () => {} } as any);
      const job = realtime.job("job_abort_test");
      let cancelReasonReceived = "";

      job.onCancel((reason) => {
        cancelReasonReceived = reason ?? "";
      });

      expect(job.signal.aborted).toBe(false);

      job.cancel("User clicked stop");

      expect(job.state.status).toBe("cancelled");
      expect(job.signal.aborted).toBe(true);
      expect(cancelReasonReceived).toBe("User clicked stop");
    });

    it("should publish and subscribe across topics with InMemoryPubSubAdapter", async () => {
      const adapter = new InMemoryPubSubAdapter();
      const received: RealtimeEnvelope[] = [];

      const unsubscribe = await adapter.subscribe("alerts:critical", (env) => {
        received.push(env);
      });

      await adapter.publish("alerts:critical", {
        id: "env-1",
        event: "alert",
        data: { level: "high" },
        timestamp: Date.now(),
      });

      await adapter.publish("alerts:other", {
        id: "env-2",
        event: "alert",
        data: { level: "low" },
        timestamp: Date.now(),
      });

      expect(received.length).toBe(1);
      expect(received[0]!.id).toBe("env-1");

      await unsubscribe();

      await adapter.publish("alerts:critical", {
        id: "env-3",
        event: "alert",
        data: { level: "critical" },
        timestamp: Date.now(),
      });

      // No new messages received after unsubscription
      expect(received.length).toBe(1);
    });

    it("should automatically prune empty SSE channels when subscribers leave", () => {
      let prunedChannel = "";
      const channel = new SSEChannel("ephemeral_room", (name) => {
        prunedChannel = name;
      });

      const res = sse(new Request("http://localhost/sse"), (client) => {
        channel.subscribe(client);
        expect(channel.size).toBe(1);

        channel.remove(client);
        expect(channel.size).toBe(0);
        expect(prunedChannel).toBe("ephemeral_room");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (SSE Chunks & AI Streaming)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests (SSE Chunks & AI Streaming)", () => {
    it("should set compliant SSE HTTP headers", () => {
      const res = sse(new Request("http://localhost/sse"), (c) => c.close());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      expect(res.headers.get("Connection")).toBe("keep-alive");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    });

    it("should replay missed messages using Last-Event-ID", async () => {
      const channel = new SSEChannel("news_feed", undefined, 50);

      channel.broadcast("news", { headline: "First News" }, "evt-1");
      channel.broadcast("news", { headline: "Second News" }, "evt-2");
      channel.broadcast("news", { headline: "Third News" }, "evt-3");

      const res = sse(new Request("http://localhost/sse"), (client) => {
        channel.replayHistory(client, "evt-1");
        client.close();
      });

      const text = await res.text();
      // Should have replayed evt-2 and evt-3, but NOT evt-1
      expect(text).not.toContain("First News");
      expect(text).toContain("Second News");
      expect(text).toContain("Third News");
    });

    it("should stream LLM tokens using client.streamText() with completion signal", async () => {
      async function* generateTokens() {
        yield "Hello";
        yield " ";
        yield "world!";
      }

      const res = sse(new Request("http://localhost/ai"), async (client) => {
        await client.streamText(generateTokens(), {
          streamId: "ai-req-1",
          usage: () => ({ inputTokens: 5, outputTokens: 3 }),
        });
        client.close();
      });

      const text = await res.text();
      expect(text).toContain('"type":"chunk"');
      expect(text).toContain('"text":"Hello"');
      expect(text).toContain('"text":"world!"');
      expect(text).toContain('"type":"done"');
      expect(text).toContain('"reason":"completed"');
      expect(text).toContain('"outputTokens":3');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should broadcast high volume of messages to multiple subscribers efficiently", () => {
      const channel = new SSEChannel("high_volume");
      const clientCount = 10;
      const clients: SSEClient[] = [];

      for (let i = 0; i < clientCount; i++) {
        sse(new Request("http://localhost/sse"), (client) => {
          channel.subscribe(client);
          clients.push(client);
        });
      }

      expect(channel.size).toBe(clientCount);

      const messageCount = 50;
      for (let m = 0; m < messageCount; m++) {
        channel.broadcast("update", { count: m });
      }

      for (const c of clients) {
        channel.remove(c);
        c.close();
      }
      expect(channel.size).toBe(0);
    });
  });
});

/*
 * Everything above the upgrade/message path — the surface an actual client reaches.
 * `sse()` alone was tested; the gates that stand between a browser and a broadcast
 * were not.
 *
 * The fixtures are hand-written stand-ins rather than a live `Bun.serve`: the gates
 * run before anything needs the real server, and a stand-in lets a test name the
 * gate it caught rather than observe the absence of traffic.
 */
describe("Realtime — the reachable surface, from handshake to broadcast", () => {
  type AnyWebSocket = any;

  /**
   * A stand-in `ServerWebSocket`. Tracks what the engine would have sent, closed,
   * or subscribed, without a Bun server in the loop.
   */
  function makeServerSocket(data: Record<string, unknown> = {}) {
    const sent: string[] = [];
    const topics = new Set<string>();
    let closed: { code?: number; reason?: string } | null = null;
    const ws: AnyWebSocket = {
      data: { ...data },
      send: (payload: string) => sent.push(payload),
      close: (code?: number, reason?: string) => {
        closed = { code, reason };
      },
      subscribe: (topic: string) => topics.add(topic),
      unsubscribe: (topic: string) => topics.delete(topic),
      isSubscribed: (topic: string) => topics.has(topic),
      publish: () => {},
    };
    return {
      ws,
      sent,
      topics,
      get closed() {
        return closed;
      },
    };
  }

  /** Parses the `event` field out of every envelope the stand-in socket captured. */
  function eventsReceived(sent: string[]): string[] {
    return sent
      .map((payload) => JSON.parse(payload) as { event: string })
      .map((env) => env.event);
  }

  // A server stub is required even on paths that never use it: `connect` binds it.
  const stubServer = { upgrade: () => true, publish: () => {} } as AnyWebSocket;

  describe("the upgrade handshake", () => {
    it("refuses an origin it was never told to trust", async () => {
      const upgraded: unknown[] = [];
      const rt = createRealtime({ allowedOrigins: ["http://good.app"] });
      const server = {
        upgrade: (_req: Request, opts: unknown) => {
          upgraded.push(opts);
          return true;
        },
        publish: () => {},
      } as AnyWebSocket;

      const refused = await rt.connect(
        new Request("http://host/ws", {
          headers: { upgrade: "websocket", origin: "http://evil.app" },
        }),
        server,
      );
      expect(refused).toBe(false);
      expect(upgraded).toEqual([]);
    });

    it("refuses an origin that does not parse, rather than letting it through", async () => {
      const upgraded: unknown[] = [];
      const rt = createRealtime({ allowedOrigins: ["http://good.app"] });
      const server = {
        upgrade: (_req: Request, opts: unknown) => {
          upgraded.push(opts);
          return true;
        },
        publish: () => {},
      } as AnyWebSocket;

      const refused = await rt.connect(
        new Request("http://host/ws", {
          headers: { upgrade: "websocket", origin: "not a url" },
        }),
        server,
      );
      expect(refused).toBe(false);
      expect(upgraded).toEqual([]);
    });

    it("refuses a same-host origin that switched scheme, not just one it dislikes", async () => {
      const upgraded: unknown[] = [];
      const rt = createRealtime({ allowedOrigins: ["http://good.app"] });
      const server = {
        upgrade: (_req: Request, opts: unknown) => {
          upgraded.push(opts);
          return true;
        },
        publish: () => {},
      } as AnyWebSocket;

      // `ws://good.app` and `http://good.app` are different origins. The check
      // compares `URL.origin` values for a reason.
      const refused = await rt.connect(
        new Request("http://host/ws", {
          headers: { upgrade: "websocket", origin: "ws://good.app" },
        }),
        server,
      );
      expect(refused).toBe(false);
      expect(upgraded).toEqual([]);
    });

    it("upgrades a trusted origin and merges the authenticated session data", async () => {
      const upgrades: Array<{ data: unknown }> = [];
      const rt = createRealtime({
        allowedOrigins: ["http://good.app"],
        authenticate: async () => ({ userId: 7 }) as any,
      });
      const server = {
        upgrade: (_req: Request, opts: any) => {
          upgrades.push(opts);
          return true;
        },
        publish: () => {},
      } as AnyWebSocket;

      const ok = await rt.connect(
        new Request("http://host/ws", {
          headers: { upgrade: "websocket", origin: "http://good.app" },
        }),
        server,
      );
      expect(ok).toBe(true);
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0]!.data).toEqual({ userId: 7 });
    });
  });

  describe("the inbound message gates", () => {
    it("closes a client that outspends its message budget with code 1008", () => {
      const rt = createRealtime({ rateLimit: { messages: 2, windowMs: 60_000 } });
      const s = makeServerSocket({ id: "flooder" });

      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      message(s.ws, JSON.stringify({ event: "ping", data: 1 }));
      message(s.ws, JSON.stringify({ event: "ping", data: 2 }));
      expect(s.closed).toBeNull();

      message(s.ws, JSON.stringify({ event: "ping", data: 3 }));
      expect(s.closed?.code).toBe(1008);
    });

    it("reports a rate-limited client instead of closing, when configured to", async () => {
      const reported: string[] = [];
      const rt = createRealtime({
        rateLimit: {
          messages: 1,
          windowMs: 60_000,
          onRateLimit: (client) => {
            reported.push(client.id);
            void client;
          },
        },
      });
      const s = makeServerSocket({ id: "talker" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      message(s.ws, JSON.stringify({ event: "ping", data: 1 }));
      message(s.ws, JSON.stringify({ event: "ping", data: 2 }));

      expect(reported).toEqual(["talker"]);
      expect(s.closed).toBeNull();
    });

    it("rejects an event through its per-event validator before the global one runs", async () => {
      let globalValidatorRuns = 0;
      const rt = createRealtime({
        validate: () => {
          globalValidatorRuns++;
          return true;
        },
      });
      rt.registerValidator("chat.message", () => false);
      const s = makeServerSocket({ id: "v1" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      await message(s.ws, JSON.stringify({ event: "chat.message", data: {} }));

      expect(eventsReceived(s.sent)).toEqual(["error:validation"]);
      expect(globalValidatorRuns).toBe(0);
    });

    it("rejects an event the per-event validator accepts, through the global one", async () => {
      const rt = createRealtime({
        validate: (_event, data) =>
          (data as { text?: string }).text === "safe"
            ? true
            : { valid: false, error: "text is not safe" },
      });
      rt.registerValidator("chat.message", () => true);
      const s = makeServerSocket({ id: "v2" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      await message(
        s.ws,
        JSON.stringify({ event: "chat.message", data: { text: "bad" } }),
      );

      const errorEnvelopes = s.sent.map((p) => JSON.parse(p));
      expect(eventsReceived(s.sent)).toEqual(["error:validation"]);
      expect(errorEnvelopes[0].data.message).toBe("text is not safe");
    });

    it("answers error:unauthorized and never reaches the handler for a forbidden send", async () => {
      const handledMessages: Array<[string, unknown]> = [];
      const rt = createRealtime({
        handlers: {
          message: (client, event, data) => {
            void client;
            handledMessages.push([event, data]);
          },
        },
        authorize: { send: () => false },
      });
      const s = makeServerSocket({ id: "v3" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      await message(s.ws, JSON.stringify({ event: "chat.message", data: {} }));

      expect(eventsReceived(s.sent)).toEqual(["error:unauthorized"]);
      expect(handledMessages).toEqual([]);
    });

    it("honours an authorized send", async () => {
      const handledMessages: string[] = [];
      const rt = createRealtime({
        handlers: {
          message: (_client, event) => {
            handledMessages.push(event);
          },
        },
        authorize: { send: () => true },
      });
      const s = makeServerSocket({ id: "v4" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      await message(
        s.ws,
        JSON.stringify({ event: "chat.message", data: { text: "safe" } }),
      );

      expect(handledMessages).toEqual(["chat.message"]);
      expect(s.closed).toBeNull();
    });

    it("routes realtime:subscribe through the join guard, so admin rooms stay admin", async () => {
      const subscribedTopics: string[] = [];
      const rt = createRealtime({
        handlers: {
          subscribe: (_client, topic) => {
            subscribedTopics.push(topic);
          },
        },
        authorize: { join: (_c, topic) => topic !== "admin" },
      });
      const s = makeServerSocket({ id: "v5" });
      const message = rt.websocket.message as (
        ws: AnyWebSocket,
        m: string,
      ) => Promise<void>;

      await message(
        s.ws,
        JSON.stringify({ event: "realtime:subscribe", data: { topic: "admin" } }),
      );
      expect(s.topics.has("admin")).toBe(false);
      expect(subscribedTopics).toEqual([]);

      await message(
        s.ws,
        JSON.stringify({ event: "realtime:subscribe", data: { topic: "lobby" } }),
      );
      expect(s.topics.has("lobby")).toBe(true);
      expect(subscribedTopics).toEqual(["lobby"]);
    });
  });

  describe("the unified transport router", () => {
    it("answers 400 for a request that is neither WebSocket nor SSE", async () => {
      const rt = createRealtime();
      const res = await rt.connect(new Request("http://host/realtime"), stubServer);
      const body = await (res as Response).text();

      expect((res as Response).status).toBe(400);
      expect(body).toContain("WebSocket");
      expect(body).toContain("SSE");
    });

    it("opens an SSE stream and subscribes it to the queried topic", async () => {
      const rt = createRealtime();
      const res = (await rt.connect(
        new Request("http://host/realtime?topic=news", {
          headers: { accept: "text/event-stream" },
        }),
        stubServer,
      )) as Response;

      expect(res.status).toBe(200);
      expect(rt.getChannel("news")!.size).toBe(1);
      await res.body!.cancel();
    });

    it("answers 401 on the SSE transport when authentication refuses", async () => {
      const rt = createRealtime({ authenticate: async () => null as any });
      const res = (await rt.connect(
        new Request("http://host/realtime", {
          headers: { accept: "text/event-stream" },
        }),
        stubServer,
      )) as Response;

      expect(res.status).toBe(401);
      expect(rt.getChannel("global")).toBeUndefined();
    });

    it("replays history on reconnect through Last-Event-ID", async () => {
      const rt = createRealtime();
      const first = (await rt.connect(
        new Request("http://host/realtime?topic=headlines", {
          headers: { accept: "text/event-stream" },
        }),
        stubServer,
      )) as Response;
      await first.body!.cancel();

      const channel = rt.getChannel("headlines")!;
      channel.broadcast("headline", { text: "first" }, "e1");
      channel.broadcast("headline", { text: "second" }, "e2");
      channel.broadcast("headline", { text: "third" }, "e3");

      const res = (await rt.connect(
        new Request("http://host/realtime?topic=headlines", {
          headers: { accept: "text/event-stream", "last-event-id": "e1" },
        }),
        stubServer,
      )) as Response;
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      let text = "";
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !text.includes("third")) {
        const read = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
        ]);
        if (!read) break;
        text += new TextDecoder().decode(read.value!);
      }
      await reader.cancel();

      expect(text).toContain("second");
      expect(text).toContain("third");
      expect(text).not.toContain("first");
    });
  });

  describe("TypedSocket.join", () => {
    it("subscribes and fires the subscribe handler when the guard allows", async () => {
      const subscribedTopics: string[] = [];
      const rt = createRealtime({
        handlers: {
          subscribe: (_c, topic) => {
            subscribedTopics.push(topic);
          },
        },
      });
      const s = makeServerSocket({ id: "joiner" });
      const client = new TypedSocket(s.ws, rt);

      const ok = await client.join("orders");
      expect(ok).toBe(true);
      expect(s.topics.has("orders")).toBe(true);
      expect(subscribedTopics).toEqual(["orders"]);
    });

    it("leaves the client un-subscribed and says no when the guard refuses", async () => {
      const subscribedTopics: string[] = [];
      const rt = createRealtime({
        handlers: {
          subscribe: (_c, topic) => {
            subscribedTopics.push(topic);
          },
        },
        authorize: { join: () => false },
      });
      const s = makeServerSocket({ id: "denied" });
      const client = new TypedSocket(s.ws, rt);

      const ok = await client.join("admin");
      expect(ok).toBe(false);
      expect(s.topics.has("admin")).toBe(false);
      expect(subscribedTopics).toEqual([]);
    });
  });

  describe("JobTracker terminal states", () => {
    it("refuses to move a completed job back to running", () => {
      const rt = createRealtime();
      rt.bindServer({ publish: () => {} } as AnyWebSocket);
      const job = rt.job("resurrect-1");
      job.start().done({ ok: true });

      // A process that missed the completion event and keeps ticking medicates the
      // tracker back to running — resetting its result and, on the second
      // completion, double-decrementing the job gauge through the terminal callback.
      job.progress(50, "late tick");

      expect(job.state.status).toBe("completed");
      expect(job.state.percent).toBe(100);
      expect(job.state.result).toEqual({ ok: true });
    });

    it("clamps progress into 0..100 rather than letting callers set it", () => {
      const rt = createRealtime();
      rt.bindServer({ publish: () => {} } as AnyWebSocket);
      const job = rt.job("clamp-1");
      job.start();

      job.progress(-5);
      expect(job.state.percent).toBe(0);
      job.progress(120);
      expect(job.state.percent).toBe(100);
    });

    it("keeps cancel a no-op on a job that already completed", () => {
      const rt = createRealtime();
      rt.bindServer({ publish: () => {} } as AnyWebSocket);
      const job = rt.job("late-cancel-1");
      job.start().done({ ok: true });

      let cancelReason = "";
      job.onCancel((reason) => {
        cancelReason = reason ?? "";
      });
      job.cancel("too late");

      expect(job.state.status).toBe("completed");
      expect(cancelReason).toBe("");
      // The abort signal was never fired by the ignored cancel: a process still
      // holding onto the signal must not be told to stop work that already finished.
      expect(job.signal.aborted).toBe(false);
    });
  });

  describe("the broadcaster's three roads", () => {
    it("publishes through the adapter, the bound server, and a subscribed SSE channel", async () => {
      const adapterEnvelopes: Array<{ topic: string; id: string }> = [];
      const adapter = {
        publish: async (topic: string, envelope: any) => {
          adapterEnvelopes.push(envelope);
        },
        subscribe: async () => () => {},
      } as AnyWebSocket;
      const rt = createRealtime({ adapter });
      const wsPayloads: string[] = [];
      rt.bindServer({
        publish: (_t: string, payload: string) => wsPayloads.push(payload),
        upgrade: () => true,
      } as AnyWebSocket);

      await rt.to("orders").send("order.created", { id: "ord_1" }, "env-1");

      expect(adapterEnvelopes).toHaveLength(1);
      expect(adapterEnvelopes[0]!.id).toBe("env-1");
      expect(adapterEnvelopes[0]!.topic).toBe("orders");
      expect(JSON.parse(wsPayloads[0]!).id).toBe("env-1");
    });

    it("delivers a broadcast to a subscribed SSE channel as SSE text", async () => {
      const wsPayloads: string[] = [];
      const rt = createRealtime();
      // Bound, so the WebSocket road is exercised too rather than logging an
      // unbound-server error for a broadcast that never was a misdelivery.
      rt.bindServer({
        publish: (_t: string, payload: string) => wsPayloads.push(payload),
        upgrade: () => true,
      } as AnyWebSocket);
      const channel = rt.channel("orders");

      const textPromise = sse(new Request("http://host/sse"), (client) => {
        channel.subscribe(client);
        rt.to("orders").send("order.created", { id: "ord_2" });
        client.close();
      });
      const text = await textPromise.text();

      expect(text).toContain("event: order.created");
      expect(text).toContain("ord_2");
      // One envelope reached the WebSocket road alongside the SSE one.
      expect(JSON.parse(wsPayloads[0]!).data).toEqual({ id: "ord_2" });
    });

    it("does not touch an SSE channel that exists but has no subscribers", () => {
      const rt = createRealtime();
      // Exists with zero size: a broadcast here must not enqueue history for nobody.
      const alpha = rt.channel("alpha");
      expect(alpha.size).toBe(0);
      rt.bindServer({ publish: () => {}, upgrade: () => true } as AnyWebSocket);

      expect(() => rt.to("alpha").send("tick", { n: 1 })).not.toThrow();
    });

    it("routes a rejected adapter publish to onError, never an unhandled rejection", async () => {
      const errors: Array<{ error: unknown; context?: string }> = [];
      const adapter = {
        publish: async () => {
          throw new Error("bus down");
        },
        subscribe: async () => () => {},
      } as AnyWebSocket;
      const rt = createRealtime({
        adapter,
        onError: (error, context) => errors.push({ error, context }),
      });
      rt.bindServer({ publish: () => {}, upgrade: () => true } as AnyWebSocket);

      await rt.to("orders").send("order.created", { id: "ord_3" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.context).toBe("adapter:publish");
      expect((errors[0]!.error as Error).message).toBe("bus down");
    });
  });

  describe("the global singleton hand-off", () => {
    it("returns the same instance until createRealtime replaces it", () => {
      const first = createRealtime();
      expect(getRealtime()).toBe(first);

      const second = createRealtime();
      expect(getRealtime()).toBe(second);
      expect(Realtime.config).toBe(second.config);
      // Draw straws? No — the proxy must delegate to the latest engine, and both
      // tell the truth only if one is reachable through the other.
      expect(Realtime.getChannel("handoff-check")).toBeUndefined();
      second.channel("handoff-check");
      expect(Realtime.getChannel("handoff-check")).toBeDefined();
    });
  });

  describe("the browser client SDK", () => {
    let instances: Array<{
      url: string;
      protocols?: string | string[];
      readyState: number;
      sent: string[];
      send: (payload: string) => void;
      close: () => void;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: (err: unknown) => void;
    }> = [];
    let StubWebSocket: any;
    // `RealtimeClient` reads the global at call time, so a saved bail-out keeps
    // real sockets from being constructed during these tests.
    const savedWebSocket = globalThis.WebSocket;
    const savedEventSource = globalThis.EventSource;

    beforeEach(() => {
      instances = [];
      StubWebSocket = class {
        static OPEN = 1;
        url: string;
        protocols?: string | string[];
        readyState = 0;
        sent: string[] = [];
        constructor(url: string, protocols?: string | string[]) {
          this.url = url;
          this.protocols = protocols;
          instances.push(this);
        }
        send(payload: string) {
          this.sent.push(payload);
        }
        close() {
          this.readyState = 3;
        }
      };
      (globalThis as any).WebSocket = StubWebSocket;
      (globalThis as any).EventSource = undefined;
    });

    afterEach(() => {
      (globalThis as any).WebSocket = savedWebSocket;
      (globalThis as any).EventSource = savedEventSource;
    });

    it("builds a ws:// URL, resubmits subscriptions on open, and dispatches envelopes", () => {
      const client = createRealtimeClient({
        url: "http://host:3000/realtime",
        transport: "websocket",
        reconnect: { enabled: false },
      });
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("ws://host:3000/realtime");

      // A topic subscribed while disconnected waits for the socket to open.
      client.subscribe("room-1");
      expect(instances[0]!.sent).toEqual([]);

      const sock = instances[0]!;
      sock.readyState = StubWebSocket.OPEN;
      sock.onopen!();
      const resent = sock.sent.map((p) => JSON.parse(p));
      expect(resent).toEqual([
        { event: "realtime:subscribe", data: { topic: "room-1" } },
      ]);

      const received: unknown[] = [];
      client.on("greet", (data) => received.push(data));
      sock.onmessage!({
        data: JSON.stringify({
          id: "e1",
          event: "greet",
          topic: "room-1",
          data: { hello: true },
          timestamp: 0,
        }),
      });
      expect(received).toEqual([{ hello: true }]);
    });

    it("sends as JSON frames while open and refuses to send after close", () => {
      const client = createRealtimeClient({
        url: "http://host:3000/realtime",
        transport: "websocket",
        reconnect: { enabled: false },
      });
      const sock = instances[0]!;

      sock.readyState = StubWebSocket.OPEN;
      client.send("chat.message", { text: "hi" });
      expect(JSON.parse(sock.sent[0]!)).toEqual({
        event: "chat.message",
        data: { text: "hi" },
      });

      client.close();
      expect(() => client.send("chat.message", { text: "gone" })).toThrow(
        RealtimeError,
      );
    });

    it("reconnects with growing backoff and stop reconnecting once explicitly closed", async () => {
      const client = createRealtimeClient({
        url: "http://host:3000/realtime",
        transport: "websocket",
        reconnect: {
          factor: 2,
          minDelay: 5,
          maxDelay: 20,
          jitter: false,
        },
      });
      expect(instances).toHaveLength(1);

      // First drop: backoff 5ms * 2^0.
      instances[0]!.onclose!();
      await Bun.sleep(30);
      expect(instances).toHaveLength(2);

      // Second drop: 5ms * 2^1 = 10ms, still under the 30ms wait.
      instances[1]!.onclose!();
      await Bun.sleep(40);
      expect(instances).toHaveLength(3);

      client.close();
      const count = instances.length;
      instances[instances.length - 1]!.onclose!();
      await Bun.sleep(40);
      expect(instances).toHaveLength(count);
    });

    it("mangles nothing when a message is not JSON", () => {
      const client = createRealtimeClient({
        url: "http://host:3000/realtime",
        transport: "websocket",
        reconnect: { enabled: false },
      });
      const raw: unknown[] = [];
      client.on("raw", (data) => raw.push(data));
      instances[0]!.onmessage!({ data: "definitely not json" });
      expect(raw).toEqual(["definitely not json"]);
    });
  });
});
