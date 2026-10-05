import { createJobs, SQLiteJobStore } from "../types/job";

export interface AppJobs {
  "send-email": { to: string; subject: string; body: string };
  "cleanup-stale-tokens": { maxAgeDays?: number };
}

declare module "../types/job" {
  interface JobRegister extends AppJobs {}
}

export const jobs = createJobs({
  store: new SQLiteJobStore("Database/jobs.db"),
});
