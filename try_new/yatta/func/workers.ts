// yatta/func/workers.ts
//
// Handlers registered here run in a worker pool, isolated from the HTTP loop.
import { jobs } from "./jobs";
import { mailer } from "./mail";

jobs.handle("send-email", async ({ data }) => {
  await mailer.send({
    to: data.to,
    subject: data.subject,
    text: data.body,
  });
});

jobs.handle("cleanup-stale-tokens", async ({ log }) => {
  log("Cleaning up expired verification tokens and sessions...");
});

// Queue name, then the concurrency and polling config.
export const defaultWorker = jobs.worker("default", {
  concurrency: 5,
  pollInterval: "1s",
  lockDuration: "60s",
});
