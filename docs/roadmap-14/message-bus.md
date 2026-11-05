# Message bus: cluster delivery and durable delivery

The bus itself already exists: `createEvents` in `src/types/job.ts`
gives you `on` / `once` / `emit` / `waitFor` / `pipe`, with exact,
prefix, suffix, and global wildcard matching. This page covers only
the two gaps: sharing events between `yatta cluster` workers, and
delivering events durably. Nothing here replaces the bus, and nothing
here runs unless you opt into it — a bus with no attachment behaves
exactly as before, local only.

Import from the lazy entry point. It is not imported by the bus, the
CLI, or the server entry point, so importing the rest of the
framework never pulls it in:

```ts
import {
  attachClusterTransport,
  createClusterHub,
  createWebSocketClusterTransport,
  createDurableConsumer,
  publishDurable,
} from "yatta.js/bus-cluster";
```

## Cluster delivery: live fan-out between workers

Cluster workers are separate processes with no channel between them,
so they share events through one hub process. Run the hub once, then
connect every worker to it:

```ts
// Hub process (once, anywhere the workers can reach it).
// Binds localhost by default. Needs a token unless you explicitly
// allow unauthenticated peers for local development.
const hub = createClusterHub({ token: process.env.CLUSTER_BUS_TOKEN });
console.log("hub at", hub.url);
```

```ts
// In each worker, next to the bus you already have:
import { createEvents } from "yatta.js/jobs";

const events = createEvents();
const transport = createWebSocketClusterTransport(hubUrl, {
  token: process.env.CLUSTER_BUS_TOKEN,
});
await transport.connect();
const cluster = attachClusterTransport(events, transport);

// Emits locally AND to every other worker:
await cluster.publish("user.registered", { userId: "u1" });

// Listeners registered the usual way fire for local and remote
// events alike. No listener changes needed:
events.on("user.registered", (user) => {
  console.log("welcome", user.userId);
});
```

Rules of the road:

- `publish` is the only path that forwards. An event arriving from
  the hub is emitted locally and stops there, so it can never bounce
  between workers. A worker hears its own publish once, from its
  local emit, not from the hub echo.
- Delivery is live fan-out only. A worker that is down when an event
  is published misses it — there is no replay on the hub. When a
  missed event must be caught up after a restart, record it durably
  (below) and replay from the change log.
- `publish` sends only JSON-faithful payloads. Functions, undefined,
  symbols, bigints, non-finite numbers, and circular values are
  rejected, because plain `JSON.stringify` would silently change
  them in transit (dropping function properties, turning `NaN`
  into `null`). Event names must be plain dotted names: no
  wildcards, no empty segments.
- Sending while disconnected throws instead of silently dropping
  the event, so the caller can fall back to durable recording.
  Unexpected closes reconnect with capped backoff; set
  `maxReconnectAttempts` when a peer with a wrong token should stop
  retrying and surface as disconnected.
- Payloads are untrusted network input. The bridge validates the
  envelope shape and never runs code carried in a payload, but a
  listener must still validate any field it acts on, the same as
  for any network input.

## Durable delivery: the shared change log, not a second log

Durable delivery is built on the shared change log from feature 7:
the same `_yatta_outbox` table in the same database file, the same
`recordOutbox` / `readChangeLog` contract. See
`docs/roadmap-14/shared-change-log.md` for the schema, ordering, and
lifecycle rules. No new table is created here.

Record inside the transaction, alongside the write the event is
about, so both commit or roll back together:

```ts
import { publishDurable } from "yatta.js/bus-cluster";

db.transaction((tx) => {
  const user = tx.users.insert({ email: "ada@example.com", name: "Ada" });
  publishDurable(tx, "user.registered", { userId: user.id, email: user.email });
});
```

Recording alone emits nothing — that is what makes it safe to
record before commit. Delivery comes from a consumer (or a relay)
reading the log:

```ts
// Replay the log into the bus, in seq order, one row at a time.
const consumer = createDurableConsumer(events, db, {
  checkpoint: createFileCheckpoint("Database/bus-checkpoint.txt"),
});
await consumer.start();
```

A durable event arrives on the bus under its event type, carrying
the change-log envelope:

```ts
events.on("user.registered", (event) => {
  // event.outboxEventId, event.eventType, event.payload,
  // event.aggregateType, event.aggregateId, event.occurredAt
  console.log(event.payload);
});
```

The relay form, for processes that already run an outbox relay, is
the existing `OutboxRelay` with a bus adapter — rows are marked
published only after the bus emit resolves, and a listener failure
leaves the row pending for retry:

```ts
import { createDurableRelay } from "yatta.js/bus-cluster";

const relay = createDurableRelay(db, events);
relay.start();
```

## Delivery guarantees, stated plainly

- Cluster delivery is at-most-once per live peer: a peer that is
  down misses the event, a peer that is up gets it once (duplicate
  envelopes arriving together are deduped by event id).
- Durable delivery is at-least-once. A crash between emit and
  checkpoint save, or a relay redelivery, can deliver one event
  twice. Handlers must stay idempotent by `outboxEventId` — check
  it before any non-idempotent side effect. The consumer's dedupe
  window only removes the common in-process duplicates (relay
  rescans, overlapping polls); it does not make delivery
  exactly-once, and no window could after a crash.
- The consumer's checkpoint advances only after a successful emit.
  A listener failure stops the pass at that row: the event is
  retried on the next pass, never skipped, and order is preserved.
- Cluster `publish` is not atomic across local and remote: local
  listeners fire before the forward happens, so a failed forward
  still leaves local side effects done. If you need atomicity,
  record durably first and let the relay or consumer deliver.

## Gotchas

- Run one durable reader per log per process: either a relay or a
  consumer, not two independent ones expecting exactly-once. If
  both must read the same log, share one `SeenEventIds` between
  them so the second path skips rows the first already delivered.
- Do not share a checkpoint between a filtered consumer
  (`eventType` set) and an unfiltered one: the filtered consumer's
  checkpoint jumps past rows of other types, and an unfiltered
  consumer resuming from it would never see them.
- The hub's token is the trust boundary: anyone holding it can
  inject events into every worker. Keep the hub on localhost or
  behind TLS, never log the token, and rotate it if it leaks.
  The hub has no per-peer rate limiting, so a compromised token
  holder can flood workers — that is a reason to guard the token,
  not a reason to trust the payloads.
- `publishDurable` rejects the same event id or dedupe key twice
  at record time. That is the write-time dedupe working: pass a
  fresh id per event, or reuse an id deliberately to make recording
  itself idempotent.
- The durable consumer reads rows regardless of relay status —
  the log is history, and a row that happened counts even before
  any relay marks it published. That includes dead rows: a row the
  relay gave up on still replays through a consumer.
- Cluster mode today is one process per core with no shared
  memory. The hub is a separate process you run and supervise
  alongside them; if the hub dies, workers keep serving locally
  and their transports reconnect with backoff when it returns.
