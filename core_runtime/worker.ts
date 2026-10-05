// core_runtime/worker.ts
import { ModuleGraphManager } from "./moduleGraph";
import type {
  IPCRequest,
  IPCResponse,
  WorkerMetrics,
  WorkerRole,
} from "./types";

declare var self: Worker;

const graphManager = new ModuleGraphManager();
let activeTasks = 0;
let totalExecuted = 0;

let workerRole: WorkerRole = "io-pool";
let workerId = "worker-init";

let lastProbe = performance.now();
let eventLoopLag = 0;

function probeLag() {
  const now = performance.now();
  const lag = Math.max(0, now - lastProbe - 16.6);
  eventLoopLag = eventLoopLag * 0.85 + lag * 0.15;
  lastProbe = now;
  setTimeout(probeLag, 16).unref();
}
setTimeout(probeLag, 16).unref();

self.onmessage = async (event: MessageEvent<IPCRequest>) => {
  const req = event.data;

  try {
    switch (req.action) {
      case "INIT": {
        workerId = req.workerId;
        workerRole = req.role;
        self.postMessage({
          id: req.id,
          success: true,
          data: "INITIALIZED",
        } satisfies IPCResponse);
        break;
      }

      case "PING": {
        self.postMessage({
          id: req.id,
          success: true,
          data: "PONG",
        } satisfies IPCResponse);
        break;
      }

      case "MOUNT_GRAPH": {
        await graphManager.mount(req.graphId, req.entrypoint, req.env);
        self.postMessage({
          id: req.id,
          success: true,
          data: { mounted: req.graphId },
        } satisfies IPCResponse);
        break;
      }

      case "EXECUTE_GRAPH": {
        activeTasks++;
        totalExecuted++;
        let result: unknown;
        try {
          result = await graphManager.execute(
            req.graphId,
            req.handler,
            req.payload,
          );
        } finally {
          // Previously skipped when the handler threw, leaking the gauge.
          activeTasks--;
        }
        self.postMessage({
          id: req.id,
          success: true,
          data: result,
        } satisfies IPCResponse);
        break;
      }

      // Micro-batch execution: handles multiple tasks in one thread hop
      case "BATCH_EXECUTE": {
        const batchSize = req.tasks.length;
        activeTasks += batchSize;
        totalExecuted += batchSize;

        let results;
        try {
          results = await Promise.all(
            req.tasks.map(async (t) => {
              try {
                const res = await graphManager.execute(
                  t.graphId,
                  t.handler,
                  t.payload,
                );
                return { id: t.id, success: true, data: res };
              } catch (err: any) {
                return {
                  id: t.id,
                  success: false,
                  error: err?.message || String(err),
                };
              }
            }),
          );
        } finally {
          activeTasks -= batchSize;
        }

        try {
          self.postMessage({
            action: "BATCH_RESPONSE",
            results,
          } satisfies IPCResponse);
        } catch {
          // A non-cloneable *result* would otherwise drop the whole batch and
          // leave every caller waiting for its deadline. Degrade per item.
          self.postMessage({
            action: "BATCH_RESPONSE",
            results: results.map((r) => {
              try {
                structuredClone(r);
                return r;
              } catch (err: any) {
                return {
                  id: r.id,
                  success: false,
                  error: `Result not serializable: ${err?.message || err}`,
                };
              }
            }),
          } satisfies IPCResponse);
        }
        break;
      }

      case "DISPOSE_GRAPH": {
        graphManager.dispose(req.graphId);
        self.postMessage({
          id: req.id,
          success: true,
          data: { disposed: req.graphId },
        } satisfies IPCResponse);
        break;
      }

      case "GET_METRICS": {
        const metrics: WorkerMetrics = {
          workerId,
          role: workerRole,
          activeGraphs: graphManager.count,
          activeTasks,
          eventLoopLagMs: Math.round(eventLoopLag * 100) / 100,
          heapUsedBytes: process.memoryUsage().heapUsed,
          totalExecutedTasks: totalExecuted,
        };
        self.postMessage({
          id: req.id,
          success: true,
          data: metrics,
        } satisfies IPCResponse);
        break;
      }

      default:
        throw new Error(`Unknown action: ${(req as any).action}`);
    }
  } catch (err: any) {
    if ("id" in req) {
      // The error reply itself can fail to clone (e.g. a non-cloneable
      // success payload for EXECUTE_GRAPH lands here too); keep it plain.
      self.postMessage({
        id: req.id,
        success: false,
        error: err?.message || String(err),
        stack: typeof err?.stack === "string" ? err.stack : undefined,
      } satisfies IPCResponse);
    }
  }
};
