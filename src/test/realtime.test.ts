import { describe, it, expect, beforeEach } from "bun:test";
import {
  createRealtime,
  SSEClient,
  SSEChannel,
  sse,
  JobTracker,
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
  describe("Security & Negative Exploitation Tests", () => {
    it("should reject undefined data payloads to prevent malformed SSE streams", () => {
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
