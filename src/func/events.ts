import { createEvents } from "../types/job";
import { jobs } from "./jobs";

export interface AppEvents {
  "user.registered": { userId: string; email: string };
  "order.completed": { orderId: string; amount: number };
}

declare module "../types/job" {
  interface EventRegister extends AppEvents {}
}

// Event bus linked to the job queue
export const events = createEvents(jobs);

/*
 * 1. A direct listener.
 *
 * The id is logged, not the email.
 *
 * An email address is personal data, and application logs are copied into error
 * trackers, shipped to third parties and retained far longer than the request that
 * produced them. The user id is enough to correlate the event with the row.
 */
events.on("user.registered", (data) => {
  console.log(`[event] user.registered id=${data.userId}`);
});

// 2. Automatically dispatch a background job when an event fires.
// The 4th argument maps the event payload into the job payload shape.
/*
 * 2. Dispatch a background job when an event fires.
 *
 * The third argument makes the dispatch idempotent under a key derived from the
 * user. Without it, an event emitted twice — a retry, a double-submitted form, an
 * at-least-once queue doing its job — sends two welcome emails, and the user
 * receives the second one as evidence that the first account was a duplicate.
 */
events.pipe(
  "user.registered",
  "send-email",
  // Deterministic key: one welcome email per user, however many events arrive.
  // Returns EnqueueOptions, so the key is derived from the payload.
  (data) => ({ uniqueKey: `welcome-email:${data.userId}` }),
  (data) => ({
    to: data.email,
    subject: "Welcome!",
    body: "Thank you for creating an account.",
  }),
);
