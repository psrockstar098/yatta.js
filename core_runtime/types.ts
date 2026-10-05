// core_runtime/types.ts

export type WorkloadType = "cpu" | "io" | "mixed";
export type WorkerRole = "cpu-pool" | "io-pool" | "dedicated";

export interface HardwareTopology {
  cpuCores: number;
  cpuWorkers: number;
  ioWorkers: number;
  totalWorkers: number;
  suggestSmol: boolean;
}

export interface WorkerMetrics {
  workerId: string;
  role: WorkerRole;
  activeGraphs: number;
  activeTasks: number;
  eventLoopLagMs: number;
  heapUsedBytes: number;
  totalExecutedTasks: number;
}

export type IPCRequest =
  | { id: number; action: "INIT"; workerId: string; role: WorkerRole }
  | { id: number; action: "PING" }
  | {
      id: number;
      action: "MOUNT_GRAPH";
      graphId: string;
      entrypoint: string;
      env?: Record<string, string>;
    }
  | {
      id: number;
      action: "EXECUTE_GRAPH";
      graphId: string;
      handler: string;
      payload: unknown;
    }
  | {
      id: number;
      action: "BATCH_EXECUTE";
      tasks: Array<{
        id: number;
        graphId: string;
        handler: string;
        payload: unknown;
      }>;
    }
  | { id: number; action: "DISPOSE_GRAPH"; graphId: string }
  | { id: number; action: "GET_METRICS" };

export type IPCResponse =
  | { id: number; success: true; data: unknown }
  | { id: number; success: false; error: string; stack?: string }
  | {
      action: "BATCH_RESPONSE";
      results: Array<{
        id: number;
        success: boolean;
        data?: unknown;
        error?: string;
      }>;
    };

export interface SubsystemDefinition {
  name: string;
  entrypoint: string;
  workload: WorkloadType;
  env?: Record<string, string>;
  /**
   * How many workers of the chosen pool host this subsystem.
   *
   * Defaults to every worker in the pool. Set it to keep per-worker state
   * consistent, such as an in-process cache or a single-writer queue.
   */
  replicas?: number;
  /**
   * Per-task execution deadline in milliseconds for this subsystem.
   * Falls back to the scheduler's `taskTimeoutMs`. Use 0 to disable.
   */
  timeoutMs?: number;
}
