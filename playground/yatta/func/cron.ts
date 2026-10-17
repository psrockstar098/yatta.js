// yatta/func/cron.ts
//
// Cron expressions use standard 5-field Vixie syntax.
import { createCron } from "yatta.js/jobs";
import { jobs } from "./jobs";

export const cron = createCron();

// Every night at midnight UTC.
cron.schedule("nightly-cleanup", "0 0 * * *", async () => {
  await jobs.enqueue("cleanup-stale-tokens", {});
});

// Shorthand for simple intervals.
cron.every("10m", () => {
  console.log("[cron] heartbeat");
});
