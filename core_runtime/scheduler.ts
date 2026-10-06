// core_runtime/scheduler.ts
import type {
  HardwareTopology,
  IPCRequest,
  IPCResponse,
  SubsystemDefinition,
  WorkerMetrics,
  WorkerRole,
} from "./types";

const CONTROL_TIMEOUT_MS = 15_000;
const MAX_RESPAWN_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const unref = (t: unknown) =>
  (t as { unref?: () => void } | undefined)?.unref?.();

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: any) => void;
  /** Deadline timer, cleared once the response lands or the worker dies. */
  timer?: ReturnType<typeof setTimeout>;
  /**
   * Whether this request occupies an execution slot.
   * False for control-plane traffic (INIT, MOUNT_GRAPH, ...) which is tracked
   * in `pendingRequests` but must not be counted in `activeTasks`.
   */
  countsAsActive?: boolean;
}

interface QueuedTask {
  id: number;
  graphId: string;
  handler: string;
  payload: unknown;
  resolve: (val: any) => void;
  reject: (err: any) => void;
  /** Deadline armed at dispatch time; also covers time spent waiting in queue. */
  timer?: ReturnType<typeof setTimeout>;
}

/** Thrown into every in-flight request when its hosting worker dies. */
export class WorkerCrashError extends Error {
  public readonly workerId: string;
  public readonly role: WorkerRole;

  constructor(workerId: string, role: WorkerRole, reason: string) {
    super(`Worker ${workerId} (${role}) crashed: ${reason}`);
    this.name = "WorkerCrashError";
    this.workerId = workerId;
    this.role = role;
  }
}

/**
 * Thrown when work is dispatched while the fleet is paused for shutdown.
 *
 * Distinct from a generic failure so a caller can distinguish "the process is
 * going away, retrying is pointless" from "something is wrong" — a retried job
 * during a deploy is a job that starts after the teardown.
 */
export class WorkPausedError extends Error {
  public readonly isWorkPaused = true;

  constructor(public readonly graphId: string) {
    super(
      `Not accepting work: the runtime is draining for shutdown (graph "${graphId}").`,
    );
    this.name = "WorkPausedError";
  }
}

/** Thrown when a dispatched task exceeds its subsystem execution deadline. */
export class TaskTimeoutError extends Error {
  public readonly graphId: string;
  public readonly handler: string;
  public readonly timeoutMs: number;

  constructor(graphId: string, handler: string, timeoutMs: number) {
    super(
      `Task '${handler}' in graph '${graphId}' exceeded its ${timeoutMs}ms execution deadline`,
    );
    this.name = "TaskTimeoutError";
    this.graphId = graphId;
    this.handler = handler;
    this.timeoutMs = timeoutMs;
  }
}

class FastQueue<T extends { id: number }> {
  private items: (T | undefined)[] = [];
  private head = 0;

  public push(item: T): void {
    this.items.push(item);
  }

  public shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined;
    this.head++;

    if (this.head > 512 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  public shiftBatch(maxCount: number): T[] {
    const batch: T[] = [];
    while (batch.length < maxCount && this.length > 0) {
      const item = this.shift();
      if (item !== undefined) batch.push(item);
    }
    return batch;
  }

  public get length(): number {
    return this.items.length - this.head;
  }

  /** Removes a still-queued task by id, preserving order of the remainder. */
  public removeQueued(id: number): boolean {
    for (let i = this.head; i < this.items.length; i++) {
      if (this.items[i]?.id === id) {
        this.items.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

/** Mount instructions captured per graph so a replacement worker can be re-seeded. */
interface GraphMount {
  entrypoint: string;
  env?: Record<string, string>;
}

/** Spawn parameters needed to (re)create an identical worker. */
interface WorkerSpawnSpec {
  scriptUrl: URL;
  smol: boolean;
  maxConcurrency: number;
}

export interface ManagedWorker {
  id: string;
  role: WorkerRole;
  worker: Worker;
  pendingRequests: Map<number, PendingRequest>;
  activeTasks: number;
  maxConcurrency: number;
  assignedGraphs: Set<string>;
  metrics: WorkerMetrics;
  queue: FastQueue<QueuedTask>;
  /** Spawn parameters, retained so a replacement is configured identically. */
  spec: WorkerSpawnSpec;
  /** Guards against double-handling when both `error` and `close` fire. */
  crashed: boolean;
  /** True once placed in the fleet; unplaced workers are never auto-respawned. */
  registered: boolean;
  /** Scheduler generation this worker belongs to (see `terminateAll`). */
  epoch: number;
}

export interface SchedulerOptions {
  cpuWorkers?: number;
  ioWorkers?: number;
  /**
   * Default per-task execution deadline in milliseconds.
   * Individual subsystems may override via `SubsystemDefinition.timeoutMs`.
   * Set to 0 to disable deadlines entirely.
   */
  taskTimeoutMs?: number;
}

export interface FleetHealth {
  ready: boolean;
  expected: number;
  healthy: number;
  byRole: Record<string, { expected: number; healthy: number }>;
}

function nonNegInt(name: string, v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
  }
  return v;
}

export class HardwareAwareScheduler {
  private workers: ManagedWorker[] = [];
  private graphWorkers = new Map<string, ManagedWorker[]>();
  /** Source of truth for what each role must host; drives crash recovery. */
  private graphSpecs = new Map<
    string,
    { role: WorkerRole; mount: GraphMount }
  >();
  private topology: HardwareTopology;
  private reqCounter = 0;

  /** Per-graph execution deadline in ms; 0 disables the deadline. */
  private graphTimeouts = new Map<string, number>();
  private defaultTaskTimeoutMs: number;
  /** Bumped by `terminateAll`; stale workers/respawn loops see a mismatch and stand down. */
    private epoch = 0;

  /** Round-robin cursor per graph for fast dispatch. */
  private roundRobinCursor = new Map<string, number>();

  constructor(options?: SchedulerOptions) {
    this.topology = this.computeTopology(options);
    this.defaultTaskTimeoutMs = options?.taskTimeoutMs ?? 30_000;
  }

  public computeTopology(options?: SchedulerOptions): HardwareTopology {
    const cores = navigator.hardwareConcurrency || 2;
    const cpuWorkers =
      nonNegInt("cpuWorkers", options?.cpuWorkers) ??
      (cores <= 2 ? 1 : Math.max(1, Math.floor(cores * 0.35)));
    const ioWorkers =
      nonNegInt("ioWorkers", options?.ioWorkers) ??
      (cores <= 2 ? 2 : Math.min(16, Math.floor(cores * 0.8)));

    return {
      cpuCores: cores,
      cpuWorkers,
      ioWorkers,
      totalWorkers: cpuWorkers + ioWorkers,
      suggestSmol: cores <= 2,
    };
  }

  public async bootstrap(workerScriptUrl: URL): Promise<void> {
    if (this.workers.length > 0) {
      throw new Error("Scheduler is already bootstrapped.");
    }

    const specs: Array<[string, WorkerRole, WorkerSpawnSpec]> = [];
    // CPU-bound pool: strict concurrency = 1
    for (let i = 0; i < this.topology.cpuWorkers; i++) {
      specs.push([
        `cpu-worker-${i}`,
        "cpu-pool",
        { scriptUrl: workerScriptUrl, smol: false, maxConcurrency: 1 },
      ]);
    }
    // I/O-bound pool: high concurrency
    for (let i = 0; i < this.topology.ioWorkers; i++) {
      specs.push([
        `io-worker-${i}`,
        "io-pool",
        {
          scriptUrl: workerScriptUrl,
          smol: this.topology.suggestSmol,
          maxConcurrency: 500,
        },
      ]);
    }

    const results = await Promise.allSettled(
      specs.map(([id, role, spec]) => this.spawnWorker(id, role, spec)),
    );

    const failed = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (failed) {
      // Don't leak the threads that did come up.
      for (const r of results) {
        if (r.status === "fulfilled") {
          r.value.crashed = true;
          r.value.worker.terminate();
        }
      }
      throw failed.reason;
    }

    for (const r of results) {
      this.placeWorker((r as PromiseFulfilledResult<ManagedWorker>).value);
    }
  }

  /** Adds a worker to the fleet (optionally replacing a dead one). */
  private placeWorker(w: ManagedWorker, replaces?: ManagedWorker): void {
    const idx = replaces ? this.workers.indexOf(replaces) : -1;
    if (idx >= 0) this.workers[idx] = w;
    else this.workers.push(w);
    w.registered = true;
    // It may have died between the handshake and now.
    if (w.crashed) void this.respawn(w);
  }

  private async spawnWorker(
    id: string,
    role: WorkerRole,
    spec: WorkerSpawnSpec,
  ): Promise<ManagedWorker> {
    const worker = new Worker(spec.scriptUrl.href, { smol: spec.smol });

    const managed: ManagedWorker = {
      id,
      role,
      worker,
      pendingRequests: new Map(),
      activeTasks: 0,
      maxConcurrency: spec.maxConcurrency,
      assignedGraphs: new Set(),
      queue: new FastQueue<QueuedTask>(),
      spec,
      crashed: false,
      registered: false,
      epoch: this.epoch,
      metrics: {
        workerId: id,
        role,
        activeGraphs: 0,
        activeTasks: 0,
        eventLoopLagMs: 0,
        heapUsedBytes: 0,
        totalExecutedTasks: 0,
      },
    };

    worker.onmessage = (event: MessageEvent<IPCResponse>) => {
      const res = event.data;

      if ("action" in res) {
        for (const item of res.results) {
          this.settle(managed, item.id, item.success, item.data, item.error);
        }
      } else {
        this.settle(
          managed,
          res.id,
          res.success,
          res.success ? res.data : undefined,
          res.success ? undefined : res.error,
        );
      }
      this.drainWorkerQueue(managed);
    };

    // `error` is normally followed by `close`; `crashed` makes recovery run once.
    worker.addEventListener("error", (err) => {
      console.error(`[Host Supervisor] Worker ${id} crashed:`, err);
      this.handleWorkerFailure(managed, "error event");
    });
    worker.addEventListener("close", () => {
      this.handleWorkerFailure(managed, "unexpected close");
    });

    try {
      await this.sendControl(managed, (reqId) => ({
        id: reqId,
        action: "INIT",
        workerId: id,
        role,
      }));
    } catch (err) {
      managed.crashed = true;
      worker.terminate();
      throw err;
    }

    return managed;
  }

  /** Resolves/rejects one pending request and releases its slot. */
  private settle(
    w: ManagedWorker,
    id: number,
    ok: boolean,
    data?: unknown,
    error?: string,
  ): void {
    const pending = w.pendingRequests.get(id);
    if (!pending) return; // already timed out or rejected
    w.pendingRequests.delete(id);
    if (pending.countsAsActive) w.activeTasks--;
    if (pending.timer) clearTimeout(pending.timer);
    if (ok) pending.resolve(data);
    else pending.reject(new Error(error ?? "Unknown worker error"));
  }

  /** Control-plane request with its own timeout and safe cleanup on send failure. */
  private sendControl<T = unknown>(
    worker: ManagedWorker,
    build: (id: number) => IPCRequest,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (worker.crashed) {
        return reject(
          new WorkerCrashError(
            worker.id,
            worker.role,
            "worker already crashed",
          ),
        );
      }
      const id = ++this.reqCounter;
      const timer = setTimeout(() => {
        worker.pendingRequests.delete(id);
        reject(
          new Error(
            `Control request timed out after ${timeoutMs}ms (worker ${worker.id})`,
          ),
        );
      }, timeoutMs);
      unref(timer);

      worker.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        countsAsActive: false,
      });
      try {
        worker.worker.postMessage(build(id));
      } catch (err) {
        clearTimeout(timer);
        worker.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private async mountOn(
    worker: ManagedWorker,
    graphId: string,
    mount: GraphMount,
  ): Promise<void> {
    await this.sendControl(worker, (id) => ({
      id,
      action: "MOUNT_GRAPH",
      graphId,
      entrypoint: mount.entrypoint,
      env: mount.env,
    }));
    worker.assignedGraphs.add(graphId);
  }

  /**
   * Erlang/OTP-style supervision: a dead worker must never leave a promise
   * dangling. Rejects everything in flight or queued on it, kills the thread
   * (so a zombie can't keep running after being replaced), then respawns it.
   */
  private handleWorkerFailure(managed: ManagedWorker, reason: string): void {
    if (managed.crashed || managed.epoch !== this.epoch) return;
    managed.crashed = true;

    const crashError = new WorkerCrashError(managed.id, managed.role, reason);

    const inFlight = [...managed.pendingRequests.values()];
    managed.pendingRequests.clear();
    managed.activeTasks = 0;
    const queued = managed.queue.shiftBatch(managed.queue.length);
    managed.metrics.activeTasks = 0;

    for (const pending of inFlight) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(crashError);
    }
    for (const task of queued) {
      if (task.timer) clearTimeout(task.timer);
      task.reject(crashError);
    }

    try {
      managed.worker.terminate();
    } catch {}

    console.error(
      `[Host Supervisor] Worker ${managed.id} lost (${reason}) — rejected ` +
        `${inFlight.length} in-flight and ${queued.length} queued task(s).`,
    );

    if (managed.registered) void this.respawn(managed);
  }

  /** Replaces a dead worker, retrying with exponential backoff. */
  private async respawn(dead: ManagedWorker): Promise<void> {
    const epoch = dead.epoch;

    for (let attempt = 0; attempt < MAX_RESPAWN_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(Math.min(5_000, 100 * 2 ** attempt));
      if (epoch !== this.epoch) return;

      let replacement: ManagedWorker;
      try {
        replacement = await this.spawnWorker(dead.id, dead.role, dead.spec);
      } catch (err) {
        console.error(
          `[Host Supervisor] Respawn of ${dead.id} failed (attempt ${attempt + 1}):`,
          err,
        );
        continue;
      }

      if (epoch !== this.epoch) {
        replacement.crashed = true;
        replacement.worker.terminate();
        return;
      }

      this.placeWorker(replacement, dead);
      await this.remountGraphs(replacement, dead);
      return;
    }

    console.error(
      `[Host Supervisor] Giving up on ${dead.id} after ${MAX_RESPAWN_ATTEMPTS} attempts; fleet is degraded.`,
    );
  }

  /** Re-mounts every graph of the worker's role and fixes up the routing table. */
  private async remountGraphs(
    replacement: ManagedWorker,
    dead: ManagedWorker,
  ): Promise<void> {
    const specs = [...this.graphSpecs].filter(
      ([, s]) => s.role === replacement.role,
    );
    if (specs.length === 0) return;

    const results = await Promise.allSettled(
      specs.map(([graphId, s]) => this.mountOn(replacement, graphId, s.mount)),
    );

    let ok = 0;
    results.forEach((r, i) => {
      const graphId = specs[i]![0];
      // No entry yet means scheduleSubsystem is still running; it will pick
      // this worker up from `assignedGraphs` when it finishes.
      const hosts = this.graphWorkers.get(graphId);
      if (!hosts) return;

      const deadIdx = hosts.indexOf(dead);
      if (deadIdx >= 0) hosts.splice(deadIdx, 1);

      if (r.status === "fulfilled") {
        ok++;
        if (!hosts.includes(replacement)) hosts.push(replacement);
      } else {
        console.error(
          `[Host Supervisor] Remount of ${graphId} on ${replacement.id} failed:`,
          r.reason,
        );
      }
    });

    console.error(
      `[Host Supervisor] Worker ${replacement.id} respawned; remounted ${ok}/${specs.length} graph(s).`,
    );
  }

  public async scheduleSubsystem(
    subsystem: SubsystemDefinition,
  ): Promise<string> {
    const role: WorkerRole =
      subsystem.workload === "cpu" ? "cpu-pool" : "io-pool";

    const pool = this.workers.filter((w) => w.role === role && !w.crashed);
    if (pool.length === 0) {
      throw new Error(`No available workers for workload role: ${role}`);
    }

    /*
     * `replicas` now bounds how many workers host the graph.
     *
     * It was accepted, documented and then ignored, so `replicas: 1` mounted the
     * subsystem on every worker of the pool — on an eight-core machine, eight
     * independent module-graph instances. Any state one of them held was
     * invisible to the other seven, which is the opposite of what asking for one
     * replica means.
     */
    const wanted = subsystem.replicas ?? pool.length;
    const candidates = pool.slice(0, Math.max(1, wanted));

    const graphId = `graph-${subsystem.name}`;
    const mount: GraphMount = {
      entrypoint: subsystem.entrypoint,
      env: subsystem.env,
    };
    // Recorded first so a worker respawned mid-mount is seeded with it too.
    this.graphSpecs.set(graphId, { role, mount });

    const results = await Promise.allSettled(
      candidates.map((w) => this.mountOn(w, graphId, mount)),
    );

    // A worker that died mid-mount will be reseeded from graphSpecs; anything
    // else (bad entrypoint, init throwing) is a real failure.
    const hard = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && !(r.reason instanceof WorkerCrashError),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    if (hard.length > 0 || succeeded === 0) {
      this.graphSpecs.delete(graphId);
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        const w = candidates[i]!;
        w.assignedGraphs.delete(graphId);
        void this.sendControl(w, (id) => ({
          id,
          action: "DISPOSE_GRAPH",
          graphId,
        })).catch(() => {});
      });
      const cause = (
        hard[0] ??
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      ).reason;
      // Name the subsystem: a bare "database is locked" is otherwise unattributable.
      throw new Error(
        `Failed to mount subsystem "${subsystem.name}": ${cause?.message ?? cause}`,
        { cause },
      );
    }

    this.graphTimeouts.set(
      graphId,
      subsystem.timeoutMs ?? this.defaultTaskTimeoutMs,
    );
    this.graphWorkers.set(
      graphId,
      this.workers.filter(
        (w) => w.role === role && !w.crashed && w.assignedGraphs.has(graphId),
      ),
    );
    return graphId;
  }

  public dispatchTask<T = unknown>(
    graphId: string,
    handler: string,
    payload: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      /*
       * Refused while paused.
       *
       * Checked here, at the single point work enters the fleet, rather than at each
       * caller. A cron tick, a queued job and a request-handler call all arrive by
       * this path, so a check higher up would miss whichever of them did not
       * remember to.
       *
       * Rejected rather than queued: a drained process is about to exit, and holding
       * the task would make the drain wait for something nobody will run.
       */
      if (this.isWorkPaused) {
        return reject(new WorkPausedError(graphId));
      }

      const candidates = this.graphWorkers.get(graphId);
      if (!candidates || candidates.length === 0) {
        return reject(new Error(`No worker found hosting graphId: ${graphId}`));
      }

      // Least-loaded healthy worker. Dead workers stay listed until their
      // replacement is mounted, so they must be skipped here.
      let worker: ManagedWorker | undefined;
      let minLoad = Infinity;
      for (const w of candidates) {
        if (w.crashed) continue;
        const load = w.activeTasks + w.queue.length;
        if (load < minLoad) {
          worker = w;
          minLoad = load;
        }
      }
      if (!worker) {
        return reject(
          new Error(`No healthy worker currently hosting graphId: ${graphId}`),
        );
      }
      const target = worker;

      const id = ++this.reqCounter;
      const timeoutMs =
        this.graphTimeouts.get(graphId) ?? this.defaultTaskTimeoutMs;

      // Deadline starts at dispatch so queue wait counts against it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = target.pendingRequests.get(id);

          if (pending) {
            // Dispatched: abandon it and release the slot.
            target.pendingRequests.delete(id);
            target.activeTasks--;
            pending.reject(new TaskTimeoutError(graphId, handler, timeoutMs));

            if (target.maxConcurrency === 1) {
              // A single-slot (CPU) worker that blew its deadline is almost
              // certainly wedged in a sync loop and can't be cancelled
              // cooperatively; recycle the thread instead of feeding it more.
              this.handleWorkerFailure(
                target,
                `task '${handler}' exceeded ${timeoutMs}ms`,
              );
            } else {
              this.drainWorkerQueue(target);
            }
            return;
          }

          // Still queued: owns no slot, but must be dropped or it would
          // later be dispatched with a dead timer.
          if (target.queue.removeQueued(id)) {
            reject(new TaskTimeoutError(graphId, handler, timeoutMs));
          }
        }, timeoutMs);
        unref(timer);
      }

      const task: QueuedTask = {
        id,
        graphId,
        handler,
        payload,
        resolve,
        reject,
        timer,
      };

      if (target.activeTasks < target.maxConcurrency) {
        this.startOne(target, task);
      } else {
        target.queue.push(task);
      }
    });
  }

      /** Sends a single task. A non-cloneable payload fails only that task. */
    /**
   * Fast dispatch path: skips per-task timeout timers and uses round-robin
   * worker selection instead of least-loaded scan. For high-throughput
   * scenarios where tasks are short-lived and timeouts are handled at a
   * higher level.
   */
  public dispatchFast<T = unknown>(
    graphId: string,
    handler: string,
    payload: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.isWorkPaused) {
        return reject(new WorkPausedError(graphId));
      }

      const candidates = this.graphWorkers.get(graphId);
      if (!candidates || candidates.length === 0) {
        return reject(new Error(`No worker found hosting graphId: ${graphId}`));
      }

      // Round-robin: O(1) instead of O(n) least-loaded scan.
      let cursor = this.roundRobinCursor.get(graphId) ?? 0;
      let worker: ManagedWorker | undefined;
      for (let i = 0; i < candidates.length; i++) {
        const w = candidates[(cursor + i) % candidates.length]!;
        if (!w.crashed) {
          worker = w;
          this.roundRobinCursor.set(graphId, (cursor + i + 1) % candidates.length);
          break;
        }
      }
      if (!worker) {
        return reject(
          new Error(`No healthy worker currently hosting graphId: ${graphId}`),
        );
      }

      const id = ++this.reqCounter;

      const task: QueuedTask = {
        id,
        graphId,
        handler,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
      };

      if (worker.activeTasks < worker.maxConcurrency) {
        this.startOneFast(worker, task);
      } else {
        worker.queue.push(task);
      }
    });
  }

  /** Fast version of startOne: skips timer bookkeeping. */
  private startOneFast(worker: ManagedWorker, t: QueuedTask): void {
    worker.activeTasks++;
    worker.pendingRequests.set(t.id, {
      resolve: t.resolve,
      reject: t.reject,
      timer: undefined,
      countsAsActive: true,
    });
    try {
      worker.worker.postMessage({
        id: t.id,
        action: "EXECUTE_GRAPH",
        graphId: t.graphId,
        handler: t.handler,
        payload: t.payload,
      } satisfies IPCRequest);
    } catch (err) {
      worker.pendingRequests.delete(t.id);
      worker.activeTasks--;
      t.reject(err);
    
  }
  
      /** Sends a single task. A non-cloneable payload fails only that task. */
  private startOne(worker: ManagedWorker, t: QueuedTask): void {
    worker.activeTasks++;
    worker.pendingRequests.set(t.id, {
      resolve: t.resolve,
      reject: t.reject,
      timer: t.timer,
      countsAsActive: true,
    });
    try {
      worker.worker.postMessage({
        id: t.id,
        action: "EXECUTE_GRAPH",
        graphId: t.graphId,
        handler: t.handler,
        payload: t.payload,
      } satisfies IPCRequest);
    } catch (err) {
      // Without this the slot, pending entry and timer would leak, and the
      // timer would later decrement activeTasks a second time.
      this.settle(
        worker,
        t.id,
        false,
        undefined,
        err instanceof Error ? err.message : String(err),
        );
    }
  }

  /**
   * Opportunistic micro-batching: drains up to 32 (64 under heavy backlog)
   * tasks per IPC message, looping until slots or queue run out.
   */
  private drainWorkerQueue(worker: ManagedWorker): void {
    while (
      !worker.crashed &&
      worker.activeTasks < worker.maxConcurrency &&
      worker.queue.length > 0
    ) {
      const availableSlots = worker.maxConcurrency - worker.activeTasks;
      const targetBatch = worker.queue.length > 256 ? 64 : 32;
      const batch = worker.queue.shiftBatch(
        Math.min(targetBatch, availableSlots, worker.queue.length),
      );
      if (batch.length === 0) return;

      if (batch.length === 1) {
        this.startOne(worker, batch[0]!);
        continue;
      }

      worker.activeTasks += batch.length;
      for (const t of batch) {
        worker.pendingRequests.set(t.id, {
          resolve: t.resolve,
          reject: t.reject,
          timer: t.timer,
          countsAsActive: true,
        });
      }

      try {
        worker.worker.postMessage({
          id: ++this.reqCounter,
          action: "BATCH_EXECUTE",
          tasks: batch.map((t) => ({
            id: t.id,
            graphId: t.graphId,
            handler: t.handler,
            payload: t.payload,
          })),
        } satisfies IPCRequest);
      } catch {
        // One bad payload must not take the whole batch down: nothing was
        // delivered, so retry each task on its own and fail only the culprit.
        for (const t of batch) {
          try {
            worker.worker.postMessage({
              id: t.id,
              action: "EXECUTE_GRAPH",
              graphId: t.graphId,
              handler: t.handler,
              payload: t.payload,
            } satisfies IPCRequest);
          } catch (err) {
            this.settle(
              worker,
              t.id,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }
  }

  public getTopology(): HardwareTopology {
    return this.topology;
  }

  /** Actual (not configured) fleet state, for readiness probes. */
  public getHealth(): FleetHealth {
    const byRole: FleetHealth["byRole"] = {};
    let healthy = 0;
    for (const w of this.workers) {
      const entry = (byRole[w.role] ??= { expected: 0, healthy: 0 });
      entry.expected++;
      if (!w.crashed) {
        entry.healthy++;
        healthy++;
      }
    }
    return {
      ready:
        this.workers.length > 0 &&
        Object.values(byRole).every((r) => r.healthy > 0),
      expected: this.workers.length,
      healthy,
      byRole,
    };
  }

  public async getMetrics(): Promise<WorkerMetrics[]> {
    const results = await Promise.allSettled(
      this.workers
        .filter((w) => !w.crashed)
        .map((w) =>
          this.sendControl<WorkerMetrics>(
            w,
            (id) => ({ id, action: "GET_METRICS" }),
            2_000,
          ),
        ),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  /**
   * Whether new work is being accepted.
   *
   * Public because a shutdown needs to report it: a runtime paused before its drain
   * behaves differently from one that was never told to.
   */
  public isWorkPaused = false;

  /**
   * Stops scheduling new tasks. Tasks already running are untouched.
   *
   * Without this, a cron tick or an arriving job starts during a drain and is then
   * killed by the teardown, so the drain reports a timeout for a deploy that was
   * simply unlucky with its timing.
   *
   * @returns `true` when the state changed, `false` when it was already paused.
   */
  public pauseWork(): boolean {
    if (this.isWorkPaused) return false;
    this.isWorkPaused = true;
    return true;
  }

  /** Resumes accepting work. @returns `true` when the state changed. */
  public resumeWork(): boolean {
    if (!this.isWorkPaused) return false;
    this.isWorkPaused = false;
    return true;
  }

  /** Tasks currently executing or queued across the fleet. */
  public getActiveTaskCount(): number {
    let total = 0;
    for (const w of this.workers) {
      total += w.activeTasks + w.queue.length;
    }
    return total;
  }

  public async terminateAll(): Promise<void> {
    // Invalidate every worker/respawn loop of this generation first, so the
    // `close` events fired by terminate() below are ignored.
    this.epoch++;
    const err = new Error("Scheduler terminated");

    for (const w of this.workers) {
      w.crashed = true;

      // Settle (not just forget) every outstanding promise, otherwise callers
      // awaiting execute() would hang forever after shutdown.
      const pendings = [...w.pendingRequests.values()];
      w.pendingRequests.clear();
      w.activeTasks = 0;
      for (const p of pendings) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      for (const task of w.queue.shiftBatch(w.queue.length)) {
        if (task.timer) clearTimeout(task.timer);
        task.reject(err);
      }
      try {
        w.worker.terminate();
      } catch {}
    }

    this.workers = [];
    this.graphWorkers.clear();
    this.graphSpecs.clear();
    this.graphTimeouts.clear();
  }
}
