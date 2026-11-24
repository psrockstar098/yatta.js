/*
 * Job handlers and the worker pool.
 *
 * Registration is a function, not a side effect of importing this file.
 *
 * Importing used to start the pool, and `main.ts` imported this at module scope —
 * before `runtime.start()` and before the subsystems were attached. A job could be
 * picked up in that window and run against a `db` that was not mounted yet. An
 * import that quietly starts a worker pool is the kind of thing that makes the
 * ordering of a bootstrap impossible to see.
 */

import { jobs } from "./jobs";
import { mailer } from "./mail";

// The auth engine is imported lazily inside the cleanup job, not at module
// scope: it costs ~260ms of import time (measured), and this module is
// imported during bootstrap — before the server serves anything. The
// cleanup job runs on a schedule, long after startup, so it pays one
// cached dynamic import instead.
async function getAuth() {
  return (await import("./auth")).auth;
}

let registered = false;

/**
 * Registers handlers and starts the worker pool. Called once, from `bootstrap`.
 *
 * @throws if called twice. Two pools would take the same leases twice and double
 *   every job's throughput.
 */
export function registerWorkers(): void {
  if (registered) {
    throw new Error("registerWorkers() called more than once. Two worker pools would take the same leases twice.");
  }
  registered = true;

  jobs.handle("send-email", async ({ data }) => {
    await mailer.send({
      to: data.to,
      subject: data.subject,
      text: data.body,
    });
  });

  jobs.handle("cleanup-stale-tokens", async ({ log }) => {
    const auth = await getAuth();
    const { tokens, sessions } = await auth.cleanupExpired();
    log(`Cleaned up ${tokens} expired verification tokens and ${sessions} expired sessions.`);
  });

  defaultWorker();
}

/** The worker pool, started by {@link registerWorkers}. */
export function defaultWorker(): void {
  jobs.worker("default", {
    concurrency: 5,
    pollInterval: "1s",
    lockDuration: "60s",
  });
}
