# Outbox — durable delivery for events and jobs

Your app writes to one database file, then pipes an event into another.
A crash between the two drops the event silently. The outbox fixes that:
the event is recorded in the same file, in the same transaction, as the
change it describes. A relay then publishes it to the job queue or the
event bus, and marks it done only after the publish succeeds.

```ts
import { createDatabase, col } from "../types/db";

const db = createDatabase({ path: "Database/app.db", schema });

db.transaction((tx) => {
  const user = tx.users.insert({ email: "ada@example.com", name: "Ada" });
  tx.recordOutbox({
    eventType: "user.registered",
    aggregateType: "user",
    aggregateId: user.id,
    payload: { userId: user.id, email: user.email },
  });
});
```

If the transaction rolls back, the user row and the outbox entry both
disappear. If it commits, both are durable. There is no window where
one exists without the other.

## Opt-in and lazy — zero cost when unconfigured

The outbox is fully opt-in. Plain writes do nothing extra: no outbox
table is created, no log row is written, and the outbox module is not
even loaded until the first `recordOutbox()` call. Nothing starts a
relay unless the app constructs one. When replication, replay, and the
outbox are all unconfigured, the write path is exactly the write path
that existed before this feature — no fast path with a flag check, no
work at all. Everything runs on SQLite itself through Bun's own
`bun:sqlite` primitives; there is no sidecar process and no new native
dependency.

## Relay — publish, then mark done

```ts
import { createOutboxRelay, toJobPublish } from "../types/outbox";
import { jobs } from "./jobs";

const relay = createOutboxRelay(db, toJobPublish(jobs, "send-email"));
relay.start();
```

The relay scans pending rows in order, publishes each one, and marks it
published only after the publish resolves. A failure leaves the row
pending for retry with exponential backoff; after 5 attempts it goes
to the dead list instead of retrying forever. Restart pickup is free:
the relay keeps no state in memory, so a fresh relay on the same file
picks up whatever the last one left behind.

Delivery is at-least-once. A crash after publish but before the mark
publishes the entry again, so handlers must tolerate a second delivery.
Job delivery helps: each job is enqueued with a key derived from the
event, so a redelivery while the first job is still active returns the
existing job instead of a duplicate. After the first job completes, the
handler itself must still check the event before any side effect that
cannot run twice.

```ts
import { createOutboxRelay, toEventPublish } from "../types/outbox";
import { events } from "./events";

// Emits the event after commit, instead of emitting directly.
const relay = createOutboxRelay(db, toEventPublish(events));
relay.start();
```

## Reading the log

The outbox table is also the shared change log: one log that later
features can use for replication and replay. Read it by checkpoint,
in order, and keep the checkpoint wherever the reader owns state.

```ts
import { readChangeLog } from "../types/outbox";

const rows = readChangeLog(db, { afterSeq: lastSeenSeq, limit: 100 });
const userHistory = readChangeLog(db, { aggregateType: "user", aggregateId: userId });
```

Published rows are kept as history. Purge them only below every
reader's checkpoint, with `purgePublished()`, and never expect a
sequence number to be reused: rolled-back writes leave gaps, and gaps
mean "nothing was ever published there".

## Gotchas

- Recording outside a transaction is still one atomic insert, but it
  is not atomic with anything else. The whole point is lost if the
  user write and `recordOutbox()` are two separate calls outside
  `db.transaction()`.
- `db.transaction()` takes a synchronous function. Do the async work
  first, then run the transaction.
- One relay per database file. Two relays on the same file do not lose
  events, but they can both publish the same row before either marks
  it, so duplicates rise.
- A publish function with no timeout of its own can stall a scan.
  Pass `publishTimeoutMs` when the publish target has no timeout.
- Never put secrets in a payload. The log is retained as history.
- A duplicate event id or dedupe key is rejected at record time.
  That is the write-time dedupe working, not a bug.
