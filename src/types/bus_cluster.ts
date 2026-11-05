/**
 * Cluster-wide and durable delivery for the existing event bus.
 *
 * This file adds nothing to the bus itself. The bus lives in
 * `./job.ts` (`createEvents`): `on` / `once` / `emit` / `waitFor` /
 * `pipe` all keep working exactly as before. Nothing in this file is
 * imported by the bus, the CLI, or the server entry point, so a project
 * that never imports it pays nothing for it: no sockets, no timers,
 * no polling, no extra work on emit.
 *
 * Two opt-in pieces, both built on what already exists:
 *
 * 1. Cluster delivery. `attachClusterTransport` wraps one bus with a
 *    transport. `publish` emits locally and forwards the envelope to
 *    every other worker; envelopes arriving from the transport are
 *    emitted locally and never forwarded again, so there is no echo
 *    loop. Delivery is live fan-out only: a worker that is down when
 *    an event is published misses it. Pair it with part 2 when a
 *    missed event must be caught up after a restart.
 *
 * 2. Durable delivery. Built on the shared change log in
 *    `./outbox.ts` — the same `_yatta_outbox` table, the same
 *    `recordOutbox` / `readChangeLog` contract, no second log.
 *    `publishDurable` records the event; `startDurableConsumer`
 *    replays the log in `seq` order into the bus. Delivery is
 *    at-least-once: a crash between emit and checkpoint, or a relay
 *    redelivery, can deliver one event twice. Handlers must therefore
 *    stay idempotent by `outboxEventId`, exactly as the change-log
 *    document already requires.
 *
 * Security notes, enforced here rather than left to callers:
 * - The cluster hub refuses to start without a token unless the
 *   caller explicitly passes `allowUnauthenticated: true` (local
 *   development only). A peer without the token can connect but is
 *   never given events and its messages are dropped.
 * - Envelopes are validated on receipt: shape, event-name pattern,
 *   and JSON-serializability. Anything else is dropped, never
 *   executed. Payloads are treated as untrusted input: a listener
 *   must validate fields it acts on, the same as for any network
 *   input. Nothing here evaluates, compiles, or otherwise runs
 *   code carried in a payload.
 * - Tokens are compared with a timing-safe hash comparison and are
 *   never logged. Payloads are never put into error messages.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createOutboxRelay,
  recordOutbox,
  readChangeLog,
  toEventPublish,
  type OutboxEntry,
  type OutboxPublishFn,
  type OutboxRelay,
  type OutboxRelayOptions,
  type OutboxStore,
} from "./outbox";

/** Minimal bus surface this file needs. Any `EventBus` satisfies it. */
export interface ClusterBus {
  on(event: string, handler: (data: any, name: string) => void | Promise<void>): () => void;
  emit(event: string, data: unknown, options?: { throwOnError?: boolean }): Promise<void>;
}

/** One event travelling between workers. All fields are plain JSON. */
export interface ClusterEnvelope {
  /** Stable identity of this delivery. The dedupe key. */
  eventId: string;
  /** Bus event name, e.g. "user.registered". */
  event: string;
  /** Event payload. Must be JSON-serializable. */
  data: unknown;
  /** Id of the worker that published it. Used for debugging only. */
  origin: string;
  /** Milliseconds since epoch when it was published. */
  sentAt: number;
}

/**
 * A channel between workers. Implementations move envelopes; they do
 * not interpret them. `subscribe` registers the receive handler and
 * returns an unsubscribe function.
 */
export interface ClusterTransport {
  send(envelope: ClusterEnvelope): Promise<void> | void;
  subscribe(handler: (envelope: ClusterEnvelope) => void | Promise<void>): () => void;
  close(): Promise<void> | void;
}

/** Maximum event-name length. Long names are almost always a mistake. */
export const MAX_EVENT_NAME_LENGTH = 256;
/** Default cap on a serialized cluster payload, in bytes. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Default size of the in-memory dedupe window, in event ids. */
export const DEFAULT_SEEN_WINDOW = 10_000;

/**
 * Checks an event name for the cluster path. Local-only bus names are
 * unrestricted, but a name arriving over the network must be a plain
 * dotted name: no wildcards, no empty segments, no control characters.
 * A remote "*" would otherwise match every global listener, and a
 * crafted pattern could fan out further than the sender intended.
 */
export function isValidClusterEventName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_EVENT_NAME_LENGTH) return false;
  if (name.includes("*")) return false;
  const segments = name.split(".");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  }
  return true;
}

/**
 * Parses and validates one envelope received from a peer. Throws on
 * anything malformed. Unknown extra fields are ignored, never trusted.
 */
export function parseClusterEnvelope(value: unknown): ClusterEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Cluster envelope must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.eventId !== "string" || raw.eventId.length === 0) {
    throw new Error("Cluster envelope has no eventId.");
  }
  if (!isValidClusterEventName(raw.event)) {
    throw new Error("Cluster envelope has an invalid event name.");
  }
  if (typeof raw.origin !== "string" || raw.origin.length === 0) {
    throw new Error("Cluster envelope has no origin.");
  }
  if (typeof raw.sentAt !== "number" || !Number.isFinite(raw.sentAt)) {
    throw new Error("Cluster envelope has an invalid sentAt.");
  }
  if (!("data" in raw)) {
    throw new Error("Cluster envelope has no data.");
  }
  // A payload that cannot survive JSON must not travel: the receiving
  // side would see a different value than the sender published.
  // `JSON.stringify` alone is not enough — it silently drops function
  // properties and turns circular checks into the only error — so
  // walk the value and reject anything JSON cannot carry faithfully.
  assertDeepSerializable(raw.data);
  return {
    eventId: raw.eventId,
    event: raw.event,
    data: raw.data,
    origin: raw.origin,
    sentAt: raw.sentAt,
  };
}

/** Compares two tokens without leaking a prefix through timing. */
function tokensEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function newPeerId(): string {
  return `worker-${crypto.randomUUID()}`;
}

function assertSerializable(data: unknown): string {
  assertDeepSerializable(data);
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new Error("Cluster payload must be JSON-serializable.");
  }
  return json;
}

/**
 * Walks a value and rejects anything JSON cannot carry faithfully:
 * functions, undefined, symbols, bigints, non-finite numbers, and
 * circular references. Plain `JSON.stringify` silently drops function
 * properties and turns `NaN` into `null`, so a payload checked only
 * with it would arrive different from what was sent.
 */
function assertDeepSerializable(value: unknown, ancestors = new Set<object>()): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cluster payload must be JSON-serializable: non-finite numbers are rejected.");
    }
    return;
  }
  if (kind !== "object") {
    throw new Error("Cluster payload must be JSON-serializable.");
  }
  const obj = value as Record<string, unknown>;
  if (ancestors.has(obj)) {
    throw new Error("Cluster payload must be JSON-serializable: it contains a circular value.");
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new Error("Cluster payload must be JSON-serializable: symbol-keyed properties are rejected.");
  }
  ancestors.add(obj);
  try {
    for (const key of Object.keys(obj)) {
      assertDeepSerializable(obj[key], ancestors);
    }
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Bounded set of recently seen event ids, for dedupe. Oldest ids fall
 * out once the window fills; a redelivery after eviction is delivered
 * again, which is safe because delivery is at-least-once and handlers
 * must be idempotent anyway. The window only removes the common
 * in-process duplicates (relay rescans, overlapping polls).
 */
export class SeenEventIds {
  private readonly ids = new Map<string, true>();
  constructor(private readonly maxSize: number = DEFAULT_SEEN_WINDOW) {}
  /** True when this id is already in the window, without adding it. */
  has(eventId: string): boolean {
    return this.ids.has(eventId);
  }
  /** Adds an id, evicting the oldest when the window is full. */
  add(eventId: string): void {
    this.ids.set(eventId, true);
    while (this.ids.size > this.maxSize) {
      const oldest = this.ids.keys().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }
  /** Returns true when this id was already seen, false when newly added. */
  hasSeen(eventId: string): boolean {
    if (this.ids.has(eventId)) return true;
    this.add(eventId);
    return false;
  }
  get size(): number {
    return this.ids.size;
  }
}

export interface ClusterBusOptions {
  /** Id for this worker. Defaults to a fresh random id. */
  peerId?: string;
  /** Shared dedupe window. Defaults to a fresh one per attachment. */
  seen?: SeenEventIds;
  /** Serialized-payload cap in bytes. Defaults to 1 MB. */
  maxPayloadBytes?: number;
  /** Called when a received envelope is dropped as invalid. Never gets the payload. */
  onInvalidEnvelope?: (error: Error) => void;
}

/** Handle returned by `attachClusterTransport`. */
export interface ClusterBusHandle {
  /** Id of this worker, as carried on its envelopes. */
  peerId: string;
  /**
   * Emits locally, then forwards to every other worker. A local
   * listener failure is still forwarded (peers are independent) and
   * is rethrown afterwards only when `throwOnError` is set.
   */
  publish(event: string, data: unknown, options?: { throwOnError?: boolean }): Promise<void>;
  /** Detaches from the transport and closes it. */
  close(): Promise<void>;
}

/**
 * Connects one bus to a transport. The returned `publish` is the only
 * path that forwards: envelopes arriving from the transport are
 * emitted locally and stop there, so a forwarded event can never
 * bounce between workers. A bus with no attachment keeps behaving
 * exactly as before — local only.
 */
export function attachClusterTransport(
  bus: ClusterBus,
  transport: ClusterTransport,
  options: ClusterBusOptions = {},
): ClusterBusHandle {
  const peerId = options.peerId ?? newPeerId();
  const seen = options.seen ?? new SeenEventIds();
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  let closed = false;

  const unsubscribe = transport.subscribe(async (raw) => {
    if (closed) return;
    let envelope: ClusterEnvelope;
    try {
      envelope = parseClusterEnvelope(raw);
    } catch (err) {
      options.onInvalidEnvelope?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Mark before emitting on purpose, unlike the durable paths:
    // bridge emit swallows listener errors (the bus default), so
    // there is no failed state to retry, and marking first is what
    // stops two copies arriving together from both delivering.
    if (seen.hasSeen(envelope.eventId)) return;
    // Local emit only: never forward a received event again.
    await bus.emit(envelope.event, envelope.data);
  });

  return {
    peerId,
    async publish(event, data, publishOptions = {}) {
      if (closed) throw new Error("Cluster bus is closed.");
      if (!isValidClusterEventName(event)) {
        throw new Error(`Invalid cluster event name: ${JSON.stringify(event)}.`);
      }
      const json = assertSerializable(data);
      if (Buffer.byteLength(json, "utf8") > maxPayloadBytes) {
        throw new Error("Cluster payload exceeds the configured size limit.");
      }
      const envelope: ClusterEnvelope = {
        eventId: crypto.randomUUID(),
        event,
        data,
        origin: peerId,
        sentAt: Date.now(),
      };
      // Mark seen before emitting, so a looped-back copy of our own
      // envelope (a hub that echoes to the sender, for example) is
      // dropped instead of delivered twice to local listeners.
      seen.hasSeen(envelope.eventId);
      let localError: unknown = null;
      try {
        await bus.emit(event, data, { throwOnError: publishOptions.throwOnError });
      } catch (err) {
        localError = err;
      }
      // Peers are independent of local listeners: forward even when a
      // local listener failed, then report the local failure.
      await transport.send(envelope);
      if (localError !== null) throw localError;
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      await transport.close();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// In-process transport: several buses in one process (tests, and
// single-process multi-bus setups). No sockets, no config.
// ──────────────────────────────────────────────────────────────────────

/** A hub that fans envelopes out to every attached in-process peer. */
export class InProcessClusterHub {
  private readonly peers = new Set<{
    deliver: (envelope: ClusterEnvelope) => void | Promise<void>;
    onPeerError?: (error: Error) => void;
  }>();

  createTransport(onPeerError?: (error: Error) => void): ClusterTransport {
    const peer = {
      deliver: (_envelope: ClusterEnvelope) => {},
      onPeerError,
    };
    const handlers = new Set<(envelope: ClusterEnvelope) => void | Promise<void>>();
    peer.deliver = (envelope) => {
      for (const handler of handlers) {
        // One peer's failure must not stop delivery to the others.
        Promise.resolve(handler(envelope)).catch((err) => {
          peer.onPeerError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    };
    this.peers.add(peer);
    let closed = false;
    return {
      send: (envelope) => {
        if (closed) return;
        for (const other of [...this.peers]) {
          if (other === peer) continue;
          try {
            const result = other.deliver(envelope);
            if (result instanceof Promise) {
              result.catch((err) => {
                other.onPeerError?.(err instanceof Error ? err : new Error(String(err)));
              });
            }
          } catch (err) {
            other.onPeerError?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
      },
      subscribe: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.peers.delete(peer);
      },
    };
  }

  get peerCount(): number {
    return this.peers.size;
  }
}

/** Creates an in-process hub. See {@link InProcessClusterHub}. */
export function createInProcessClusterHub(): InProcessClusterHub {
  return new InProcessClusterHub();
}

// ──────────────────────────────────────────────────────────────────────
// WebSocket hub + transport: cluster workers are separate processes
// with no IPC channel, so they share events through one hub process.
// Run the hub once (any worker host, or a sidecar process); every
// worker connects to it. The hub keeps no state besides its live
// sockets: it is fan-out, not storage. Durable catch-up is part 2.
// ──────────────────────────────────────────────────────────────────────

export interface ClusterHubOptions {
  port?: number;
  hostname?: string;
  /**
   * Shared secret. Defaults to `CLUSTER_BUS_TOKEN`. The hub refuses
   * to start without one unless `allowUnauthenticated` is set, so a
   * hub is never accidentally open to the network.
   */
  token?: string;
  /** Local development only: accept peers without a token. */
  allowUnauthenticated?: boolean;
  /** Largest inbound message in bytes. Defaults to 1 MB. */
  maxPayloadBytes?: number;
  /** Idle timeout in seconds for hub sockets. Defaults to 120. */
  idleTimeoutSec?: number;
}

/** Handle returned by `createClusterHub`. */
export interface ClusterHubHandle {
  /** Port the hub actually bound to. */
  port: number;
  /** WebSocket URL workers connect to. */
  url: string;
  /** Currently connected, authenticated peers. */
  readonly peerCount: number;
  /** Invalid envelopes dropped since start. */
  readonly invalidCount: number;
  /** Stops the hub and drops every peer connection. */
  close(): void;
}

type HubSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  data?: { authed?: boolean };
};

/**
 * Starts a WebSocket hub on `Bun.serve`. Peers authenticate at
 * upgrade time with `Authorization: Bearer <token>`, or with a first
 * message of `{"type":"cluster-auth","token":"..."}` when they cannot
 * set headers. Unauthenticated sockets receive nothing, their
 * messages are dropped, and they are closed after a short grace
 * period. A bad peer therefore cannot inject events, and a dead peer
 * only removes itself: broadcast catches per-socket failures and
 * keeps going to the rest.
 */
export function createClusterHub(options: ClusterHubOptions = {}): ClusterHubHandle {
  const token = options.token ?? process.env.CLUSTER_BUS_TOKEN;
  if (!token && !options.allowUnauthenticated) {
    throw new Error(
      "Cluster hub needs a token (option `token` or CLUSTER_BUS_TOKEN), " +
        "or an explicit `allowUnauthenticated: true` for local development.",
    );
  }
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const sockets = new Set<HubSocket>();
  const authed = new Set<HubSocket>();
  let invalidCount = 0;
  let graceTimers: ReturnType<typeof setTimeout>[] = [];

  const broadcast = (from: HubSocket, raw: string): void => {
    for (const socket of [...sockets]) {
      if (socket === from || !authed.has(socket)) continue;
      try {
        socket.send(raw);
      } catch {
        // A dead peer must not lose the event for the live ones.
        sockets.delete(socket);
        authed.delete(socket);
      }
    }
  };

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== "/bus") {
        return new Response("Not found.", { status: 404 });
      }
      const header = req.headers.get("authorization");
      const headerToken =
        header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
      const authedByHeader =
        token !== undefined && headerToken !== null && tokensEqual(headerToken, token);
      if (server.upgrade(req, { data: { authed: authedByHeader || options.allowUnauthenticated === true } })) {
        return undefined as unknown as Response;
      }
      return new Response("Upgrade failed.", { status: 400 });
    },
    websocket: {
      // Type placeholder, per Bun's docs: this types ws.data and
      // the `data` option of server.upgrade below.
      data: {} as { authed: boolean },
      maxPayloadLength: maxPayloadBytes,
      idleTimeout: options.idleTimeoutSec ?? 120,
      open(ws) {
        const socket = ws as unknown as HubSocket;
        sockets.add(socket);
        if (socket.data?.authed) authed.add(socket);
        if (!socket.data?.authed && token !== undefined && options.allowUnauthenticated !== true) {
          // First-frame auth grace: a peer that cannot set headers
          // gets a few seconds to send its token, then it is cut off.
          const timer = setTimeout(() => {
            graceTimers = graceTimers.filter((t) => t !== timer);
            if (!authed.has(socket)) {
              try {
                socket.close(4401, "Unauthenticated.");
              } catch {}
              sockets.delete(socket);
            }
          }, 5000);
          graceTimers.push(timer);
        }
      },
      message(ws, message) {
        const socket = ws as unknown as HubSocket;
        const raw =
          typeof message === "string"
            ? message
            : message instanceof ArrayBuffer
              ? Buffer.from(message).toString("utf8")
              : Buffer.from(message as Uint8Array).toString("utf8");
        if (!authed.has(socket)) {
          // First-frame auth: the only message an unauthenticated
          // socket may send. The token is checked, never logged.
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (
              parsed.type === "cluster-auth" &&
              typeof parsed.token === "string" &&
              token !== undefined &&
              tokensEqual(parsed.token, token)
            ) {
              authed.add(socket);
              return;
            }
          } catch {}
          return;
        }
        // A repeat auth frame from an already-authenticated socket is
        // a no-op, not a malformed envelope.
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.type === "cluster-auth") return;
        } catch {
          invalidCount += 1;
          return;
        }
        // Validate before forwarding, so one bad peer cannot inject
        // a malformed envelope into every other worker.
        try {
          parseClusterEnvelope(JSON.parse(raw));
        } catch {
          invalidCount += 1;
          return;
        }
        broadcast(socket, raw);
      },
      close(ws) {
        const socket = ws as unknown as HubSocket;
        sockets.delete(socket);
        authed.delete(socket);
      },
    },
  });

  return {
    get port() {
      const bound = server.port;
      if (bound === undefined) throw new Error("Cluster hub did not bind a port.");
      return bound;
    },
    get url() {
      const host = options.hostname;
      const connectHost = host === undefined || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      return `ws://${connectHost}:${server.port}/bus`;
    },
    get peerCount() {
      return authed.size;
    },
    get invalidCount() {
      return invalidCount;
    },
    close() {
      for (const timer of graceTimers) {
        clearTimeout(timer);
      }
      graceTimers = [];
      for (const socket of [...sockets]) {
        try {
          socket.close(1000, "Hub shutting down.");
        } catch {}
      }
      sockets.clear();
      authed.clear();
      server.stop();
    },
  };
}

export interface WebSocketClusterTransportOptions {
  /** Shared secret. Defaults to `CLUSTER_BUS_TOKEN`. */
  token?: string;
  /** Reconnect after an unexpected close. Defaults to true. */
  reconnect?: boolean;
  /** First reconnect delay in milliseconds. Defaults to 100. */
  reconnectBaseMs?: number;
  /** Reconnect delay cap in milliseconds. Defaults to 5000. */
  reconnectMaxMs?: number;
  /**
   * Maximum reconnect attempts after an unexpected close. Unset by
   * default: retry forever with capped backoff. Set it when a peer
   * with a wrong token should stop retrying and surface as
   * disconnected instead of looping forever.
   */
  maxReconnectAttempts?: number;
  /** Called on connect, disconnect, and reconnect attempts. */
  onStatus?: (status: "connected" | "disconnected" | "reconnecting") => void;
}

/**
 * A transport that talks to a cluster hub over WebSocket. `connect`
 * must resolve before `send` is called; sending while disconnected
 * throws instead of silently dropping the event, so the caller can
 * fall back to durable recording. Unexpected closes reconnect with
 * backoff; an explicit `close` does not reconnect.
 */
export class WebSocketClusterTransport implements ClusterTransport {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<(envelope: ClusterEnvelope) => void | Promise<void>>();
  private explicitClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly options: WebSocketClusterTransportOptions = {},
  ) {}

  /** Opens the connection. Resolves when the socket is open. */
  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;
    this.explicitClose = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket();
    });
    return this.connectPromise;
  }

  private openSocket(): void {
    const token = this.options.token ?? process.env.CLUSTER_BUS_TOKEN;
    const socket = new WebSocket(
      this.url,
      token !== undefined
        ? ({ headers: { authorization: `Bearer ${token}` } } as never)
        : undefined,
    );
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      // First-frame auth as well: harmless when the header already
      // authenticated, required when headers were not forwarded.
      if (token !== undefined) {
        try {
          socket.send(JSON.stringify({ type: "cluster-auth", token }));
        } catch {}
      }
      this.options.onStatus?.("connected");
      this.connectResolve?.();
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // Auth frames and anything else the hub sends that is not an
      // envelope are ignored here; the bridge validates envelopes.
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>).type === "cluster-auth"
      ) {
        return;
      }
      for (const handler of [...this.handlers]) {
        Promise.resolve(handler(parsed as ClusterEnvelope)).catch(() => {
          // A throwing bridge handler must not kill the socket.
        });
      }
    };
    socket.onerror = () => {
      // The close handler below owns recovery; an error alone is not
      // a state change worth reporting twice.
    };
    socket.onclose = () => {
      this.socket = null;
      const wasConnecting = this.connectPromise !== null;
      if (wasConnecting) {
        this.connectPromise = null;
        this.connectResolve = null;
        const reject = this.connectReject;
        this.connectReject = null;
        reject?.(new Error("Cluster WebSocket closed before connecting."));
      }
      if (this.explicitClose) {
        this.options.onStatus?.("disconnected");
        return;
      }
      this.options.onStatus?.("reconnecting");
      if (this.options.reconnect === false) {
        this.options.onStatus?.("disconnected");
        return;
      }
      const maxAttempts = this.options.maxReconnectAttempts;
      if (maxAttempts !== undefined && this.reconnectAttempts >= maxAttempts) {
        this.options.onStatus?.("disconnected");
        return;
      }
      const base = this.options.reconnectBaseMs ?? 100;
      const max = this.options.reconnectMaxMs ?? 5000;
      const delay = Math.min(max, base * Math.pow(2, this.reconnectAttempts));
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.explicitClose) this.connect().catch(() => {});
      }, delay);
    };
  }

  send(envelope: ClusterEnvelope): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Never swallow: a dropped event the caller thinks was sent is
      // worse than an error the caller can fall back from.
      throw new Error("Cluster WebSocket is not connected; event was not sent.");
    }
    socket.send(JSON.stringify(envelope));
  }

  subscribe(handler: (envelope: ClusterEnvelope) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.explicitClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close();
      } catch {}
    }
    this.handlers.clear();
  }
}

/** Creates a WebSocket transport for a cluster hub. Call `connect()` on it. */
export function createWebSocketClusterTransport(
  url: string,
  options?: WebSocketClusterTransportOptions,
): WebSocketClusterTransport {
  return new WebSocketClusterTransport(url, options);
}

// ──────────────────────────────────────────────────────────────────────
// Durable delivery, on the shared change log. No new table, no new
// relay: recording uses `recordOutbox`, the relay path reuses
// `OutboxRelay` + `toEventPublish`, and the consumer path reads with
// `readChangeLog` in `seq` order.
// ──────────────────────────────────────────────────────────────────────

/** Data shape a durable event arrives with on the bus. */
export interface DurableBusEvent {
  /** The change-log identity. Handlers dedupe on this. */
  outboxEventId: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
  occurredAt: number;
}

export interface PublishDurableOptions {
  /** Pass one to make recording itself idempotent. Defaults to a fresh UUID. */
  eventId?: string;
  /** Caller-chosen dedupe key. A repeat is rejected at record time. */
  dedupeKey?: string;
  aggregateType?: string;
  aggregateId?: string;
  /** Business time of the event. Defaults to now. */
  occurredAt?: number;
}

/**
 * Records one durable event in the shared change log. Call it inside
 * `db.transaction()` alongside the write it records, so both commit
 * or roll back together. The event reaches the bus only when a relay
 * or consumer (below) publishes the row — recording alone emits
 * nothing, which is what makes it safe to record before commit.
 */
export function publishDurable(
  store: OutboxStore,
  event: string,
  payload: unknown,
  options: PublishDurableOptions = {},
): OutboxEntry {
  if (!isValidClusterEventName(event)) {
    throw new Error(`Invalid durable event name: ${JSON.stringify(event)}.`);
  }
  return recordOutbox(store, {
    eventType: event,
    payload,
    eventId: options.eventId,
    dedupeKey: options.dedupeKey,
    aggregateType: options.aggregateType,
    aggregateId: options.aggregateId,
    occurredAt: options.occurredAt,
  });
}

/**
 * Builds a relay publish function that emits change-log rows on the
 * bus, skipping rows this process already delivered. Wraps
 * `toEventPublish`, so listener failure still counts as publish
 * failure (the row stays pending) exactly as the change-log document
 * requires. Share one `SeenEventIds` with a durable consumer when
 * both read the same log, so the two paths do not double-deliver.
 */
export function createDurableRelayPublish(
  bus: ClusterBus,
  options: { seen?: SeenEventIds } = {},
): OutboxPublishFn {
  const seen = options.seen ?? new SeenEventIds();
  const publish = toEventPublish(
    {
      emit: (event: string, data: unknown, emitOptions?: { throwOnError?: boolean }) =>
        bus.emit(event, data, emitOptions),
    },
    undefined,
  );
  return async (entry) => {
    if (seen.has(entry.eventId)) return;
    // Mark seen only after the emit resolves: a listener failure
    // must leave the row retryable, not silently marked delivered.
    await publish(entry);
    seen.add(entry.eventId);
  };
}

/**
 * Creates a relay that publishes durable events on the bus. This is
 * the existing `OutboxRelay` with the bus adapter above — no new
 * relay logic, no new table. Rows are marked published only after
 * the bus emit resolves.
 */
export function createDurableRelay(
  store: OutboxStore,
  bus: ClusterBus,
  options: OutboxRelayOptions & { seen?: SeenEventIds } = {},
): OutboxRelay {
  return createOutboxRelay(store, createDurableRelayPublish(bus, { seen: options.seen }), options);
}

/** Where a durable consumer keeps its checkpoint (last delivered `seq`). */
export interface DurableCheckpoint {
  load(): number | undefined | Promise<number | undefined>;
  save(seq: number): void | Promise<void>;
}

/** File-backed checkpoint: atomic write (temp file + rename). */
export function createFileCheckpoint(filePath: string): DurableCheckpoint {
  return {
    load() {
      try {
        const raw = fs.readFileSync(filePath, "utf8").trim();
        const seq = Number(raw);
        return Number.isFinite(seq) ? seq : undefined;
      } catch {
        return undefined;
      }
    },
    save(seq: number) {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, String(seq), "utf8");
      fs.renameSync(tmp, filePath);
    },
  };
}

export interface DurableConsumerOptions {
  /** `seq` to resume from. Defaults to the checkpoint, else 0 (from the start). */
  fromSeq?: number;
  /** Checkpoint store. Defaults to in-memory only. */
  checkpoint?: DurableCheckpoint;
  /** Shared dedupe window. Defaults to a fresh one per consumer. */
  seen?: SeenEventIds;
  /** Rows per read. Defaults to 100. */
  batchSize?: number;
  /** Milliseconds between polls. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Only deliver this event type. Defaults to all types. */
  eventType?: string;
  /** Called when a listener fails or a checkpoint save fails. The row is retried. */
  onError?: (error: Error, entry: OutboxEntry) => void;
}

/** Result of one consumer pass. */
export interface DurableConsumerResult {
  delivered: number;
  skipped: number;
  failed: number;
}

/**
 * Replays the shared change log into the bus, in `seq` order, one
 * row at a time. The checkpoint advances only after a successful
 * emit, so a listener failure stops the pass at that row: the event
 * is retried on the next pass, never skipped. Reads ignore row
 * status — the log is history, and a row that happened counts even
 * before any relay marks it published. A restart replays from the
 * checkpoint, so a crash between emit and checkpoint save can
 * deliver one event twice; handlers must dedupe by `outboxEventId`.
 */
export class DurableConsumer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private cursor: number;
  private readonly seen: SeenEventIds;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly bus: ClusterBus,
    private readonly store: OutboxStore,
    private readonly options: DurableConsumerOptions = {},
  ) {
    this.seen = options.seen ?? new SeenEventIds();
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.cursor = options.fromSeq ?? 0;
  }

  /** Last delivered `seq` (0 when nothing has been delivered yet). */
  get lastSeq(): number {
    return this.cursor;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Loads a stored checkpoint into the cursor, if one exists. */
  async loadCheckpoint(): Promise<void> {
    if (this.options.checkpoint) {
      const saved = await this.options.checkpoint.load();
      if (saved !== undefined && saved > this.cursor) this.cursor = saved;
    }
  }

  /**
   * Delivers every unread row, in order, until the log is caught up
   * or a listener fails. A failure ends the pass without advancing
   * past the failed row.
   */
  async runOnce(): Promise<DurableConsumerResult> {
    if (this.inFlight) return { delivered: 0, skipped: 0, failed: 0 };
    this.inFlight = true;
    try {
      const result: DurableConsumerResult = { delivered: 0, skipped: 0, failed: 0 };
      for (;;) {
        const rows = readChangeLog(this.store, {
          afterSeq: this.cursor,
          limit: this.batchSize,
          eventType: this.options.eventType,
        });
        if (rows.length === 0) break;
        let failed = false;
        for (const entry of rows) {
          if (this.seen.has(entry.eventId)) {
            this.cursor = entry.seq;
            result.skipped += 1;
            continue;
          }
          const data: DurableBusEvent = {
            outboxEventId: entry.eventId,
            eventType: entry.eventType,
            aggregateType: entry.aggregateType,
            aggregateId: entry.aggregateId,
            payload: entry.payload,
            occurredAt: entry.occurredAt,
          };
          try {
            await this.bus.emit(entry.eventType, data, { throwOnError: true });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.options.onError?.(error, entry);
            result.failed += 1;
            failed = true;
            break;
          }
          // Mark seen only after a successful emit, so a failed row
          // stays eligible for retry instead of being skipped.
          this.seen.add(entry.eventId);
          this.cursor = entry.seq;
          result.delivered += 1;
          if (this.options.checkpoint) {
            try {
              await this.options.checkpoint.save(this.cursor);
            } catch (err) {
              // The in-memory cursor still advanced; a restart may
              // replay this row, which at-least-once delivery allows.
              // Report it, do not stop delivery for it.
              this.options.onError?.(
                err instanceof Error ? err : new Error(String(err)),
                entry,
              );
            }
          }
        }
        if (failed || rows.length < this.batchSize) break;
      }
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  /** Starts polling, with one pass immediately. Loads a checkpoint first. */
  async start(): Promise<void> {
    if (this.timer !== null) return;
    await this.loadCheckpoint();
    void this.runOnce().catch(() => {});
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      void this.runOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  /** Stops polling. A pass already running finishes. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Creates a durable consumer. See {@link DurableConsumer}. */
export function createDurableConsumer(
  bus: ClusterBus,
  store: OutboxStore,
  options?: DurableConsumerOptions,
): DurableConsumer {
  return new DurableConsumer(bus, store, options);
}
