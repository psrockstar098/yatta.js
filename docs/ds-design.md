# `yatta.js/ds` — design note

Four primitives added as first-class Yatta citizens under `yatta.js/ds`.
Design principle for each: **make memory and concurrency behaviour explicit
instead of leaving it to engine defaults.** Everything is TypeScript + Bun,
tested in `src/test/ds.test.ts`, benchmarked in `src/test/ds_benchmark.ts`.

## StringMap — open-addressing hash map with explicit memory control

**Concept.** A hash table with linear probing, tombstone deletion, and a
load-factor threshold: instead of growing whenever the engine feels like it,
the map grows on a schedule the user sets. The hash function is pluggable and
deterministic, so bucket assignment is stable across processes and machines.

**Why it exists.** The built-in `Map` is faster per op and should stay the
default. `StringMap` is for the cases where the default's opacity hurts:
capacity preallocation (avoid rehash spikes during warm-up), a chosen
load factor, and deterministic hashing for sharding keys across cluster
workers.

**TS adaptation.** Open addressing in typed slots (string keys, tombstones),
`ensureCapacity(n)` preallocation, iteration in unspecified slot order
(documented, like the design it borrows from). Measured: ~1.6x slower than
native `Map` on 100k put+get — the overhead buys the control.

## ColumnStore — struct-of-arrays row storage

**Concept.** Store each field of a row type in its own dense array instead of
storing one object per row. Numeric fields back onto typed arrays, so a
million scores are one contiguous `Float64Array`, not a million objects.

**Why it exists.** Backends repeatedly touch one column at a time: ORM row
materialization, job queues, metric series. Scanning one field walks one
dense array.

**TS adaptation.** Schema-driven (`{ id: "u32", score: "f64", name: "string" }`),
`append`/`get`/`set`/`swapRemove`/`pop`/`len`, zero-copy typed `field(name)`
views (mutating the view mutates the list). Measured: field scan ~1.1–1.3x
faster than array-of-objects; full-row random access ~2x *slower* because
`get(i)` materializes an object. Use it for column work, not as a generic
row store.

## TaskGroup — structured concurrency for async work

**Concept.** A group owns its tasks: spawn into it, `waitAll()` to join,
and the group outlives no task and loses no error. Cancellation is one
signal for all tasks.

**Why it exists.** `Promise.all` drops context: first rejection wins, the
rest of the errors vanish, and cancellation has to be wired by hand per
call-site. `TaskGroup` gives ordered results, one `AggregateError` with
*every* failure, bounded concurrency (no 10,000-socket fan-out), and
`cancel()` that reaches running *and* queued tasks.

**Measured.** ~30% overhead over raw `Promise.all` on trivial tasks. The
price is deliberate: semantics, not throughput.

## Batch — batched IO submissions

**Concept.** Queue reads/writes/stats (or arbitrary async ops), submit them
together, harvest ordered per-operation results. A failed op comes back as
`{ ok: false, error }` data; it never sinks the batch.

**Why it exists.** Bun/Node IO is already async, so this is an API over
concurrency: one await for N ops, ordered results, optional bounded
concurrency and per-op timeouts, and failure-as-data. `run({ throwOnError })`
recovers the throw-first-failure shape when that's what you want.

**Measured.** ~1.8x slower than a hand-rolled `Promise.all` on the same ops
(50 file write+reads), ~faster than sequential. Again: semantics, not speed.

## Module conventions followed

- `src/types/ds.ts` matches the sibling modules (`src/types/cache_queue.ts`,
  `src/types/realtime.ts`): header doc block with overview, honest notes,
  key exports, quickstart; factory functions (`createStringMap`, …) alongside
  the classes; tests in `src/test/ds.test.ts`; benchmarks in
  `src/test/ds_benchmark.ts` (script, not `.test.ts`).
- New package export `"./ds": "./src/types/ds.ts"` in `package.json`, same
  shape as the other `./<name>` entries. No existing export touched.
