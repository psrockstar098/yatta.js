# Time-travel replay (dev only)

Rebuild an aggregate's state as of any point in its history, from the
shared change log — no second log. Replay reads the same
`_yatta_outbox` table the outbox relay publishes from, in `seq` order,
and ignores each row's relay status: the log is history, not a queue.
See `shared-change-log.md` for the contract this builds on.

## Dev-only enforcement, in code

Replay is never on by default, and it never runs against production:

- Every entry point requires `{ enabled: true }`. Without it, the call
  throws.
- Every entry point refuses when the environment is production. The
  check looks at the explicit `environment` option, `YATTA_ENV`, and
  `NODE_ENV` — a production signal from any of them refuses the call,
  so an option cannot hide a production `NODE_ENV`.
- The gate fails closed on an unknown environment too: with no
  environment signal anywhere, the call throws instead of assuming
  "not production".

Rewind also never writes to the application's own tables. It returns
rebuilt state in memory; in dev, the caller writes that state back
explicitly if that is what they want. There is no code path in this
feature that rewinds a production database, and no flag that enables
one.

## Rebuild state from the log

```ts
import { createReplayRunner } from "../types/replay";

const replay = createReplayRunner(db, {
  enabled: true,
  environment: "development",
});

const result = replay.replay({
  aggregateType: "user",
  aggregateId: user.id,
  // Pure fold: returns the next state, performs no external effect.
  reducer: (state, entry) => {
    if (entry.eventType === "user.renamed") {
      return { ...state, name: entry.payload.name };
    }
    return state;
  },
  initialState: { name: null },
});
// result.state is the aggregate now; result.lastSeq is the last seq folded.
```

Replay up to a position with `upToSeq`, or from a position with
`fromSeq`. Both bounds are on `seq`, the log's only ordering key.

## Snapshots: rewind to a checkpoint

A snapshot stores one aggregate's state as of one `seq`, checksummed
with SHA-256, in `_yatta_replay_snapshots` (a snapshot table, not a
second event log — the log itself is still only `_yatta_outbox`).

```ts
const snapshot = replay.snapshot({
  aggregateType: "user",
  aggregateId: user.id,
  reducer,
  initialState: { name: null },
  upToSeq: 42,
});

// Later: state as of seq 42, then only the entries after it replayed.
const rewound = replay.rewind({
  aggregateType: "user",
  aggregateId: user.id,
  reducer,
  initialState: { name: null },
  targetSeq: 60,
});
// rewound.snapshotUsed is the snapshot replay started from, or null.
```

A snapshot whose stored state no longer matches its checksum throws
on load — a corrupt snapshot fails loudly and never replays wrong
state. A corrupt log payload throws the same way: replay refuses to
guess. `seq` must strictly increase and `event_id` must be unique
within a replay; violations throw instead of producing state.

## Side effects: replay must not double-apply

The shared log delivers at-least-once, so an entry may already have
been acted on. The reducer must be pure — never send an email, run a
job, or charge a payment from inside it. When the caller does need to
track what was already applied, pass their own applied set:

```ts
const applied = new Set<string>();
replay.replay({
  aggregateType: "user",
  aggregateId: user.id,
  reducer,
  initialState,
  isApplied: (eventId) => applied.has(eventId),
  markApplied: (eventId) => applied.add(eventId),
});
```

Entries `isApplied` already knows are skipped and counted in
`skippedCount`, never folded twice.

## Laziness

This module is not imported by the framework entry points, so loading
the framework costs nothing here. It is reachable only through its
own export path, `yatta.js/replay`, which a caller imports
deliberately. No snapshot table is created and no log is read until
a caller builds a runner with the dev flag set.

## Gotchas

- Replay reads one database file's log. There is no total order across
  files; an aggregate that spans files has no single replay.
- Purging published rows below a snapshot's `seq` rewrites the history
  that snapshot stands on. Do not purge below the lowest snapshot or
  replay position you still need, same rule as the shared log's
  retention note.
- A tampered log row that keeps a valid `seq`, a unique `event_id`,
  and valid JSON payload cannot be detected by replay alone — the
  shared log has no per-row checksum column, and adding one would
  change the shared contract. Snapshots bound the damage: tampering
  after the latest verified snapshot still replays, but tampering
  with a snapshot itself is caught by its checksum.
- The pure helper `replayEntries()` folds entries already in memory
  and touches no store, so it carries no dev gate. The gate lives on
  every function that reads a database or stores a snapshot.
- Snapshot state must be JSON-serializable, same rule as log payloads.
