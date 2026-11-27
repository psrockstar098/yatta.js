// PGliteConnectionGate: the single-connection guard for PGlite.
//
// PGlite is one WASM connection: two statements cannot run concurrently,
// and a transaction holds the connection across awaits. Every operation
// on the root session goes through this FIFO gate; every operation inside
// an active transaction runs on that transaction's handle instead.
//
// Shape: f4 from the Gemini multi-db design (see
// ~/workspace/yatta-106-gemini-multidb-findings.md), rebased onto the
// real code and the 0.6.0 probe:
//   - YattaError calls are single-arg (message only) — the constructor
//     takes `(message, sql?)` and has no `code` field.
//   - `pg.transaction(cb)` is real in 0.6.0 (the probe verified it);
//     the callback receives a Transaction with query/exec/rollback and
//     a `closed` getter, and no `transaction()` — nested transactions
//     are SAVEPOINT SQL on the same handle.
//   - `runExclusive` is NOT a substitute for this gate: a transaction
//     holds the connection across awaits, so the gate tracks the active
//     transaction in AsyncLocalStorage and refuses a root query inside
//     one (fail fast with a deadlock error) instead of queueing behind
//     itself forever.

import { AsyncLocalStorage } from "node:async_hooks";
import type { PGlite, Transaction as PgTransaction } from "@electric-sql/pglite";
import { YattaError } from "../errors";

export interface ActiveTxState {
  pgTx: PgTransaction;
  depth: number;
  gateId: symbol;
}

export class PGliteConnectionGate {
  readonly id = Symbol("pglite-gate");
  private tail: Promise<void> = Promise.resolve();
  private txLocal = new AsyncLocalStorage<ActiveTxState>();
  private queued = 0;

  constructor(private readonly acquireTimeoutMs = 30_000) {}

  get activeTransaction(): ActiveTxState | undefined {
    return this.txLocal.getStore();
  }

  get queueDepth(): number {
    return this.queued;
  }

  /**
   * Runs a non-transactional operation exclusively on the single PGlite connection.
   * Fails fast if called from the root handle while inside an active transaction.
   */
  runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.txLocal.getStore()?.gateId === this.id) {
      return Promise.reject(
        new YattaError(
          "Deadlock prevented: root `db` was queried inside an active PGlite transaction. " +
            "Use the `tx` handle passed to db.transaction(async (tx) => ...) instead.",
        ),
      );
    }
    return this.enqueue(fn, signal);
  }

  /**
   * Acquires the single connection for a root transaction, or opens a SAVEPOINT
   * when already inside a transaction on this gate.
   */
  runTransaction<T>(
    pg: PGlite,
    fn: (txState: ActiveTxState) => Promise<T>,
  ): Promise<T> {
    const current = this.txLocal.getStore();
    if (current && current.gateId === this.id) {
      const nextDepth = current.depth + 1;
      const sp = `yatta_sp_${nextDepth}`;
      return (async () => {
        await current.pgTx.exec(`SAVEPOINT ${sp}`);
        try {
          const result = await this.txLocal.run(
            { pgTx: current.pgTx, depth: nextDepth, gateId: this.id },
            () => fn({ pgTx: current.pgTx, depth: nextDepth, gateId: this.id }),
          );
          await current.pgTx.exec(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          // Recover outer tx from PostgreSQL 25P02 aborted state
          await current.pgTx.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
          throw err;
        }
      })();
    }

    return this.enqueue(() =>
      pg.transaction(async (pgTx) => {
        const state: ActiveTxState = { pgTx, depth: 1, gateId: this.id };
        return this.txLocal.run(state, () => fn(state));
      }),
    );
  }

  private enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new YattaError("PGlite query aborted before dispatch"));
    }

    this.queued++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((res) => {
      release = res;
    });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer =
        this.acquireTimeoutMs > 0
          ? setTimeout(() => {
              if (!settled) {
                settled = true;
                reject(
                  new YattaError(
                    `Timed out after ${this.acquireTimeoutMs}ms waiting for PGlite single-connection lock`,
                  ),
                );
              }
            }, this.acquireTimeoutMs)
          : undefined;

      prev.then(async () => {
        if (timer) clearTimeout(timer);
        if (settled) {
          this.queued--;
          release();
          return;
        }
        try {
          if (signal?.aborted) {
            throw new YattaError("PGlite query aborted while waiting in queue");
          }
          const value = await fn();
          settled = true;
          resolve(value);
        } catch (err) {
          settled = true;
          reject(err);
        } finally {
          this.queued--;
          release();
        }
      });
    });
  }
}
