// core_runtime/moduleGraph.ts

let warnedFallback = false;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as any).then === "function"
  );
}

export class IsolatedAppGraph {
  public readonly id: string;
  private nativeGraph: any = null;
  private exports: any = null;
  private isDisposed = false;
  private inFlightAborts = new Set<(err: Error) => void>();

  constructor(
    id: string,
    private entrypoint: string,
    globals: Record<string, unknown> = {},
    onError?: (err: unknown, kind: string) => void,
  ) {
    this.id = id;

    const BunModuleGraph = (globalThis as any).Bun?.ModuleGraph;
    if (typeof BunModuleGraph === "function") {
      this.nativeGraph = new BunModuleGraph({
        globals: {
          ...globals,
          GRAPH_ID: id,
        },
        onError: (err: unknown, kind: string) => {
          if (onError) onError(err, kind);
          else
            console.error(
              `[ModuleGraph:${this.id} Uncaught Error (${kind})]:`,
              err,
            );
        },
      });
    } else if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        "[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module " +
          "cache and per-tenant globals/env are NOT applied. Not isolated.",
      );
    }
  }

  public async initialize(): Promise<void> {
    if (this.isDisposed)
      throw new Error(`Cannot initialize disposed graph ${this.id}`);
    if (this.exports) return;

    if (this.nativeGraph) {
      this.exports = await this.nativeGraph.import(this.entrypoint);
    } else {
      this.exports = await import(this.entrypoint);
    }
  }

  /**
   * Runs `action` against the module exports. Sync results are returned
   * directly (no allocation); async results are wrapped so `dispose()` can
   * reject them while still in flight.
   */
  public runSafe<T>(
    action: (moduleExports: any) => Promise<T> | T,
  ): Promise<T> | T {
    if (this.isDisposed) {
      return Promise.reject(new Error(`Graph ${this.id} is already disposed.`));
    }
    const mod = this.exports;
    if (!mod) {
      return Promise.reject(new Error(`Graph ${this.id} is not initialized.`));
    }

    const result = this.nativeGraph
      ? this.nativeGraph.run(() => action(mod))
      : action(mod);

    // Duck-typed: a promise created inside another realm (a separate
    // ModuleGraph global) fails `instanceof Promise`.
    if (!isThenable(result)) return result as T;

    return new Promise<T>((resolve, reject) => {
      const abort = (err: Error) => {
        this.inFlightAborts.delete(abort);
        reject(err);
      };
      this.inFlightAborts.add(abort);
      result.then(
        (v) => {
          this.inFlightAborts.delete(abort);
          resolve(v as T);
        },
        (e) => {
          this.inFlightAborts.delete(abort);
          reject(e);
        },
      );
    });
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    const err = new Error(`Graph ${this.id} was disposed.`);
    for (const abort of [...this.inFlightAborts]) abort(err);
    this.inFlightAborts.clear();

    try {
      if (this.nativeGraph) {
        this.nativeGraph.dispose();
      } else if (this.exports && typeof this.exports.dispose === "function") {
        this.exports.dispose();
      }
    } catch (e) {
      console.error(`[ModuleGraph:${this.id}] dispose failed:`, e);
    }

    this.nativeGraph = null;
    this.exports = null;
  }

  public get disposed(): boolean {
    return this.isDisposed;
  }
}

export class ModuleGraphManager {
  private graphs = new Map<string, IsolatedAppGraph>();
  private mounting = new Map<string, Promise<void>>();

  /** Idempotent and safe under concurrent calls for the same id. */
  public mount(
    graphId: string,
    entrypoint: string,
    env: Record<string, string> = {},
  ): Promise<void> {
    if (this.graphs.has(graphId)) return Promise.resolve();

    // Without this, two concurrent mounts both passed the `has` check, both
    // initialised, and the loser's native graph leaked.
    const inflight = this.mounting.get(graphId);
    if (inflight) return inflight;

    const p = this.doMount(graphId, entrypoint, env).finally(() =>
      this.mounting.delete(graphId),
    );
    this.mounting.set(graphId, p);
    return p;
  }

  private async doMount(
    graphId: string,
    entrypoint: string,
    env: Record<string, string>,
  ): Promise<void> {
    // NOTE: this still hands each tenant the host's full process.env.
    const tenantProcess = Object.create(process, {
      env: {
        value: { ...process.env, ...env, TENANT_ID: graphId },
        enumerable: true,
      },
    });

    const graph = new IsolatedAppGraph(graphId, entrypoint, {
      process: tenantProcess,
    });

    try {
      await graph.initialize();
    } catch (err) {
      graph.dispose(); // don't leak the native graph of a failed import
      throw err;
    }
    this.graphs.set(graphId, graph);
  }

  public async execute(
    graphId: string,
    handlerName: string,
    payload: unknown,
  ): Promise<unknown> {
    const graph = this.graphs.get(graphId);
    if (!graph) throw new Error(`Graph ${graphId} not found.`);

    return await graph.runSafe((mod) => {
      const fn = mod[handlerName];
      // Reject inherited Object.prototype members ("constructor",
      // "toString", ...) so a handler name can't reach built-ins.
      const inheritedBuiltin =
        handlerName in Object.prototype && !Object.hasOwn(mod, handlerName);
      if (typeof fn !== "function" || inheritedBuiltin) {
        throw new Error(
          `Handler '${handlerName}' not found in graph ${graphId}`,
        );
      }
      return fn.call(mod, payload);
    });
  }

  public dispose(graphId: string): void {
    const graph = this.graphs.get(graphId);
    if (graph) {
      graph.dispose();
      this.graphs.delete(graphId);
    }
  }

  public disposeAll(): void {
    for (const [id, graph] of this.graphs.entries()) {
      graph.dispose();
      this.graphs.delete(id);
    }
  }

  public get count(): number {
    return this.graphs.size;
  }
}
