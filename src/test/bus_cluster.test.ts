import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvents } from "../types/job";
import { createDatabase, col, type TypedDatabase } from "../types/db";
import { recordOutbox, getOutboxByEventId } from "../types/outbox";
import {
  attachClusterTransport,
  createClusterHub,
  createDurableConsumer,
  createDurableRelay,
  createDurableRelayPublish,
  createFileCheckpoint,
  createInProcessClusterHub,
  createWebSocketClusterTransport,
  isValidClusterEventName,
  parseClusterEnvelope,
  publishDurable,
  SeenEventIds,
} from "../types/bus_cluster";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const schema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    name: col.text(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
};

type TestDb = TypedDatabase<typeof schema>;
const dbs: TestDb[] = [];
const tmpDirs: string[] = [];
const closers: Array<() => void | Promise<void>> = [];

function memDb(): TestDb {
  const db = createDatabase({ path: ":memory:", schema, forceNew: true });
  dbs.push(db);
  return db;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yatta-bus12-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const close of closers.splice(0)) {
    try {
      await close();
    } catch {}
  }
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("bus cluster — unconfigured buses stay local", () => {
  it("two buses without an attachment never share events", async () => {
    const a = createEvents();
    const b = createEvents();
    const seen: unknown[] = [];
    b.on("user.registered", (data) => seen.push(data));
    await a.emit("user.registered", { userId: "u1" });
    expect(seen).toEqual([]);
  });
});

describe("bus cluster — in-process transport", () => {
  it("publishes to the other bus, and the sender hears its own event only once", async () => {
    const hub = createInProcessClusterHub();
    const a = createEvents();
    const b = createEvents();
    const ha = attachClusterTransport(a, hub.createTransport());
    const hb = attachClusterTransport(b, hub.createTransport());
    closers.push(() => ha.close(), () => hb.close());
    const aSeen: unknown[] = [];
    const bSeen: unknown[] = [];
    a.on("user.registered", (data) => aSeen.push(data));
    b.on("user.registered", (data) => bSeen.push(data));
    await ha.publish("user.registered", { userId: "u1" });
    await sleep(20);
    expect(aSeen).toEqual([{ userId: "u1" }]);
    expect(bSeen).toEqual([{ userId: "u1" }]);
  });

  it("remote events match wildcard listeners", async () => {
    const hub = createInProcessClusterHub();
    const a = createEvents();
    const b = createEvents();
    const ha = attachClusterTransport(a, hub.createTransport());
    const hb = attachClusterTransport(b, hub.createTransport());
    closers.push(() => ha.close(), () => hb.close());
    const seen: string[] = [];
    b.on("order.*", (_data, name) => seen.push(name));
    await ha.publish("order.paid", { orderId: "o1" });
    await sleep(20);
    expect(seen).toEqual(["order.paid"]);
  });

  it("a redelivered envelope is delivered once (dedupe by eventId)", async () => {
    const hub = createInProcessClusterHub();
    const a = createEvents();
    const b = createEvents();
    const ha = attachClusterTransport(a, hub.createTransport());
    const hb = attachClusterTransport(b, hub.createTransport());
    closers.push(() => ha.close(), () => hb.close());
    const seen: unknown[] = [];
    b.on("user.registered", (data) => seen.push(data));
    // Reach into the transport: send the same envelope twice by hand.
    const transport = hub.createTransport();
    const hc = attachClusterTransport(createEvents(), transport);
    closers.push(() => hc.close());
    const envelope = {
      eventId: "00000000-0000-4000-8000-000000000001",
      event: "user.registered",
      data: { userId: "u9" },
      origin: "peer-x",
      sentAt: Date.now(),
    };
    // Deliver twice through a fresh transport pair that shares bus b's
    // bridge path: emulate a relay rescan by re-sending via the hub.
    const sender = hub.createTransport();
    sender.send(envelope);
    sender.send(envelope);
    await sleep(30);
    expect(seen).toEqual([{ userId: "u9" }]);
    void ha;
    void hb;
  });

  it("one peer's throwing listener does not stop fan-out to the others", async () => {
    const errors: Error[] = [];
    const hub = createInProcessClusterHub();
    const a = createEvents();
    const b = createEvents();
    const c = createEvents();
    const ha = attachClusterTransport(a, hub.createTransport((e) => errors.push(e)));
    const hb = attachClusterTransport(b, hub.createTransport((e) => errors.push(e)));
    const hc = attachClusterTransport(c, hub.createTransport((e) => errors.push(e)));
    closers.push(() => ha.close(), () => hb.close(), () => hc.close());
    b.on("ping", () => {
      throw new Error("boom");
    });
    const cSeen: unknown[] = [];
    c.on("ping", (data) => cSeen.push(data));
    await ha.publish("ping", { n: 1 });
    await sleep(30);
    expect(cSeen).toEqual([{ n: 1 }]);
  });

  it("invalid envelopes are dropped, never delivered", () => {
    const received: unknown[] = [];
    const bus = createEvents();
    bus.on("user.registered", (data) => received.push(data));
    const hub = createInProcessClusterHub();
    const handle = attachClusterTransport(bus, hub.createTransport());
    closers.push(() => handle.close());
    // Bypass publish validation: hand a malformed envelope straight
    // to a second peer transport, the way a hostile or buggy peer would.
    const rogue = hub.createTransport();
    (rogue as { send: (e: unknown) => void }).send({
      eventId: "x",
      event: "*",
      data: {},
      origin: "peer-x",
      sentAt: Date.now(),
    } as never);
    expect(received).toEqual([]);
  });

  it("rejects wildcard, malformed, and oversized payloads on publish", async () => {
    const hub = createInProcessClusterHub();
    const handle = attachClusterTransport(createEvents(), hub.createTransport());
    closers.push(() => handle.close());
    await expect(handle.publish("*", {})).rejects.toThrow();
    await expect(handle.publish("a..b", {})).rejects.toThrow();
    await expect(handle.publish("ok.event", { fn: () => {} })).rejects.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(handle.publish("ok.event", circular)).rejects.toThrow();
    await expect(
      handle.publish("ok.event", { big: "x".repeat(100) }, undefined),
    ).resolves.toBeUndefined();
    const small = attachClusterTransport(createEvents(), hub.createTransport(), {
      maxPayloadBytes: 10,
    });
    closers.push(() => small.close());
    await expect(
      small.publish("ok.event", { big: "x".repeat(100) }),
    ).rejects.toThrow(/size limit/);
  });
});

describe("bus cluster — envelope validation", () => {
  it("accepts a well-formed envelope and rejects the rest", () => {
    const good = {
      eventId: "e1",
      event: "user.registered",
      data: { a: 1 },
      origin: "w0",
      sentAt: 1,
    };
    expect(parseClusterEnvelope(good).event).toBe("user.registered");
    expect(() => parseClusterEnvelope(null)).toThrow();
    expect(() => parseClusterEnvelope({ ...good, event: "" })).toThrow();
    expect(() => parseClusterEnvelope({ ...good, event: "a b" })).toThrow();
    expect(() => parseClusterEnvelope({ ...good, eventId: "" })).toThrow();
    expect(() => parseClusterEnvelope({ ...good, sentAt: "now" })).toThrow();
    expect(() => parseClusterEnvelope({ ...good, data: undefined })).toThrow();
    expect(isValidClusterEventName("user.registered")).toBe(true);
    expect(isValidClusterEventName("*")).toBe(false);
    expect(isValidClusterEventName("a..b")).toBe(false);
    expect(isValidClusterEventName("")).toBe(false);
  });

  it("seen window evicts the oldest ids", () => {
    const seen = new SeenEventIds(2);
    expect(seen.hasSeen("a")).toBe(false);
    expect(seen.hasSeen("b")).toBe(false);
    expect(seen.hasSeen("a")).toBe(true);
    expect(seen.hasSeen("c")).toBe(false);
    // "a" fell out of the window of 2, so it counts as new again.
    expect(seen.hasSeen("a")).toBe(false);
  });
});

describe("bus cluster — WebSocket hub", () => {
  it("refuses to start without a token unless explicitly allowed", () => {
    delete process.env.CLUSTER_BUS_TOKEN;
    expect(() => createClusterHub()).toThrow(/token/);
    const open = createClusterHub({ allowUnauthenticated: true });
    open.close();
  });

  it("delivers between real hub peers, and drops a dead peer without losing the rest", async () => {
    const hub = createClusterHub({ token: "test-token-feat12" });
    closers.push(() => hub.close());
    const a = createEvents();
    const b = createEvents();
    const c = createEvents();
    const ta = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    const tb = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    const tc = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    await Promise.all([ta.connect(), tb.connect(), tc.connect()]);
    const ha = attachClusterTransport(a, ta);
    const hb = attachClusterTransport(b, tb);
    const hc = attachClusterTransport(c, tc);
    closers.push(() => ha.close(), () => hb.close(), () => hc.close());
    const bSeen: unknown[] = [];
    const cSeen: unknown[] = [];
    b.on("order.paid", (data) => bSeen.push(data));
    c.on("order.paid", (data) => cSeen.push(data));
    await ha.publish("order.paid", { orderId: "o7" });
    await sleep(100);
    expect(bSeen).toEqual([{ orderId: "o7" }]);
    expect(cSeen).toEqual([{ orderId: "o7" }]);
    // Kill peer C, then publish again: B must still receive.
    await hc.close();
    await sleep(100);
    await ha.publish("order.paid", { orderId: "o8" });
    await sleep(100);
    expect(bSeen).toEqual([{ orderId: "o7" }, { orderId: "o8" }]);
    expect(cSeen).toEqual([{ orderId: "o7" }]);
  });

  it("an unauthenticated peer cannot inject events", async () => {
    const hub = createClusterHub({ token: "test-token-feat12" });
    closers.push(() => hub.close());
    const good = createEvents();
    const tg = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    await tg.connect();
    const hg = attachClusterTransport(good, tg);
    closers.push(() => hg.close());
    const seen: unknown[] = [];
    good.on("evil.event", (data) => seen.push(data));
    // Raw socket, no token anywhere: header or first frame.
    const rogue = new WebSocket(hub.url);
    await new Promise<void>((resolve) => {
      rogue.onopen = () => resolve();
    });
    rogue.send(
      JSON.stringify({
        eventId: "rogue-1",
        event: "evil.event",
        data: { injected: true },
        origin: "rogue",
        sentAt: Date.now(),
      }),
    );
    await sleep(150);
    expect(seen).toEqual([]);
    rogue.close();
  });

  it("a wrong-token peer receives nothing", async () => {
    const hub = createClusterHub({ token: "test-token-feat12" });
    closers.push(() => hub.close());
    const good = createEvents();
    const tg = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    await tg.connect();
    const hg = attachClusterTransport(good, tg);
    closers.push(() => hg.close());
    const bad = createEvents();
    const tb = createWebSocketClusterTransport(hub.url, { token: "wrong-token" });
    await tb.connect();
    const hb = attachClusterTransport(bad, tb);
    closers.push(() => hb.close());
    const badSeen: unknown[] = [];
    bad.on("order.paid", (data) => badSeen.push(data));
    await hg.publish("order.paid", { orderId: "o1" });
    await sleep(150);
    expect(badSeen).toEqual([]);
  });

  it("the hub drops malformed envelopes instead of forwarding them", async () => {
    const hub = createClusterHub({ token: "test-token-feat12" });
    closers.push(() => hub.close());
    const good = createEvents();
    const tg = createWebSocketClusterTransport(hub.url, { token: "test-token-feat12" });
    await tg.connect();
    const hg = attachClusterTransport(good, tg);
    closers.push(() => hg.close());
    const seen: unknown[] = [];
    good.on("evil.event", (data) => seen.push(data));
    const raw = new WebSocket(hub.url, {
      headers: { authorization: "Bearer test-token-feat12" },
    } as never);
    await new Promise<void>((resolve) => {
      raw.onopen = () => resolve();
    });
    raw.send(JSON.stringify({ eventId: "bad-1", event: "*", data: {}, origin: "x", sentAt: 1 }));
    await sleep(100);
    expect(hub.invalidCount).toBe(1);
    expect(seen).toEqual([]);
    raw.close();
  });

  it("sending while disconnected throws instead of silently dropping", async () => {
    const transport = createWebSocketClusterTransport("ws://127.0.0.1:1/bus", {
      token: "x",
      reconnect: false,
    });
    closers.push(() => transport.close());
    expect(() =>
      transport.send({
        eventId: "e1",
        event: "a.b",
        data: {},
        origin: "w",
        sentAt: 1,
      }),
    ).toThrow(/not connected/);
  });
});

describe("bus durable — shared change log, no second log", () => {
  it("records via the outbox table and replays in seq order", async () => {
    const db = memDb();
    const bus = createEvents();
    const got: Array<{ type: string; payload: unknown }> = [];
    bus.on("user.registered", (data: any) => got.push({ type: "user.registered", payload: data.payload }));
    bus.on("order.paid", (data: any) => got.push({ type: "order.paid", payload: data.payload }));
    db.transaction((tx) => {
      tx.users.insert({ email: "ada@example.com", name: "Ada" });
      publishDurable(tx as never, "user.registered", { userId: "u1" });
      publishDurable(tx as never, "order.paid", { orderId: "o1" });
    });
    const consumer = createDurableConsumer(bus, db as never);
    closers.push(() => consumer.stop());
    const result = await consumer.runOnce();
    expect(result).toEqual({ delivered: 2, skipped: 0, failed: 0 });
    expect(got.map((g) => g.type)).toEqual(["user.registered", "order.paid"]);
    expect(got[0].payload).toEqual({ userId: "u1" });
    expect(consumer.lastSeq).toBe(2);
    // Second pass delivers nothing: the checkpoint already covers it.
    expect(await consumer.runOnce()).toEqual({ delivered: 0, skipped: 0, failed: 0 });
  });

  it("a file checkpoint lets a new consumer resume instead of replaying everything", async () => {
    const db = memDb();
    const dir = tmpDir();
    const checkpoint = createFileCheckpoint(path.join(dir, "checkpoint.txt"));
    const busA = createEvents();
    const seenA: unknown[] = [];
    busA.on("user.registered", (data: any) => seenA.push(data.payload));
    publishDurable(db as never, "user.registered", { n: 1 });
    publishDurable(db as never, "user.registered", { n: 2 });
    const consumerA = createDurableConsumer(busA, db as never, { checkpoint });
    await consumerA.runOnce();
    expect(seenA).toEqual([{ n: 1 }, { n: 2 }]);
    // New consumer, same checkpoint file: only rows after it deliver.
    publishDurable(db as never, "user.registered", { n: 3 });
    const busB = createEvents();
    const seenB: unknown[] = [];
    busB.on("user.registered", (data: any) => seenB.push(data.payload));
    const consumerB = createDurableConsumer(busB, db as never, { checkpoint });
    await consumerB.loadCheckpoint();
    await consumerB.runOnce();
    expect(seenB).toEqual([{ n: 3 }]);
  });

  it("a listener failure stops the pass at that row and retries in order", async () => {
    const db = memDb();
    const bus = createEvents();
    publishDurable(db as never, "user.registered", { n: 1 });
    publishDurable(db as never, "user.registered", { n: 2 });
    let failFirst = true;
    const got: unknown[] = [];
    bus.on("user.registered", (data: any) => {
      if (failFirst && data.payload.n === 1) throw new Error("listener down");
      got.push(data.payload);
    });
    const errors: Error[] = [];
    const consumer = createDurableConsumer(bus, db as never, {
      onError: (err) => errors.push(err),
    });
    const first = await consumer.runOnce();
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);
    expect(consumer.lastSeq).toBe(0);
    expect(got).toEqual([]);
    failFirst = false;
    const second = await consumer.runOnce();
    expect(second).toEqual({ delivered: 2, skipped: 0, failed: 0 });
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
    expect(errors.length).toBe(1);
  });

  it("handlers dedupe a replay by outboxEventId (at-least-once, honestly)", async () => {
    const db = memDb();
    const bus = createEvents();
    publishDurable(db as never, "user.registered", { n: 1 });
    // A fresh consumer from the start replays the row: a crash between
    // emit and checkpoint save does exactly this in production.
    const applied = new Set<string>();
    const appliedPayloads: unknown[] = [];
    bus.on("user.registered", (data: any) => {
      if (applied.has(data.outboxEventId)) return;
      applied.add(data.outboxEventId);
      appliedPayloads.push(data.payload);
    });
    const first = createDurableConsumer(bus, db as never);
    await first.runOnce();
    const replay = createDurableConsumer(bus, db as never);
    await replay.runOnce();
    expect(appliedPayloads).toEqual([{ n: 1 }]);
  });

  it("a duplicate eventId is rejected at record time, not delivered twice", async () => {
    const db = memDb();
    publishDurable(db as never, "user.registered", { n: 1 }, { eventId: "dup-1" });
    expect(() =>
      publishDurable(db as never, "user.registered", { n: 1 }, { eventId: "dup-1" }),
    ).toThrow();
    const bus = createEvents();
    const got: unknown[] = [];
    bus.on("user.registered", (data: any) => got.push(data.payload));
    const consumer = createDurableConsumer(bus, db as never);
    await consumer.runOnce();
    expect(got).toEqual([{ n: 1 }]);
  });

  it("the durable relay marks rows published only after the bus emit resolves", async () => {
    const db = memDb();
    const bus = createEvents();
    const entry = recordOutbox(db as never, {
      eventType: "user.registered",
      payload: { n: 1 },
    });
    let fail = true;
    bus.on("user.registered", () => {
      if (fail) throw new Error("listener down");
    });
    const relay = createDurableRelay(db as never, bus, {
      pollIntervalMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    const first = await relay.runOnce();
    expect(first.failed).toBe(1);
    expect(getOutboxByEventId(db as never, entry.eventId)?.status).toBe("pending");
    fail = false;
    await sleep(10);
    const second = await relay.runOnce();
    expect(second.published).toBe(1);
    expect(getOutboxByEventId(db as never, entry.eventId)?.status).toBe("published");
  });

  it("relay and consumer sharing a seen window do not double-deliver", async () => {
    const db = memDb();
    const bus = createEvents();
    publishDurable(db as never, "user.registered", { n: 1 });
    const seen = new SeenEventIds();
    const got: unknown[] = [];
    bus.on("user.registered", (data: any) => got.push(data.payload));
    const relay = createDurableRelay(db as never, bus, {
      pollIntervalMs: 60_000,
      seen,
    });
    await relay.runOnce();
    const consumer = createDurableConsumer(bus, db as never, { seen });
    const result = await consumer.runOnce();
    expect(result.skipped).toBe(1);
    expect(got).toEqual([{ n: 1 }]);
  });

  it("rejects invalid durable event names", async () => {
    const db = memDb();
    expect(() => publishDurable(db as never, "*", {})).toThrow();
    expect(() => publishDurable(db as never, "a..b", {})).toThrow();
  });
});
