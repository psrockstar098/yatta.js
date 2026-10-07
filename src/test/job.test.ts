import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createJobs,
  createEvents,
  createCron,
  SQLiteJobStore,
  MemoryJobStore,
  CronExpression,
  QueueError,
  duration,
  parsePriority,
  normalizeRetryPolicy,
  calculateBackoff,
  JobQueueManager,
  EventBus,
  type JobRecord,
  type JobContext,
  type EnqueueOptions,
  type JobState,
} from "../types/job";

// Ad-hoc event names used throughout this test suite.
declare module "../types/job" {
  interface EventRegister {
    [key: string]: any;
    "user.created": { id: string };
    "notify.user": { userId: string; text: string };
    "async.ready": { token: string };
    "never.happens": { never: boolean };
    "single.fire": { n: number };
    "fail.event": Record<string, never>;
  }
}

describe("Yatta Jobs, Scheduler & Events", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should enforce JobRecord contract and state transitions", () => {
      const validStates: JobState[] = ["queued", "delayed", "running", "completed", "dead"];
      expect(validStates).toHaveLength(5);

      const record: JobRecord<{ foo: string }, { result: number }> = {
        id: "job-123",
        queue: "test-queue",
        name: "test-job",
        data: { foo: "bar" },
        state: "queued",
        attempts: 0,
        maxAttempts: 3,
        priority: 10,
        runAt: Date.now(),
        retry: {
          type: "exponential",
          delay: 1000,
          factor: 2,
          jitter: false,
          maxDelay: 60000,
        },
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(record.id).toBe("job-123");
      expect(record.state).toBe("queued");
      expect(record.data.foo).toBe("bar");
    });

    it("should enforce EnqueueOptions structure", () => {
      const options: EnqueueOptions = {
        queue: "emails",
        delay: "5s",
        priority: "high",
        attempts: 5,
        timeout: "30s",
        uniqueKey: "email:user_1:welcome",
        retry: {
          type: "exponential",
          delay: "2s",
          factor: 2,
          jitter: true,
          maxDelay: "1m",
        },
      };

      expect(options.queue).toBe("emails");
      expect(options.priority).toBe("high");
      expect(options.attempts).toBe(5);
    });

    it("should verify JobContext interface methods", async () => {
      let progressReported = 0;
      let progressMsg: string | undefined;

      const mockContext: JobContext<{ orderId: string }> = {
        id: "ctx-1",
        name: "process-order",
        queue: "orders",
        attempts: 1,
        maxAttempts: 3,
        data: { orderId: "ord_999" },
        signal: new AbortController().signal,
        progress: async (percent, message) => {
          progressReported = percent;
          progressMsg = message;
        },
        log: () => {},
      };

      expect(mockContext.id).toBe("ctx-1");
      expect(mockContext.data.orderId).toBe("ord_999");
      await mockContext.progress(50, "halfway done");
      expect(progressReported).toBe(50);
      expect(progressMsg).toBe("halfway done");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should reject invalid cron expressions with missing or extra fields", () => {
      expect(() => new CronExpression("* * * *")).toThrow(QueueError);
      expect(() => new CronExpression("* * * * * *")).toThrow(QueueError);
      expect(() => new CronExpression("")).toThrow(QueueError);
      expect(() => new CronExpression("invalid")).toThrow(QueueError);
    });

    it("should reject out-of-bounds numbers in cron fields", () => {
      // Minute > 59
      expect(() => new CronExpression("60 * * * *")).toThrow(/bounds/);
      // Hour > 23
      expect(() => new CronExpression("* 24 * * *")).toThrow(/bounds/);
      // Day of month 0 or 32
      expect(() => new CronExpression("* * 0 * *")).toThrow(/bounds/);
      expect(() => new CronExpression("* * 32 * *")).toThrow(/bounds/);
      // Month 0 or 13
      expect(() => new CronExpression("* * * 0 *")).toThrow(/bounds/);
      expect(() => new CronExpression("* * * 13 *")).toThrow(/bounds/);
      // Day of week 7
      expect(() => new CronExpression("* * * * 7")).toThrow(/bounds/);
    });

    it("should reject invalid cron ranges and non-positive steps", () => {
      // Inverted range
      expect(() => new CronExpression("50-10 * * * *")).toThrow(/Invalid range/);
      // Range out of bounds
      expect(() => new CronExpression("10-70 * * * *")).toThrow(/Invalid range/);
      // Zero or negative step
      expect(() => new CronExpression("*/0 * * * *")).toThrow(/Invalid step/);
      expect(() => new CronExpression("*/-5 * * * *")).toThrow(/Invalid step/);
      expect(() => new CronExpression("*/abc * * * *")).toThrow(/Invalid step/);
    });

    it("should reject malformed duration strings", () => {
      expect(() => duration("invalid" as any)).toThrow(QueueError);
      expect(() => duration("100x" as any)).toThrow(QueueError);
      expect(() => duration("-10s" as any)).toThrow(QueueError);
    });

    it("should safely mark jobs with no registered handler as dead immediately", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      const deadPromise = new Promise<JobRecord>((resolve) => {
        jobs.worker("unhandled-queue", {
          pollInterval: 10,
          onDead: (j) => resolve(j),
        });
      });

      await jobs.enqueue("unhandled-job", { test: 123 }, { queue: "unhandled-queue" });

      const deadJob = await deadPromise;
      expect(deadJob.state).toBe("dead");
      expect(deadJob.name).toBe("unhandled-job");
      expect(deadJob.error?.message).toContain("No worker handler registered");

      await jobs.stopAll();
      await store.close();
    });

    it("should terminate jobs that exceed configured execution timeout", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      let abortedWithTimeout = false;

      jobs.handle("timeout-task", async (ctx) => {
        return new Promise((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            abortedWithTimeout = true;
            reject(ctx.signal.reason);
          });
          // Intentionally stall longer than timeout
          setTimeout(resolve, 500);
        });
      });

      const failedPromise = new Promise<JobRecord>((resolve) => {
        jobs.worker("timeout-queue", {
          pollInterval: 10,
          onFailed: (j) => resolve(j),
        });
      });

      await jobs.enqueue(
        "timeout-task",
        {},
        {
          queue: "timeout-queue",
          timeout: "50ms",
          attempts: 1,
        },
      );

      const failedJob = await failedPromise;
      expect(failedJob.error?.message).toContain("timed out after 50ms");
      expect(abortedWithTimeout).toBe(true);

      await jobs.stopAll();
      await store.close();
    });

    it("should route jobs exceeding maxAttempts strictly to dead letter state (DLQ)", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      let attemptsCount = 0;
      jobs.handle("failing-task", async () => {
        attemptsCount++;
        throw new Error("Intentional catastrophe");
      });

      const deadPromise = new Promise<JobRecord>((resolve) => {
        jobs.worker("retry-queue", {
          pollInterval: 10,
          onDead: (j) => resolve(j),
        });
      });

      await jobs.enqueue(
        "failing-task",
        {},
        {
          queue: "retry-queue",
          attempts: 2,
          retry: { type: "fixed", delay: 10, jitter: false },
        },
      );

      const deadJob = await deadPromise;
      expect(deadJob.state).toBe("dead");
      expect(deadJob.attempts).toBe(2);
      expect(attemptsCount).toBe(2);

      const deadList = await jobs.dlq.list("retry-queue");
      expect(deadList.length).toBe(1);
      expect(deadList[0]!.id).toBe(deadJob.id);

      await jobs.stopAll();
      await store.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should correctly convert duration strings to milliseconds", () => {
      expect(duration("500ms")).toBe(500);
      expect(duration("5s")).toBe(5_000);
      expect(duration("2m")).toBe(120_000);
      expect(duration("1h")).toBe(3_600_000);
      expect(duration("1d")).toBe(86_400_000);
      expect(duration("1w")).toBe(604_800_000);
      expect(duration(2500)).toBe(2500);
      expect(duration(undefined, 42)).toBe(42);
    });

    it("should parse string and numeric priorities accurately", () => {
      expect(parsePriority("critical")).toBe(100);
      expect(parsePriority("high")).toBe(50);
      expect(parsePriority("normal")).toBe(10);
      expect(parsePriority("low")).toBe(0);
      expect(parsePriority(75)).toBe(75);
      expect(parsePriority(undefined)).toBe(10);
    });

    it("should normalize retry policy and default appropriately", () => {
      const policy = normalizeRetryPolicy();
      expect(policy.type).toBe("exponential");
      expect(policy.delay).toBe(1_000);
      expect(policy.factor).toBe(2);
      expect(policy.jitter).toBe(true);
      expect(policy.maxDelay).toBe(3_600_000);

      const custom = normalizeRetryPolicy({
        type: "fixed",
        delay: "500ms",
        factor: 3,
        jitter: false,
        maxDelay: "10s",
      });
      expect(custom.type).toBe("fixed");
      expect(custom.delay).toBe(500);
      expect(custom.factor).toBe(3);
      expect(custom.jitter).toBe(false);
      expect(custom.maxDelay).toBe(10_000);
    });

    it("should calculate backoff delays accurately for exponential and fixed policies", () => {
      const fixedPolicy = normalizeRetryPolicy({
        type: "fixed",
        delay: "100ms",
        jitter: false,
      });
      expect(calculateBackoff(1, fixedPolicy)).toBe(100);
      expect(calculateBackoff(3, fixedPolicy)).toBe(100);

      const expPolicy = normalizeRetryPolicy({
        type: "exponential",
        delay: "100ms",
        factor: 2,
        jitter: false,
        maxDelay: "1000ms",
      });
      // attempt 1: 100 * 2^0 = 100
      expect(calculateBackoff(1, expPolicy)).toBe(100);
      // attempt 2: 100 * 2^1 = 200
      expect(calculateBackoff(2, expPolicy)).toBe(200);
      // attempt 3: 100 * 2^2 = 400
      expect(calculateBackoff(3, expPolicy)).toBe(400);
      // attempt 5: 100 * 2^4 = 1600 -> capped at maxDelay 1000
      expect(calculateBackoff(5, expPolicy)).toBe(1000);

      // Jitter bounds: 0.5x to 1.5x
      const jitterPolicy = normalizeRetryPolicy({
        type: "fixed",
        delay: "1000ms",
        jitter: true,
      });
      for (let i = 0; i < 20; i++) {
        const val = calculateBackoff(1, jitterPolicy);
        expect(val).toBeGreaterThanOrEqual(500);
        expect(val).toBeLessThanOrEqual(1500);
      }
    });

    it("should calculate next cron date for standard expressions", () => {
      const cron = new CronExpression("0 12 * * *"); // Everyday at 12:00
      const baseDate = new Date("2026-06-01T10:00:00Z");
      const nextDate = cron.getNextDate(baseDate);

      expect(nextDate.getUTCHours()).toBe(12);
      expect(nextDate.getUTCMinutes()).toBe(0);
      expect(nextDate.getTime()).toBeGreaterThan(baseDate.getTime());
    });

    it("should support step and range values in cron expressions", () => {
      const cron = new CronExpression("*/15 9-17 * * 1-5"); // Every 15 min during business hours mon-fri
      const baseDate = new Date("2026-06-01T08:50:00Z"); // Mon 8:50
      const nextDate = cron.getNextDate(baseDate);

      expect(nextDate.getUTCHours()).toBe(9);
      expect(nextDate.getUTCMinutes()).toBe(0);
    });

    it("should respect Vixie Cron DOM/DOW OR-semantics", () => {
      // 1st of month OR on Mondays
      const cron = new CronExpression("0 0 1 * 1");
      const baseDate = new Date("2026-06-01T01:00:00Z");
      const nextDate = cron.getNextDate(baseDate);

      // Next execution should either be the 1st of next month or the next Monday
      const isFirst = nextDate.getUTCDate() === 1;
      const isMonday = nextDate.getUTCDay() === 1;
      expect(isFirst || isMonday).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should run full job lifecycle: queued -> running -> completed", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      let executedData: any = null;
      jobs.handle("calc-sum", async (ctx) => {
        await ctx.progress(50, "computing");
        executedData = ctx.data;
        return { sum: ctx.data.a + ctx.data.b };
      });

      const completedPromise = new Promise<JobRecord>((resolve) => {
        jobs.worker("math-queue", {
          pollInterval: 10,
          onCompleted: (j) => resolve(j),
        });
      });

      const enqueued = await jobs.enqueue(
        "calc-sum",
        { a: 10, b: 20 },
        { queue: "math-queue" },
      );
      expect(enqueued.state).toBe("queued");

      const completed = await completedPromise;
      expect(completed.id).toBe(enqueued.id);
      expect(completed.state).toBe("completed");
      expect(completed.result).toEqual({ sum: 30 });
      expect(completed.progress).toBe(100);
      expect(executedData).toEqual({ a: 10, b: 20 });

      // Verify persistent record in SQLite
      const fetched = await store.getJob(enqueued.id);
      expect(fetched?.state).toBe("completed");
      expect(fetched?.result).toEqual({ sum: 30 });

      await jobs.stopAll();
      await store.close();
    });

    it("should handle delayed jobs and postpone execution until runAt timestamp", async () => {
      const store = new MemoryJobStore();
      const jobs = createJobs({ store });

      let executed = false;
      jobs.handle("delayed-task", async () => {
        executed = true;
      });

      const delayMs = 100;
      const enqueued = await jobs.enqueue(
        "delayed-task",
        {},
        { delay: `${delayMs}ms` },
      );
      expect(enqueued.state).toBe("delayed");
      expect(enqueued.runAt).toBeGreaterThan(Date.now() + 50);

      // Attempt immediate claim before runAt
      const earlyClaim = await store.claimNext("default", "w1", 10_000);
      expect(earlyClaim).toBeNull();
      expect(executed).toBe(false);

      // Wait until runAt has passed
      await new Promise((r) => setTimeout(r, delayMs + 20));

      const readyClaim = await store.claimNext("default", "w1", 10_000);
      expect(readyClaim).not.toBeNull();
      expect(readyClaim?.id).toBe(enqueued.id);

      await jobs.stopAll();
      await store.close();
    });

    it("should prevent duplicate enqueues with uniqueKey while job is active", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      const uniqueKey = "sync:tenant_42";

      const job1 = await jobs.enqueue(
        "sync-tenant",
        { step: 1 },
        { uniqueKey, queue: "sync-queue" },
      );
      const job2 = await jobs.enqueue(
        "sync-tenant",
        { step: 2 },
        { uniqueKey, queue: "sync-queue" },
      );

      // Should return the exact same job record, preventing duplication
      expect(job1.id).toBe(job2.id);
      expect(job2.data).toEqual({ step: 1 });

      const metrics = await store.getMetrics("sync-queue");
      expect(metrics.total).toBe(1);

      await jobs.stopAll();
      await store.close();
    });

    it("should renew worker lease via heartbeat", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();

      const enqueued = await store.enqueue({
        id: "lease-job",
        queue: "test",
        name: "test",
        data: {},
        priority: 10,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      const claimed = await store.claimNext("test", "worker-1", 10_000);
      expect(claimed?.lease?.workerId).toBe("worker-1");
      const initialExpiry = claimed?.lease?.expiresAt!;

      await new Promise((r) => setTimeout(r, 20));
      const heartbeatSuccess = await store.heartbeat("lease-job", "worker-1", 15_000);
      expect(heartbeatSuccess).toBe(true);

      const refreshed = await store.getJob("lease-job");
      expect(refreshed?.lease?.expiresAt).toBeGreaterThan(initialExpiry);

      // Wrong worker should fail heartbeat
      const badHeartbeat = await store.heartbeat("lease-job", "worker-intruder", 15_000);
      expect(badHeartbeat).toBe(false);

      await store.close();
    });

    it("should reclaim stale jobs whose worker lease has expired", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();

      await store.enqueue({
        id: "stale-job",
        queue: "stale-queue",
        name: "stale-job",
        data: {},
        priority: 10,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      // Claim with 10ms lease
      const claimed = await store.claimNext("stale-queue", "dead-worker", 10);
      expect(claimed?.state).toBe("running");

      // Wait for lease expiration
      await new Promise((r) => setTimeout(r, 25));

      const reclaimedCount = await store.reclaimStaleJobs(10);
      expect(reclaimedCount).toBe(1);

      const jobAfter = await store.getJob("stale-job");
      expect(jobAfter?.state).toBe("queued");
      expect(jobAfter?.lease).toBeUndefined();

      await store.close();
    });

    it("should replay dead jobs from DLQ and reset attempts", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      const deadJob = await store.enqueue({
        id: "dead-1",
        queue: "failed-queue",
        name: "fail-job",
        data: { important: true },
        priority: 10,
        runAt: Date.now(),
        maxAttempts: 1,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      await store.fail(
        deadJob.id,
        { message: "Fatal database error" },
        undefined,
        true, // dead
      );

      const deadList = await jobs.dlq.list("failed-queue");
      expect(deadList.length).toBe(1);
      expect(deadList[0]!.state).toBe("dead");

      // Replay
      const replayed = await jobs.dlq.retry(deadJob.id);
      expect(replayed).toBe(true);

      const replayedJob = await store.getJob(deadJob.id);
      expect(replayedJob?.state).toBe("queued");
      expect(replayedJob?.attempts).toBe(0);
      expect(replayedJob?.error).toBeUndefined();

      await jobs.stopAll();
      await store.close();
    });

    it("should provide fluent JobBuilder API", async () => {
      const store = new MemoryJobStore();
      const jobs = createJobs({ store });

      const record = await jobs
        .job<{ task: string }>("fluent-task")
        .with({ task: "do something" })
        .priority("critical")
        .retry(5)
        .unique("uniq-task-1")
        .onQueue("fluent-queue")
        .save();

      expect(record.queue).toBe("fluent-queue");
      expect(record.priority).toBe(100);
      expect(record.maxAttempts).toBe(5);
      expect(record.uniqueKey).toBe("uniq-task-1");
      expect(record.data.task).toBe("do something");

      await jobs.stopAll();
      await store.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (EventBus & Realtime Pipelines)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests", () => {
    it("should route exact, prefix, suffix, and global wildcard events", async () => {
      const bus = createEvents();
      const received: string[] = [];

      bus.on("user.created", () => {
        received.push("exact");
      });
      bus.on("user.*", () => {
        received.push("prefix");
      });
      bus.on("*.created", () => {
        received.push("suffix");
      });
      bus.on("*", () => {
        received.push("global");
      });

      await bus.emit("user.created", { id: "u1" });

      expect(received).toContain("exact");
      expect(received).toContain("prefix");
      expect(received).toContain("suffix");
      expect(received).toContain("global");
      expect(received.length).toBe(4);
    });

    it("should trigger once listener only once and automatically unsubscribe", async () => {
      const bus = createEvents();
      let callCount = 0;

      bus.once("single.fire", () => {
        callCount++;
      });

      await bus.emit("single.fire", {});
      await bus.emit("single.fire", {});
      await bus.emit("single.fire", {});

      expect(callCount).toBe(1);
    });

    it("should pipe events directly to a JobQueueManager queue", async () => {
      const store = new MemoryJobStore();
      const jobs = createJobs({ store });
      const bus = createEvents(jobs);

      let processedJobData: any = null;
      jobs.handle("send-notification", async (ctx) => {
        processedJobData = ctx.data;
      });

      const completedPromise = new Promise<void>((resolve) => {
        jobs.worker("notifications", {
          pollInterval: 10,
          onCompleted: () => resolve(),
        });
      });

      // Pipe event "notify.user" to job "send-notification" on queue "notifications"
      bus.pipe("notify.user", "send-notification" as any, { queue: "notifications" });

      await bus.emit("notify.user", { userId: "user_777", text: "Welcome!" });
      await completedPromise;

      expect(processedJobData).toEqual({
        userId: "user_777",
        text: "Welcome!",
      });

      await jobs.stopAll();
      await store.close();
    });

    it("should support waitFor promise resolution on emitted event", async () => {
      const bus = createEvents();

      setTimeout(() => {
        bus.emit("async.ready", { token: "secret-abc" });
      }, 20);

      const result = await bus.waitFor("async.ready", "500ms");
      expect(result).toEqual({ token: "secret-abc" });
    });

    it("should timeout waitFor promise if event is not emitted", async () => {
      const bus = createEvents();
      await expect(bus.waitFor("never.happens", "20ms")).rejects.toThrow(QueueError);
    });

    it("should collect errors and throw AggregateError when throwOnError is enabled", async () => {
      const bus = createEvents();

      bus.on("fail.event", () => {
        throw new Error("Handler error 1");
      });
      bus.on("fail.event", () => {
        throw new Error("Handler error 2");
      });

      await expect(
        bus.emit("fail.event", {}, { throwOnError: true }),
      ).rejects.toThrow();
    });

    it("should stream progress updates through worker callback and store", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      const progressSteps: number[] = [];

      jobs.handle("long-calculation", async (ctx) => {
        await ctx.progress(25, "Step 1");
        await ctx.progress(50, "Step 2");
        await ctx.progress(100, "Done");
        return { status: "ok" };
      });

      const completedPromise = new Promise<void>((resolve) => {
        jobs.worker("progress-queue", {
          pollInterval: 10,
          onProgress: (j) => progressSteps.push(j.progress),
          onCompleted: () => resolve(),
        });
      });

      await jobs.enqueue("long-calculation", {}, { queue: "progress-queue" });
      await completedPromise;

      expect(progressSteps).toContain(25);
      expect(progressSteps).toContain(50);
      expect(progressSteps).toContain(100);

      await jobs.stopAll();
      await store.close();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should handle high-throughput parallel enqueuing in SQLiteJobStore", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();
      const jobs = createJobs({ store });

      const batchSize = 100;
      const start = performance.now();

      await Promise.all(
        Array.from({ length: batchSize }, (_, i) =>
          jobs.enqueue("batch-job", { index: i }, { queue: "perf-queue" }),
        ),
      );

      const elapsed = performance.now() - start;
      const metrics = await store.getMetrics("perf-queue");

      expect(metrics.queued).toBe(batchSize);
      expect(metrics.total).toBe(batchSize);
      void elapsed;
      /*
       * No timing assertion here.
       *
       * This was `expect(elapsed).toBeLessThan(<n>ms)`, and it was a flake: the same
       * commit passed on a developer machine and failed on a shared runner, with the
       * failure naming a performance regression that was really four jobs competing
       * for two cores. The behaviour that matters is asserted immediately above — the
       * right number of items came back, with the right contents. A timing bound on a
       * correctness test measures the runner, not the code.
       *
       * If the speed of this ever needs a floor, it belongs in `bench_jobs.ts` or
       * `src/test/benchmark.ts`, where a number is the point rather than an accident.
       */

      await jobs.stopAll();
      await store.close();
    });

    it("should process jobs concurrently matching configured concurrency limit", async () => {
      const store = new MemoryJobStore();
      const jobs = createJobs({ store });

      let currentConcurrency = 0;
      let maxObservedConcurrency = 0;
      const jobCount = 10;
      const concurrencyLimit = 4;

      jobs.handle("concurrency-task", async () => {
        currentConcurrency++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentConcurrency);
        await new Promise((r) => setTimeout(r, 25));
        currentConcurrency--;
      });

      let completedCount = 0;
      const allDone = new Promise<void>((resolve) => {
        jobs.worker("concurrent-queue", {
          concurrency: concurrencyLimit,
          pollInterval: 10,
          onCompleted: () => {
            completedCount++;
            if (completedCount === jobCount) resolve();
          },
        });
      });

      for (let i = 0; i < jobCount; i++) {
        await jobs.enqueue("concurrency-task", { i }, { queue: "concurrent-queue" });
      }

      await allDone;
      expect(completedCount).toBe(jobCount);
      expect(maxObservedConcurrency).toBeGreaterThan(1);
      expect(maxObservedConcurrency).toBeLessThanOrEqual(concurrencyLimit);

      await jobs.stopAll();
      await store.close();
    });

    it("should process jobs strictly adhering to priority order", async () => {
      const store = new MemoryJobStore();

      // Enqueue in reverse priority order
      await store.enqueue({
        id: "job-low",
        queue: "priority-q",
        name: "test",
        data: {},
        priority: 0,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      await store.enqueue({
        id: "job-critical",
        queue: "priority-q",
        name: "test",
        data: {},
        priority: 100,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      await store.enqueue({
        id: "job-normal",
        queue: "priority-q",
        name: "test",
        data: {},
        priority: 10,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      // Claim should return critical first, then normal, then low
      const claim1 = await store.claimNext("priority-q", "w1", 10_000);
      const claim2 = await store.claimNext("priority-q", "w1", 10_000);
      const claim3 = await store.claimNext("priority-q", "w1", 10_000);

      expect(claim1?.id).toBe("job-critical");
      expect(claim2?.id).toBe("job-normal");
      expect(claim3?.id).toBe("job-low");

      await store.close();
    });

    it("should purge queue efficiently by state", async () => {
      const store = new SQLiteJobStore(":memory:");
      await store.init();

      await store.enqueue({
        id: "q-1",
        queue: "purge-test",
        name: "task",
        data: {},
        priority: 10,
        runAt: Date.now(),
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      await store.enqueue({
        id: "q-2",
        queue: "purge-test",
        name: "task",
        data: {},
        priority: 10,
        runAt: Date.now() + 100_000,
        maxAttempts: 3,
        retry: normalizeRetryPolicy(),
        progress: 0,
      });

      let metrics = await store.getMetrics("purge-test");
      expect(metrics.total).toBe(2);

      const deletedQueued = await store.purgeQueue("purge-test", "queued");
      expect(deletedQueued).toBe(1);

      metrics = await store.getMetrics("purge-test");
      expect(metrics.total).toBe(1);
      expect(metrics.delayed).toBe(1);

      const deletedAll = await store.purgeQueue("purge-test");
      expect(deletedAll).toBe(1);

      metrics = await store.getMetrics("purge-test");
      expect(metrics.total).toBe(0);

      await store.close();
    });
  });
});

describe("CronScheduler — stopping a task that is running", () => {
  it("does not let the in-flight run re-arm the timer", async () => {
    const scheduler = createCron();

    let runs = 0;
    let release!: () => void;

    // The handler blocks until the test releases it, so stop() is guaranteed to
    // land while the task is mid-run.
    scheduler.every(
      "20ms",
      async () => {
        runs++;
        await new Promise<void>((r) => {
          release = r;
        });
      },
      "leaky",
    );

    // Let the first tick fire and enter the handler.
    await Bun.sleep(60);
    expect(runs).toBe(1);

    scheduler.stop("leaky");
    release();

    // The handler settles after the stop. Previously the unconditional re-arm at
    // the end of the callback then created a new timer for a task no longer in
    // the map, so it kept firing forever with no way to stop it.
    await Bun.sleep(150);

    const runsAtStop = runs;
    await Bun.sleep(150);

    expect(runs).toBe(runsAtStop);
  });

  it("leaves a task that was not stopped running", async () => {
    const scheduler = createCron();

    let runs = 0;
    scheduler.every("20ms", () => {
      runs++;
    }, "kept");

    await Bun.sleep(120);
    const before = runs;

    expect(before).toBeGreaterThan(1);
    scheduler.stop();

    await Bun.sleep(120);
    expect(runs).toBe(before);
  });
});
