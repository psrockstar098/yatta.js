# Replication — phase 1: primary + async read replicas

Phase 1 only. One primary takes all writes. Replicas pull the shared
change log (docs/roadmap-14/shared-change-log.md) and serve reads.
There is no leader election here: that is phase 2 (Raft), and a
replica never promotes itself. A partitioned replica just stalls on
its last checkpoint and keeps serving old reads.

## The shape

The primary answers pull requests, one log per database file: `app`,
`jobs`, and `cache`. Auth tables live inside `app.db`, so there is no
separate auth file to replicate. The publisher is a pull model: it
keeps no per-replica state, so a replica that lies about its cursor
can only waste its own time, never corrupt the primary.

```ts
import { createDatabase } from "../types/db";
import {
  createReplicationPublisher,
  createReplicationApplier,
  createReplicationHttpHandler,
  createNodeToken,
} from "../types/replication";

const secret = process.env.YATTA_REPLICATION_SECRET!; // env only, never logged
const appDb = createDatabase({ path: "Database/app.db", schema });

// Primary side: serve pulls over HTTP.
const publisher = createReplicationPublisher({ app: appDb }, {
  nodeId: "primary-1",
  secret,
  allowedReplicaIds: ["replica-1"], // optional; empty means any valid token
});
Bun.serve({ fetch: createReplicationHttpHandler(publisher) });
```

```ts
// Replica side: poll the primary and apply what arrives.
import { createReplicationApplier, ReplicationRunner, createHttpReplicationTransport } from "../types/replication";

const replicaDb = createDatabase({ path: "Database/app.db", schema });
const applier = createReplicationApplier(replicaDb, {
  secret,
  expectedNodeId: "primary-1",
  // Optional: build a read model from each entry as it lands.
  onEntry: (entry) => { /* handlers must be idempotent */ },
});
const transport = createHttpReplicationTransport("https://primary.example", createNodeToken(secret, "replica-1"));
const runner = new ReplicationRunner(transport, new Map([["app", applier]]));
runner.start();
```

```ts
// Reads from a replica: the replicated log, in seq order.
const rows = applier.replicatedEntries("app", "app");
const checkpoint = applier.checkpoint("app", "app");
```

## What a replica actually gets

This is the honest limit of phase 1: the change log only holds events
the app recorded with `recordOutbox()`. A replica gets the log, plus
whatever its `onEntry` handler builds from it. An app that wants a row
visible on a replica must record that row's change in the outbox.
Replication does not copy raw database rows, and it does not ship WAL
bytes. A replica starting with no checkpoint pulls the whole log from
seq 0, so the log is the bootstrap.

Reads on the primary are unchanged. Reads on a replica are async: a
replica can lag the primary, and lag is just
`latestSeq - checkpoint`, reported on every pull.

## Config: minimal, but not zero

"Zero-config" is aspirational. Node discovery and auth still need
these, and a node without them runs nothing:

```
YATTA_REPLICATION_ROLE=primary | replica   # unset: replication is off, zero cost
YATTA_REPLICATION_NODE_ID=primary-1
YATTA_REPLICATION_SECRET=...              # required when the role is set; env only
YATTA_REPLICATION_PRIMARY_URL=https://primary.example  # replicas only
YATTA_REPLICATION_ALLOWED_REPLICAS=replica-1,replica-2  # primary only, optional
YATTA_REPLICATION_POLL_MS=1000
YATTA_REPLICATION_BATCH_SIZE=100
```

```ts
import { replicationConfigFromEnv } from "../types/replication";

// Returns null when the role is unset: that is the normal case, and
// nothing replication-related starts. Throws when the role is set
// but the secret (or a replica's primary URL) is missing: a
// configured node without a secret fails closed, never open.
const config = replicationConfigFromEnv();
```

No config file is read, so no JSON5 parsing is involved: env plus
programmatic config only.

## Safety rules

- Auth first. Node tokens and batch signatures are HMAC-SHA256 over
  the shared secret. A node without the secret gets a 401 and no data.
  The primary checks the allowlist when one is set.
- Replica-supplied data is never trusted by the primary: a replica
  sends only its cursor and its token, and a bad cursor is a 400.
- Primary-supplied data is never trusted by the replica: every batch
  is signature-checked, then every entry is shape-checked (seq,
  event id, event type, timestamps, payload size cap) before anything
  is stored. A bad batch applies nothing.
- Order: entries must arrive in strictly increasing seq order within
  a batch, or the whole batch is rejected. Gaps are fine: the log
  contract says a gap means nothing was ever published there.
- Idempotency: delivery is at-least-once. An entry at or below the
  checkpoint, or with an already-applied event id, is skipped. The
  handler runs before the entry is stored, so a failing handler is
  retried on the next pull; handlers must still be idempotent,
  because a crash between handler and store redelivers.
- Writes go to the primary only. `createReadOnlyStore()` wraps a
  replica store so app reads pass and `rawRun` throws
  `ReplicaWriteError`. That guards the raw surface only; ORM-level
  write blocking on a replica is a phase 2 follow-up.
- The publisher never marks rows published. Replication and the
  outbox relay are independent readers of the same log, and
  replication reads all rows regardless of relay status: filtering
  on `published` would stall replication behind relay failures.

## Gotchas

- Never purge published rows above a replica's checkpoint. Purging
  rewrites that replica's history, and its next pull can never fill
  the hole. Purge only below the lowest checkpoint of every replica.
- A replica's checkpoint is per file: `app`, `jobs`, and `cache`
  advance independently, and a failure pulling one file never moves
  another file's checkpoint.
- The HTTP transport has no response body size cap: a compromised
  primary could send a very large batch body. Per-entry payload caps
  still apply once the body is parsed, so this is an availability
  concern, not a corruption path, but it is open in phase 1.
- A primary that assigns the same seq to two different event ids
  fails the replica's insert and stalls that file fail-stop: the
  checkpoint stays put and the bad batch is retried, not applied.
  That needs an operator, not an automatic fix.
- WAL durability carries over from the shared change log: committed
  means durable across a process crash, not proven against power
  loss, under `PRAGMA synchronous = NORMAL`.
- No promotion, no failover, no write forwarding. If the primary is
  down, replicas serve stale reads until it returns. That is phase 2.
