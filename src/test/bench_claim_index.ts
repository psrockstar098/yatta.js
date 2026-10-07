/**
 * Offline comparison of claim-index shapes.
 *
 * A measurement, not a test. The claim query is the hot path of task handling, and its
 * cost is dominated by the shape of the index rather than by the statement, so this
 * exists to compare shapes without editing the real schema each time.
 *
 *   bun run src/test/bench_claim_index.ts
 */
import { Database } from "bun:sqlite";

const N = Number(process.argv[2] ?? 3000);

function drain(indexes: string[]): number {
  const db = new Database(":memory:");

  db.run(`CREATE TABLE j (
    id TEXT PRIMARY KEY, queue TEXT, name TEXT, data TEXT, state TEXT,
    attempts INT, max_attempts INT, priority INT, run_at INT, locked_at INT,
    progress INT DEFAULT 0, lock_expires_at INT, locked_by TEXT, updated_at INT
  )`);

  for (const ddl of indexes) db.run(ddl);

  const now = Date.now();

  const insert = db.query(
    `INSERT INTO j (id,queue,name,data,state,attempts,max_attempts,priority,run_at,
      locked_at,lock_expires_at,locked_by,updated_at)
     VALUES (?,?,?,?,?,0,3,0,?,NULL,NULL,NULL,?)`,
  );

  for (let i = 0; i < N; i++) insert.run(`j-${i}`, "b", "w", "{}", "queued", now, now);

  const claim = db.query(
    `UPDATE j SET state='running', locked_at=?, locked_by=?, lock_expires_at=?,
       attempts=attempts+1, updated_at=?
     WHERE id = (
       SELECT id FROM j
       WHERE queue=? AND state IN ('queued','delayed') AND run_at <= ?
         AND (lock_expires_at IS NULL OR lock_expires_at <= ?)
       ORDER BY priority DESC, run_at ASC, id ASC
       LIMIT 1
     )
     RETURNING *`,
  );

  const done = db.query(
    `UPDATE j SET state='completed', progress=100, locked_by=NULL,
       lock_expires_at=NULL, updated_at=? WHERE id=?`,
  );

  const start = performance.now();

  for (;;) {
    const row = claim.get(now, "w1", now + 30_000, now, "b", now, now);
    if (!row) break;
    done.run(now, (row as { id: string }).id);
  }

  return performance.now() - start;
}

const shapes: Array<[string, string[]]> = [
  [
    "current  (queue,state,run_at,priority,id)",
    [`CREATE INDEX ix ON j(queue, state, run_at, priority DESC, id ASC)`],
  ],
  [
    "covering (queue,state,priority,run_at,id,lock)",
    [
      `CREATE INDEX ix ON j(queue, state, priority DESC, run_at ASC, id ASC, lock_expires_at)`,
    ],
  ],
];

console.log(`draining ${N} jobs\n`);

for (const [label, indexes] of shapes) {
  // Best of three: the first run pays for SQLite's page cache being cold.
  const times = [drain(indexes), drain(indexes), drain(indexes)];
  const best = Math.min(...times);
  console.log(`  ${label.padEnd(42)} ${best.toFixed(0)}ms  (runs: ${times.map((t) => t.toFixed(0)).join(", ")})`);
}