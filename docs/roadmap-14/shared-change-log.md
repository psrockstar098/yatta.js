# Shared change log — one log for outbox, replication, and replay

One log, not three. Every database file that needs durable delivery keeps a
single `_yatta_outbox` table in that same file. The outbox relay publishes
from it today; a future replication worker and a future time-travel replay
worker read from the same table, in the same order, with the same rules.
Nothing in this document requires a new table for those later features.

## The rule that makes it work

Write the change and its log entry in the same transaction, in the same
file. If the transaction rolls back, both disappear. If it commits, both
are durable. There is no window where the change exists but the event
does not, or the other way round.

```ts
import { createDatabase, col } from "../types/db";
import { recordOutbox } from "../types/outbox";

const db = createDatabase({ path: "Database/app.db", schema });

db.transaction((tx) => {
  const user = tx.users.insert({ email: "ada@example.com", name: "Ada" });
  // Same transaction, same file: this row commits or rolls back with the insert.
  recordOutbox(tx, {
    eventType: "user.registered",
    aggregateType: "user",
    aggregateId: user.id,
    payload: { userId: user.id, email: user.email },
  });
});
```

The short form does the same thing through the database object:

```ts
db.transaction((tx) => {
  tx.users.insert({ email: "ada@example.com", name: "Ada" });
  tx.recordOutbox({ eventType: "user.registered", payload: { email: "ada@example.com" } });
});
```

## Schema

Table `_yatta_outbox`, created with `CREATE TABLE IF NOT EXISTS` by
`ensureOutboxTable()` (called automatically by `recordOutbox()` and by
the relay, so app code never creates it by hand). One table per database
file: `app.db`, `jobs.db`, `cache.db`, and the auth store each get their
own log. There is no cross-file transaction and no cross-file order.

| Column | Type | Meaning |
| --- | --- | --- |
| `seq` | INTEGER PRIMARY KEY AUTOINCREMENT | Position in this file's log. The only ordering key. |
| `event_id` | TEXT NOT NULL UNIQUE | Stable identity of this event, a UUID by default. The dedupe key. |
| `event_type` | TEXT NOT NULL | What happened, e.g. `user.registered`. Consumers filter on this. |
| `aggregate_type` | TEXT, nullable | What kind of thing changed, e.g. `user`. Null when the event has no aggregate. |
| `aggregate_id` | TEXT, nullable | Which thing changed. Together with `aggregate_type` it selects one aggregate's history. |
| `payload` | TEXT NOT NULL | JSON. The event data. Must be JSON-serializable; anything else is rejected at record time. |
| `occurred_at` | INTEGER NOT NULL | Milliseconds since epoch when the event happened. Defaults to record time; callers may pass an earlier business time. |
| `dedupe_key` | TEXT, nullable, unique when present | Caller-chosen dedupe key, e.g. `welcome-email:<userId>`. Nulls do not collide. |
| `status` | TEXT NOT NULL | `pending`, `published`, or `dead`. See lifecycle below. |
| `attempts` | INTEGER NOT NULL | Publish attempts so far. Only the relay increments this. |
| `next_attempt_at` | INTEGER NOT NULL | Earliest time the relay may retry. Pending rows past this time are due. |
| `published_at` | INTEGER, nullable | When the relay marked the row published. Null until then. |
| `last_error` | TEXT, nullable | Last publish failure message, for inspection. Never a secret: do not put credentials in it. |
| `created_at` | INTEGER NOT NULL | Milliseconds since epoch when the row was recorded. |

Indexes: `(status, next_attempt_at, seq)` for the relay scan,
`(event_type, seq)` for event-type consumers, and
`(aggregate_type, aggregate_id, seq)` for per-aggregate replay.
`event_id` and non-null `dedupe_key` are unique indexes.

## Ordering guarantees

- `seq` is strictly increasing within one file, in commit order as far as
  SQLite assigns it. It is the only order consumers may rely on.
- `seq` values may have gaps. A rolled-back transaction consumes no
  published sequence, and a failed insert never appears. Consumers must
  treat a gap as "nothing was ever published there", never as a missing
  event to wait for.
- Timestamps do not order the log. `occurred_at` and `created_at` can
  skew across processes and machines; `seq` cannot.
- There is no total order across files. A consumer reading `app.db` and
  `jobs.db` sees two independent logs. If a future feature needs one
  merged order, it must define it (for example, by per-source cursor plus
  a merge rule) — it does not get one from this table.
- Within one file, the relay publishes in `seq` order, one row at a time.
  A later row is not published while an earlier due row is still failing
  and retrying in the same batch scan — but a failed row with a future
  `next_attempt_at` does not block later rows in later scans. Order is
  best-effort across failures, strict within a single successful scan.

## Lifecycle and publish rules

```
pending -> published
pending -> dead      (attempts reached maxAttempts, default 5)
dead -> pending      (manual replay only, via republishDead())
published rows are never deleted by the relay.
```

- The relay marks a row `published` only after its publish function
  resolves. A publish function that rejects leaves the row `pending`
  (or `dead` at the attempt limit) with `attempts` incremented and
  `next_attempt_at` pushed out by exponential backoff:
  `base * 2 ^ (attempts - 1)`, capped at `retryMaxMs`
  (defaults: base 1000ms, cap 60000ms).
- Delivery is at-least-once, never at-most-once. A crash after publish
  but before the mark leaves the row `pending`, so the next relay run
  publishes it again. Nothing in this design prevents that second
  delivery, and nothing may assume it cannot happen.
- Therefore every consumer must be idempotent. Two mechanisms, in order:
  1. Job delivery uses the job queue's existing idempotency key:
     the relay enqueues with `uniqueKey: "outbox:<event_id>"`, so a
     second enqueue while the first job is still queued, delayed, or
     running returns the existing job instead of creating a duplicate.
  2. Job and event handlers themselves must tolerate a second delivery
     after the first job completed (the unique key only covers active
     jobs). Check `event_id` before any non-idempotent side effect,
     or make the side effect itself idempotent. The relay cannot do
     this for the consumer.
- The relay holds no state in memory. Restart pickup is free: a new
  relay on the same file reads the same `pending` rows on its first
  scan, including rows left by a crashed relay. The relay's interval
  loop also runs a scan immediately on `start()`.
- Run one relay per database file. Two relays on the same file do not
  lose events, but they can both publish the same row before either
  marks it, so duplicates rise. The dedupe rules above still hold;
  the cost is duplicate work, not lost or corrupted work.
- The event-bus adapter must treat listener failure as publish
  failure: it emits with `throwOnError: true`. The bus's default
  swallows listener errors, and a relay built on that default would
  mark rows published that no listener handled.

## What each consumer reads

All consumers read with `readChangeLog(store, { afterSeq, limit, ... })`,
which returns rows in `seq` order, exclusive of `afterSeq`. A consumer
keeps its own checkpoint (its last processed `seq`, stored wherever the
consumer owns state) and resumes from it. The log never tracks
consumers; adding a consumer never changes the table.

- **Outbox relay (today):** reads `pending` rows due for retry, in
  `seq` order, via `listPending()`. It does not use `afterSeq`; its
  cursor is the row's `status`, and it marks rows itself.
- **Replication (future):** reads all rows with `afterSeq` equal to its
  checkpoint, regardless of `status`, and applies them to the replica
  in `seq` order. It must apply idempotently by `event_id`: a replica
  that restarts re-reads from its checkpoint and may see rows it
  already applied. It must not filter on `status = 'published'`,
  because a row can be applied to a replica before the relay publishes
  it elsewhere, and filtering would stall replication behind relay
  failures. Replication and relay are independent readers of one log.
- **Time-travel replay (future):** reads by `aggregate_type` and
  `aggregate_id` with `afterSeq`, in `seq` order, and replays payloads
  to rebuild state at a chosen `seq`. It reads `published` and `dead`
  rows as well as `pending` ones: the log is history, not a queue,
  and a row's relay status says nothing about whether it happened.
  Replay must ignore `status` and must not mark rows.
- **In-process event bus durability (future):** the relay's
  event-bus adapter is the bridge. App code records the event in the
  outbox instead of emitting directly; the relay emits it after
  commit. Listeners still receive each event at least once and must
  be idempotent, exactly as for job delivery.

## Retention

Published rows are history, so the relay never deletes them. Purging
is an explicit operator action via `purgePublished()`, which deletes
only `published` rows, never `pending` or `dead` ones. Purge only
below the lowest checkpoint of every consumer that reads history
(replication, replay); purging above a consumer's checkpoint silently
rewrites that consumer's history. If no consumer reads history, purge
by age freely.

## Gotchas

- Recording outside a transaction is still one atomic insert, but it
  is not atomic with anything else. The whole point is lost if the
  user write and `recordOutbox()` are two separate calls outside
  `db.transaction()`.
- `db.transaction()` takes a synchronous function. Do the async work
  first, then run the transaction; an async callback commits before
  its awaits finish.
- Never put secrets, tokens, or passwords in `payload` or `last_error`.
  The log is retained as history and may be replicated.
- A duplicate `event_id` or `dedupe_key` is rejected at record time.
  That is the write-time dedupe working, not a bug: the caller is
  recording an event that already exists.
- `payload` must survive `JSON.stringify`. Functions, `undefined`,
  symbols, and circular objects are rejected at record time, not at
  publish time, so a bad payload fails the user's transaction
  instead of poisoning the relay.
