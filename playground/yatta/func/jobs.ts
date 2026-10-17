// yatta/func/jobs.ts
//
// Durable queue backed by SQLite (WAL). Add your job names to AppJobs to get
// full autocompletion on .job() and .handle().
import { createJobs, SQLiteJobStore } from "yatta.js/jobs";

export interface AppJobs {
  "send-email": { to: string; subject: string; body: string };
  "cleanup-stale-tokens": { maxAgeDays?: number };
}

declare module "yatta.js/jobs" {
  interface JobRegister extends AppJobs {}
}

export const jobs = createJobs({
  store: new SQLiteJobStore("Database/jobs.db"),
});
