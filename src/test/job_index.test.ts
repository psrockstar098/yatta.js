import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

import { SQLiteJobStore } from "../types/job";

/*
 * The claim index, pinned by the query plan rather than by a timing.
 *
 * A duration assertion fails on a loaded machine for reasons unrelated to the code.
 * What actually broke was the shape: the index led with `run_at`, which serves the
 * filter but not `ORDER BY priority DESC, run_at ASC, id ASC`, so every claim built a
 * temporary B-tree over the whole queued group and re-read each row from the table to
 * check `lock_expires_at` — a column the index did not carry.
 *
 * Draining 3,000 jobs took 2211ms and grew with queue depth. With the index below it
 * takes 81ms and is flat. Those numbers are in `bench_claim_index.ts`; what is
 * asserted here is the property that produced them, which does not depend on the
 * machine.
 */

const CLAIM_SUBQUERY = `SELECT id FROM "_yatta_jobs"
  WHERE queue = 'q'
    AND state IN ('queued', 'delayed')
    AND run_at <= 1
    AND (lock_expires_at IS NULL OR lock_expires_at <= 1)
  ORDER BY priority DESC, run_at ASC, id ASC
  LIMIT 1`;

function plan(store: SQLiteJobStore): string[] {
  const db = (store as unknown as { db: Database }).db;

  return db
    .query(`EXPLAIN QUERY PLAN ${CLAIM_SUBQUERY}`)
    .all("q", 1, 1)
    .map((row) => String((row as { detail: string }).detail));
}

describe("The claim query is served by an index built for it", () => {
  let store: SQLiteJobStore;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SQLiteJobStore(db);
  });

  it("satisfies the claim from the index alone, with no table read", async () => {
    await store.init();

    const steps = plan(store);

    /*
     * The property that produced the 27x. `lock_expires_at` is part of the claim's own
     * predicate, and the old index did not carry it, so every candidate cost a row
     * lookup on top of the sort.
     *
     * The temp B-tree below is a separate matter and is expected to stay: the query
     * filters `state IN ('queued', 'delayed')`, which is two disjoint ranges of the
     * index, and merging two ordered ranges needs a sort. It is cheap here because the
     * sort operates on an index scan rather than on rows fetched from the table.
     */
    expect(steps.filter((s) => s.includes("COVERING INDEX"))).not.toEqual([]);
  });

  it("does not fall back to scanning the table", async () => {
    await store.init();

    const steps = plan(store);

    expect(steps.filter((s) => s.startsWith("SCAN"))).toEqual([]);
  });

  it("carries lock_expires_at, so the claim never reads the row", async () => {
    await store.init();

    // `lock_expires_at IS NULL OR lock_expires_at <= ?` is part of the claim's own
    // predicate. Without the column in the index, every candidate costs a table lookup
    // on top of the sort.
    const columns = db
      .query(`SELECT name FROM pragma_index_info('idx_yatta_jobs_claim_v2')`)
      .all()
      .map((r) => String((r as { name: string }).name));

    expect(columns).toContain("lock_expires_at");
  });

  it("orders the index the way the claim sorts", async () => {
    await store.init();

    // `pragma_index_info` reports names and positions but not sort direction; that
    // lives in `pragma_index_xinfo`.
    const rows = db
      .query(
        `SELECT name, desc FROM pragma_index_xinfo('idx_yatta_jobs_claim_v2') WHERE key = 1 ORDER BY seqno`,
      )
      .all()
      .map((r) => ({
        name: String((r as { name: string }).name),
        desc: (r as { desc: number }).desc === 1,
      }));

    const afterEquality = rows.slice(2);

    // The first two columns are the equality prefix (`queue = ?`, `state = ?`). What
    // follows has to match the ORDER BY, or the index cannot supply the order — which
    // is exactly what the old `run_at`-leading index got wrong.
    expect(afterEquality.map((c) => c.name)).toEqual([
      "priority",
      "run_at",
      "id",
      "lock_expires_at",
    ]);

    // `priority DESC` is the sort's lead, so the index has to carry it descending.
    expect(afterEquality[0]!.desc).toBe(true);
    expect(afterEquality[1]!.desc).toBe(false);
  });

  it("drops the old index rather than leaving two to choose between", async () => {
    await store.init();

    const indexes = db
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='_yatta_jobs'`)
      .all()
      .map((r) => String((r as { name: string }).name));

    /*
     * A new name was needed because `CREATE INDEX IF NOT EXISTS` will not replace an
     * existing index, so every database created before this change still carries the
     * old one. Leaving both would cost write amplification and let the planner pick
     * the wrong one.
     */
    expect(indexes).toContain("idx_yatta_jobs_claim_v2");
    expect(indexes).not.toContain("idx_yatta_jobs_claim");
  });

  it("migrates a database that already has the old index", async () => {
    const file = `/tmp/opencode/yatta-index-upgrade-${Date.now()}.db`;
    rmSync(file, { force: true });

    try {
      // Build a database the way the previous version would have: old index, no v2.
      const legacy = new Database(file, { create: true });
      legacy.run(`
        CREATE TABLE "_yatta_jobs" (
          id TEXT PRIMARY KEY, queue TEXT NOT NULL, name TEXT NOT NULL,
          data TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
          run_at INTEGER NOT NULL, locked_at INTEGER, lock_expires_at INTEGER,
          locked_by TEXT, progress INTEGER NOT NULL DEFAULT 0, progress_message TEXT,
          result TEXT, error_message TEXT, error_stack TEXT, unique_key TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);
      legacy.run(
        `CREATE INDEX "idx_yatta_jobs_claim" ON "_yatta_jobs" (queue, state, run_at, priority DESC, id ASC);`,
      );
      legacy.close();

      // Opening it with the new code must leave exactly one claim index, the right one.
      const upgraded = new SQLiteJobStore(file);
      await upgraded.init();

      const indexes = (
        (upgraded as unknown as { db: Database }).db
          .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='_yatta_jobs'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      expect(indexes).toContain("idx_yatta_jobs_claim_v2");
      expect(indexes).not.toContain("idx_yatta_jobs_claim");

      // The upgraded database must be served by a covering index, which is the
      // property that makes the claim cheap — and which only holds if the new index
      // was actually created in place of the old one.
      const steps = (upgraded as unknown as { db: Database }).db
        .query(`EXPLAIN QUERY PLAN ${CLAIM_SUBQUERY}`)
        .all("q", 1, 1)
        .map((r) => String((r as { detail: string }).detail));

      expect(steps.filter((d) => d.includes("COVERING INDEX"))).not.toEqual([]);
    } finally {
      rmSync(file, { force: true });
      rmSync(`${file}-wal`, { force: true });
      rmSync(`${file}-shm`, { force: true });
    }
  });
});