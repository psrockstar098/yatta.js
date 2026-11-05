# Raft — phase 2: leader election + log consistency

Phase 1 (docs/roadmap-14/replication.md) had one fixed primary and
replicas that never promoted themselves. This phase adds the missing
piece: when the primary dies, the replicas elect a new leader by
majority vote, and the new leader's log becomes authoritative. The
phase-1 rule still stands in the other direction: a replica NEVER
self-promotes. It becomes leader ONLY by winning an election.

The log under Raft is still the shared change log
(docs/roadmap-14/shared-change-log.md). Raft stores no second copy of
entry payloads: a leader's entries live in its `_yatta_outbox`, a
follower's in its `_yatta_replicated_log` (phase 1's table), and Raft
adds only two small tables in the same database file —
`_yatta_raft_state` (current term, voted-for, commit index) and
`_yatta_raft_terms` (the Raft term of each log position, which the
change log itself does not record).

## The shape

One Raft group, one log. Three nodes, `a`, `b`, `c`, wired with the
in-memory transport (the HTTP transport below is the same shape over
the wire):

```ts
import { RaftNode, InMemoryRaftLog, InMemoryRaftTransport, PersistentRaftState } from "../types/raft";
import type { OutboxStore } from "../types/outbox";

const secret = process.env.YATTA_RAFT_SECRET!; // env only, never logged

function makeNode(id: string, peers: string[], db: OutboxStore) {
  const node = new RaftNode({
    nodeId: id,
    peers,
    secret,
    log: new InMemoryRaftLog(),
    persistentState: new PersistentRaftState(db),
    timers: true, // election + heartbeat timers run after start()
  });
  const transport = new InMemoryRaftTransport(id, secret);
  node.setTransport(transport);
  return { node, transport };
}
```

```ts
// Election: the first node whose election timeout fires asks every
// peer for its vote. A voter grants at most one vote per term, and
// only to a candidate whose log is at least as up-to-date as its own
// (higher last term, or equal term and longer log). Two of three
// votes is a majority, so the winner becomes leader for that term.
const { node } = makeNode("a", ["b", "c"], db);
node.start(); // timers only start here; nothing runs before start()

// Leader append: only a leader may call this. The entry still needs
// a majority ack (via syncPeer / sendHeartbeats) before it commits —
// appending alone never commits.
const entry = node.appendAsLeader({
  eventId: "evt-1",
  eventType: "user.registered",
  payload: { user: "ada" },
  occurredAt: Date.now(),
  createdAt: Date.now(),
});
await node.sendHeartbeats();
node.commitIndex; // 1, once a majority holds the entry
```

```ts
// HTTP transport, phase-1 pattern: Bearer node token plus an HMAC
// over the AppendEntries body with a Raft-only domain string, so a
// phase-1 batch signature can never replay as a Raft message.
import { createSignedHttpRaftTransport, createRaftHttpHandler, createNodeToken } from "../types/raft";

const transport = createSignedHttpRaftTransport("https://peer-b.example", createNodeToken(secret, "a"), secret);
Bun.serve({ fetch: createRaftHttpHandler(node, secret) });
```

## Config: fail-closed, opt-in, lazy

Nothing Raft-related starts unless Raft is explicitly enabled, and a
node without quorum configuration never claims leadership:

```
YATTA_RAFT_ENABLED=true                 # anything else: Raft is off, zero cost
YATTA_RAFT_NODE_ID=a
YATTA_RAFT_SECRET=...                   # required when enabled; env only
YATTA_RAFT_PEERS=b,c                    # the other nodes in the group
YATTA_RAFT_SINGLE_NODE=true             # one-node group only; explicit, never implied
YATTA_RAFT_ELECTION_MIN_MS=150
YATTA_RAFT_ELECTION_MAX_MS=300
YATTA_RAFT_HEARTBEAT_MS=50              # must stay below the election minimum
```

```ts
import { raftConfigFromEnv } from "../types/raft";

// Returns null when YATTA_RAFT_ENABLED is not exactly "true": the
// normal unconfigured case. Throws when enabled but the secret, the
// node id, or the quorum config is missing — a configured node
// without a secret or without peers (and without single-node mode)
// fails closed instead of running unauthenticated or leaderless.
const config = raftConfigFromEnv();
```

No framework entry point imports this module: a test greps
`src/main.ts`, `src/types/index.ts`, and `core_runtime/index.ts` and
fails if any of them mentions it. Import it only where Raft is
actually constructed.

## Safety rules

- One vote per term, persisted before it is granted. A restarted node
  resumes its term and its vote from `_yatta_raft_state`; it cannot
  double-vote. A node with no durable state refuses to grant votes
  entirely rather than risk it.
- Up-to-date vote rule: a voter refuses a candidate whose log is
  behind its own. Together with majority quorum, that is what makes
  leader completeness hold: an elected leader holds every committed
  entry, because every committed entry sits on a majority, and any
  election majority overlaps that majority at a voter that refuses
  stale candidates.
- Election safety: one leader per term. A candidate or leader that
  sees a higher term steps down at once; a candidate that sees a
  legitimate leader for its own term steps down too.
- No split-brain writes: a leader that cannot reach a majority
  within one election timeout (itself plus peers that acked recently)
  steps down to follower. A partitioned old leader stops claiming
  leadership instead of serving writes nobody else sees.
- Log consistency: the leader's log is authoritative. A follower
  checks `prevLogSeq`/`prevLogTerm` before applying anything, backs
  the leader up to its last seq on mismatch, and truncates a
  conflicting suffix only above its commit index. A conflict at or
  below the commit index is refused outright, and a refused message
  mutates nothing: the whole message is validated before any entry
  is applied or truncated.
- Commit rule: an entry commits when a majority holds it AND it is
  from the leader's current term. Entries from older terms commit
  only indirectly, when a current-term entry commits above them —
  the standard Raft rule that keeps a stale leader from committing by
  counting acks.
- Auth: Raft RPCs reuse phase-1 node tokens (HMAC-SHA256 over the
  shared secret). The HTTP handler verifies the token before parsing
  anything else, and verifies the AppendEntries signature over the
  raw wire body before applying anything. A node without the secret
  gets refused votes and refused AppendEntries, and learns nothing.
  Secrets and tokens are never logged.

## Gotchas

- Single-node dev mode is explicit, not inferred. `peers: []` without
  `singleNode: true` throws at construction: a node with no quorum
  config must never claim leadership, and an empty peer list on its
  own is a misconfiguration, not a one-node cluster.
- A leader's originated entries go through `appendOriginated()` on
  the change-log adapter, which records the outbox row and then
  mirrors it into the Raft log view. A crash between the two leaves
  an outbox row with no Raft term, which votes as term 0 — safe
  direction only (less up-to-date, never more), and the next
  AppendEntries round re-mirrors it.
- Pre-Raft entries carry term 0. They vote as older than any Raft-era
  entry, which is correct: they predate every election. Two nodes
  holding only pre-Raft entries decide by log length.
- Election timeouts are randomized in `[min, max)` so nodes do not
  all fire at once after a leader dies; bounds are validated, and a
  heartbeat interval at or above the minimum is rejected. Timers are
  single chained timeouts, never intervals that can pile up: at most
  one election timer and one heartbeat timer exist per node, and
  `stop()` clears both.
- The HTTP handler's AppendEntries signature is verified over the
  raw wire body, not the validated subset: validation normalizes
  entries (dropping the full change-log fields the signer covered),
  and verifying over the subset would reject every legitimately
  signed message. The unsigned HTTP transport exists only for the
  vote path; AppendEntries over HTTP must use the signed transport,
  or the handler answers 401.
- A follower's commit index advances only from the leader's
  `leaderCommit`, capped at its own last seq. It never advances past
  entries it does not hold.
- WAL durability carries over from the shared change log: committed
  means durable across a process crash, not proven against power
  loss, under `PRAGMA synchronous = NORMAL`.
- ORM-level write blocking on replicas is still the open phase-1
  follow-up: `createReadOnlyStore()` guards the raw surface only,
  and Raft does not change that. A follower that is not the leader
  refuses `appendAsLeader()`, but app-level writes through a full
  database object are not blocked by this module.

## What Raft does NOT do

- No sharding. One group, one log. A deployment with several
  database files runs one Raft group per file if it wants them all
  covered; there is no merged cross-file order, exactly as in the
  shared change log.
- No multi-group membership changes. Peers are fixed at
  construction; adding or removing a node is a restart with new
  config, not a joint-consensus operation.
- No snapshots or log compaction. The log grows with the change log;
  purging follows the shared change log's rule (never above the
  lowest checkpoint of every consumer).
- No write forwarding. A follower that receives a write does not
  forward it to the leader; the caller must send writes to the
  leader, and `appendAsLeader()` on a non-leader throws.
- No leader leases beyond quorum loss. Leadership lasts until a
  higher term appears or quorum is lost; there is no wall-clock
  lease, and a leader that can still reach a majority keeps leading.
```

## The honest limits of this phase

- Real multi-process clusters are proven through the HTTP handler
  and the signed transport in tests, not against live peers on
  separate machines: the fake transport covers election and
  replication logic, the handler covers auth and validation, but no
  three-machine run happened on this VM.
- A newly elected leader keeps using the same Raft log view it held
  as a follower (the phase-1 replicated log). Its future originated
  entries go through the outbox plus the mirror described above;
  seq continuity across that switch is the operator's to watch in a
  deployment where the old leader's outbox seqs and the follower's
  replicated seqs could diverge.
- `createHttpRaftTransport` (unsigned) posts AppendEntries without a
  signature and is therefore rejected by the signed handler. It is
  kept only so the signed transport can reuse its vote path; new
  code should use `createSignedHttpRaftTransport`.
