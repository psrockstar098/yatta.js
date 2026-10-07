/**
 * ============================================================================
 *  YATTA REALTIME — Enterprise Unified SSE & Native WebSockets for Bun
 * ============================================================================
 *
 *  OVERVIEW:
 *  Unified realtime engine designed for Bun's high-speed HTTP and WebSocket primitives.
 *  Combines Server-Sent Events (SSE) and native WebSockets with topic-based pub/sub,
 *  AI/LLM token streaming (`streamText`), async job tracking (`JobTracker`),
 *  backpressure management, rate limiting, and connection lifecycle telemetry.
 *
 *  KEY EXPORTS:
 *  - `createRealtime(config?)`: Factory creating a configured `RealtimeServer` instance.
 *  - `Realtime`: Global default proxy singleton for zero-config setups.
 *  - `RealtimeServer`: Core engine facade providing:
 *    - `.connect(req, server)`: Auto-routes between WebSocket upgrade and SSE connection.
 *    - `.upgrade(req, server)`: Upgrades an HTTP request to native WebSocket with auth.
 *    - `.to(topic)`: Returns a `RealtimeBroadcaster` publishing across WS, SSE, and PubSub.
 *    - `.channel(name)`: Retrieves or creates an auto-pruning named `SSEChannel`.
 *    - `.job(id)`: Returns a `JobTracker` to broadcast async job progress.
 *    - `.websocket`: Handler object passed directly to `Bun.serve({ websocket })`.
 *  - `SSEClient`: Client connection wrapper offering:
 *    - `.send(event, data, id?)`: Dispatches formatted SSE frames with newline sanitization.
 *    - `.streamText(source, options?)`: Streams LLM tokens or async iterables with finish events.
 *  - `JobTracker`: Tracks long-running tasks: `.progress(percent, msg)`, `.done(result)`, `.fail(err)`.
 *  - `RealtimeClient`: Isomorphic client SDK supporting auto-transport selection and exponential backoff.
 *
 *  MODULE AUGMENTATION:
 *  ```ts
 *  declare module "./realtime" {
 *    interface RealtimeRegister {
 *      events: {
 *        "chat.message": { user: string; text: string };
 *        "order.status": { orderId: string; status: string };
 *      };
 *    }
 *  }
 *  ```
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { createRealtime } from "./realtime";
 *
 *  export const realtime = createRealtime<{ userId: string }>({
 *    authenticate: (req) => {
 *      const token = req.headers.get("Authorization");
 *      return token ? { userId: "usr_123" } : null;
 *    },
 *  });
 *
 *  // In Bun.serve fetch handler:
 *  export default {
 *    fetch(req, server) {
 *      const url = new URL(req.url);
 *      if (url.pathname === "/realtime") {
 *        return realtime.connect(req, server);
 *      }
 *      return new Response("Not found", { status: 404 });
 *    },
 *    websocket: realtime.websocket,
 *  };
 *
 *  // Broadcast an event across all WebSocket & SSE subscribers:
 *  realtime.to("general").send("chat.message", { user: "Bob", text: "Hello world!" });
 *  ```
 */

import type { Server, ServerWebSocket } from "bun";

// ──────────────────────────────────────────────────────────────────────────
// 0. Type Registry & Envelopes
// ──────────────────────────────────────────────────────────────────────────

/**
 * Base exception thrown by the Yatta Realtime engine for protocol, connection, and stream errors.
 *
 * @example
 * ```ts
 * try {
 *   client.send("chat.message", undefined);
 * } catch (error) {
 *   if (error instanceof RealtimeError) {
 *     console.error(error.message, error.code);
 *   }
 * }
 * ```
 */
export class RealtimeError extends Error {
  /**
   * @param message Human-readable error message.
   * @param code Optional machine-readable error code (e.g. `"ABORTED"`, `"RATE_LIMIT"`).
   */
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "RealtimeError";
  }
}

/**
 * Global interface augmented by application code for typed event names and payloads.
 *
 * @example
 * ```ts
 * declare module "./realtime" {
 *   interface RealtimeRegister {
 *     events: {
 *       "chat.message": { user: string; text: string };
 *       "order.status": { orderId: string; status: string };
 *     };
 *   }
 * }
 * ```
 */
export interface RealtimeRegister {}

/**
 * Extracts the registered events map from {@link RealtimeRegister}, or falls back to a generic event map.
 */
export type RegisteredEvents = RealtimeRegister extends {
  events: infer E extends Record<string, unknown>;
}
  ? E
  : Record<string, unknown>;

/**
 * Type-level boolean indicating if a custom event registry has been configured via module augmentation.
 */
export type IsRegistryConfigured = RealtimeRegister extends { events: any }
  ? true
  : false;

/**
 * Resolves the payload type for a given event name `K`.
 * Returns the registered payload type if the registry is configured, otherwise `unknown`.
 *
 * @template K Event name string.
 */
export type EventPayload<K extends string> = IsRegistryConfigured extends true
  ? K extends keyof RegisteredEvents
    ? RegisteredEvents[K]
    : unknown
  : unknown;

/**
 * Standard realtime message envelope wrapping all events sent over WebSocket or SSE channels.
 *
 * @template T Payload data type.
 */
export interface RealtimeEnvelope<T = unknown> {
  /** Unique event message identifier (UUID). */
  id: string;
  /** Event type name (e.g. `"chat.message"`, `"job:status"`). */
  event: string;
  /** Optional pub/sub topic name this event was routed on. */
  topic?: string;
  /** Strongly-typed event payload data. */
  data: T;
  /** Unix millisecond timestamp when the event was dispatched. */
  timestamp: number;
}

/**
 * AI/LLM streaming chunk frame sent during active token streaming.
 */
export type AIStreamChunk = {
  /** Frame type discriminant. */
  type: "chunk";
  /** Unique stream session identifier. */
  streamId: string;
  /** Token or text chunk emitted by the model. */
  text: string;
  /** Sequential chunk index (0-based). */
  index: number;
};

/**
 * AI/LLM streaming completion frame emitted when the stream finishes.
 */
export type AIStreamDone = {
  /** Frame type discriminant. */
  type: "done";
  /** Unique stream session identifier. */
  streamId: string;
  /** Completion reason. */
  reason: "completed" | "aborted" | "cancelled" | "failed";
  /** Optional token usage statistics from the language model. */
  usage?: {
    /** Number of input/prompt tokens consumed. */
    inputTokens?: number;
    /** Number of output/generated tokens produced. */
    outputTokens?: number;
    /** Total tokens consumed. */
    totalTokens?: number;
  };
};

/**
 * AI/LLM streaming error frame emitted when the stream encounters an irrecoverable error.
 */
export type AIStreamError = {
  /** Frame type discriminant. */
  type: "error";
  /** Unique stream session identifier. */
  streamId: string;
  /** Error details. */
  error: {
    /** Machine-readable error code (e.g. `"STREAM_ERROR"`, `"READER_ERROR"`). */
    code: string;
    /** Human-readable error description. */
    message: string;
  };
};

/**
 * Discriminated union of AI/LLM stream frame types transmitted over SSE.
 */
export type AIStreamEnvelope = AIStreamChunk | AIStreamDone | AIStreamError;

/**
 * Structured logger interface for realtime engine diagnostics.
 */
export interface Logger {
  /** Emit debug-level trace messages. */
  debug(...args: unknown[]): void;
  /** Emit informational operational messages. */
  info(...args: unknown[]): void;
  /** Emit warning-level messages. */
  warn(...args: unknown[]): void;
  /** Emit error-level messages. */
  error(...args: unknown[]): void;
}

const defaultLogger: Logger = {
  debug: () => {},
  info: (...args) => console.log("[realtime:info]", ...args),
  warn: (...args) => console.warn("[realtime:warn]", ...args),
  error: (...args) => console.error("[realtime:error]", ...args),
};

/**
 * Strips carriage returns and newlines from control fields to prevent SSE response-splitting attacks.
 *
 * @param value Raw field string.
 * @returns Sanitized single-line string.
 */
function sanitizeSSEField(value: string): string {
  return value.replace(/[\r\n]+/g, "");
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Horizontal Scaling: PubSub Adapter Architecture
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pluggable publish/subscribe adapter interface enabling horizontal scaling across multiple server nodes.
 * Swap `InMemoryPubSubAdapter` with a Redis, NATS, or database-backed adapter for multi-node clusters.
 *
 * @example
 * ```ts
 * class RedisPubSubAdapter implements PubSubAdapter {
 *   async publish(topic: string, envelope: RealtimeEnvelope) {
 *     await redis.publish(topic, JSON.stringify(envelope));
 *   }
 *   async subscribe(topic: string, handler: (envelope: RealtimeEnvelope) => void) {
 *     const sub = redis.duplicate();
 *     await sub.subscribe(topic, (msg) => handler(JSON.parse(msg)));
 *     return () => sub.unsubscribe(topic);
 *   }
 * }
 * ```
 */
export interface PubSubAdapter {
  /**
   * Publish an envelope to all subscribers of a topic across the cluster.
   *
   * @param topic Topic name.
   * @param envelope Realtime message envelope.
   */
  publish(topic: string, envelope: RealtimeEnvelope): Promise<void>;

  /**
   * Subscribe to a topic, returning an unsubscribe cleanup function.
   *
   * @param topic Topic name.
   * @param handler Callback invoked when an envelope is received for this topic.
   * @returns Async function that terminates the subscription when called.
   */
  subscribe(
    topic: string,
    handler: (envelope: RealtimeEnvelope) => void,
  ): Promise<() => void>;

  /**
   * Optional cleanup hook for closing client connections.
   */
  close?(): Promise<void>;
}

/**
 * Default single-process in-memory pub/sub adapter.
 * Routes messages directly between subscribers in the same process without network I/O.
 * Replace with a distributed adapter when deploying across multiple server instances.
 */
export class InMemoryPubSubAdapter implements PubSubAdapter {
  private handlers = new Map<string, Set<(env: RealtimeEnvelope) => void>>();

  /**
   * Publishes an envelope to all in-process subscribers of the given topic.
   *
   * @param topic Topic name.
   * @param envelope Realtime message envelope.
   */
  async publish(topic: string, envelope: RealtimeEnvelope): Promise<void> {
    const list = this.handlers.get(topic);
    if (list) {
      for (const handler of list) {
        try {
          handler(envelope);
        } catch {}
      }
    }
  }

  /**
   * Subscribes to a topic with a handler callback.
   *
   * @param topic Topic name.
   * @param handler Callback invoked on each published envelope.
   * @returns Async cleanup function to unsubscribe.
   */
  async subscribe(
    topic: string,
    handler: (env: RealtimeEnvelope) => void,
  ): Promise<() => void> {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) {
        this.handlers.delete(topic);
      }
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Metrics & Telemetry
// ──────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of realtime engine operational statistics at a given moment.
 */
export interface RealtimeStats {
  /** Number of active WebSocket client connections. */
  websocketConnections: number;
  /** Number of active SSE (Server-Sent Events) client connections. */
  sseConnections: number;
  /** Number of active named SSE channels. */
  topics: number;
  /** Cumulative count of messages dispatched outward. */
  messagesSent: number;
  /** Cumulative count of messages received from clients. */
  messagesReceived: number;
  /** Cumulative bytes sent across all transports. */
  bytesSent: number;
  /** Cumulative bytes received from all clients. */
  bytesReceived: number;
  /** Count of currently active in-progress job trackers. */
  activeJobs: number;
}

/**
 * Internal metrics accumulator tracking connection counts, message throughput, and byte transfer totals.
 * Use `.snapshot()` to read current counters as a {@link RealtimeStats} object.
 */
export class MetricsCollector {
  private wsCount = 0;
  private sseCount = 0;
  private msgSent = 0;
  private msgReceived = 0;
  private bytesOut = 0;
  private bytesIn = 0;
  private activeJobsCount = 0;

  /** Increments the active WebSocket connection counter by 1. */
  incWS() {
    this.wsCount++;
  }
  /** Decrements the active WebSocket connection counter by 1 (floored at 0). */
  decWS() {
    this.wsCount = Math.max(0, this.wsCount - 1);
  }
  /** Increments the active SSE connection counter by 1. */
  incSSE() {
    this.sseCount++;
  }
  /** Decrements the active SSE connection counter by 1 (floored at 0). */
  decSSE() {
    this.sseCount = Math.max(0, this.sseCount - 1);
  }
  /**
   * Records an outbound message and increments cumulative byte totals.
   * @param bytes Byte length of the dispatched frame.
   */
  recordSent(bytes: number) {
    this.msgSent++;
    this.bytesOut += bytes;
  }
  /**
   * Records an inbound message and increments cumulative byte totals.
   * @param bytes Byte length of the received frame.
   */
  recordReceived(bytes: number) {
    this.msgReceived++;
    this.bytesIn += bytes;
  }
  /** Increments the count of active background job trackers. */
  incJob() {
    this.activeJobsCount++;
  }
  /** Decrements the count of active background job trackers (floored at 0). */
  decJob() {
    this.activeJobsCount = Math.max(0, this.activeJobsCount - 1);
  }

  /**
   * Returns a point-in-time snapshot copy of current operational metrics.
   *
   * @param topicCount Current number of active named SSE channels.
   * @returns Immutable {@link RealtimeStats} snapshot.
   */
  snapshot(topicCount: number): RealtimeStats {
    return {
      websocketConnections: this.wsCount,
      sseConnections: this.sseCount,
      topics: topicCount,
      messagesSent: this.msgSent,
      messagesReceived: this.msgReceived,
      bytesSent: this.bytesOut,
      bytesReceived: this.bytesIn,
      activeJobs: this.activeJobsCount,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Server-Sent Events (SSE) Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Configuration options for the Server-Sent Events (SSE) transport layer.
 */
export interface SSEOptions {
  /** Additional HTTP response headers to merge into the SSE response. */
  headers?: Record<string, string>;
  /**
   * Interval in milliseconds between keep-alive comment pings (`: keep-alive ping`).
   * Set to `0` to disable heartbeats.
   * @default 15000
   */
  heartbeatInterval?: number; // ms (default: 15_000)
  /**
   * Client-side reconnect delay hint in milliseconds, sent as the SSE `retry:` field.
   */
  retry?: number; // reconnect ms
  /**
   * Maximum number of events buffered for a slow consumer before backpressure is triggered.
   * @default 1024
   */
  maxBufferedEvents?: number; // Slow consumer backpressure limit
  /**
   * Number of recent events to retain for `Last-Event-ID` reconnection replay.
   * Applies per-channel, not per-client.
   * @default 100
   */
  historySize?: number; // Number of events to keep for Last-Event-ID replay
  /**
   * Custom backpressure handler invoked when a slow client's buffer is full.
   * If not provided, the client connection is terminated automatically.
   */
  onBackpressure?: (client: SSEClient) => void;
}

/**
 * Represents a single SSE connection to a browser or HTTP client.
 * Provides methods to emit typed events, stream AI/LLM tokens, and manage connection lifecycle.
 *
 * @template TData Shape of the per-connection session data attached to this connection.
 *
 * @example
 * ```ts
 * sse(req, (client) => {
 *   client.send("welcome", { message: "connected!" });
 *   const timer = setInterval(() => {
 *     client.send("tick", { time: Date.now() });
 *   }, 1000);
 *   client.signal.addEventListener("abort", () => clearInterval(timer));
 * });
 * ```
 */
export class SSEClient<TData = Record<string, unknown>> {
  private isClosed = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Events written to this stream. Kept for metrics, not for the limit check. */
  private bufferedEventCount = 0;
  /** `AbortSignal` that fires when the client disconnects. Use to clean up resources. */
  readonly signal: AbortSignal;
  /** Unique UUID assigned to this SSE connection. */
  readonly id: string;
  /** Mutable per-connection session data. Useful for storing auth state or metadata. */
  public data: TData;

  /**
   * @param controller Underlying `ReadableStreamDefaultController` managing the HTTP response body.
   * @param request Incoming HTTP `Request`.
   * @param options SSE transport configuration options.
   * @param data Initial session data.
   * @param metrics Optional metrics collector.
   * @param logger Optional structured logger.
   */
  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    readonly request: Request,
    private readonly options: SSEOptions = {},
    data?: TData,
    private readonly metrics?: MetricsCollector,
    private readonly logger?: Logger,
  ) {
    this.signal = request.signal;
    this.id = crypto.randomUUID();
    this.data = (data ?? {}) as TData;

    this.signal.addEventListener("abort", () => {
      this.close();
    });

    const interval = options.heartbeatInterval ?? 15_000;
    if (interval > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.isClosed) return;
        this.comment("keep-alive ping");
      }, interval);
    }

    // Fix 6: Supports retry: 0
    if (options.retry !== undefined) {
      this.write(`retry: ${options.retry}\n\n`);
    }
  }

  private write(payload: string): boolean {
    if (this.isClosed || this.signal.aborted) return false;

    /*
     * Backpressure is read from the stream itself, not from a counter.
     *
     * The counter used to be incremented and decremented around a synchronous
     * `controller.enqueue`, so it was always 0 at the next check: the documented
     * limit was unreachable, `onBackpressure` never fired, and a slow consumer
     * was never disconnected — its queue grew until the process ran out of
     * memory. `desiredSize` is the actual signal: it goes negative once the
     * internal queue is full.
     */
    const maxQueue = this.options.maxBufferedEvents ?? 1024;
    const queued = this.controller.desiredSize === null ? 0 : -this.controller.desiredSize;

    if (queued >= maxQueue) {
      this.logger?.warn(
        `[SSEClient:${this.id}] Backpressure limit exceeded (${queued}/${maxQueue}).`,
      );
      if (this.options.onBackpressure) {
        this.options.onBackpressure(this as unknown as SSEClient);
      } else {
        // With no handler to apply its own policy, dropping the connection is the
        // only way to stop an unbounded queue — and the client reconnects with
        // Last-Event-ID, so history covers the gap.
        this.close();
      }
      return false;
    }

    try {
      const bytes = new TextEncoder().encode(payload);
      this.controller.enqueue(bytes);
      this.bufferedEventCount++;
      this.metrics?.recordSent(bytes.byteLength);
      return true;
    } catch (err) {
      this.close();
      return false;
    }
  }

  /**
   * Send a typed named event with data payload and optional message ID.
   *
   * @param event Registered or arbitrary event name.
   * @param data Event payload (must be JSON-serializable).
   * @param id Optional event ID for `Last-Event-ID` reconnection support.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * client.send("user.joined", { userId: "abc", name: "Alice" });
   * client.send("chat.message", { text: "Hello!" }, "msg-001");
   * client.send({ raw: "anonymous data" }); // no event name
   * ```
   */
  send<K extends keyof RegisteredEvents>(
    event: K,
    data: RegisteredEvents[K],
    id?: string,
  ): this;
  send(event: string, data: unknown, id?: string): this;
  send(data: unknown): this;
  send(arg1: unknown, arg2?: unknown, id?: string): this {
    if (this.isClosed) return this;

    let eventName: string | undefined;
    let dataPayload: unknown;

    if (arg2 !== undefined) {
      eventName = String(arg1);
      dataPayload = arg2;
    } else {
      dataPayload = arg1;
    }

    // Fix 5: Disallow undefined data payloads explicitly
    if (dataPayload === undefined) {
      throw new RealtimeError(
        "SSE data payload cannot be undefined. Use null or a valid value.",
      );
    }

    let rawData: string;
    if (typeof dataPayload === "string") {
      rawData = dataPayload;
    } else {
      const serialized = JSON.stringify(dataPayload);
      if (serialized === undefined) {
        throw new RealtimeError("SSE data must be JSON serializable.");
      }
      rawData = serialized;
    }

    let payload = "";
    // Fix 4: Sanitize line-oriented control fields
    if (id !== undefined) payload += `id: ${sanitizeSSEField(String(id))}\n`;
    if (eventName !== undefined)
      payload += `event: ${sanitizeSSEField(eventName)}\n`;

    const lines = rawData.split(/\r\n|\r|\n/);
    for (const line of lines) {
      payload += `data: ${line}\n`;
    }
    payload += "\n";

    this.write(payload);
    return this;
  }

  /**
   * Send an SSE comment line (begins with `:`). Useful for keep-alive pings or debug annotations.
   * Comments are ignored by browsers and event parsers.
   *
   * @param text Comment text.
   * @returns `this` for chaining.
   */
  comment(text: string): this {
    this.write(`: ${sanitizeSSEField(text)}\n\n`);
    return this;
  }

  /**
   * First-class LLM / AI token streaming protocol.
   * Streams text chunks from an `AsyncIterable`, `ReadableStream`, or async producer function,
   * emitting typed `AIStreamEnvelope` frames (chunk → done/error) over SSE.
   *
   * Handles client disconnect gracefully — will abort the stream and emit a `done/aborted` frame.
   *
   * @param source Token source: async iterable, readable stream, or a callback-based producer.
   * @param options Streaming options including event name, stream ID override, and token usage reporter.
   *
   * @example
   * ```ts
   * await client.streamText(llm.stream("Tell me a joke"), {
   *   eventName: "ai:stream",
   *   streamId: "session-123",
   *   usage: () => ({ inputTokens: 10, outputTokens: 25 }),
   * });
   * ```
   */
  async streamText(
    source:
      | AsyncIterable<string>
      | ReadableStream<string>
      | ((emit: (chunk: string) => void) => Promise<void>),
    options: {
      eventName?: string;
      streamId?: string;
      usage?: () => { inputTokens?: number; outputTokens?: number };
    } = {},
  ): Promise<void> {
    const eventName = options.eventName ?? "ai:stream";
    const streamId = options.streamId ?? crypto.randomUUID();
    let chunkIndex = 0;

    const emitChunk = (text: string) => {
      const chunkMsg: AIStreamEnvelope = {
        type: "chunk",
        streamId,
        text,
        index: chunkIndex++,
      };
      this.send(eventName, chunkMsg);
    };

    if (typeof source === "function") {
      try {
        await source((chunk) => {
          if (this.signal.aborted)
            throw new RealtimeError("Stream aborted by client", "ABORTED");
          emitChunk(chunk);
        });
        const doneMsg: AIStreamEnvelope = {
          type: "done",
          streamId,
          reason: "completed",
          usage: options.usage?.(),
        };
        this.send(eventName, doneMsg);
      } catch (err: any) {
        const isAbort = this.signal.aborted || err?.code === "ABORTED";
        const doneMsg: AIStreamEnvelope = isAbort
          ? { type: "done", streamId, reason: "aborted" }
          : {
              type: "error",
              streamId,
              error: {
                code: "STREAM_ERROR",
                message: String(err?.message ?? err),
              },
            };
        this.send(eventName, doneMsg);
      }
      return;
    }

    if (Symbol.asyncIterator in source) {
      try {
        for await (const chunk of source) {
          if (this.signal.aborted) {
            this.send(eventName, { type: "done", streamId, reason: "aborted" });
            return;
          }
          emitChunk(chunk);
        }
        this.send(eventName, {
          type: "done",
          streamId,
          reason: "completed",
          usage: options.usage?.(),
        });
      } catch (err: any) {
        this.send(eventName, {
          type: "error",
          streamId,
          error: {
            code: "ITERATION_ERROR",
            message: String(err?.message ?? err),
          },
        });
      }
      return;
    }

    // ReadableStream Handling
    const reader = (source as ReadableStream<string>).getReader();
    try {
      while (true) {
        if (this.signal.aborted) {
          await reader.cancel("Client disconnected");
          this.send(eventName, { type: "done", streamId, reason: "aborted" });
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          this.send(eventName, {
            type: "done",
            streamId,
            reason: "completed",
            usage: options.usage?.(),
          });
          break;
        }

        if (value) {
          emitChunk(value);
        }
      }
    } catch (err: any) {
      if (this.signal.aborted) {
        await reader.cancel("Client disconnected").catch(() => {});
      }
      this.send(eventName, {
        type: "error",
        streamId,
        error: { code: "READER_ERROR", message: String(err?.message ?? err) },
      });
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Closes the SSE connection, stopping the heartbeat and terminating the readable stream.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.controller.close();
    } catch {}
  }
}

/**
 * Named SSE broadcast channel — a group of {@link SSEClient} connections subscribed to the same topic.
 * Supports message history for `Last-Event-ID` reconnection replay and auto-cleanup when empty.
 *
 * @template TEvents Registered event map for this channel.
 *
 * @example
 * ```ts
 * const ch = realtime.channel("notifications");
 * ch.broadcast("alert", { level: "info", message: "Deploy complete" });
 * console.log(`${ch.size} clients listening`);
 * ```
 */
export class SSEChannel<
  TEvents extends Record<string, unknown> = RegisteredEvents,
> {
  private subscribers = new Set<SSEClient<any>>();
  private messageHistory: Array<{ id: string; event: string; data: unknown }> =
    [];

  /**
   * @param name Channel name — used as the pub/sub topic identifier.
   * @param onEmpty Optional callback triggered when the last subscriber leaves.
   * @param maxHistory Maximum number of recent messages to retain for `Last-Event-ID` replay.
   */
  constructor(
    /** Channel name — used as the pub/sub topic identifier. */
    readonly name: string,
    private readonly onEmpty?: (name: string) => void,
    private readonly maxHistory = 100,
  ) {}

  /** Returns the number of active subscribers currently connected to this channel. */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Adds a client to this channel and wires up an abort listener to auto-remove on disconnect.
   *
   * @param client SSE client to subscribe.
   */
  subscribe(client: SSEClient<any>): void {
    this.subscribers.add(client);
    client.signal.addEventListener("abort", () => {
      this.remove(client);
    });
  }

  /**
   * Removes a client from this channel's subscriber set.
   * If the channel becomes empty, the `onEmpty` cleanup callback is called.
   *
   * @param client SSE client to remove.
   */
  remove(client: SSEClient<any>): void {
    this.subscribers.delete(client);
    // Fix 1: Auto-pruning empty dynamic SSE channels
    if (this.subscribers.size === 0 && this.onEmpty) {
      this.onEmpty(this.name);
    }
  }

  /**
   * Replays missed historical events to a reconnecting client, starting after `lastEventId`.
   *
   * @param client The reconnecting SSE client.
   * @param lastEventId The `Last-Event-ID` header value from the client's reconnect request.
   */
  replayHistory(client: SSEClient<any>, lastEventId: string): void {
    const lastIndex = this.messageHistory.findIndex(
      (m) => m.id === lastEventId,
    );
    if (lastIndex !== -1) {
      const missed = this.messageHistory.slice(lastIndex + 1);
      for (const msg of missed) {
        client.send(msg.event, msg.data, msg.id);
      }
    }
  }

  /**
   * Broadcasts a typed event to all connected subscribers on this channel.
   * The event is also recorded in the channel's message history for reconnection replay.
   *
   * @param event Event name from the registered event map.
   * @param data Event payload.
   * @param id Optional message ID; auto-generated UUID if omitted.
   *
   * @example
   * ```ts
   * channel.broadcast("order.updated", { orderId: "x", status: "shipped" });
   * ```
   */
  broadcast<K extends keyof TEvents>(
    event: K,
    data: TEvents[K],
    id?: string,
  ): void;
  broadcast(event: string, data: unknown, id?: string): void;
  broadcast(event: string, data: unknown, id?: string): void {
    const eventId = id ?? crypto.randomUUID();

    if (this.maxHistory > 0) {
      this.messageHistory.push({ id: eventId, event, data });
      if (this.messageHistory.length > this.maxHistory) {
        this.messageHistory.shift();
      }
    }

    for (const client of this.subscribers) {
      client.send(event, data, eventId);
    }
  }
}

/**
 * Creates an SSE `Response` for a given HTTP request, establishing a persistent SSE stream.
 * Protocol-critical SSE headers override any custom headers provided in `options`.
 *
 * @template TData Shape of per-connection session data passed to the handler.
 * @param req Incoming HTTP `Request`.
 * @param handler Callback invoked with the connected {@link SSEClient}. May be async.
 * @param options SSE transport configuration.
 * @param initialData Initial per-connection data attached to `client.data`.
 * @param metrics Optional metrics collector.
 * @param logger Optional structured logger.
 * @returns An HTTP `Response` with `Content-Type: text/event-stream`.
 *
 * @example
 * ```ts
 * export function GET(req: Request) {
 *   return sse(req, async (client) => {
 *     client.send("connected", { id: client.id });
 *     for await (const event of eventSource) {
 *       if (client.signal.aborted) break;
 *       client.send("update", event);
 *     }
 *   });
 * }
 * ```
 */
// Fix 7: Protocol-critical SSE headers override custom headers
export function sse<TData = Record<string, unknown>>(
  req: Request,
  handler: (client: SSEClient<TData>) => void | Promise<void>,
  options: SSEOptions = {},
  initialData?: TData,
  metrics?: MetricsCollector,
  logger?: Logger,
): Response {
  let sseClient: SSEClient<TData>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClient = new SSEClient(
        controller,
        req,
        options,
        initialData,
        metrics,
        logger,
      );
      metrics?.incSSE();

      Promise.resolve(handler(sseClient)).catch((err) => {
        logger?.error("[SSE:HandlerError]", err);
        sseClient.close();
      });
    },
    cancel() {
      metrics?.decSSE();
      sseClient?.close();
    },
  });

  const responseHeaders = new Headers(options.headers);
  responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-cache, no-transform");
  responseHeaders.set("Connection", "keep-alive");
  responseHeaders.set("X-Accel-Buffering", "no");

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Job Lifecycle & Cancellation Engine (Fixes 13 & 14)
// ──────────────────────────────────────────────────────────────────────────

/**
 * All possible lifecycle states for a tracked background job.
 * - `"pending"` — Job created but not yet started.
 * - `"running"` — Job is currently executing.
 * - `"paused"` — Job has been paused mid-execution.
 * - `"completed"` — Job finished successfully.
 * - `"failed"` — Job terminated with an error.
 * - `"cancelled"` — Job was cancelled by the caller.
 */
export type JobStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Serializable snapshot of a job's current lifecycle state, broadcast to clients via SSE.
 *
 * @template TResult Type of the job's result payload on completion.
 */
export interface JobState<TResult = unknown> {
  /** Unique job identifier. */
  jobId: string;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Progress percentage (0–100). */
  percent: number;
  /** Human-readable status message for display in UIs. */
  message: string;
  /** Result value emitted on successful completion. */
  result?: TResult;
  /** Error message string emitted on failure. */
  error?: string;
  /** Unix millisecond timestamp of the last state update. */
  updatedAt: number;
  /** Optional arbitrary extra metadata for custom progress data. */
  extra?: Record<string, unknown>;
}

/**
 * Tracks and broadcasts the lifecycle of a long-running background job over SSE.
 * Use the builder-style methods to transition through job states (`start → progress → done/fail`).
 * Clients receive live updates via the `job:status` event on the SSE channel.
 *
 * @template TResult Type of the job's result payload.
 *
 * @example
 * ```ts
 * const tracker = realtime.job("reports");
 * tracker.start("Generating report...");
 * await generateReport((pct) => tracker.progress(pct, `${pct}% done`));
 * tracker.done({ url: "/reports/latest.pdf" }, "Report ready");
 * ```
 */
export class JobTracker<TResult = unknown> {
  private abortController = new AbortController();
  private cancelCallbacks: Array<(reason?: string) => void> = [];
  /** Current serializable job state snapshot. */
  public state: JobState<TResult>;

  /**
   * @param jobId Unique job identifier for routing and client tracking.
   * @param broadcaster Realtime broadcaster used to dispatch state updates.
   * @param onLifecycleChange Optional callback fired whenever the job state updates.
   */
  constructor(
    /** Unique job identifier for routing and client tracking. */
    readonly jobId: string,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly onLifecycleChange?: (job: JobTracker<any>) => void,
  ) {
    this.state = {
      jobId,
      status: "pending",
      percent: 0,
      message: "Initialized",
      updatedAt: Date.now(),
    };
  }

  /** `AbortSignal` that is triggered when the job is cancelled. Use to cooperatively stop work. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  private dispatch() {
    this.state.updatedAt = Date.now();
    this.broadcaster.send("job:status", this.state);
    this.onLifecycleChange?.(this);
  }

  /**
   * Transitions the job to `running` and broadcasts the update.
   *
   * @param message Status message displayed in client UIs.
   * @returns `this` for chaining.
   */
  start(message = "Job started"): this {
    this.state.status = "running";
    this.state.message = message;
    this.dispatch();
    return this;
  }

  /**
   * Updates the job's progress percentage and optional status message.
   * No-op if the job is already in a terminal state (`cancelled` or `failed`).
   *
   * @param percent Progress 0–100 (clamped automatically).
   * @param message Optional status message.
   * @param extra Optional extra metadata to merge into `state.extra`.
   * @returns `this` for chaining.
   */
  progress(
    percent: number,
    message?: string,
    extra?: Record<string, unknown>,
  ): this {
    if (this.state.status === "cancelled" || this.state.status === "failed")
      return this;
    this.state.status = "running";
    this.state.percent = Math.min(100, Math.max(0, percent));
    if (message) this.state.message = message;
    if (extra) this.state.extra = { ...this.state.extra, ...extra };
    this.dispatch();
    return this;
  }

  /**
   * Transitions the job to `paused` and broadcasts the update.
   *
   * @param message Optional pause message.
   * @returns `this` for chaining.
   */
  pause(message = "Job paused"): this {
    this.state.status = "paused";
    this.state.message = message;
    this.dispatch();
    return this;
  }

  /**
   * Transitions the job from `paused` back to `running`.
   *
   * @param message Optional resume message.
   * @returns `this` for chaining.
   */
  resume(message = "Job resumed"): this {
    this.state.status = "running";
    this.state.message = message;
    this.dispatch();
    return this;
  }

  /**
   * Marks the job as `completed`, setting progress to 100 and broadcasting the result.
   *
   * @param result Optional result payload delivered to subscribed clients.
   * @param message Completion message.
   */
  done(result?: TResult, message = "Completed"): void {
    this.state.status = "completed";
    this.state.percent = 100;
    this.state.message = message;
    this.state.result = result;
    this.dispatch();
  }

  /**
   * Marks the job as `failed` and broadcasts the error message.
   *
   * @param error Error instance or error message string.
   */
  fail(error: string | Error): void {
    this.state.status = "failed";
    this.state.error = error instanceof Error ? error.message : error;
    this.state.message = this.state.error;
    this.dispatch();
  }

  /**
   * Cancels the job, triggers the abort signal, and invokes all registered cancel callbacks.
   * No-op if the job is already `completed` or `failed`.
   *
   * @param reason Human-readable cancellation reason.
   */
  cancel(reason = "Job cancelled by caller"): void {
    if (this.state.status === "completed" || this.state.status === "failed")
      return;
    this.state.status = "cancelled";
    this.state.message = reason;
    this.abortController.abort(reason);
    for (const cb of this.cancelCallbacks) {
      try {
        cb(reason);
      } catch {}
    }
    this.dispatch();
  }

  /**
   * Registers a callback to be invoked when the job is cancelled.
   * If the job is already cancelled, the callback is invoked immediately.
   *
   * @param callback Function called with the cancellation reason.
   * @returns `this` for chaining.
   */
  onCancel(callback: (reason?: string) => void): this {
    if (this.abortController.signal.aborted) {
      callback(this.abortController.signal.reason);
    } else {
      this.cancelCallbacks.push(callback);
    }
    return this;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Bun Native WebSockets Engine & Binary Support
// ──────────────────────────────────────────────────────────────────────────

/**
 * Public interface representing a connected WebSocket client.
 * Provides typed event sending, topic subscription management, and a direct binary channel.
 *
 * @template TData Shape of the per-connection session data attached to this socket.
 */
export interface SocketClient<TData = Record<string, unknown>> {
  /** Unique UUID assigned to this connection. */
  readonly id: string;
  /** Mutable per-connection session data (auth context, user info, etc.). */
  data: TData;
  /** The raw underlying `ServerWebSocket` instance (Bun-native). */
  readonly raw: ServerWebSocket<TData>;
  /** Send a typed registered event. */
  send<K extends keyof RegisteredEvents>(
    event: K,
    data: RegisteredEvents[K],
  ): void;
  /** Send an arbitrary named event with unknown payload. */
  send(event: string, data: unknown): void;
  /** Serialize an event as a JSON string and send it. */
  sendJSON(event: string, data: unknown): void;
  /** Send a raw UTF-8 text frame. */
  sendText(text: string): void;
  /** Send a raw binary frame. */
  sendBinary(data: ArrayBufferView | ArrayBuffer): void;
  /** Subscribe to a pub/sub topic, pending authorization check. Returns `true` on success. */
  join(topic: string): Promise<boolean>;
  /** Unsubscribe from a pub/sub topic. */
  leave(topic: string): void;
  /** Returns whether this socket is subscribed to a given topic. */
  isSubscribed(topic: string): boolean;
  /** Returns a broadcaster that sends to all sockets on `topic` (including this one). */
  to(topic: string): RoomBroadcaster;
  /** Returns a broadcaster that sends to all sockets on `topic` (excluding this one). */
  broadcast(topic: string): RoomBroadcaster;
  /** Close the WebSocket with an optional code and reason. */
  close(code?: number, reason?: string): void;
}

/**
 * Sends a realtime event to all WebSocket clients subscribed to a pub/sub topic.
 * Obtained via `socket.to(topic)` or `socket.broadcast(topic)` on a connected socket.
 */
export class RoomBroadcaster {
  /**
   * @param topic Target pub/sub topic name.
   * @param server Bun server instance used to publish messages.
   * @param excludeSocket Optional socket to exclude from broadcast (used by `socket.broadcast()`).
   * @param metrics Optional metrics collector.
   */
  constructor(
    private readonly topic: string,
    private readonly server: Server<unknown>,
    private readonly excludeSocket?: ServerWebSocket<any>,
    private readonly metrics?: MetricsCollector,
  ) {}

  /**
   * Broadcast a named event with payload to all topic subscribers.
   *
   * @param event Event name.
   * @param data Event payload (JSON-serialized).
   */
  send(event: string, data: unknown): void {
    const payload = JSON.stringify({
      id: crypto.randomUUID(),
      event,
      topic: this.topic,
      data,
      timestamp: Date.now(),
    });
    this.metrics?.recordSent(payload.length);
    if (this.excludeSocket) {
      this.excludeSocket.publish(this.topic, payload);
    } else {
      this.server.publish(this.topic, payload);
    }
  }
}

/**
 * Concrete implementation of {@link SocketClient} wrapping a raw Bun `ServerWebSocket`.
 * Created internally by {@link RealtimeServer} for each new connection.
 *
 * @template TData Shape of the per-connection session data.
 */
export class TypedSocket<
  TData = Record<string, unknown>,
> implements SocketClient<TData> {
  /** Unique UUID for this socket connection. */
  readonly id: string;

  /**
   * @param raw Underlying Bun `ServerWebSocket` instance.
   * @param engine Reference to parent {@link RealtimeServer}.
   */
  constructor(
    readonly raw: ServerWebSocket<TData>,
    private readonly engine: RealtimeServer<TData>,
  ) {
    this.id = (raw.data as any)?.id ?? crypto.randomUUID();
    (raw.data as any).id = this.id;
  }

  get data(): TData {
    return this.raw.data;
  }

  set data(val: TData) {
    this.raw.data = val;
  }

  /** Send a named event JSON envelope to this client. */
  send(event: string, data: unknown): void {
    this.sendJSON(event, data);
  }

  /**
   * Serialize and send a named event as a JSON `RealtimeEnvelope` to this specific client.
   *
   * @param event Event name.
   * @param data Event payload.
   */
  sendJSON(event: string, data: unknown): void {
    const payload = JSON.stringify({
      id: crypto.randomUUID(),
      event,
      data,
      timestamp: Date.now(),
    });
    this.engine.metrics.recordSent(payload.length);
    this.raw.send(payload);
  }

  /**
   * Send a raw UTF-8 text WebSocket frame to this client.
   *
   * @param text Raw text to send.
   */
  sendText(text: string): void {
    this.engine.metrics.recordSent(text.length);
    this.raw.sendText(text);
  }

  /**
   * Send a raw binary WebSocket frame to this client.
   *
   * @param data Binary buffer to send.
   */
  sendBinary(data: ArrayBufferView | ArrayBuffer): void {
    this.engine.metrics.recordSent(data.byteLength);
    this.raw.sendBinary(data as any);
  }

  /**
   * Attempt to join a pub/sub topic, pending `authorize.join` validation.
   *
   * @param topic Topic name to join.
   * @returns `true` if authorized and subscribed; `false` if denied.
   */
  async join(topic: string): Promise<boolean> {
    const canJoin = await this.engine.checkAuthorizeJoin(this, topic);
    if (!canJoin) {
      this.engine.logger.warn(`Client ${this.id} denied join to ${topic}`);
      return false;
    }
    this.raw.subscribe(topic);
    this.engine.config.handlers?.subscribe?.(this, topic);
    return true;
  }

  /**
   * Unsubscribe from a pub/sub topic.
   *
   * @param topic Topic name to leave.
   */
  leave(topic: string): void {
    this.raw.unsubscribe(topic);
    this.engine.config.handlers?.unsubscribe?.(this, topic);
  }

  /**
   * Check whether this socket is subscribed to a given topic.
   *
   * @param topic Topic name to check.
   */
  isSubscribed(topic: string): boolean {
    return this.raw.isSubscribed(topic);
  }

  /**
   * Returns a broadcaster that sends to all sockets on the topic (including this socket).
   *
   * @param topic Topic name.
   */
  to(topic: string): RoomBroadcaster {
    return new RoomBroadcaster(
      topic,
      this.engine.server,
      undefined,
      this.engine.metrics,
    );
  }

  /**
   * Returns a broadcaster that sends to all sockets on the topic, **excluding** this socket.
   *
   * @param topic Topic name.
   */
  broadcast(topic: string): RoomBroadcaster {
    return new RoomBroadcaster(
      topic,
      this.engine.server,
      this.raw,
      this.engine.metrics,
    );
  }

  /**
   * Close this WebSocket connection with an optional status code and reason.
   *
   * @param code WebSocket close code (default: 1000 normal closure).
   * @param reason Human-readable close reason.
   */
  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Security, Rate Limiter, and Realtime Server
// ──────────────────────────────────────────────────────────────────────────

/**
 * Configuration for WebSocket inbound message rate limiting.
 * When a client exceeds the message budget within the window, `onRateLimit` is called
 * or the connection is terminated with code 1008.
 *
 * @example
 * ```ts
 * createRealtime({
 *   rateLimit: {
 *     messages: 50,
 *     windowMs: 10_000,
 *     onRateLimit: (client) => client.send("error:rate_limit", { message: "Slow down!" }),
 *   },
 * });
 * ```
 */
export interface RateLimitConfig {
  /** Maximum number of messages allowed per client within `windowMs`. */
  messages: number;
  /** Sliding window duration in milliseconds over which `messages` are counted. */
  windowMs: number;
  /**
   * Custom handler invoked when a client exceeds the rate limit.
   * If omitted, the connection is closed with WebSocket code 1008.
   */
  onRateLimit?: (client: SocketClient<any>) => void;
}

/**
 * Lifecycle and event callbacks for the WebSocket transport layer.
 * All handlers are optional and may be async.
 *
 * @template TData Per-connection session data type.
 *
 * @example
 * ```ts
 * createRealtime({
 *   handlers: {
 *     open(client) { console.log("Client connected:", client.id); },
 *     message(client, event, data) { console.log(event, data); },
 *     close(client, code, reason) { console.log("Disconnected:", code, reason); },
 *   },
 * });
 * ```
 */
export interface RealtimeHandlers<TData = Record<string, unknown>> {
  /** Called when a new WebSocket client connects. */
  open?: (client: SocketClient<TData>) => void | Promise<void>;
  /** Called for each inbound WebSocket message, after rate limiting, validation, and authorization. */
  message?: (
    client: SocketClient<TData>,
    event: string,
    data: any,
  ) => void | Promise<void>;
  /** Called when a client disconnects. `code` and `reason` follow the WebSocket close handshake. */
  close?: (
    client: SocketClient<TData>,
    code: number,
    reason: string,
  ) => void | Promise<void>;
  /** Called when the send buffer drains after backpressure. */
  drain?: (client: SocketClient<TData>) => void | Promise<void>;
  /** Called on low-level WebSocket transport errors. */
  error?: (client: SocketClient<TData>, error: unknown) => void | Promise<void>;
  /** Called when a WebSocket ping frame is received. */
  ping?: (client: SocketClient<TData>, data: Buffer) => void | Promise<void>;
  /** Called when a WebSocket pong frame is received. */
  pong?: (client: SocketClient<TData>, data: Buffer) => void | Promise<void>;
  /** Called after a client successfully joins a pub/sub topic. */
  subscribe?: (
    client: SocketClient<TData>,
    topic: string,
  ) => void | Promise<void>;
  /** Called after a client leaves a pub/sub topic. */
  unsubscribe?: (
    client: SocketClient<TData>,
    topic: string,
  ) => void | Promise<void>;
}

/**
 * Top-level configuration for {@link RealtimeServer} / {@link createRealtime}.
 * All fields are optional — a zero-config instance works out of the box.
 *
 * @template TData Per-connection session data attached to every client.
 *
 * @example
 * ```ts
 * const realtime = createRealtime<{ userId: string }>({
 *   authenticate: async (req) => {
 *     const user = await verifyToken(req.headers.get("authorization"));
 *     return user ? { userId: user.id } : null;
 *   },
 *   authorize: {
 *     join: (client, topic) => topic.startsWith(`user:${client.data.userId}`),
 *   },
 *   rateLimit: { messages: 100, windowMs: 10_000 },
 *   handlers: {
 *     open: (client) => console.log("Connected:", client.data.userId),
 *   },
 * });
 * ```
 */
export interface RealtimeConfig<TData = Record<string, unknown>> {
  /** WebSocket lifecycle and message event handlers. See {@link RealtimeHandlers}. */
  handlers?: RealtimeHandlers<TData>;
  /**
   * Authentication hook invoked on every incoming connection (WebSocket upgrade or SSE).
   * Return session data to allow the connection, or `null` to reject it (401).
   */
  authenticate?: (req: Request) => Promise<TData | null> | TData | null;
  /**
   * Fine-grained authorization guards.
   * - `join`: Called before a client subscribes to a topic via `client.join()`.
   * - `send`: Called before delivering an inbound client message to the `message` handler.
   */
  authorize?: {
    join?: (
      client: SocketClient<TData>,
      topic: string,
    ) => boolean | Promise<boolean>;
    send?: (
      client: SocketClient<TData>,
      event: string,
      data: unknown,
    ) => boolean | Promise<boolean>;
  };
  /**
   * Global inbound message payload validator.
   * Return `false` or `{ valid: false, error }` to reject a message and send back `error:validation`.
   * For per-event validators, use {@link RealtimeServer.registerValidator}.
   */
  validate?: (
    event: string,
    data: unknown,
  ) => boolean | { valid: boolean; error?: string };
  /** WebSocket inbound message rate limiting. See {@link RateLimitConfig}. */
  rateLimit?: RateLimitConfig;
  /**
   * Pluggable pub/sub adapter for horizontal multi-node scaling.
   * Defaults to {@link InMemoryPubSubAdapter} (single-process).
   * Swap for a Redis or NATS adapter in multi-instance deployments.
   */
  adapter?: PubSubAdapter;
  /** Custom structured logger. Defaults to `console`-based output. */
  logger?: Logger;
  /**
   * Allowed WebSocket origins for CSRF protection.
   * If set, the `Origin` header is validated during the upgrade handshake.
   * Requests from disallowed origins are rejected (prevents Cross-Site WebSocket Hijacking).
   */
  allowedOrigins?: string[];
  /**
   * Enable WebSocket `permessage-deflate` compression.
   * @default true
   */
  perMessageDeflate?: boolean;
  /**
   * Maximum allowed WebSocket message payload size in bytes.
   * @default 16_777_216 (16 MiB)
   */
  maxPayloadLength?: number;
  /** Default SSE transport options applied to all channels. See {@link SSEOptions}. */
  sseOptions?: SSEOptions;
  /**
   * Global error handler for adapter, WebSocket publish, and other internal errors.
   * If omitted, errors are logged via `logger.error`.
   *
   * @param error The caught error value.
   * @param context A short string identifying the error site (e.g. `"adapter:publish"`).
   */
  onError?: (error: unknown, context?: string) => void;
}

/**
 * Core realtime engine orchestrating WebSocket and SSE transports, pub/sub routing,
 * authentication, authorization, rate limiting, metrics, and job tracking.
 *
 * Typically created via {@link createRealtime} rather than instantiated directly.
 *
 * @template TData Per-connection session data type stored on each client.
 *
 * @example
 * ```ts
 * import { createRealtime } from "./realtime";
 *
 * export const realtime = createRealtime({
 *   handlers: {
 *     open: (client) => console.log("Connected:", client.id),
 *     message: (client, event, data) => client.send(event, data),
 *   },
 * });
 *
 * // In Bun.serve:
 * Bun.serve({
 *   fetch(req, server) {
 *     if (new URL(req.url).pathname === "/ws") {
 *       return realtime.connect(req, server);
 *     }
 *     return new Response("Not found", { status: 404 });
 *   },
 *   websocket: realtime.websocket,
 * });
 * ```
 */
export class RealtimeServer<TData = Record<string, unknown>> {
  private _server: Server<unknown> | null = null;
  private sseChannels = new Map<string, SSEChannel<any>>();
  private jobs = new Map<string, JobTracker<any>>();
  private rateLimitBuckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private messageValidators = new Map<string, (data: any) => boolean>();

  /** Live connection and throughput metrics. Query via `.stats()`. */
  readonly metrics = new MetricsCollector();
  /** Active pub/sub adapter (in-memory by default, swappable for Redis/NATS). */
  readonly adapter: PubSubAdapter;
  /** Structured logger instance used throughout the engine. */
  readonly logger: Logger;

  /**
   * @param config Optional server configuration. All fields are optional.
   */
  constructor(readonly config: RealtimeConfig<TData> = {}) {
    this.logger = config.logger ?? defaultLogger;
    this.adapter = config.adapter ?? new InMemoryPubSubAdapter();
  }

  /**
   * Binds the live `Bun.Server` instance to this engine, enabling WebSocket pub/sub broadcasts.
   * Called automatically by {@link upgrade} and {@link connect}.
   *
   * @param server The `Bun.Server` returned by `Bun.serve(...)`.
   */
  bindServer(server: Server<unknown>): void {
    this._server = server;
  }

  /**
   * Returns the bound `Bun.Server` instance.
   * @throws {@link RealtimeError} if called before the server has been bound via `bindServer()` or `connect()`.
   */
  get server(): Server<unknown> {
    if (!this._server) {
      throw new RealtimeError(
        "Bun server not bound. Pass it via realtime.bindServer(server) or within fetch upgrade().",
      );
    }
    return this._server;
  }

  /**
   * Registers a type-safe per-event inbound message validator.
   * The per-event validator takes precedence over the global `config.validate` for its event name.
   *
   * @param event Registered event name to validate.
   * @param validator Function receiving the typed payload; return `true` to accept, `false` to reject.
   *
   * @example
   * ```ts
   * realtime.registerValidator("chat.message", (data) =>
   *   typeof data.text === "string" && data.text.length <= 2000
   * );
   * ```
   */
  registerValidator<K extends keyof RegisteredEvents>(
    event: K,
    validator: (data: RegisteredEvents[K]) => boolean,
  ): void {
    this.messageValidators.set(event as string, validator);
  }

  /**
   * Runs the `authorize.join` guard from config against a client/topic pair.
   * Returns `true` (permitted) if no join guard is configured.
   *
   * @param client The socket client attempting to subscribe.
   * @param topic Topic name being joined.
   */
  async checkAuthorizeJoin(
    client: SocketClient<TData>,
    topic: string,
  ): Promise<boolean> {
    if (this.config.authorize?.join) {
      return await this.config.authorize.join(client, topic);
    }
    return true;
  }

  /**
   * Runs the `authorize.send` guard from config before delivering an inbound message.
   * Returns `true` (permitted) if no send guard is configured.
   *
   * @param client The socket client sending the message.
   * @param event Event name.
   * @param data Event payload.
   */
  async checkAuthorizeSend(
    client: SocketClient<TData>,
    event: string,
    data: unknown,
  ): Promise<boolean> {
    if (this.config.authorize?.send) {
      return await this.config.authorize.send(client, event, data);
    }
    return true;
  }

  /**
   * Routes an internal engine error to `config.onError` if provided,
   * or falls back to `logger.error`.
   *
   * @param error The caught error value.
   * @param context Short label for the error site (e.g. `"adapter:publish"`, `"websocket:publish"`).
   */
  reportError(error: unknown, context?: string): void {
    if (this.config.onError) {
      this.config.onError(error, context);
    } else {
      this.logger.error(`[RealtimeError:${context ?? "general"}]`, error);
    }
  }

  /** Checks whether a client has exceeded the configured message rate limit within the current window. */
  private isRateLimited(clientId: string): boolean {
    if (!this.config.rateLimit) return false;
    const now = Date.now();
    const { messages, windowMs } = this.config.rateLimit;
    let bucket = this.rateLimitBuckets.get(clientId);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs };
      this.rateLimitBuckets.set(clientId, bucket);
      return false;
    }

    bucket.count++;
    return bucket.count > messages;
  }

  /**
   * Attempts to upgrade an incoming HTTP request to a WebSocket connection.
   * Runs authentication, merges session data, and delegates to `server.upgrade()`.
   *
   * Prefer {@link connect} for a unified handler that auto-selects between WebSocket and SSE.
   *
   * @param req Incoming HTTP `Request`.
   * @param server The `Bun.Server` instance.
   * @param customData Optional extra data merged into the session after authentication.
   * @returns `true` if the upgrade was successful, `false` if authentication failed or upgrade was refused.
   */
  async upgrade(
    req: Request,
    server: Server<unknown>,
    customData?: Partial<TData>,
  ): Promise<boolean> {
    this.bindServer(server);

    // CSRF protection: Validate Origin header if allowedOrigins is configured.
    if (this.config.allowedOrigins?.length) {
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          const originUrl = new URL(origin);
          const isAllowed = this.config.allowedOrigins.some((allowed) => {
            try {
              return new URL(allowed).origin === originUrl.origin;
            } catch {
              return allowed === originUrl.origin;
            }
          });
          if (!isAllowed) {
            return false;
          }
        } catch {
          return false;
        }
      }
    }

    let authData: TData = {} as TData;
    if (this.config.authenticate) {
      const authenticated = await this.config.authenticate(req);
      if (!authenticated) {
        return false;
      }
      authData = authenticated;
    }

    const mergedData = { ...authData, ...customData } as TData;
    return server.upgrade(req, { data: mergedData });
  }

  /**
   * Unified connection entry point — auto-routes between WebSocket upgrade and SSE streaming.
   *
   * Routing logic:
   * - If the request has an `Upgrade: websocket` header → delegates to {@link upgrade}.
   * - If the request has `Accept: text/event-stream` → returns an SSE `Response`.
   * - Otherwise → returns a `400 Bad Request` listing supported transports.
   *
   * For SSE connections, the `topic` query parameter (default `"global"`) selects the channel,
   * and `Last-Event-ID` / `lastEventId` query param enables reconnection replay.
   *
   * @param req Incoming HTTP `Request`.
   * @param server The `Bun.Server` instance.
   * @param customData Optional extra data merged into the session after authentication.
   * @returns A `Response` (for SSE or errors) or `true`/`false` (for WebSocket upgrades).
   *
   * @example
   * ```ts
   * Bun.serve({
   *   fetch: (req, server) => realtime.connect(req, server),
   *   websocket: realtime.websocket,
   * });
   * ```
   */
  async connect(
    req: Request,
    server: Server<unknown>,
    customData?: Partial<TData>,
  ): Promise<Response | boolean> {
    const isWS = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isWS) {
      return this.upgrade(req, server, customData);
    }

    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      let authData: TData = {} as TData;
      if (this.config.authenticate) {
        const authenticated = await this.config.authenticate(req);
        if (!authenticated) {
          return new Response("Unauthorized", { status: 401 });
        }
        authData = authenticated;
      }

      const mergedData = { ...authData, ...customData } as TData;
      const url = new URL(req.url);
      const topic = url.searchParams.get("topic") ?? "global";
      const lastEventId =
        req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");

      const channel = this.channel(topic);
      return sse<TData>(
        req,
        (client) => {
          channel.subscribe(client);
          if (lastEventId) channel.replayHistory(client, lastEventId);
        },
        this.config.sseOptions,
        mergedData,
        this.metrics,
        this.logger,
      );
    }

    return new Response(
      "Supported transports: WebSocket, SSE (text/event-stream)",
      { status: 400 },
    );
  }

  /**
   * WebSocket handler object to pass directly to `Bun.serve({ websocket })`.
   * Wires all Bun WebSocket lifecycle events (`open`, `message`, `close`, `drain`, `ping`, `pong`)
   * to the configured {@link RealtimeHandlers}, applying rate limiting, validation, and authorization
   * at the message layer.
   *
   * @example
   * ```ts
   * Bun.serve({
   *   fetch: (req, server) => realtime.connect(req, server),
   *   websocket: realtime.websocket,
   * });
   * ```
   */
  get websocket() {
    return {
      open: (ws: ServerWebSocket<TData>) => {
        this.metrics.incWS();
        const client = new TypedSocket(ws, this);
        this.config.handlers?.open?.(client);
      },
      message: async (ws: ServerWebSocket<TData>, message: string | Buffer) => {
        const client = new TypedSocket(ws, this);

        const bytesLength =
          typeof message === "string" ? message.length : message.byteLength;
        this.metrics.recordReceived(bytesLength);

        // Rate Limiting Gate
        if (this.isRateLimited(client.id)) {
          if (this.config.rateLimit?.onRateLimit) {
            this.config.rateLimit.onRateLimit(client);
          } else {
            client.close(1008, "Rate limit exceeded");
          }
          return;
        }

        // Protocol Parse Gate
        try {
          if (typeof message !== "string") {
            this.config.handlers?.message?.(client, "binary", message);
            return;
          }

          const parsed = JSON.parse(message);
          const event = parsed.event ?? "message";
          const data = parsed.data ?? parsed;

          // Inbound Message Validation Gate
          const customValidator = this.messageValidators.get(event);
          if (customValidator && !customValidator(data)) {
            client.send("error:validation", {
              event,
              message: "Validation schema failed",
            });
            return;
          }

          if (this.config.validate) {
            const result = this.config.validate(event, data);
            if (
              result === false ||
              (typeof result === "object" && !result.valid)
            ) {
              client.send("error:validation", {
                event,
                message:
                  typeof result === "object" ? result.error : "Invalid payload",
              });
              return;
            }
          }

          // Inbound Message Authorization Gate
          const authorized = await this.checkAuthorizeSend(client, event, data);
          if (!authorized) {
            client.send("error:unauthorized", {
              event,
              message: "Forbidden action",
            });
            return;
          }

          // Inbound Subscription Protocol Action
          if (
            event === "realtime:subscribe" &&
            typeof data?.topic === "string"
          ) {
            await client.join(data.topic);
            return;
          }
          if (
            event === "realtime:unsubscribe" &&
            typeof data?.topic === "string"
          ) {
            client.leave(data.topic);
            return;
          }

          this.config.handlers?.message?.(client, event, data);
        } catch (err) {
          this.config.handlers?.message?.(client, "raw", message);
        }
      },
      close: (ws: ServerWebSocket<TData>, code: number, reason: string) => {
        this.metrics.decWS();
        this.rateLimitBuckets.delete((ws.data as any)?.id);
        const client = new TypedSocket(ws, this);
        this.config.handlers?.close?.(client, code, reason);
      },
      drain: (ws: ServerWebSocket<TData>) => {
        const client = new TypedSocket(ws, this);
        this.config.handlers?.drain?.(client);
      },
      ping: (ws: ServerWebSocket<TData>, data: Buffer) => {
        const client = new TypedSocket(ws, this);
        this.config.handlers?.ping?.(client, data);
      },
      pong: (ws: ServerWebSocket<TData>, data: Buffer) => {
        const client = new TypedSocket(ws, this);
        this.config.handlers?.pong?.(client, data);
      },
      perMessageDeflate: this.config.perMessageDeflate ?? true,
      maxPayloadLength: this.config.maxPayloadLength ?? 16 * 1024 * 1024,
    };
  }

  /**
   * Returns an existing named SSE channel without creating one.
   * Use this when you need to inspect an active channel without implicitly creating it.
   *
   * @param name Channel/topic name.
   * @returns The {@link SSEChannel} if it exists, or `undefined`.
   */
  getChannel(name: string): SSEChannel | undefined {
    return this.sseChannels.get(name);
  }

  /**
   * Returns the named SSE channel, creating it if it doesn't exist yet.
   * The channel is automatically removed when all subscribers disconnect.
   *
   * @param name Channel/topic name.
   * @returns The {@link SSEChannel} for the given name.
   *
   * @example
   * ```ts
   * const ch = realtime.channel("notifications");
   * ch.broadcast("alert", { level: "info", message: "Deploy complete" });
   * ```
   */
  channel(name: string): SSEChannel {
    let chan = this.sseChannels.get(name);
    if (!chan) {
      chan = new SSEChannel(
        name,
        (emptyChannelName) => {
          this.sseChannels.delete(emptyChannelName);
        },
        this.config.sseOptions?.historySize ?? 100,
      );
      this.sseChannels.set(name, chan);
    }
    return chan;
  }

  /**
   * Fluent helper to scope rooms (WebSockets) and channels (SSE) under a common prefix.
   *
   * @param prefix Common namespace prefix (e.g. `"tenant:101"` or `"chat"`).
   * @returns Scoped builder exposing `.room(name)` and `.channel(name)`.
   *
   * @example
   * ```ts
   * const tenant = realtime.namespace("tenant:org_42");
   * tenant.room("billing").send("invoice:paid", { id: "inv_123" });
   * ```
   */
  namespace(prefix: string) {
    return {
      room: (name: string) => this.to(`${prefix}:${name}`),
      channel: (name: string) => this.channel(`${prefix}:${name}`),
    };
  }

  /**
   * Returns a {@link RealtimeBroadcaster} targeting a specific topic across both
   * WebSocket clients and active SSE channel subscribers, distributed via the pub/sub adapter.
   *
   * @param topic Topic name to publish to.
   * @returns Topic-scoped broadcaster.
   *
   * @example
   * ```ts
   * realtime.to("orders").send("order:created", { id: "ord_99" });
   * ```
   */
  to(topic: string): RealtimeBroadcaster {
    return new RealtimeBroadcaster(topic, this);
  }

  /**
   * Retrieves or instantiates a tracked {@link JobTracker} for a long-running background task.
   * Automatically publishes state updates to `job:${jobId}` and garbage-collects completed/failed
   * trackers after 60 seconds.
   *
   * @template T Result payload type on successful job completion.
   * @param jobId Unique identifier for the job.
   * @returns {@link JobTracker} instance.
   *
   * @example
   * ```ts
   * const tracker = realtime.job("video-transcode-42");
   * tracker.start("Transcoding 1080p...");
   * tracker.progress(50, "Halfway done");
   * tracker.done({ url: "/video.mp4" });
   * ```
   */
  job<T = unknown>(jobId: string): JobTracker<T> {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = new JobTracker<T>(jobId, this.to(`job:${jobId}`), (j) => {
        if (
          j.state.status === "completed" ||
          j.state.status === "failed" ||
          j.state.status === "cancelled"
        ) {
          this.metrics.decJob();
          setTimeout(() => this.jobs.delete(jobId), 60_000);
        }
      });
      this.jobs.set(jobId, job);
      this.metrics.incJob();
    }
    return job;
  }

  /**
   * Captures a real-time operational metrics snapshot of active connections,
   * channels, throughput, and jobs.
   *
   * @returns Current {@link RealtimeStats} telemetry snapshot.
   */
  stats(): RealtimeStats {
    return this.metrics.snapshot(this.sseChannels.size);
  }
}

/**
 * Publishes events to a designated topic across distributed pub/sub adapters,
 * local native WebSockets, and active local SSE channels.
 */
export class RealtimeBroadcaster {
  /**
   * @param topic Target pub/sub topic.
   * @param engine Reference to parent {@link RealtimeServer}.
   */
  constructor(
    private readonly topic: string,
    private readonly engine: RealtimeServer<any>,
  ) {}

  /**
   * Publishes a typed event and payload to all topic subscribers across transports.
   *
   * @param event Registered event name.
   * @param data Typed payload data.
   * @param id Optional explicit UUID for message tracking.
   */
  send<K extends keyof RegisteredEvents>(
    event: K,
    data: RegisteredEvents[K],
    id?: string,
  ): void;
  /**
   * Publishes an arbitrary named event and payload to all topic subscribers across transports.
   *
   * @param event Event name string.
   * @param data Payload data.
   * @param id Optional explicit UUID for message tracking.
   */
  send(event: string, data: unknown, id?: string): void;
  send(event: string, data: unknown, id?: string): void {
    const envelope: RealtimeEnvelope = {
      id: id ?? crypto.randomUUID(),
      event,
      topic: this.topic,
      data,
      timestamp: Date.now(),
    };

    // 1. Distribute via PubSub adapter (Horizontal Cluster Scaling)
    this.engine.adapter.publish(this.topic, envelope).catch((err) => {
      this.engine.reportError(err, "adapter:publish");
    });

    // 2. Publish to local WebSockets
    try {
      if (this.engine.server) {
        const payload = JSON.stringify(envelope);
        this.engine.metrics.recordSent(payload.length);
        this.engine.server.publish(this.topic, payload);
      }
    } catch (err) {
      this.engine.reportError(err, "websocket:publish");
    }

    // 3. Fix 1: Broadcast to local SSE Channel ONLY IF active subscribers exist
    const chan = this.engine.getChannel(this.topic);
    if (chan && chan.size > 0) {
      chan.broadcast(event, data, envelope.id);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Optional Global Singleton & Fluent DSL
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_REALTIME_KEY = Symbol.for("yatta.realtime.instance");
const g = globalThis as unknown as {
  [GLOBAL_REALTIME_KEY]?: RealtimeServer<any>;
};

/**
 * Factory function creating and registering a configured {@link RealtimeServer} instance.
 *
 * @template TData Shape of per-connection session data.
 * @param config Optional server configuration (authentication, rate limits, adapters, etc.).
 * @returns Configured {@link RealtimeServer} instance.
 *
 * @example
 * ```ts
 * import { createRealtime } from "./realtime";
 *
 * export const realtime = createRealtime({
 *   rateLimit: { messages: 100, windowMs: 10_000 },
 * });
 * ```
 */
export function createRealtime<TData = Record<string, unknown>>(
  config: RealtimeConfig<TData> = {},
): RealtimeServer<TData> {
  const instance = new RealtimeServer(config);
  g[GLOBAL_REALTIME_KEY] = instance;
  return instance;
}

/**
 * Retrieves the global default {@link RealtimeServer} instance, initializing one if not already created.
 *
 * @returns Global {@link RealtimeServer} singleton.
 */
export function getRealtime(): RealtimeServer<any> {
  if (!g[GLOBAL_REALTIME_KEY]) {
    g[GLOBAL_REALTIME_KEY] = new RealtimeServer({});
  }
  return g[GLOBAL_REALTIME_KEY]!;
}

/**
 * Global default {@link RealtimeServer} proxy singleton.
 * Delegates all property and method calls dynamically to the global engine instance.
 *
 * @example
 * ```ts
 * import { Realtime } from "./realtime";
 *
 * Realtime.to("news").send("headline", { title: "Bun Released" });
 * ```
 */
export const Realtime: RealtimeServer<any> = new Proxy(
  function () {} as unknown as RealtimeServer<any>,
  {
    get(_target, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_target, prop, receiver);
      }
      const instance = getRealtime();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);

// ──────────────────────────────────────────────────────────────────────────
// 8. Client SDK (Isomorphic SSE & WebSocket with Backoff Reconnect)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Configuration options for the isomorphic {@link RealtimeClient} SDK.
 */
export interface ClientOptions {
  /** Target server endpoint URL (e.g. `"http://localhost:3000/realtime"` or `"ws://localhost:3000/realtime"`). */
  url: string;
  /** Transport mode: `"websocket"`, `"sse"`, or `"auto"` (prefers WebSocket if available). Defaults to `"auto"`. */
  transport?: "auto" | "websocket" | "sse";
  /** Optional sub-protocols for WebSocket handshakes. */
  protocols?: string | string[];
  /** Exponential backoff and jitter configuration for automatic reconnection. */
  reconnect?: {
    /** Enable automatic reconnect attempts on connection drop. Default: `true`. */
    enabled?: boolean;
    /** Initial backoff delay in milliseconds. Default: `500`. */
    minDelay?: number;
    /** Maximum backoff delay cap in milliseconds. Default: `30000`. */
    maxDelay?: number;
    /** Multiplier factor for backoff progression. Default: `2`. */
    factor?: number;
    /** Apply random jitter to prevent reconnect stampedes. Default: `true`. */
    jitter?: boolean;
  };
}

/**
 * Isomorphic Realtime Client SDK supporting native WebSockets and Server-Sent Events (SSE).
 * Handles automatic fallback, topic subscription resubmission on reconnect, and exponential backoff.
 *
 * @example
 * ```ts
 * const client = new RealtimeClient({ url: "http://localhost:3000/realtime" });
 *
 * client.on("chat.message", (msg) => {
 *   console.log("New message:", msg.text);
 * });
 *
 * client.subscribe("room:101");
 * client.send("chat.message", { text: "Hello!" });
 * ```
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private listeners = new Map<
    string,
    Set<(data: any, env?: RealtimeEnvelope) => void>
  >();
  private subscribedTopics = new Set<string>();
  private reconnectAttempts = 0;
  private isExplicitClose = false;

  /**
   * @param options Connection parameters and reconnect options.
   */
  constructor(private readonly options: ClientOptions) {
    this.connect();
  }

  private connect(): void {
    if (this.isExplicitClose) return;

    const transport = this.options.transport ?? "auto";
    const isWSAvailable = typeof WebSocket !== "undefined";

    if ((transport === "auto" || transport === "websocket") && isWSAvailable) {
      this.initWebSocket();
    } else {
      this.initSSE();
    }
  }

  private initWebSocket(): void {
    const wsUrl = this.options.url.replace(/^http/, "ws");
    this.ws = new WebSocket(wsUrl, this.options.protocols);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      for (const topic of this.subscribedTopics) {
        this.ws?.send(
          JSON.stringify({ event: "realtime:subscribe", data: { topic } }),
        );
      }
      this.dispatch("open", {});
    };

    this.ws.onmessage = (event) => {
      try {
        const envelope: RealtimeEnvelope = JSON.parse(event.data);
        this.dispatch(envelope.event, envelope.data, envelope);
      } catch {
        this.dispatch("raw", event.data);
      }
    };

    this.ws.onclose = () => {
      this.dispatch("close", {});
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      this.dispatch("error", err);
    };
  }

  private initSSE(): void {
    if (typeof EventSource === "undefined") return;
    this.es = new EventSource(this.options.url);

    this.es.onopen = () => {
      this.reconnectAttempts = 0;
      this.dispatch("open", {});
    };

    this.es.onerror = (err) => {
      this.dispatch("error", err);
    };

    // Generic packet router
    this.es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.dispatch("message", data);
      } catch {
        this.dispatch("message", e.data);
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.isExplicitClose) return;
    const config = {
      enabled: true,
      minDelay: 500,
      maxDelay: 30000,
      factor: 2,
      jitter: true,
      ...this.options.reconnect,
    };
    if (!config.enabled) return;

    let delay = Math.min(
      config.maxDelay,
      config.minDelay * Math.pow(config.factor, this.reconnectAttempts++),
    );
    if (config.jitter) {
      delay += Math.random() * 500;
    }

    setTimeout(() => this.connect(), delay);
  }

  /**
   * Registers an event listener for a typed registered event name.
   *
   * @param event Registered event name.
   * @param handler Callback receiving the typed payload and optional raw envelope.
   * @returns Cleanup function to deregister this listener.
   */
  on<K extends keyof RegisteredEvents>(
    event: K,
    handler: (data: RegisteredEvents[K], env?: RealtimeEnvelope) => void,
  ): () => void;
  /**
   * Registers an event listener for an arbitrary event name or lifecycle event (`"open"`, `"close"`, `"error"`).
   *
   * @param event Event name string.
   * @param handler Callback receiving the payload and optional raw envelope.
   * @returns Cleanup function to deregister this listener.
   */
  on(
    event: string,
    handler: (data: any, env?: RealtimeEnvelope) => void,
  ): () => void;
  on(
    event: string,
    handler: (data: any, env?: RealtimeEnvelope) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);

    /*
     * On SSE, wire up a named event listener on the stream as well.
     *
     * The listener has to be kept in a variable. It used to be an inline arrow
     * function, so the cleanup could only remove `handler` from the local map and
     * had no reference to the function actually attached to the EventSource —
     * which means the stream listener survived forever. Every `on()` leaked one,
     * and a UI that subscribes on mount and tears down on unmount leaks a copy of
     * every handler per mount. React's double-invoked effects in development
     * doubled that.
     */
    const isLifecycle = event === "open" || event === "close" || event === "error";
    let streamListener: ((e: Event) => void) | undefined;

    if (this.es && !isLifecycle) {
      streamListener = (e: Event) => {
        const raw = (e as MessageEvent).data;
        try {
          handler(typeof raw === "string" ? JSON.parse(raw) : raw);
        } catch {
          handler(raw);
        }
      };
      this.es.addEventListener(event, streamListener);
    }

    return () => {
      set?.delete(handler);

      if (streamListener) {
        this.es?.removeEventListener(event, streamListener);
      }
    };
  }

  /**
   * Subscribes to a pub/sub topic on the server. If using WebSocket, automatically resubscribes on reconnect.
   *
   * @param topic Topic identifier to join.
   * @returns Cleanup function to unsubscribe from this topic.
   */
  subscribe(topic: string): () => void {
    this.subscribedTopics.add(topic);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ event: "realtime:subscribe", data: { topic } }),
      );
    }
    return () => {
      this.subscribedTopics.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ event: "realtime:unsubscribe", data: { topic } }),
        );
      }
    };
  }

  /**
   * Sends an outbound event to the server. Requires an active WebSocket transport.
   *
   * @param event Event name.
   * @param data Payload to serialize and dispatch.
   * @throws {RealtimeError} If WebSocket is not currently connected.
   */
  send(event: string, data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data }));
    } else {
      throw new RealtimeError(
        "WebSocket is not connected. Sending messages requires an active WebSocket.",
      );
    }
  }

  private dispatch(event: string, data: any, envelope?: RealtimeEnvelope) {
    const list = this.listeners.get(event);
    if (list) {
      for (const handler of list) {
        handler(data, envelope);
      }
    }
  }

  /**
   * Closes active WebSocket and EventSource connections and disables automatic reconnect attempts.
   */
  close(): void {
    this.isExplicitClose = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }
}

/**
 * Factory helper for initializing a {@link RealtimeClient}.
 *
 * @param options Target endpoint string URL or client configuration object.
 * @returns Configured {@link RealtimeClient} instance.
 *
 * @example
 * ```ts
 * const client = createRealtimeClient("http://localhost:3000/realtime");
 * client.on("open", () => console.log("Connected!"));
 * ```
 */
export function createRealtimeClient(
  options: ClientOptions | string,
): RealtimeClient {
  const opts = typeof options === "string" ? { url: options } : options;
  return new RealtimeClient(opts);
}
