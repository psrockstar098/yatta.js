import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteJobStore, MemoryJobStore, normalizeRetryPolicy, type JobStore } from "../types/job";

/*
 * `release`, which had zero direct coverage.
 *
 * The bug this pins was found there: both stores treated `release(id)` without a
 * `workerId` as "trusted admin, act on any state". The lease check was skipped, so was
 * the state check, and releasing a *completed* job moved it back to `queued` with its
 * `run_at` still in the past — so the very next claim picked it up and its work ran a
 * second time, having already succeeded. A dead job came back the same way, without
 * `replayDead`'s attempt reset or error cleanup.
 *
 * The interface contract says release returns "a running job to queued", used when a job
 * stopped for an infrastructural reason — shutdown or a lost lease. Nothing in that
 * contract needs to resurrect a job that is not running: queued jobs are already queued,
 * and delaying a release is a no-op.
 */

let dir: string;
let fileDb: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yatta-release-"));
  fileDb = join(dir, "jobs.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Both stores must behave identically; the bug was duplicated, not divergent. */
const stores: Array<[string, () => JobStore]> = [
  ["SQLiteJobStore", () => new SQLiteJobStore(":memory:")],
  ["MemoryJobStore", () => new MemoryJobStore()],
];

describe.each(stores)("release on a job that is not running (%s)", (_, make) => {
  let store: JobStore;

  beforeEach(async () => {
    store = make();
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("never resurrects a completed job", async () => {
    await store.enqueue({
      id: "done",
      queue: "q",
      name: "work",
      data: {},
      priority: 10,
      runAt: Date.now() - 1000,
      maxAttempts: 3,
      retry: normalizeRetryPolicy(),
      progress: 0,
    });

    const claimed = await store.claimNext("q", "w1", 60_000);
    expect(claimed?.state).toBe("running");
    expect(await store.complete("done")).toBe(true);

    // The admin release path takes no workerId, and used to trust it across every
    // state — returning true and flipping this job back into the queue.
    expect(await store.release("done")).toBe(false);

    const after = await store.getJob("done");
    expect(after?.state).toBe("completed");

    // The resurrection used to re-execute this job, because completion left
    // `run_at` in the past and `claimNext` selects queued rows with `run_at <= now`.
    expect(await store.claimNext("q", "w2", 60_000)).toBeNull();
  });

  it("does not turn a dead job into a queued one without a replay", async () => {
    await store.enqueue({
      id: "corpse",
      queue: "q",
      name: "work",
      data: {},
      priority: 10,
      runAt: Date.now() - 1000,
      maxAttempts: 1,
      retry: normalizeRetryPolicy(),
      progress: 0,
    });

    await store.claimNext("q", "w1", 60_000);
    await store.fail(
      "corpse",
      { message: "boom" },
      undefined,
      true,
    );

    expect(await store.release("corpse")).toBe(false);
    expect((await store.getJob("corpse"))?.state).toBe("dead");
  });

  it("still rescues a genuinely running job, which is the documented purpose", async () => {
    await store.enqueue({
      id: "stuck",
      queue: "q",
      name: "work",
      data: {},
      priority: 10,
      runAt: Date.now() - 1000,
      maxAttempts: 3,
      retry: normalizeRetryPolicy(),
      progress: 0,
    });

    expect((await store.claimNext("q", "w1", 60_000))?.id).toBe("stuck");
    expect(await store.release("stuck")).toBe(true);
    expect((await store.getJob("stuck"))?.state).toBe("queued");
  });
});

describe("release lease checks", () => {
  it("rejects a worker that does not hold the lease", async () => {
    const store = new MemoryJobStore();
    await store.init();

    await store.enqueue({
      id: "held",
      queue: "q",
      name: "work",
      data: {},
      priority: 10,
      runAt: Date.now() - 1000,
      maxAttempts: 3,
      retry: normalizeRetryPolicy(),
      progress: 0,
    });
    await store.claimNext("q", "w1", 60_000);

    expect(await store.release("held", "w2")).toBe(false);
    expect((await store.getJob("held"))?.state).toBe("running");

    await store.close();
  });
});

describe("a durable queue really is durable", () => {
  /*
   * Nothing covered this: enqueue, close the process, open again. It is the property
   * the SQLite store exists for, and it breaks quietly — a job enqueued before a
   * restart and gone after is exactly the failure nobody reproduces in unit tests.
   */
  it("keeps queued jobs across a close and reopen", async () => {
    const first = new SQLiteJobStore(fileDb);
    await first.init();

    for (const id of ["a", "b", "c"]) {
      await first.enqueue({
        id,
        queue: "emails",
        name: "send",
        data: { id },
        priority: 5,
        runAt: Date.now() - 1000,
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });
    }
    // One in flight, so the restart also exercises the lease columns.
    await first.claimNext("emails", "w1", 60_000);
    await first.close();

    const second = new SQLiteJobStore(fileDb);
    await second.init();

    expect((await second.getMetrics("emails")).queued).toBe(2);
    expect((await second.getMetrics("emails")).running).toBe(1);

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const job = await second.claimNext("emails", "w2", 60_000);
      if (job) ids.push(job.id);
    }
    expect(ids.sort()).toEqual(["b", "c"]);
    expect((await second.getJob("a"))?.lease?.workerId).toBe("w1");

    await second.close();
  });

  it("keeps dead-letter rows and their errors across a restart", async () => {
    const first = new SQLiteJobStore(fileDb);
    await first.init();

    await first.enqueue({
      id: "doomed",
      queue: "q",
      name: "work",
      data: {},
      priority: 10,
      runAt: Date.now() - 1000,
      maxAttempts: 1,
      retry: normalizeRetryPolicy(),
      progress: 0,
    });
    await first.claimNext("q", "w1", 60_000);
    await first.fail("doomed", { message: "collateral" }, undefined, true);
    await first.close();

    const second = new SQLiteJobStore(fileDb);
    await second.init();

    const dead = await second.listDead("q");
    expect(dead.map((j) => j.id)).toEqual(["doomed"]);
    expect(dead[0]?.error?.message).toBe("collateral");

    expect(await second.replayDead("doomed")).toBe(true);
    const reincarnated = await second.claimNext("q", "w2", 60_000);
    expect(reincarnated?.id).toBe("doomed");
    // A replay is a fresh life, not a continuation of the failed one.
    expect(reincarnated?.attempts).toBe(1);
    expect(reincarnated?.error).toBeUndefined();

    await second.close();
  });

  it("reopens a file another store instance left alone", async () => {
    // Bun 1.4 requires an explicit option when opening an existing file, and a fresh
    // store on an already-initialised database must not need to migrate anything.
    const first = new SQLiteJobStore(fileDb);
    await first.init();
    await first.close();

    const second = new SQLiteJobStore(fileDb);
    await second.init();
    await second.close();

    new Database(fileDb, { readonly: true });
    expect(true).toBe(true);
  });
});
