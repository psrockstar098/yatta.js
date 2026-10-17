// yatta/func/events.ts
//
// Typed event bus wired to the queue, so an event can pipe straight into a
// background job.
import { createEvents } from "yatta.js/jobs";
import { jobs } from "./jobs";

export interface AppEvents {
  "user.registered": { userId: string; email: string };
}

declare module "yatta.js/jobs" {
  interface EventRegister extends AppEvents {}
}

export const events = createEvents(jobs);

// 1. Direct listener
events.on("user.registered", (data) => {
  console.log(`[event] New user registered: ${data.email}`);
});

// 2. Pipe the event into a background job.
// The 4th argument maps the event payload into the job payload.
events.pipe(
  "user.registered",
  "send-email",
  undefined,
  (data) => ({
    to: data.email,
    subject: "Welcome to Yatta!",
    body: "Thank you for creating an account.",
  }),
);
