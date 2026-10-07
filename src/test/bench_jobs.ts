/**
 * Measures the job path the way an application uses it: enqueue, then claim and
 * complete until drained.
 *
 * A measurement, not a test — a timing assertion fails on a loaded machine for reasons
 * that have nothing to do with the code. Run it on both revisions to compare.
 */
import { Database } from "bun:sqlite";
import { SQLiteJobStore } from "../types/job";

const N = Number(process.argv[2] ?? 3000);

const db = new Database(":memory:");
const store = new SQLiteJobStore(db);
await store.init();

const t0 = performance.now();

for (let i = 0; i < N; i++) {
  await store.enqueue({
    id: `j-${i}`,
    queue: "bench",
    name: "work",
    data: { i },
    runAt: Date.now(),
    maxAttempts: 3,
    priority: 0,
    progress: 0,
    retry: { type: "fixed", delay: 1000, factor: 2, jitter: false, maxDelay: 60_000 },
  });
}

const enqueueMs = performance.now() - t0;

const t1 = performance.now();
let claimed = 0;

while (true) {
  const job = await store.claimNext("bench", "w1", 30_000);
  if (!job) break;
  claimed++;
  await store.complete(job.id, { ok: true }, "w1");
}

const drainMs = performance.now() - t1;

console.log(
  JSON.stringify({
    n: N,
    enqueueMs: +enqueueMs.toFixed(1),
    enqueuePerOpUs: +((enqueueMs / N) * 1000).toFixed(2),
    claimed,
    drainMs: +drainMs.toFixed(1),
    claimCompletePerOpUs: +((drainMs / Math.max(claimed, 1)) * 1000).toFixed(2),
  }),
);