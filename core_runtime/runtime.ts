import {
  HardwareAwareScheduler,
  type FleetHealth,
  type SchedulerOptions,
} from "./scheduler";
import type {
  SubsystemDefinition,
  HardwareTopology,
  WorkerMetrics,
} from "./types";

export interface RuntimeConfig extends SchedulerOptions {
  name?: string;
  workerUrl?: URL | string;
  silent?: boolean;
}

export class FrameworkRuntime {
  private scheduler: HardwareAwareScheduler;
  private isInitialized = false;
  private startPromise: Promise<void> | null = null;
  private workerUrl: URL;
  private silent: boolean;

  constructor(config?: RuntimeConfig) {
    this.scheduler = new HardwareAwareScheduler(config);
    this.silent = config?.silent ?? false;

    if (config?.workerUrl) {
      this.workerUrl =
        config.workerUrl instanceof URL
          ? config.workerUrl
          : new URL(config.workerUrl, import.meta.url);
    } else {
      this.workerUrl = new URL("./worker.ts", import.meta.url);
    }
  }

  /** Idempotent; concurrent callers share one bootstrap. */
  public start(): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    this.startPromise ??= this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (!this.silent) {
      const topology = this.scheduler.getTopology();
      console.log(
        `[Yatta Runtime] Fleet active on ${topology.cpuCores} CPU cores:\n` +
          `  • CPU-Bound Workers : ${topology.cpuWorkers}\n` +
          `  • I/O-Bound Workers : ${topology.ioWorkers} (smol: ${topology.suggestSmol})\n` +
          `  • Total OS Threads  : ${topology.totalWorkers}`,
      );
    }

    await this.scheduler.bootstrap(this.workerUrl);
    this.isInitialized = true;
  }

  public async registerSubsystem(
    subsystem: SubsystemDefinition,
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error("Runtime must be started before registering subsystems.");
    }
    return await this.scheduler.scheduleSubsystem(subsystem);
  }

  public execute<TResult = unknown, TPayload = unknown>(
    graphId: string,
    handler: string,
    payload: TPayload,
  ): Promise<TResult> {
    if (!this.isInitialized) {
      return Promise.reject(new Error("Runtime is not running."));
    }
    return this.scheduler.dispatchTask<TResult>(graphId, handler, payload);
  }

  /** Configured topology (what was asked for). See {@link getHealth} for reality. */
  public getTopology(): HardwareTopology {
    return this.scheduler.getTopology();
  }

  /** Live fleet state: how many workers are actually alive, per role. */
  public getHealth(): FleetHealth {
    return this.scheduler.getHealth();
  }

  public getMetrics(): Promise<WorkerMetrics[]> {
    return this.scheduler.getMetrics();
  }

  /** Tasks currently in flight or queued across the worker fleet. */
  public getActiveTaskCount(): number {
    return this.scheduler.getActiveTaskCount();
  }

  /**
   * Resolves once the fleet has no in-flight or queued tasks, or when
   * `timeoutMs` elapses. Intended for graceful shutdown.
   *
   * @returns `true` if the fleet drained cleanly, `false` on timeout.
   */
  public async drain(timeoutMs = 5_000, pollIntervalMs = 50): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (this.scheduler.getActiveTaskCount() > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return true;
  }

  /**
   * Stops handing new work to the fleet. In-flight tasks are untouched.
   *
   * This is the difference between draining and shutting down. During a drain the
   * fleet is still live, so a cron tick or a job arriving in that window starts,
   * gets counted as in-flight, and is then killed by the teardown that follows. The
   * drain then reports a timeout and the deploy looks like it failed, when the work
   * simply began too late.
   *
   * Pairs with {@link resumeWork}, and is not a permanent stop — a drain that
   * completes cleanly leaves the process exiting, but a drained-then-resumed runtime
   * is the honest interpretation of "pause".
   *
   * @returns `true` if work was actually paused, `false` if it already was.
   */
  public pauseWork(): boolean {
    return this.scheduler.pauseWork();
  }

  /** Resumes handing work to the fleet after a {@link pauseWork}. */
  public resumeWork(): boolean {
    return this.scheduler.resumeWork();
  }

  /** Whether new work is currently being accepted. */
  public get isWorkPaused(): boolean {
    return this.scheduler.isWorkPaused;
  }

  public async shutdown(): Promise<void> {
    // Don't let a half-finished start() resurrect workers after teardown.
    await this.startPromise?.catch(() => {});
    await this.scheduler.terminateAll();
    this.isInitialized = false;
  }
}

export function createRuntime(config?: RuntimeConfig): FrameworkRuntime {
  return new FrameworkRuntime(config);
}
