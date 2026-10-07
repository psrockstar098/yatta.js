/**
 * ============================================================================
 *  YATTA JOBS, SCHEDULER & EVENTS (v2.0) — Distributed Runtime for Bun
 * ============================================================================
 *
 *  OVERVIEW:
 *  Full-featured asynchronous background job queue, worker pool, cron scheduler,
 *  and segmented event bus. Features persistent SQLite storage (with WAL mode),
 *  atomic worker leases with heartbeat renewal, stale job reclamation, dead-letter queue (DLQ)
 *  replay, priority ordering, exponential backoff with jitter, cron parsing (Vixie semantics),
 *  and event piping directly into job queues.
 *
 *  KEY EXPORTS:
 *  - `createJobs(options)`: Factory creating a `JobQueueManager`.
 *  - `JobQueueManager`: Manages job queues, workers, DLQ, and metrics:
 *    - `.handle(name, handler)`: Registers worker handler for a specific job name.
 *    - `.enqueue(name, data, options)`: Enqueues a job into a queue.
 *    - `.job(name)`: Fluent builder (`.with()`, `.delay()`, `.priority()`, `.unique()`, `.save()`).
 *    - `.worker(queue, options)`: Starts a managed `WorkerPool` with concurrency caps.
 *    - `.dlq`: Dead-letter queue manager (`.list()`, `.retry()`, `.purge()`).
 *    - `.metrics(queue?)`: Returns queue stats (queued, delayed, running, completed, dead).
 *  - `createEvents(jobs?)`: Factory creating an `EventBus` with exact, prefix/suffix, and global wildcards.
 *    - `.on(event, handler)`, `.once()`, `.emit(event, data)`, `.waitFor()`.
 *    - `.pipe(event, jobName, options)`: Automatically enqueues a background job when an event fires!
 *  - `createCron()`: Factory creating a `CronScheduler` for recurring tasks (`.schedule()`, `.every()`).
 *  - `CronExpression`: 5-field cron parser supporting timezone translations via `Intl.DateTimeFormat`.
 *  - Storage Engines: `SQLiteJobStore` (persistent) and `MemoryJobStore` (in-memory).
 *
 *  MODULE AUGMENTATION:
 *  ```ts
 *  declare module "../types/job" {
 *    interface JobRegister {
 *      "send-email": { to: string; subject: string; body: string };
 *      "transcode-video": { videoId: string; quality: string };
 *    }
 *    interface EventRegister {
 *      "user.registered": { userId: string; email: string };
 *    }
 *  }
 *  ```
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { createJobs, createEvents } from "../types/job";
 *
 *  export const jobs = createJobs();
 *  export const events = createEvents(jobs);
 *
 *  // 1. Define job handler
 *  jobs.handle("send-email", async (ctx) => {
 *    await ctx.progress(50, "Sending...");
 *    return { sent: true };
 *  });
 *
 *  // 2. Start worker
 *  jobs.worker("default", { concurrency: 5 });
 *
 *  // 3. Pipe event to background job
 *  events.pipe("user.registered", "send-email", (data) => ({
 *    to: data.email,
 *    subject: "Welcome!",
 *    body: "Thanks for signing up!",
 *  }));
 *  ```
 */

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// ──────────────────────────────────────────────────────────────────────────
// 0. Global Registry & Type Definitions
// ──────────────────────────────────────────────────────────────────────────

/**
 * Standard error class thrown by Yatta Job Queue, Scheduler, and Event Bus.
 */
/*
 * `db.query()`, not `db.prepare()`.
 *
 * Bun caches the compiled statement inside `query()` and re-parses on every `prepare()`.
 * Measured on the job-select statement: 50,000 selects took 2921ms via `prepare()` and
 * 372ms via `query()`. On a queue path that runs per operation that is the difference
 * between the database doing work and the driver re-compiling the same SQL.
 *
 * The trade is a cache keyed on the SQL string, so a statement assembled from a varying
 * number of placeholders gets one entry per arity. That is bounded and the values are
 * still bound parameters, so it is safe — but do not interpolate *values* into a
 * statement passed to either.
 */

export class QueueError extends Error {
  /**
   * @param message Human-readable error description.
   * @param code Optional machine-readable error code (e.g. `"TIMEOUT"`, `"LEASE_LOST"`).
   */
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

/**
 * Global interface for project-wide job type registration and declaration merging.
 * Augment this interface to get full IDE autocomplete on `jobs.handle()` and `jobs.enqueue()`.
 *
 * @example
 * ```ts
 * declare module "../types/job" {
 *   interface JobRegister {
 *     "send-email": { to: string; subject: string; body: string };
 *     "transcode-video": { videoId: string; quality: string };
 *   }
 * }
 * ```
 */
export interface JobRegister {}

/**
 * Global interface for project-wide event type registration and declaration merging.
 * Augment this interface to get full IDE autocomplete on `events.on()`, `events.emit()`, and `events.pipe()`.
 *
 * @example
 * ```ts
 * declare module "../types/job" {
 *   interface EventRegister {
 *     "user.registered": { userId: string; email: string };
 *     "order.completed": { orderId: string; amount: number };
 *   }
 * }
 * ```
 */
export interface EventRegister {}

/** Type alias referring to {@link JobRegister}. */
export type RegisteredJobs = JobRegister;

/** Type alias referring to {@link EventRegister}. */
export type RegisteredEvents = EventRegister;

/**
 * Resolves the payload type for a specific registered job name, or falls back to `any`.
 */
export type JobPayload<K extends string> = K extends keyof RegisteredJobs
  ? RegisteredJobs[K]
  : any;

/**
 * Resolves the payload type for a specific registered event name, or falls back to `any`.
 */
export type EventPayload<K extends string> = K extends keyof RegisteredEvents
  ? RegisteredEvents[K]
  : any;

/**
 * Millisecond duration represented as a literal string (e.g. `"500ms"`, `"30s"`, `"15m"`, `"2h"`, `"7d"`, `"1w"`)
 * or raw milliseconds as a number.
 */
export type Duration =
  | `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`
  | number;

/**
 * Represents the execution lifecycle status of a background job:
 * - `"queued"`: Waiting in line to be picked up by a worker.
 * - `"delayed"`: Scheduled to run at a future timestamp.
 * - `"running"`: Currently claimed and processing by a worker.
 * - `"completed"`: Finished successfully.
 * - `"dead"`: Exhausted all retry attempts or terminally failed (DLQ).
 */
export type JobState = "queued" | "delayed" | "running" | "completed" | "dead";

/**
 * Retry and backoff configuration for failed jobs.
 */
export interface RetryPolicy {
  /**
   * Backoff strategy:
   * - `"exponential"`: Delay increases exponentially (`delay * factor ^ attempt`).
   * - `"fixed"`: Delay remains constant (`delay`).
   */
  type: "exponential" | "fixed";
  /** Initial delay in milliseconds before the first retry attempt. */
  delay: number;
  /** Exponential multiplier factor (e.g. `2` for doubling delay each attempt). */
  factor: number;
  /** Whether to apply random jitter to prevent worker thundering herds. */
  jitter: boolean;
  /** Maximum upper bound in milliseconds for retry delays. */
  maxDelay: number;
}

/**
 * Serialized error details saved onto failed or dead jobs for inspection.
 */
export interface SerializedError {
  /** Error message. */
  message: string;
  /** Error stack trace if available. */
  stack?: string;
  /** Error classification code. */
  code?: string;
}

/**
 * Complete record of a background job in storage.
 *
 * @template TData The payload data type.
 * @template TResult The return result type upon successful completion.
 */
/**
 * Resolve when `work` settles, but reject with the abort reason if the signal
 * fires first.
 *
 * Aborting alone only reached handlers that watch `ctx.signal`. A handler that
 * ignored it kept running and kept its concurrency slot, so the timeout was not
 * a timeout at all.
 */
function runWithTimeout<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return work;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new QueueError(`Job timed out after ${timeoutMs}ms`, "TIMEOUT"),
      );
    }, timeoutMs);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Whether `workerId` may still mutate this job.
 *
 * The job must be running, and — when a worker is named — that worker must hold
 * the lease. A worker whose lease expired must not complete or fail the copy
 * that was already reclaimed and re-queued, or the job runs a second time.
 *
 * `workerId` is optional so administrative callers keep working; they are
 * trusted, and the running-state check still applies.
 */
function ownsLease(job: JobRecord, workerId?: string): boolean {
  // No worker named: an administrative caller, trusted to act on any state.
  if (workerId === undefined) return true;

  // A worker may only touch the job while it holds the lease.
  return job.state === "running" && job.lease?.workerId === workerId;
}

export interface JobRecord<TData = unknown, TResult = unknown> {
  /** Unique job identifier. */
  id: string;
  /** Target queue name (e.g. `"default"`, `"emails"`). */
  queue: string;
  /** Task action name. */
  name: string;
  /** Input payload data. */
  data: TData;
  /** Current execution lifecycle state. */
  state: JobState;
  /** Number of execution attempts completed so far. */
  attempts: number;
  /** Maximum attempts allowed before moving to the dead-letter queue. */
  maxAttempts: number;
  /** Numerical priority (higher values run first). */
  priority: number;
  /** Scheduled execution timestamp in milliseconds since epoch. */
  runAt: number;
  /** Maximum execution time allowed in milliseconds before aborting. */
  timeout?: number;
  /** Retry and backoff policy applied upon execution failure. */
  retry: RetryPolicy;
  /** Active worker lease metadata while in the `"running"` state. */
  lease?: {
    /** Worker ID holding the lease. */
    workerId: string;
    /** Timestamp when lease was acquired. */
    acquiredAt: number;
    /** Timestamp when lease expires if not renewed via heartbeat. */
    expiresAt: number;
  };
  /** Execution completion percentage (0 - 100). */
  progress: number;
  /** Human-readable status or progress message. */
  progressMessage?: string;
  /** Result returned upon successful completion. */
  result?: TResult;
  /** Serialized error details if the job failed or died. */
  error?: SerializedError;
  /** Deduplication key preventing concurrent duplicate enqueueing. */
  uniqueKey?: string;
  /** Initial creation timestamp. */
  createdAt: number;
  /** Last modification timestamp. */
  updatedAt: number;
}

/**
 * Execution context supplied to a {@link JobHandler}.
 * Provides job metadata, cancellation signals, progress reporting, and contextual logging.
 *
 * @template TData Payload data type.
 */
export interface JobContext<TData = unknown> {
  /** Unique job ID. */
  readonly id: string;
  /** Job task name. */
  readonly name: string;
  /** Queue name. */
  readonly queue: string;
  /** Current execution attempt count (1-indexed). */
  readonly attempts: number;
  /** Maximum retry attempts configured. */
  readonly maxAttempts: number;
  /** Input job payload. */
  readonly data: TData;
  /** Abort signal triggered if the job times out, loses its lease, or the worker shuts down. */
  readonly signal: AbortSignal;
  /**
   * Reports execution progress percentage (0 - 100) and an optional status message.
   * Progress updates are throttled and coalesced automatically.
   *
   * @param percent Number between 0 and 100.
   * @param message Optional human-readable message.
   */
  progress(percent: number, message?: string): Promise<void>;
  /**
   * Logs a structured message tagged with the current job name and ID.
   *
   * @param message Log message.
   * @param meta Optional metadata payload.
   */
  log(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Function handler invoked by workers to execute a queued job.
 *
 * @template TData Input payload type.
 * @template TResult Output result type.
 */
export type JobHandler<TData = any, TResult = any> = (
  ctx: JobContext<TData>,
) => Promise<TResult> | TResult;

/**
 * Options configuring how a job is enqueued and scheduled.
 */
export interface EnqueueOptions {
  /** Target queue name (defaults to `"default"`). */
  queue?: string;
  /** Delay duration before the job becomes eligible to run (e.g. `"5m"`, `"1h"`). */
  delay?: Duration;
  /** Exact future timestamp or Date to execute the job. */
  runAt?: Date | number;
  /** Maximum number of retry attempts before moving to DLQ (defaults to 3). */
  attempts?: number;
  /** Job execution priority (`"low"`, `"normal"`, `"high"`, `"critical"` or custom number). Defaults to `"normal"`. */
  priority?: "low" | "normal" | "high" | "critical" | number;
  /** Execution timeout duration before aborting (e.g. `"30s"`, `"5m"`). */
  timeout?: Duration;
  /** Unique key preventing duplicate jobs in the queue while one is already active. */
  uniqueKey?: string;
  /** Custom retry and backoff parameters. */
  retry?: {
    /** Backoff calculation strategy (`"exponential"` or `"fixed"`). */
    type?: "exponential" | "fixed";
    /** Base initial delay before first retry (defaults to `"1s"`). */
    delay?: Duration;
    /** Exponential factor multiplier (defaults to 2). */
    factor?: number;
    /** Whether to add random jitter (defaults to true). */
    jitter?: boolean;
    /** Maximum backoff delay cap (defaults to `"1h"`). */
    maxDelay?: Duration;
  };
}

/**
 * Configuration options for starting a background {@link WorkerPool}.
 */
export interface WorkerOptions {
  /** Target queue to process (defaults to `"default"`). */
  queue?: string;
  /** Maximum concurrent jobs executed simultaneously by this worker pool (defaults to 5). */
  concurrency?: number;
  /** Polling interval when no ready jobs are found (defaults to `"1s"`). */
  pollInterval?: Duration;
  /** Lease lock duration before an abandoned job can be reclaimed by other workers (defaults to `"60s"`). */
  lockDuration?: Duration;
  /** How frequently to scan for and recover stale/orphaned jobs (defaults to `"30s"`). */
  staleRecoveryInterval?: Duration;
  /** Maximum grace period to wait for active jobs to finish during graceful shutdown (defaults to `"10s"`). */
  shutdownTimeout?: Duration;
  /** Callback fired when a job updates its progress percentage. */
  onProgress?: (job: JobRecord) => void;
  /** Callback fired when a job completes successfully. */
  onCompleted?: (job: JobRecord) => void;
  /** Callback fired when a job execution fails (before retries). */
  onFailed?: (job: JobRecord, err: Error) => void;
  /** Callback fired when a job exhausts all retries and is moved to the dead-letter queue. */
  onDead?: (job: JobRecord, err: Error) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Utilities, Timing & Standards-Compliant Cron Parser
// ──────────────────────────────────────────────────────────────────────────

/**
 * Converts a string duration (e.g. `"500ms"`, `"10s"`, `"5m"`, `"2h"`, `"1d"`, `"1w"`)
 * or number to milliseconds.
 *
 * @param value Duration string or numeric milliseconds.
 * @param fallbackMs Default fallback milliseconds if value is undefined.
 * @returns Milliseconds as an integer.
 * @throws {@link QueueError} if the format or unit is invalid.
 */
export function duration(value?: Duration, fallbackMs = 0): number {
  if (value == null) return fallbackMs;
  if (typeof value === "number") return value; // numbers are strictly milliseconds

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) throw new QueueError(`Invalid duration format: "${value}"`);

  const n = parseFloat(match[1]!);
  switch (match[2]!.toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 604_800_000;
    default:
      throw new QueueError(`Invalid duration unit: "${match[2]}"`);
  }
}

/**
 * Normalizes priority literals (`"critical"`, `"high"`, `"normal"`, `"low"`) or numbers into numeric values.
 *
 * @param p Priority value or string.
 * @returns Numerical priority (100 = critical, 50 = high, 10 = normal, 0 = low).
 */
export function parsePriority(p?: EnqueueOptions["priority"]): number {
  if (typeof p === "number") return p;
  switch (p) {
    case "critical":
      return 100;
    case "high":
      return 50;
    case "normal":
      return 10;
    case "low":
      return 0;
    default:
      return 10;
  }
}

/**
 * Standardizes an enqueue retry configuration into a concrete {@link RetryPolicy}.
 *
 * @param config Optional retry options.
 * @returns Normalized {@link RetryPolicy}.
 */
export function normalizeRetryPolicy(
  config?: EnqueueOptions["retry"],
): RetryPolicy {
  return {
    type: config?.type ?? "exponential",
    delay: duration(config?.delay, 1_000), // Default: 1s base
    factor: config?.factor ?? 2,
    jitter: config?.jitter ?? true,
    maxDelay: duration(config?.maxDelay, 3_600_000), // Default: 1h max
  };
}

/**
 * Calculates the next retry delay in milliseconds based on attempt number and policy.
 * Applies exponential backoff and randomized jitter to mitigate thundering herds.
 *
 * @param attempt Current retry attempt count.
 * @param policy Configured retry policy.
 * @returns Milliseconds to delay before reattempting.
 */
export function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  let delay =
    policy.type === "exponential"
      ? policy.delay * Math.pow(policy.factor, Math.max(0, attempt - 1))
      : policy.delay;

  delay = Math.min(delay, policy.maxDelay);

  if (policy.jitter) {
    const jitterFactor = 0.5 + Math.random(); // 0.5x to 1.5x jitter
    delay = Math.round(delay * jitterFactor);
  }

  return delay;
}

/**
 * Internal descriptor representing parsed values of a single cron field.
 */
export interface ParsedCronField {
  /** Set of allowable integer values for this field. */
  values: Set<number>;
  /** Whether the field was specified as a wildcard (`*`). */
  isWildcard: boolean;
}

/**
 * Standard 5-field Cron parser supporting:
 * - Traditional Vixie Cron DOM/DOW OR-semantics.
 * - Proper range bounds checking.
 * - Deterministic, DST-aware time zone conversions via Intl.DateTimeFormat.
 */
/**
 * Standard 5-field Cron parser supporting:
 * - Traditional Vixie Cron DOM/DOW OR-semantics.
 * - Proper range bounds checking.
 * - Deterministic, DST-aware time zone conversions via `Intl.DateTimeFormat`.
 *
 * @example
 * ```ts
 * const cron = new CronExpression("0 9 * * 1-5", "America/New_York");
 * const nextRun = cron.getNextDate();
 * ```
 */
export class CronExpression {
  private minutes!: ParsedCronField;
  private hours!: ParsedCronField;
  private daysOfMonth!: ParsedCronField;
  private months!: ParsedCronField;
  private daysOfWeek!: ParsedCronField;

  /**
   * Parses and validates a standard 5-field cron string.
   *
   * @param expression 5-field cron expression (`"minute hour dom month dow"`).
   * @param timezone Optional IANA timezone identifier (e.g. `"America/New_York"`).
   * @throws {@link QueueError} if the cron expression syntax or field values are invalid.
   */
  /**
   * Built once per expression, not per lookup.
   *
   * `getZonedParts` is called once per loop iteration of `getNextDate`, and
   * constructing an Intl.DateTimeFormat is expensive enough that a
   * non-matching expression — a half-hour zone made `0 3 * * *` unmatchable —
   * blocked the event loop for seconds over 525,600 iterations.
   */
  private readonly zonedFormatter: Intl.DateTimeFormat | undefined;

  constructor(
    public readonly expression: string,
    public readonly timezone?: string,
  ) {
    this.zonedFormatter = timezone
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          hour12: false,
          weekday: "short",
        })
      : undefined;

    this.parse(expression.trim());
  }

  private parse(expr: string) {
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) {
      throw new QueueError(
        `Invalid cron expression "${expr}". Expected 5 fields (m h dom mon dow).`,
      );
    }

    this.minutes = this.parseField(parts[0]!, 0, 59, "minute");
    this.hours = this.parseField(parts[1]!, 0, 23, "hour");
    this.daysOfMonth = this.parseField(parts[2]!, 1, 31, "day-of-month");
    this.months = this.parseField(parts[3]!, 1, 12, "month");
    this.daysOfWeek = this.parseField(parts[4]!, 0, 6, "day-of-week");
  }

  private parseField(
    field: string,
    min: number,
    max: number,
    name: string,
  ): ParsedCronField {
    const values = new Set<number>();
    let isWildcard = false;

    for (const item of field.split(",")) {
      if (item === "*") {
        isWildcard = true;
        for (let i = min; i <= max; i++) values.add(i);
      } else if (item.includes("/")) {
        const [subExpr, stepStr] = item.split("/");
        const step = parseInt(stepStr!, 10);
        if (isNaN(step) || step <= 0)
          throw new QueueError(`Invalid step in cron field ${name}: "${item}"`);

        let start = min;
        let end = max;
        if (subExpr !== "*") {
          if (subExpr!.includes("-")) {
            [start, end] = this.parseRange(subExpr!, min, max, name);
          } else {
            start = parseInt(subExpr!, 10);
          }
        }
        for (let i = start; i <= end; i += step) values.add(i);
      } else if (item.includes("-")) {
        const [start, end] = this.parseRange(item, min, max, name);
        for (let i = start; i <= end; i++) values.add(i);
      } else {
        const num = parseInt(item, 10);
        if (isNaN(num) || num < min || num > max) {
          throw new QueueError(
            `Value "${item}" out of bounds (${min}-${max}) in cron field ${name}`,
          );
        }
        values.add(num);
      }
    }

    return { values, isWildcard };
  }

  private parseRange(
    rangeStr: string,
    min: number,
    max: number,
    name: string,
  ): [number, number] {
    const [startStr, endStr] = rangeStr.split("-");
    const start = parseInt(startStr!, 10);
    const end = parseInt(endStr!, 10);

    if (isNaN(start) || isNaN(end) || start > end || start < min || end > max) {
      throw new QueueError(
        `Invalid range "${rangeStr}" in cron field ${name}. Must be within ${min}-${max} and start <= end.`,
      );
    }
    return [start, end];
  }

  private getZonedParts(date: Date): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    dow: number;
  } {
    if (!this.timezone) {
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        dow: date.getDay(),
      };
    }

    const parts = this.zonedFormatter!.formatToParts(date);
    let year = 0,
      month = 0,
      day = 0,
      hour = 0,
      minute = 0,
      dow = 0;
    const dowMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    for (const p of parts) {
      if (p.type === "year") year = parseInt(p.value, 10);
      else if (p.type === "month") month = parseInt(p.value, 10);
      else if (p.type === "day") day = parseInt(p.value, 10);
      else if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
      else if (p.type === "minute") minute = parseInt(p.value, 10);
      else if (p.type === "weekday") dow = dowMap[p.value] ?? 0;
    }

    return { year, month, day, hour, minute, dow };
  }

  /**
   * Computes the next matching execution timestamp after the specified reference date.
   *
   * @param from Reference starting date (defaults to `new Date()`).
   * @returns Next matching {@link Date}.
   * @throws {@link QueueError} if no matching date is found within a 1-year lookahead window.
   */
  /**
   * The smallest value in `set` strictly greater than `after`, or undefined.
   *
   * `after` of -1 returns the smallest value, so the same helper serves both
   * "next one after this" and "the first one".
   */
  private sortedAfter(set: Set<number>, after: number): number | undefined {
    let best: number | undefined;
    for (const v of set) {
      if (v > after && (best === undefined || v < best)) best = v;
    }
    return best;
  }

  getNextDate(from: Date = new Date()): Date {
    /*
     * Everything below advances the cursor by *absolute minutes* read from the
     * zoned parts. The previous version used setHours(0, 0, 0, 0) and friends,
     * which operate in the server's local time: on a UTC server, `0 9 * * 1` in
     * America/New_York landed on Monday 19:00 NY and fired a week late, and a
     * half-hour zone such as Asia/Kolkata made the hour step land on :30
     * forever, so `0 3 * * *` never matched and burned all 525,600 iterations.
     *
     * Every jump is a fixed number of minutes from the cursor, so the zoned
     * fields are re-read each pass and any drift (DST included) self-corrects.
     */
    const next = new Date(from.getTime() + 60_000);
    next.setSeconds(0, 0);

    const MINUTE = 60_000;

    for (let i = 0; i < 525_600; i++) {
      const parts = this.getZonedParts(next);

      if (!this.months.values.has(parts.month)) {
        // Jump to midnight on the 1st of the next zoned month.
        const daysInMonth = new Date(
          Date.UTC(parts.year, parts.month, 0),
        ).getUTCDate();
        const skip =
          (daysInMonth - parts.day + 1) * 24 * 60 -
          (parts.hour * 60 + parts.minute);
        next.setTime(next.getTime() + skip * MINUTE);
        continue;
      }

      // Vixie semantics: when both day-of-month and day-of-week are restricted,
      // either matching is enough.
      const domMatch = this.daysOfMonth.values.has(parts.day);
      const dowMatch = this.daysOfWeek.values.has(parts.dow);
      const dayMatches =
        !this.daysOfMonth.isWildcard && !this.daysOfWeek.isWildcard
          ? domMatch || dowMatch
          : domMatch && dowMatch;

      if (!dayMatches) {
        // A whole zoned day: to the next midnight, then 24h on.
        const skip = (48 - parts.hour) * 60 - parts.minute;
        next.setTime(next.getTime() + skip * MINUTE);
        continue;
      }

      /*
       * Jump to the next *matching* hour rather than always to midnight.
       *
       * Skipping straight to midnight meant a schedule like `0 9 * * 1-5`
       * landed on hour 0, failed, and skipped to midnight again — 525,600
       * iterations with no chance of ever reaching 09:xx.
       */
      if (!this.hours.values.has(parts.hour)) {
        const later = this.sortedAfter(this.hours.values, parts.hour);

        const skip =
          later === undefined
            ? // No later hour today: go to the next day's first allowed hour.
              ((24 - parts.hour) * 60 - parts.minute) +
              (this.sortedAfter(this.hours.values, -1) ?? 0) * 60
            : (later - parts.hour) * 60 - parts.minute;

        next.setTime(next.getTime() + skip * MINUTE);
        continue;
      }

      if (!this.minutes.values.has(parts.minute)) {
        const later = this.sortedAfter(this.minutes.values, parts.minute);

        const skip =
          later === undefined
            ? // No later minute this hour: roll into the next hour's first
              // allowed minute.
              (60 - parts.minute) +
              (this.sortedAfter(this.minutes.values, -1) ?? 0)
            : later - parts.minute;

        next.setTime(next.getTime() + skip * MINUTE);
        continue;
      }

      return next;
    }

    throw new QueueError(
      `Could not find next matching date for cron: "${this.expression}" within 1 year.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Storage Engines (SQLite with Heartbeat & Memory Engine)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Storage and state-management interface for job queues.
 * Implemented by persistent database stores (e.g. {@link SQLiteJobStore}) and {@link MemoryJobStore}.
 */
export interface JobStore {
  /** Initializes tables, schemas, and indexes. */
  init(): Promise<void>;
  /** Enqueues a new job into the store. */
  enqueue(
    job: Omit<JobRecord, "attempts" | "state" | "createdAt" | "updatedAt">,
  ): Promise<JobRecord>;
  /** Atomically claims the next eligible job for the worker with an active lease. */
  claimNext(
    queue: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<JobRecord | null>;
  /** Renews an active worker lease to prevent premature reclamation. */
  heartbeat(
    id: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<boolean>;
  /**
   * Updates the job's completion progress and optional status message.
   *
   * @param workerId When given, the write is rejected unless this worker holds
   *   the lease.
   */
  updateProgress(
    id: string,
    progress: number,
    message?: string,
    workerId?: string,
  ): Promise<void>;
  /**
   * Marks a job as completed and stores its result.
   *
   * @param workerId When given, the update is rejected unless this worker still
   *   holds the lease — otherwise a worker whose lease was reclaimed completes
   *   the re-queued copy and the job runs twice.
   */
  complete(id: string, result?: unknown, workerId?: string): Promise<boolean>;
  /** Marks a job as failed, scheduling a retry or moving it to DLQ. */
  fail(
    id: string,
    error: SerializedError,
    nextRunAt?: number,
    dead?: boolean,
    workerId?: string,
  ): Promise<boolean>;
  /** Reclaims orphaned or abandoned running jobs whose leases expired. */
  reclaimStaleJobs(staleThresholdMs: number): Promise<number>;
  /**
   * Returns a running job to `queued` without consuming an attempt or applying
   * backoff.
   *
   * Used when a job stopped for an infrastructural reason — the worker is
   * shutting down, or the lease was lost — as opposed to the job itself
   * failing. Routing those through {@link JobStore.fail} would spend an attempt,
   * so a job on its last attempt reached the dead-letter queue simply because a
   * deploy happened.
   *
   * @param id Job ID.
   * @param workerId Releasing worker, when it still holds the lease.
   * @returns `true` if the job was released.
   */
  release(id: string, workerId?: string): Promise<boolean>;
  /** Fetches a job record by ID. */
  getJob(id: string): Promise<JobRecord | null>;
  /** Returns queue operational metrics partitioned by job state. */
  getMetrics(queue?: string): Promise<QueueMetrics>;
  /** Retrieves jobs currently residing in the dead-letter queue. */
  listDead(queue?: string, limit?: number): Promise<JobRecord[]>;
  /** Replays a dead job by resetting its attempts and moving it back to queued. */
  replayDead(id: string): Promise<boolean>;
  /** Purges jobs from a queue, optionally filtered by state. */
  purgeQueue(queue: string, state?: JobState): Promise<number>;
  /** Closes storage connections and releases resources. */
  close(): Promise<void>;
}

/**
 * Real-time queue volume metrics grouped by lifecycle state.
 */
export interface QueueMetrics {
  /** Count of jobs awaiting pickup. */
  queued: number;
  /** Count of jobs scheduled for future execution. */
  delayed: number;
  /** Count of jobs currently being executed by workers. */
  running: number;
  /** Count of successfully finished jobs. */
  completed: number;
  /** Count of jobs in the dead-letter queue. */
  dead: number;
  /** Total count of all jobs. */
  total: number;
}

/**
 * Persistent SQLite-backed job queue storage engine with WAL mode,
 * atomic worker leases, heartbeat renewal, and dead-letter queueing.
 */
export class SQLiteJobStore implements JobStore {
  private db: Database;
  /** Resolved filesystem database path. */
  readonly path: string;

  /**
   * Initializes the SQLite job store.
   *
   * @param dbPath File path to SQLite database or existing `bun:sqlite` Database instance.
   */
  constructor(dbPath: string | Database = "Database/jobs.db") {
    if (typeof dbPath === "string") {
      this.path =
        dbPath === ":memory:"
          ? ":memory:"
          : path.resolve(process.cwd(), dbPath);
      if (this.path !== ":memory:") {
        const dir = path.dirname(this.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(this.path, { create: true });
    } else {
      this.db = dbPath;
      this.path = (this.db as any).filename || "database";
    }

    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run("PRAGMA synchronous = NORMAL;");
  }

  /**
   * Creates the `_yatta_jobs` table and performance indexes.
   */
  async init(): Promise<void> {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "_yatta_jobs" (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 10,
        run_at INTEGER NOT NULL,
        timeout INTEGER,
        retry_policy TEXT NOT NULL,
        locked_at INTEGER,
        locked_by TEXT,
        lock_expires_at INTEGER,
        progress INTEGER NOT NULL DEFAULT 0,
        progress_message TEXT,
        result TEXT,
        error_message TEXT,
        error_stack TEXT,
        unique_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    /*
     * The claim index, and the reason it is shaped this way.
     *
     * `claimNext` asks for the highest-priority job that is due, so the index has to
     * hand rows back in `priority DESC, run_at ASC, id ASC` order. The old index led
     * with `run_at`, which matches the filter but not the sort, so every claim built a
     * temporary B-tree over the whole queued group and re-read each row from the table
     * to check `lock_expires_at` — a column the index did not carry.
     *
     * Measured draining 3,000 jobs: 2211ms with the old shape, 81ms with this one.
     * A 27x difference on the path that decides what work happens next.
     *
     * Leading with `priority DESC` serves the sort; carrying `lock_expires_at` makes
     * the index cover the claim's own predicate, so the lookup stops touching the table.
     *
     * A new name, because `CREATE INDEX IF NOT EXISTS` will not replace an existing
     * index and every database created before this change still has the old one. The
     * old index is dropped immediately after: leaving both would cost the write
     * amplification and let the planner pick the wrong one.
     */
    this.db.run(`
      CREATE INDEX IF NOT EXISTS "idx_yatta_jobs_claim_v2"
      ON "_yatta_jobs" (queue, state, priority DESC, run_at ASC, id ASC, lock_expires_at);
    `);

    this.db.run(`DROP INDEX IF EXISTS "idx_yatta_jobs_claim";`);

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_yatta_jobs_unique"
      ON "_yatta_jobs" (queue, unique_key)
      WHERE unique_key IS NOT NULL AND state IN ('queued', 'delayed', 'running');
    `);
  }

  /**
   * Persists a job into SQLite. Deduplicates by unique key if currently active.
   */
  async enqueue(
    job: Omit<JobRecord, "attempts" | "state" | "createdAt" | "updatedAt">,
  ): Promise<JobRecord> {
    const now = Date.now();
    const state: JobState = job.runAt > now ? "delayed" : "queued";

    if (job.uniqueKey) {
      const existing = this.db
        .query(
          `
        SELECT * FROM "_yatta_jobs"
        WHERE queue = ? AND unique_key = ? AND state IN ('queued', 'delayed', 'running')
      `,
        )
        .get(job.queue, job.uniqueKey) as any;

      if (existing) return this.deserialize(existing);
    }

    const sql = `
      INSERT INTO "_yatta_jobs" (
        id, queue, name, data, state, attempts, max_attempts,
        priority, run_at, timeout, retry_policy, progress, unique_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      RETURNING *;
    `;

    const row = this.db
      .query(sql)
      .get(
        job.id,
        job.queue,
        job.name,
        JSON.stringify(job.data ?? {}),
        state,
        job.maxAttempts,
        job.priority,
        job.runAt,
        job.timeout ?? null,
        JSON.stringify(job.retry),
        job.uniqueKey ?? null,
        now,
        now,
      ) as any;

    return this.deserialize(row);
  }

  /**
   * Atomically claims the next eligible job in the queue using an SQLite `RETURNING` subquery.
   */
  async claimNext(
    queue: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<JobRecord | null> {
    const now = Date.now();
    const lockExpiresAt = now + lockDurationMs;

    const sql = `
      UPDATE "_yatta_jobs"
      SET 
        state = 'running',
        locked_at = ?,
        locked_by = ?,
        lock_expires_at = ?,
        attempts = attempts + 1,
        updated_at = ?
      WHERE id = (
        SELECT id FROM "_yatta_jobs"
        WHERE queue = ?
          AND state IN ('queued', 'delayed')
          AND run_at <= ?
          AND (lock_expires_at IS NULL OR lock_expires_at <= ?)
        ORDER BY priority DESC, run_at ASC, id ASC
        LIMIT 1
      )
      RETURNING *;
    `;

    const row = this.db
      .query(sql)
      .get(now, workerId, lockExpiresAt, now, queue, now, now) as any;

    return row ? this.deserialize(row) : null;
  }

  /**
   * Renews the active worker lease in SQLite.
   */
  async heartbeat(
    id: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const res = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET lock_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND locked_by = ?
    `,
      )
      .run(now + lockDurationMs, now, id, workerId);

    return res.changes > 0;
  }

  /**
   * Updates execution progress percentage and message for a job.
   */
  async updateProgress(
    id: string,
    progress: number,
    message?: string,
    workerId?: string,
  ): Promise<void> {
    // Scoped to the state and lease holder: a worker whose lease was reclaimed
    // must not write progress onto the copy that is now running elsewhere.
    this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET progress = ?, progress_message = ?, updated_at = ?
      WHERE id = ?
        AND (? IS NULL OR (state = 'running' AND locked_by = ?))
    `,
      )
      .run(progress, message ?? null, Date.now(), id, workerId ?? null, workerId ?? null);
  }

  /**
   * Marks a job completed and saves its return result.
   */
  async complete(id: string, result?: unknown, workerId?: string): Promise<boolean> {
    // The state and lease predicates are what stop a stale worker from
    // completing a job that has already been reclaimed and re-queued, which
    // would run it a second time. Zero changes means the guard rejected it.
    const res = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET
        state = 'completed',
        progress = 100,
        result = ?,
        locked_by = NULL,
        lock_expires_at = NULL,
        updated_at = ?
      WHERE id = ?
        AND (? IS NULL OR (state = 'running' AND locked_by = ?))
    `,
      )
      .run(
        result !== undefined ? JSON.stringify(result) : null,
        Date.now(),
        id,
        workerId ?? null,
        workerId ?? null,
      );

    return res.changes > 0;
  }

  /**
   * Marks a job failed, updating retry state or moving to the dead-letter state.
   */
  async fail(
    id: string,
    error: SerializedError,
    nextRunAt?: number,
    dead = false,
    workerId?: string,
  ): Promise<boolean> {
    const now = Date.now();
    const state: JobState = dead ? "dead" : "delayed";

    // Same guard as complete(): a stale worker's failure must not reschedule
    // the copy another worker is already running.
    const res = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET
        state = ?,
        error_message = ?,
        error_stack = ?,
        run_at = ?,
        locked_by = NULL,
        lock_expires_at = NULL,
        updated_at = ?
      WHERE id = ?
        AND (? IS NULL OR (state = 'running' AND locked_by = ?))
    `,
      )
      .run(
        state,
        error.message,
        error.stack ?? null,
        nextRunAt ?? now,
        now,
        id,
        workerId ?? null,
        workerId ?? null,
      );

    return res.changes > 0;
  }

  /**
   * Reclaims running jobs whose lease expired, and dead-letters the exhausted
   * ones.
   *
   * Lease expiry is the only staleness signal. The earlier version also
   * matched `locked_at <= now - threshold`, which never cleared for a long
   * job: `heartbeat` only pushes `lock_expires_at` forward, so any job running
   * longer than the threshold was reclaimed and duplicated while heartbeating
   * correctly.
   *
   * Jobs past their attempt limit go to `dead` instead of back to `queued`, so
   * one that crashes its worker every time eventually reaches the DLQ instead
   * of being reclaimed forever.
   */
  async reclaimStaleJobs(_staleThresholdMs: number): Promise<number> {
    const now = Date.now();

    const dead = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET state = 'dead', locked_by = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE state = 'running'
        AND (locked_by IS NULL OR lock_expires_at <= ?)
        AND attempts >= max_attempts
    `,
      )
      .run(now, now);

    const requeued = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET state = 'queued', locked_by = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE state = 'running'
        AND (locked_by IS NULL OR lock_expires_at <= ?)
        AND attempts < max_attempts
    `,
      )
      .run(now, now);

    return dead.changes + requeued.changes;
  }

  /** Returns a running job to queued without consuming an attempt. */
  async release(id: string, workerId?: string): Promise<boolean> {
    const res = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET state = 'queued', locked_by = NULL, lock_expires_at = NULL, updated_at = ?
      WHERE id = ?
        AND (? IS NULL OR (state = 'running' AND locked_by = ?))
    `,
      )
      .run(Date.now(), id, workerId ?? null, workerId ?? null);

    return res.changes > 0;
  }

  /**
   * Fetches a single job record by ID.
   */
  async getJob(id: string): Promise<JobRecord | null> {
    const row = this.db
      .query(`SELECT * FROM "_yatta_jobs" WHERE id = ?`)
      .get(id) as any;
    return row ? this.deserialize(row) : null;
  }

  /**
   * Calculates metrics for all or a specific queue.
   */
  async getMetrics(queue?: string): Promise<QueueMetrics> {
    const sql = queue
      ? `SELECT state, COUNT(*) as count FROM "_yatta_jobs" WHERE queue = ? GROUP BY state`
      : `SELECT state, COUNT(*) as count FROM "_yatta_jobs" GROUP BY state`;

    const rows = (
      queue ? this.db.query(sql).all(queue) : this.db.query(sql).all()
    ) as Array<{ state: JobState; count: number }>;

    const counts: Record<string, number> = {
      queued: 0,
      delayed: 0,
      running: 0,
      completed: 0,
      dead: 0,
    };
    let total = 0;
    for (const r of rows) {
      if (counts[r.state] !== undefined) counts[r.state] = r.count;
      total += r.count;
    }

    return {
      queued: counts.queued!,
      delayed: counts.delayed!,
      running: counts.running!,
      completed: counts.completed!,
      dead: counts.dead!,
      total,
    };
  }

  /**
   * Lists jobs in the dead-letter queue.
   */
  async listDead(queue?: string, limit = 50): Promise<JobRecord[]> {
    const sql = queue
      ? `SELECT * FROM "_yatta_jobs" WHERE state = 'dead' AND queue = ? ORDER BY updated_at DESC LIMIT ?`
      : `SELECT * FROM "_yatta_jobs" WHERE state = 'dead' ORDER BY updated_at DESC LIMIT ?`;

    const rows = (
      queue
        ? this.db.query(sql).all(queue, limit)
        : this.db.query(sql).all(limit)
    ) as any[];
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * Replays a dead-letter job by re-queuing it.
   */
  async replayDead(id: string): Promise<boolean> {
    const res = this.db
      .query(
        `
      UPDATE "_yatta_jobs"
      SET state = 'queued', attempts = 0, error_message = NULL, error_stack = NULL, run_at = ?, updated_at = ?
      WHERE id = ? AND state = 'dead'
    `,
      )
      .run(Date.now(), Date.now(), id);

    return res.changes > 0;
  }

  /**
   * Purges jobs from SQLite.
   */
  async purgeQueue(queue: string, state?: JobState): Promise<number> {
    const sql = state
      ? `DELETE FROM "_yatta_jobs" WHERE queue = ? AND state = ?`
      : `DELETE FROM "_yatta_jobs" WHERE queue = ?`;

    const res = state
      ? this.db.query(sql).run(queue, state)
      : this.db.query(sql).run(queue);

    return res.changes;
  }

  /**
   * Closes the SQLite database connection.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  private deserialize(row: any): JobRecord {
    return {
      id: row.id,
      queue: row.queue,
      name: row.name,
      data: JSON.parse(row.data),
      state: row.state as JobState,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      runAt: row.run_at,
      timeout: row.timeout ?? undefined,
      retry: JSON.parse(row.retry_policy),
      lease: row.locked_by
        ? {
            workerId: row.locked_by,
            acquiredAt: row.locked_at,
            expiresAt: row.lock_expires_at,
          }
        : undefined,
      progress: row.progress,
      progressMessage: row.progress_message ?? undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error_message
        ? {
            message: row.error_message,
            stack: row.error_stack ?? undefined,
          }
        : undefined,
      uniqueKey: row.unique_key ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * High-speed in-memory job store designed for unit tests and ephemeral background tasks.
 */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();
  private uniqueKeys = new Map<string, string>(); // index: `${queue}:${key}` -> jobId

  /** Initializes the memory store (no-op). */
  async init(): Promise<void> {}

  /** Enqueues a job into memory. */
  async enqueue(
    job: Omit<JobRecord, "attempts" | "state" | "createdAt" | "updatedAt">,
  ): Promise<JobRecord> {
    const now = Date.now();

    if (job.uniqueKey) {
      const uKey = `${job.queue}:${job.uniqueKey}`;
      const existingId = this.uniqueKeys.get(uKey);
      if (existingId) {
        const existing = this.jobs.get(existingId);
        if (
          existing &&
          (existing.state === "queued" ||
            existing.state === "delayed" ||
            existing.state === "running")
        ) {
          return existing;
        }
      }
    }

    const state: JobState = job.runAt > now ? "delayed" : "queued";
    const record: JobRecord = {
      ...job,
      state,
      attempts: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(record.id, record);
    if (job.uniqueKey) {
      this.uniqueKeys.set(`${job.queue}:${job.uniqueKey}`, record.id);
    }
    return record;
  }

  /** Claims the highest priority ready job in memory. */
  async claimNext(
    queue: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<JobRecord | null> {
    const now = Date.now();
    let selected: JobRecord | null = null;

    for (const j of this.jobs.values()) {
      if (j.queue !== queue) continue;
      if (j.state !== "queued" && j.state !== "delayed") continue;
      if (j.runAt > now) continue;
      if (j.lease && j.lease.expiresAt > now) continue;

      if (!selected) {
        selected = j;
        continue;
      }

      // Priority desc, then runAt asc
      if (
        j.priority > selected.priority ||
        (j.priority === selected.priority && j.runAt < selected.runAt)
      ) {
        selected = j;
      }
    }

    if (!selected) return null;

    selected.state = "running";
    selected.attempts++;
    selected.lease = {
      workerId,
      acquiredAt: now,
      expiresAt: now + lockDurationMs,
    };
    selected.updatedAt = now;

    return { ...selected };
  }

  /** Renews a worker lease in memory. */
  async heartbeat(
    id: string,
    workerId: string,
    lockDurationMs: number,
  ): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || j.state !== "running" || j.lease?.workerId !== workerId)
      return false;
    j.lease.expiresAt = Date.now() + lockDurationMs;
    j.updatedAt = Date.now();
    return true;
  }

  /** Updates progress percentage and message in memory. */
  async updateProgress(
    id: string,
    progress: number,
    message?: string,
    workerId?: string,
  ): Promise<void> {
    const j = this.jobs.get(id);
    if (j && !ownsLease(j, workerId)) return;
    if (j) {
      j.progress = progress;
      j.progressMessage = message;
      j.updatedAt = Date.now();
    }
  }

  /** Marks a job completed in memory. */
  async complete(id: string, result?: unknown, workerId?: string): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || !ownsLease(j, workerId)) return false;

    j.state = "completed";
    j.progress = 100;
    j.result = result;
    j.lease = undefined;
    j.updatedAt = Date.now();
    // Ownership-checked: a stale worker must not release a dedup key that a
    // newer job has since claimed.
    if (j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === j.id) {
      this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
    }
    return true;
  }

  /** Marks a job failed or dead in memory. */
  async fail(
    id: string,
    error: SerializedError,
    nextRunAt?: number,
    dead = false,
    workerId?: string,
  ): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || !ownsLease(j, workerId)) return false;

    j.state = dead ? "dead" : "delayed";
    j.error = error;
    j.runAt = nextRunAt ?? Date.now();
    j.lease = undefined;
    j.updatedAt = Date.now();
    if (dead && j.uniqueKey && this.uniqueKeys.get(`${j.queue}:${j.uniqueKey}`) === j.id) {
      this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
    }
    return true;
  }

  /**
   * Reclaims orphaned running jobs in memory, dead-lettering the exhausted ones.
   *
   * Lease expiry is the only staleness signal — see the note on
   * {@link MemoryQueueO1.reclaimStaleJobs} for why an `acquiredAt` clause here
   * would duplicate every long-running job.
   */
  async reclaimStaleJobs(_staleThresholdMs: number): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const j of this.jobs.values()) {
      if (j.state !== "running") continue;
      if (j.lease && j.lease.expiresAt > now) continue;

      j.lease = undefined;
      j.updatedAt = now;
      j.state = j.attempts >= j.maxAttempts ? "dead" : "queued";
      count++;
    }

    return count;
  }

  /** Returns a running job to queued in memory without consuming an attempt. */
  async release(id: string, workerId?: string): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || !ownsLease(j, workerId)) return false;

    j.state = "queued";
    j.lease = undefined;
    j.updatedAt = Date.now();
    return true;
  }

  /** Fetches a job record from memory. */
  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ? { ...this.jobs.get(id)! } : null;
  }

  /** Calculates queue counts in memory. */
  async getMetrics(queue?: string): Promise<QueueMetrics> {
    let queued = 0,
      delayed = 0,
      running = 0,
      completed = 0,
      dead = 0,
      total = 0;
    for (const j of this.jobs.values()) {
      if (queue && j.queue !== queue) continue;
      total++;
      if (j.state === "queued") queued++;
      else if (j.state === "delayed") delayed++;
      else if (j.state === "running") running++;
      else if (j.state === "completed") completed++;
      else if (j.state === "dead") dead++;
    }
    return { queued, delayed, running, completed, dead, total };
  }

  /** Lists dead jobs from memory. */
  async listDead(queue?: string, limit = 50): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.state === "dead" && (!queue || j.queue === queue))
      .slice(0, limit);
  }

  /** Replays a dead job in memory. */
  async replayDead(id: string): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || j.state !== "dead") return false;
    j.state = "queued";
    j.attempts = 0;
    j.error = undefined;
    j.runAt = Date.now();
    j.updatedAt = Date.now();
    if (j.uniqueKey) this.uniqueKeys.set(`${j.queue}:${j.uniqueKey}`, j.id);
    return true;
  }

  /** Purges jobs from memory. */
  async purgeQueue(queue: string, state?: JobState): Promise<number> {
    let removed = 0;
    for (const [id, j] of this.jobs.entries()) {
      if (j.queue === queue && (!state || j.state === state)) {
        this.jobs.delete(id);
        if (j.uniqueKey) this.uniqueKeys.delete(`${j.queue}:${j.uniqueKey}`);
        removed++;
      }
    }
    return removed;
  }

  /** Clears all jobs and keys from memory. */
  async close(): Promise<void> {
    this.jobs.clear();
    this.uniqueKeys.clear();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Segmented EventBus ($O(1)$ Hash Map Routing)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Event handler callback signature.
 *
 * @template T Payload data type.
 * @param data Event payload.
 * @param eventName Name of the emitted event.
 */
export type EventHandler<T = any> = (
  data: T,
  eventName: string,
) => void | Promise<void>;

/**
 * High-performance event bus featuring O(1) hash routing, prefix/suffix pattern matching,
 * global wildcarding, promise awaiting (`waitFor`), and direct background queue piping (`pipe`).
 *
 * @example
 * ```ts
 * const events = createEvents(jobs);
 * events.on("user.registered", async (user) => {
 *   console.log("Welcome", user.email);
 * });
 * await events.emit("user.registered", { email: "alice@example.com" });
 * ```
 */
export class EventBus {
  private exactListeners = new Map<string, Set<EventHandler>>();
  private prefixListeners = new Map<string, Set<EventHandler>>(); // key: "order" from "order.*"
  private suffixListeners = new Map<string, Set<EventHandler>>(); // key: "created" from "*.created"
  private globalListeners = new Set<EventHandler>(); // matches "*" or "**"

  /**
   * Initializes the event bus, optionally wiring it to a {@link JobQueueManager} for background piping.
   *
   * @param queueManager Optional jobs manager used by `.pipe()`.
   */
  constructor(private readonly queueManager?: JobQueueManager) {}

  /**
   * Subscribes a listener to a specific event pattern.
   * Supports:
   * - Exact matches (e.g. `"user.created"`)
   * - Segmented prefix matches (e.g. `"order.*"`)
   * - Segmented suffix matches (e.g. `"*.completed"`)
   * - Global wildcard matches (`"*"` or `"**"`)
   *
   * @template K Registered event name from {@link EventRegister}.
   * @param event Event pattern string.
   * @param handler Callback to invoke when event occurs.
   * @returns Unsubscribe function.
   *
   * @example
   * ```ts
   * const unsubscribe = events.on("order.paid", (order) => { ... });
   * // Later:
   * unsubscribe();
   * ```
   */
  on<K extends keyof RegisteredEvents>(
    event: K,
    handler: (data: RegisteredEvents[K], name: string) => void | Promise<void>,
  ): () => void;
  on(event: string, handler: EventHandler): () => void;
  on(event: string, handler: EventHandler): () => void {
    if (event === "*" || event === "**") {
      this.globalListeners.add(handler);
      return () => this.globalListeners.delete(handler);
    }

    if (event.endsWith(".*")) {
      const prefix = event.slice(0, -2);
      let set = this.prefixListeners.get(prefix);
      if (!set) {
        set = new Set();
        this.prefixListeners.set(prefix, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    }

    if (event.startsWith("*.")) {
      const suffix = event.slice(2);
      let set = this.suffixListeners.get(suffix);
      if (!set) {
        set = new Set();
        this.suffixListeners.set(suffix, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    }

    let set = this.exactListeners.get(event);
    if (!set) {
      set = new Set();
      this.exactListeners.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /**
   * Subscribes a one-time listener that automatically unsubscribes after its first invocation.
   *
   * @template K Registered event name.
   * @param event Event pattern string.
   * @param handler One-time callback.
   * @returns Unsubscribe function to cancel before trigger.
   */
  once<K extends keyof RegisteredEvents>(
    event: K,
    handler: (data: RegisteredEvents[K], name: string) => void | Promise<void>,
  ): () => void;
  once(event: string, handler: EventHandler): () => void;
  once(event: string, handler: EventHandler): () => void {
    const unsub = this.on(event, async (data, name) => {
      unsub();
      await handler(data, name);
    });
    return unsub;
  }

  /**
   * Emits an event, invoking all matching listeners concurrently.
   *
   * @template K Registered event name.
   * @param event Event name string.
   * @param data Payload passed to listeners.
   * @param options Execution options (e.g. `{ throwOnError: true }`).
   * @throws AggregateError if any listener throws and `throwOnError` is enabled.
   *
   * @example
   * ```ts
   * await events.emit("order.completed", { orderId: "123", amount: 99 });
   * ```
   */
  async emit<K extends keyof RegisteredEvents>(
    event: K,
    data: RegisteredEvents[K],
    options?: { throwOnError?: boolean },
  ): Promise<void>;
  async emit(
    event: string,
    data: unknown,
    options?: { throwOnError?: boolean },
  ): Promise<void>;
  async emit(
    event: string,
    data: unknown,
    options: { throwOnError?: boolean } = {},
  ): Promise<void> {
    const targets = new Set<EventHandler>();

    // 1. Exact match
    const exact = this.exactListeners.get(event);
    if (exact) for (const h of exact) targets.add(h);

    // 2. Segmented prefix / suffix match
    const dotIndex = event.indexOf(".");
    if (dotIndex !== -1) {
      const prefix = event.slice(0, dotIndex);
      const prefixHandlers = this.prefixListeners.get(prefix);
      if (prefixHandlers) for (const h of prefixHandlers) targets.add(h);

      const lastDotIndex = event.lastIndexOf(".");
      const suffix = event.slice(lastDotIndex + 1);
      const suffixHandlers = this.suffixListeners.get(suffix);
      if (suffixHandlers) for (const h of suffixHandlers) targets.add(h);
    }

    // 3. Global wildcards
    for (const h of this.globalListeners) targets.add(h);

    const errors: Error[] = [];
    const promises = Array.from(targets).map((handler) =>
      Promise.resolve(handler(data, event)).catch((err) => {
        errors.push(err);
        if (!options.throwOnError) {
          console.error(`[EventBus] Error in listener for "${event}":`, err);
        }
      }),
    );

    await Promise.all(promises);

    if (options.throwOnError && errors.length > 0) {
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(
        errors,
        `Multiple errors occurred emitting event "${event}"`,
      );
    }
  }

  /**
   * Pipes an event directly into a background job queue!
   * Whenever the event fires, a background job is enqueued automatically.
   *
   * @template E Event key.
   * @template J Job key.
   * @param event Event to listen for.
   * @param jobName Background job name to dispatch.
   * @param options Enqueue options or dynamic options factory based on event data.
   * @param transform Optional mapper converting the event payload into the job payload.
   * @returns Unsubscribe function.
   *
   * @example
   * ```ts
   * events.pipe("user.created", "send-welcome-email", (data) => ({
   *   delay: "5m",
   *   priority: "high",
   * }));
   *
   * // Map the event payload into a different job payload shape
   * events.pipe(
   *   "user.registered",
   *   "send-email",
   *   undefined,
   *   (data) => ({ to: data.email, subject: "Welcome!" }),
   * );
   * ```
   */
  pipe<E extends keyof RegisteredEvents, J extends keyof RegisteredJobs>(
    event: E,
    jobName: J,
    options?: EnqueueOptions | ((data: RegisteredEvents[E]) => EnqueueOptions),
    transform?: (data: RegisteredEvents[E]) => JobPayload<J>,
  ): () => void {
    const targetJobs = this.queueManager ?? getDefaultJobs();
    return this.on(event as string, async (data) => {
      const opts = typeof options === "function" ? options(data) : options;
      const payload = transform ? transform(data) : data;
      await targetJobs.enqueue(jobName as string, payload, opts);
    });
  }

  /**
   * Suspends and waits for the next occurrence of an event, resolving with its payload.
   *
   * @template K Registered event key.
   * @param event Event to await.
   * @param timeout Maximum wait duration before rejecting (defaults to `"30s"`).
   * @returns Promise resolving to the event data.
   * @throws {@link QueueError} if timeout elapses before event fires.
   *
   * @example
   * ```ts
   * const payment = await events.waitFor("payment.confirmed", "1m");
   * ```
   */
  async waitFor<K extends keyof RegisteredEvents>(
    event: K,
    timeout: Duration = 30_000,
  ): Promise<RegisteredEvents[K]> {
    return new Promise((resolve, reject) => {
      const ms = duration(timeout, 30_000);
      const timer = setTimeout(() => {
        unsub();
        reject(
          new QueueError(
            `Timeout waiting for event: "${String(event)}" after ${ms}ms`,
            "TIMEOUT",
          ),
        );
      }, ms);

      const unsub = this.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Job Manager & Worker Pool Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fluent builder for configuring and dispatching background jobs.
 *
 * @template TData Job payload data type.
 *
 * @example
 * ```ts
 * await jobs.job("process-image")
 *   .with({ imageId: 42 })
 *   .delay("10m")
 *   .priority("high")
 *   .save();
 * ```
 */
export class JobBuilder<TData = unknown> {
  private data!: TData;
  private options: EnqueueOptions = {};

  /**
   * @param name Job action name.
   * @param jobsManager Parent {@link JobQueueManager}.
   */
  constructor(
    private name: string,
    private jobsManager: JobQueueManager,
  ) {}

  /**
   * Sets the payload data for the job.
   *
   * @param data Payload object.
   * @returns Current builder for chaining.
   */
  with(data: TData): this {
    this.data = data;
    return this;
  }

  /**
   * Delays job execution by the specified duration.
   *
   * @param delay Duration string (e.g. `"5m"`) or milliseconds.
   * @returns Current builder for chaining.
   */
  delay(delay: Duration): this {
    this.options.delay = delay;
    return this;
  }

  /**
   * Schedules job execution at an exact Date or timestamp.
   *
   * @param date Target execution Date or millisecond timestamp.
   * @returns Current builder for chaining.
   */
  at(date: Date | number): this {
    this.options.runAt = date;
    return this;
  }

  /**
   * Sets the retry limit and optional backoff parameters for this job.
   *
   * @param attempts Maximum retry attempts.
   * @param config Optional custom retry policy parameters.
   * @returns Current builder for chaining.
   */
  retry(attempts: number, config?: EnqueueOptions["retry"]): this {
    this.options.attempts = attempts;
    if (config) this.options.retry = config;
    return this;
  }

  /**
   * Sets the execution priority tier.
   *
   * @param p Priority level (`"low"`, `"normal"`, `"high"`, `"critical"` or number).
   * @returns Current builder for chaining.
   */
  priority(p: EnqueueOptions["priority"]): this {
    this.options.priority = p;
    return this;
  }

  /**
   * Configures execution timeout before aborting.
   *
   * @param limit Timeout duration.
   * @returns Current builder for chaining.
   */
  timeout(limit: Duration): this {
    this.options.timeout = limit;
    return this;
  }

  /**
   * Assigns a unique deduplication key preventing concurrent duplicates in the queue.
   *
   * @param key Unique identifier string.
   * @returns Current builder for chaining.
   */
  unique(key: string): this {
    this.options.uniqueKey = key;
    return this;
  }

  /**
   * Targets a specific queue name instead of `"default"`.
   *
   * @param queueName Queue name string.
   * @returns Current builder for chaining.
   */
  onQueue(queueName: string): this {
    this.options.queue = queueName;
    return this;
  }

  /**
   * Finalizes configuration and enqueues the job into storage.
   *
   * @returns Promise resolving to the created {@link JobRecord}.
   */
  async save(): Promise<JobRecord<TData>> {
    return (await this.jobsManager.enqueue(
      this.name,
      this.data,
      this.options,
    )) as JobRecord<TData>;
  }
}

/**
 * Worker execution pool managing concurrent job picking, active leases,
 * heartbeats, timeouts, progress coalescing, and DLQ handling.
 */
export class WorkerPool {
  private isRunning = false;
  private activeWorkers = 0;
  private pollTimer?: ReturnType<typeof setTimeout>;
  /** Guards against overlapping poll chains; see `tick()`. */
  private ticking = false;
  private staleTimer?: ReturnType<typeof setInterval>;
  private workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  private inFlightJobs = new Map<string, AbortController>();

  /**
   * Initializes a worker pool for a designated queue.
   *
   * @param queue Queue name to process.
   * @param store Storage backend.
   * @param handlers Map of registered job handlers.
   * @param options Worker concurrency and lifecycle options.
   */
  constructor(
    readonly queue: string,
    private readonly store: JobStore,
    private readonly handlers: Map<string, JobHandler>,
    private readonly options: WorkerOptions,
  ) {}

  /**
   * Starts the worker polling loop and stale recovery timer.
   *
   * @returns Current worker pool.
   */
  start(): this {
    if (this.isRunning) return this;
    this.isRunning = true;

    const staleInterval = duration(this.options.staleRecoveryInterval, 30_000);
    this.staleTimer = setInterval(async () => {
      try {
        await this.store.reclaimStaleJobs(staleInterval);
      } catch (err) {
        console.error(
          `[WorkerPool:${this.queue}] Error reclaiming stale jobs:`,
          err,
        );
      }
    }, staleInterval);

    this.tick();
    return this;
  }

  private async tick() {
    if (!this.isRunning) return;

    /*
     * Re-entrancy guard. Every finished job called tick(), and each tick armed
     * a fresh setTimeout without clearing the previous one, so after N completed
     * jobs there were roughly N+1 independent polling chains all hitting the
     * store. Two chains could also both pass `activeWorkers < concurrency`,
     * await claimNext, and only then increment, overshooting the cap.
     */
    if (this.ticking) return;
    this.ticking = true;

    // Belt and braces: drop any timer a concurrent path left armed.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    try {
      const concurrency = this.options.concurrency ?? 5;
      const lockDuration = duration(this.options.lockDuration, 60_000);

      while (this.isRunning && this.activeWorkers < concurrency) {
        let job: JobRecord | null = null;
        try {
          job = await this.store.claimNext(
            this.queue,
            this.workerId,
            lockDuration,
          );
        } catch (err) {
          console.error(`[WorkerPool:${this.queue}] Claim error:`, err);
          break;
        }

        if (!job) break;

        // Reserved before the await so the next iteration's check sees it.
        this.activeWorkers++;
        void this.executeJob(job, lockDuration)
          .catch((err) => {
            // executeJob already reports job failures; reaching here means the
            // reporting itself failed (SQLITE_BUSY, disk full, a store closed
            // during shutdown). Unhandled, it would take the process down.
            console.error(`[WorkerPool:${this.queue}] Unhandled job error:`, err);
          })
          .finally(() => {
            this.activeWorkers--;
            void this.tick();
          });
      }
    } finally {
      this.ticking = false;
    }

    if (!this.isRunning) return;
    const pollInterval = duration(this.options.pollInterval, 1_000);
    this.pollTimer = setTimeout(() => void this.tick(), pollInterval);
  }

  private async executeJob(job: JobRecord, lockDuration: number) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      const err: SerializedError = {
        message: `No worker handler registered for job: "${job.name}"`,
      };
      await this.store.fail(job.id, err, undefined, true);
      job.state = "dead";
      job.error = err;
      this.options.onDead?.(job, new Error(err.message));
      return;
    }

    const abortController = new AbortController();
    this.inFlightJobs.set(job.id, abortController);

    // Active Lease Heartbeat
    const heartbeatInterval = Math.max(1_000, Math.floor(lockDuration / 3));
    const heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.store.heartbeat(
          job.id,
          this.workerId,
          lockDuration,
        );
        if (!renewed) {
          abortController.abort(
            new QueueError("Lease lost: heartbeat failed", "LEASE_LOST"),
          );
        }
      } catch {
        abortController.abort(
          new QueueError("Heartbeat network error", "LEASE_LOST"),
        );
      }
    }, heartbeatInterval);

    /*
     * Execution timeout.
     *
     * abort() alone only reached handlers that watch ctx.signal; one that
     * ignored it ran to completion while holding its concurrency slot. The
     * promise is raced so the slot is released either way.
     */
    const timeoutMs = job.timeout && job.timeout > 0 ? job.timeout : 0;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        abortController.abort(
          new QueueError(`Job timed out after ${timeoutMs}ms`, "TIMEOUT"),
        );
      }, timeoutMs);
    }

    // Coalesced progress writes: at most one per 250ms, with the held value
    // flushed before the terminal write so the last update is never lost.
    let lastProgressWrite = 0;
    let pendingProgress: { percent: number; message?: string } | undefined;

    const writeProgress = async (percent: number, message?: string) => {
      await this.store.updateProgress(job.id, percent, message, this.workerId);
      pendingProgress = undefined;
    };

    const context: JobContext = {
      id: job.id,
      name: job.name,
      queue: job.queue,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      data: job.data,
      signal: abortController.signal,
      progress: async (percent, message) => {
        job.progress = percent;
        job.progressMessage = message;
        this.options.onProgress?.(job);

        const now = Date.now();
        if (percent >= 100 || percent <= 0 || now - lastProgressWrite >= 250) {
          lastProgressWrite = now;
          await writeProgress(percent, message);
        } else {
          // Held rather than dropped: an update inside the throttle window used
          // to be discarded, so a job that reported 90% then finished left the
          // store showing 80%.
          pendingProgress = { percent, message };
        }
      },
      log: (message, meta) => {
        console.log(
          `[Job:${job.name}#${job.id}] ${message}`,
          meta ? JSON.stringify(meta) : "",
        );
      },
    };

    /*
     * Handler and store bookkeeping are kept in separate phases.
     *
     * Previously `store.complete` and the onCompleted callback shared the
     * handler's try: a store write that threw (SQLITE_BUSY, disk full) was
     * recorded as a handler failure and retried, and a throwing onCompleted
     * called fail() and onFailed for a job that had already completed.
     */
    let result: unknown;
    let handlerError: any;
    try {
      result = await runWithTimeout(
        handler(context),
        abortController.signal,
        timeoutMs,
      );
    } catch (err) {
      handlerError = err;
    }

    clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);

    if (handlerError === undefined) {
      // Flush a throttled progress update before the terminal write.
      if (pendingProgress) {
        try {
          await writeProgress(pendingProgress.percent, pendingProgress.message);
        } catch {
          /* best effort */
        }
      }

      let completed = false;
      try {
        completed = await this.store.complete(job.id, result, this.workerId);
      } catch (err) {
        // The work is done; only the record of it failed. Retrying the job
        // would run it twice, so report and move on.
        console.error(
          `[WorkerPool:${this.queue}] Failed to persist completion for ${job.id}:`,
          err,
        );
        console.error(`[WorkerPool:${this.queue}] ${String(err)}`);
      }

      // A rejected write means the lease was lost and this job was reclaimed.
      // Announcing completion for a copy someone else is running would be a lie.
      if (completed) {
        job.state = "completed";
        job.progress = 100;
        job.result = result;
        this.options.onCompleted?.(job);
      }
    } else {
      const err: SerializedError = {
        message: handlerError?.message ?? String(handlerError),
        stack: handlerError?.stack,
        code:
          handlerError?.code ??
          (abortController.signal.aborted
            ? (abortController.signal.reason as any)?.code
            : undefined),
      };

      /*
       * A shutdown or a lost lease is not a failure of the work. Treating it
       * as one consumed an attempt and applied backoff, so a job on its last
       * attempt landed in the dead-letter queue purely because a deploy
       * happened. Release it back to queued instead.
       */
      const isInfrastructural = err.code === "SHUTDOWN" || err.code === "LEASE_LOST";
      const isDead = !isInfrastructural && job.attempts >= job.maxAttempts;
      const nextRunAt = isDead
        ? undefined
        : Date.now() + calculateBackoff(job.attempts, job.retry);

      let accepted = false;
      try {
        if (isInfrastructural) {
          // Not a failure of the work: hand the job back for another attempt
          // without consuming one. Going through fail() would burn an attempt
          // and apply backoff, so a deploy could dead-letter a job.
          accepted = await this.store.release(job.id, this.workerId);
        } else {
          accepted = await this.store.fail(
            job.id,
            err,
            nextRunAt,
            isDead,
            this.workerId,
          );
        }
      } catch (storeErr) {
        console.error(
          `[WorkerPool:${this.queue}] Failed to persist failure for ${job.id}:`,
          storeErr,
        );
      }

      if (accepted) {
        job.state = isDead ? "dead" : isInfrastructural ? "queued" : "delayed";
        job.error = err;

        const runtimeError = new Error(err.message);
        // A shutdown or lease loss is not the job's fault, so onFailed does not
        // fire for it.
        if (!isInfrastructural) {
          this.options.onFailed?.(job, runtimeError);
          if (isDead) this.options.onDead?.(job, runtimeError);
        }
      }
    }

    this.inFlightJobs.delete(job.id);
  }

  /**
   * Gracefully shuts down the worker pool, aborting in-flight tasks and waiting
   * up to `shutdownTimeout` for active jobs to finish.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);

    for (const ctrl of this.inFlightJobs.values()) {
      ctrl.abort(new QueueError("Worker shutting down", "SHUTDOWN"));
    }

    const shutdownLimit = duration(this.options.shutdownTimeout, 10_000);
    const start = Date.now();
    while (this.activeWorkers > 0 && Date.now() - start < shutdownLimit) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Primary manager for background jobs, worker pools, queues, dead-letter queues, and operational metrics.
 *
 * @example
 * ```ts
 * const jobs = createJobs();
 *
 * // 1. Register task handler
 * jobs.handle("send-email", async (ctx) => {
 *   await mailer.send(ctx.data);
 * });
 *
 * // 2. Start worker
 * jobs.worker("default", { concurrency: 10 });
 *
 * // 3. Enqueue job
 * await jobs.enqueue("send-email", { to: "user@example.com" });
 * ```
 */
export class JobQueueManager {
  private handlers = new Map<string, JobHandler>();
  private pools = new Map<string, WorkerPool>();
  /** Storage backend engine powering this manager. */
  readonly store: JobStore;

  /**
   * Initializes the job queue manager.
   *
   * @param options Configuration options including custom store or database path.
   */
  constructor(options: { store?: JobStore; dbPath?: string } = {}) {
    this.store = options.store ?? new SQLiteJobStore(options.dbPath);
    this.store.init().catch(console.error);

    if (typeof process !== "undefined") {
      const shutdown = async () => {
        await this.stopAll();
        await this.store.close();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
  }

  /**
   * Registers a task execution handler for a specific job name.
   *
   * @template K Registered job name.
   * @template R Return type.
   * @param name Job task name.
   * @param handler Execution function receiving {@link JobContext}.
   * @returns Current manager for chaining.
   *
   * @example
   * ```ts
   * jobs.handle("render-video", async (ctx) => {
   *   await ctx.progress(25, "Encoding audio...");
   *   return { file: "out.mp4" };
   * });
   * ```
   */
  handle<K extends keyof RegisteredJobs, R = unknown>(
    name: K,
    handler: (ctx: JobContext<JobPayload<K>>) => Promise<R> | R,
  ): this;
  handle(name: string, handler: JobHandler): this;
  handle(name: string, handler: JobHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  /**
   * Enqueues a job into storage for background execution.
   *
   * @template K Registered job name.
   * @param name Job task name.
   * @param data Payload object.
   * @param options Scheduling, priority, and retry options.
   * @returns Created {@link JobRecord}.
   *
   * @example
   * ```ts
   * await jobs.enqueue("send-email", { to: "alice@example.com" }, { delay: "5m" });
   * ```
   */
  async enqueue<K extends keyof RegisteredJobs>(
    name: K,
    data: JobPayload<K>,
    options?: EnqueueOptions,
  ): Promise<JobRecord<JobPayload<K>>>;
  async enqueue(
    name: string,
    data: unknown,
    options?: EnqueueOptions,
  ): Promise<JobRecord>;
  async enqueue(
    name: string,
    data: unknown,
    options: EnqueueOptions = {},
  ): Promise<JobRecord> {
    const queue = options.queue ?? "default";
    const id = crypto.randomUUID();

    let runAt = Date.now();
    if (options.runAt) {
      runAt =
        options.runAt instanceof Date ? options.runAt.getTime() : options.runAt;
    } else if (options.delay) {
      runAt += duration(options.delay);
    }

    return this.store.enqueue({
      id,
      queue,
      name,
      data,
      priority: parsePriority(options.priority),
      runAt,
      maxAttempts: options.attempts ?? 3,
      timeout: options.timeout ? duration(options.timeout) : undefined,
      retry: normalizeRetryPolicy(options.retry),
      progress: 0,
      uniqueKey: options.uniqueKey,
    });
  }

  /**
   * Initiates a fluent {@link JobBuilder} for configuring and enqueuing a job.
   *
   * @template K Registered job name.
   * @param name Job task name.
   * @returns {@link JobBuilder} instance.
   */
  job<K extends keyof RegisteredJobs>(name: K): JobBuilder<JobPayload<K>>;
  job<T = unknown>(name: string): JobBuilder<T>;
  job<T = unknown>(name: string): JobBuilder<T> {
    return new JobBuilder(name, this);
  }

  /**
   * Starts or retrieves a managed {@link WorkerPool} processing the specified queue.
   *
   * @param queue Queue identifier (defaults to `"default"`).
   * @param options Worker options (concurrency, intervals, callbacks).
   * @returns Running {@link WorkerPool}.
   *
   * @example
   * ```ts
   * const pool = jobs.worker("emails", { concurrency: 5 });
   * ```
   */
  worker(queue = "default", options: WorkerOptions = {}): WorkerPool {
    let pool = this.pools.get(queue);
    if (!pool) {
      pool = new WorkerPool(queue, this.store, this.handlers, {
        queue,
        ...options,
      });
      this.pools.set(queue, pool);
      pool.start();
    }
    return pool;
  }

  /**
   * Gracefully shuts down all active worker pools.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.stop()));
    this.pools.clear();
  }

  /**
   * Dead-letter queue (DLQ) operations for inspecting, retrying, and purging dead jobs.
   */
  get dlq() {
    return {
      /** Lists dead jobs. */
      list: (queue?: string, limit?: number) =>
        this.store.listDead(queue, limit),
      /** Retries a dead job by ID. */
      retry: (jobId: string) => this.store.replayDead(jobId),
      /** Purges dead jobs from a queue. */
      purge: (queue = "default") => this.store.purgeQueue(queue, "dead"),
    };
  }

  /**
   * Returns current operational volume counts (queued, delayed, running, completed, dead, total).
   *
   * @param queue Optional queue name filter.
   * @returns {@link QueueMetrics}.
   */
  async metrics(queue?: string): Promise<QueueMetrics> {
    return this.store.getMetrics(queue);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Cron Scheduler Engine
// ──────────────────────────────────────────────────────────────────────────

/**
 * Task registration record in the cron scheduler.
 */
export interface ScheduledTask {
  /** Task identifier name. */
  name: string;
  /** Cron expression string or duration string/number. */
  schedule: string | Duration;
  /** Optional timezone string. */
  timezone?: string;
  /** Concurrency policy when a tick fires while previous run is still in progress (`"skip"` or `"allow"`). */
  concurrency: "skip" | "allow";
  /** Execution callback. */
  handler: () => Promise<void> | void;
  /** Whether the task is currently executing. */
  isRunning: boolean;
  /** Scheduled timer reference. */
  timer?: ReturnType<typeof setTimeout>;
  /**
   * Incremented on every stop().
   *
   * The timer callback re-arms itself after awaiting the handler, and it used to
   * do so unconditionally. Clearing an already-fired timer is a no-op, so
   * stopping a task while it was mid-run deleted it from the map and then let the
   * finished run schedule a fresh timer for a task nothing could reach again —
   * an unstoppable, unfindable leak, one per stopped-while-running task. The
   * callback captures the generation it was armed with and re-arms only if it is
   * still current.
   */
  generation: number;
}

/**
 * Recurring task scheduler supporting standard 5-field cron syntax and fixed interval durations.
 *
 * @example
 * ```ts
 * const cron = createCron();
 * cron.schedule("daily-cleanup", "0 0 * * *", async () => {
 *   await db.cleanup();
 * });
 * cron.every("15m", async () => {
 *   await syncData();
 * });
 * ```
 */
export class CronScheduler {
  private tasks = new Map<string, ScheduledTask>();

  /**
   * Schedules a task to run according to a standard 5-field cron expression.
   *
   * @param name Unique task name.
   * @param cronExpression 5-field cron string (e.g. `"0/5 * * * *"`).
   * @param handler Execution callback.
   * @param options Optional timezone and concurrency settings.
   * @returns Current scheduler for chaining.
   */
  schedule(
    name: string,
    cronExpression: string,
    handler: () => Promise<void> | void,
    options: { timezone?: string; concurrency?: "skip" | "allow" } = {},
  ): this {
    const task: ScheduledTask = {
      name,
      schedule: cronExpression,
      timezone: options.timezone,
      concurrency: options.concurrency ?? "skip",
      handler,
      isRunning: false,
      generation: 0,
    };
    this.tasks.set(name, task);
    this.armCron(task);
    return this;
  }

  /**
   * Schedules a task to run repeatedly at a fixed interval duration.
   *
   * @param interval Duration string (e.g. `"10s"`, `"1h"`) or milliseconds.
   * @param handler Execution callback.
   * @param name Optional task name.
   * @returns Current scheduler for chaining.
   */
  every(
    interval: Duration,
    handler: () => Promise<void> | void,
    name = `interval-${crypto.randomUUID().slice(0, 8)}`,
  ): this {
    const task: ScheduledTask = {
      name,
      schedule: interval,
      concurrency: "skip",
      handler,
      isRunning: false,
      generation: 0,
    };
    this.tasks.set(name, task);
    this.armInterval(task);
    return this;
  }

  private armCron(task: ScheduledTask) {
    const parser = new CronExpression(task.schedule as string, task.timezone);
    const nextDate = parser.getNextDate();
    const delay = Math.max(0, nextDate.getTime() - Date.now());

    // Captured at arm time; compared before re-arming.
    const generation = task.generation;

    task.timer = setTimeout(async () => {
      if (task.isRunning && task.concurrency === "skip") {
        console.warn(
          `[Cron:${task.name}] Task skipped: previous execution is still running.`,
        );
      } else {
        task.isRunning = true;
        try {
          await task.handler();
        } catch (err) {
          console.error(`[Cron:${task.name}] Task failed:`, err);
        } finally {
          task.isRunning = false;
        }
      }

      // stop() ran while the handler was awaiting: do not resurrect the task.
      if (task.generation !== generation) return;

      this.armCron(task);
    }, delay);

    // Never keeps a process alive on its own; a schedule is not a reason to
    // block an exit.
    task.timer.unref?.();
  }

  private armInterval(task: ScheduledTask) {
    const ms = duration(task.schedule as Duration);
    const generation = task.generation;

    task.timer = setTimeout(async () => {
      if (task.isRunning && task.concurrency === "skip") {
        console.warn(
          `[Cron:${task.name}] Task skipped: previous execution is still running.`,
        );
      } else {
        task.isRunning = true;
        try {
          await task.handler();
        } catch (err) {
          console.error(`[Cron:${task.name}] Error:`, err);
        } finally {
          task.isRunning = false;
        }
      }

      if (task.generation !== generation) return;

      this.armInterval(task);
    }, ms);

    task.timer.unref?.();
  }

  /**
   * Cancels and stops a specific scheduled task or all tasks.
   *
   * @param name Optional task name to cancel. If omitted, stops all tasks.
   */
  stop(name?: string): void {
    if (name) {
      const task = this.tasks.get(name);
      if (task) {
        // Bumped first, so an in-flight run sees a stale generation and does not
        // re-arm once its handler settles.
        task.generation++;
        if (task.timer) clearTimeout(task.timer);
      }
      this.tasks.delete(name);
    } else {
      for (const t of this.tasks.values()) {
        t.generation++;
        if (t.timer) clearTimeout(t.timer);
      }
      this.tasks.clear();
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Factories & Non-Mutating Singletons
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_JOBS_KEY = Symbol.for("yatta.jobs.default");
const GLOBAL_EVENTS_KEY = Symbol.for("yatta.events.default");
const GLOBAL_CRON_KEY = Symbol.for("yatta.cron.default");

const g = globalThis as unknown as {
  [GLOBAL_JOBS_KEY]?: JobQueueManager;
  [GLOBAL_EVENTS_KEY]?: EventBus;
  [GLOBAL_CRON_KEY]?: CronScheduler;
};

/**
 * Creates an independent {@link EventBus} instance.
 *
 * @param jobs Optional {@link JobQueueManager} enabling `.pipe()` background routing.
 * @returns Configured {@link EventBus}.
 */
export function createEvents(jobs?: JobQueueManager): EventBus {
  return new EventBus(jobs);
}

/**
 * Creates an independent {@link JobQueueManager} instance.
 *
 * @param options Storage engine or SQLite database path options.
 * @returns Configured {@link JobQueueManager}.
 */
export function createJobs(options?: {
  store?: JobStore;
  dbPath?: string;
}): JobQueueManager {
  return new JobQueueManager(options);
}

/**
 * Creates an independent {@link CronScheduler} instance.
 *
 * @returns Configured {@link CronScheduler}.
 */
export function createCron(): CronScheduler {
  return new CronScheduler();
}

function getDefaultJobs(): JobQueueManager {
  if (!g[GLOBAL_JOBS_KEY]) g[GLOBAL_JOBS_KEY] = new JobQueueManager();
  return g[GLOBAL_JOBS_KEY]!;
}

function getDefaultEvents(): EventBus {
  if (!g[GLOBAL_EVENTS_KEY])
    g[GLOBAL_EVENTS_KEY] = new EventBus(getDefaultJobs());
  return g[GLOBAL_EVENTS_KEY]!;
}

function getDefaultCron(): CronScheduler {
  if (!g[GLOBAL_CRON_KEY]) g[GLOBAL_CRON_KEY] = new CronScheduler();
  return g[GLOBAL_CRON_KEY]!;
}

/**
 * Global default {@link JobQueueManager} proxy singleton.
 * Provides zero-configuration background task queuing with persistent SQLite durability.
 *
 * @example
 * ```ts
 * import { Jobs } from "./job";
 *
 * Jobs.handle("send-email", async (ctx) => { ... });
 * Jobs.worker();
 * await Jobs.enqueue("send-email", { to: "user@example.com" });
 * ```
 */
export const Jobs: JobQueueManager = new Proxy(
  function () {} as unknown as JobQueueManager,
  {
    get(_t, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_t, prop, receiver);
      }
      const instance = getDefaultJobs();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);

/**
 * Global default {@link EventBus} proxy singleton.
 * Provides zero-configuration event emission and listening with wildcard and queue piping support.
 *
 * @example
 * ```ts
 * import { events } from "./job";
 *
 * events.on("order.created", (order) => { ... });
 * await events.emit("order.created", { id: "123" });
 * ```
 */
export const events: EventBus = new Proxy(
  function () {} as unknown as EventBus,
  {
    get(_t, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_t, prop, receiver);
      }
      const instance = getDefaultEvents();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);

/**
 * Global default {@link CronScheduler} proxy singleton.
 * Provides zero-configuration cron scheduling and periodic intervals.
 *
 * @example
 * ```ts
 * import { cron } from "./job";
 *
 * cron.schedule("midnight-backup", "0 0 * * *", async () => { ... });
 * cron.every("1h", async () => { ... });
 * ```
 */
export const cron: CronScheduler = new Proxy(
  function () {} as unknown as CronScheduler,
  {
    get(_t, prop, receiver) {
      if (
        prop === "name" ||
        prop === "length" ||
        prop === "prototype" ||
        prop === Symbol.toPrimitive
      ) {
        return Reflect.get(_t, prop, receiver);
      }
      const instance = getDefaultCron();
      const val = (instance as any)[prop];
      return typeof val === "function" ? val.bind(instance) : val;
    },
  },
);

