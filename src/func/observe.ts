// yatta/func/observe.ts
//
// The framework's own observer, used by the test app and as the reference for
// what a scaffolded project gets.

import { createObserver } from "../types/observe";

export const observer = createObserver({
  service: "yatta",
  environment: process.env.NODE_ENV || "development",
  bufferSize: 2000,
  tracesSampleRate: 1,
  logLevel: "debug",

  // Served by src/main.ts on the observer's own paths.
  dashboard: process.env.NODE_ENV !== "production",

  // Process and event-loop metrics, off in production by default because
  // they cost a background sample every ten seconds.
  runtimeMetrics: process.env.NODE_ENV !== "production",
});

/**
 * Register the subsystems so every database query, login and job execution is
 * traced without touching a call site.
 *
 * Called once, after the subsystems exist. `observer.db`, `observer.auth` and
 * `observer.jobs` are typed and instrumented from here on.
 */
export function attachSubsystems(subsystems: {
  db?: unknown;
  auth?: unknown;
  jobs?: unknown;
  cache?: unknown;
  storage?: unknown;
  mail?: unknown;
  realtime?: unknown;
}): void {
  if (subsystems.db) observer.attach("db", subsystems.db as never);
  if (subsystems.auth) observer.attach("auth", subsystems.auth as never);
  if (subsystems.jobs) observer.attach("jobs", subsystems.jobs as never);
  if (subsystems.cache) observer.attach("cache", subsystems.cache as never);
  if (subsystems.storage)
    observer.attach("storage", subsystems.storage as never);
  if (subsystems.mail) observer.attach("mail", subsystems.mail);
  if (subsystems.realtime) observer.attach("realtime", subsystems.realtime);
}

export const traceDb = observer.traceDb.bind(observer);
export const traceJob = observer.traceJob.bind(observer);

export function report(error: unknown, request?: Request): void {
  observer.errors.capture(error, request ? { request } : {});
}
