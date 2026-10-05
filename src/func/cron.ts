/*
 * Scheduled work.
 *
 * Every cluster worker mounts this module, so an unguarded schedule fires once per
 * worker: a nightly cleanup enqueues N copies and the heartbeat logs N times. In a
 * three-worker cluster that is three emails and three claims to be the cleanup job.
 *
 * Two ways out, and they compose: only the leader schedules, and every enqueued job
 * carries a deterministic id so a duplicate enqueue is a no-op rather than a second
 * run.
 */

import { createCron } from "../types/job";
import { jobs } from "./jobs";

export const cron = createCron();

/** True in the worker that should run schedules. The others stay idle. */
export const isScheduleLeader =
  typeof process.env.CLUSTER_WORKER_ID === "undefined" ||
  process.env.CLUSTER_WORKER_ID === "0";

if (isScheduleLeader) {
  /*
   * Every night at 00:00 UTC.
   *
   * The timezone is stated explicitly rather than left to the host's local time,
   * which is what a bare "0 0 * * *" actually means. A server running in UTC-5 would
   * otherwise clean up at 19:00 the previous day, and nobody would notice until a
   * report was a day out.
   */
  cron.schedule(
    "nightly-cleanup",
    "0 0 * * *",
    async () => {
      try {
        /*
         * A deterministic id, so a re-enqueue is a no-op.
         *
         * Leader-only scheduling closes the cluster case; this closes the rest — a
         * process that was down at 00:00 and catches up, or a deploy that fires the
         * schedule twice. Dated by the run day rather than by `now`, so two runs in
         * the same 24 hours collide and two runs on different days do not.
         */
        await jobs
          .job("cleanup-stale-tokens")
          .unique(`cleanup-stale-tokens:${new Date().toISOString().slice(0, 10)}`)
          .save();
      } catch (err) {
        /*
         * Handled, because an unhandled throw here kills the cron tick.
         *
         * The next tick is fifteen minutes away; a missing cleanup is not worth
         * taking the process down for, and the error is recorded so it is visible
         * without being fatal.
         */
        console.error("[cron] nightly-cleanup failed:", err);
      }
    },
    { timezone: "UTC" },
  );
}

/** Every 10 minutes. Leader-only for the same reason. */
if (isScheduleLeader) {
  cron.every("10m", async () => {
    try {
      /*
       * A check, not a log line.
       *
       * This logged on every tick, which is log noise that trains people to ignore
       * the log — and it verified nothing. Checking that the database answers turns
       * the same frequency into something worth having, and gives the dashboard a
       * liveness signal that is not "the process exists".
       */
      const { db } = await import("./db");
      await db.exec("SELECT 1");
    } catch (err) {
      console.error("[cron] 10-minute health check failed:", err);
    }
  });
}
