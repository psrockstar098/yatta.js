import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Boot warnings that every fleet worker thread re-prints.
 *
 * Each Bun worker thread has its own module registry, so a module-level "warned once"
 * flag cannot span the host thread and its workers. Measured on this fleet: with one
 * CPU-bound and two I/O workers, identical startup lines were printed three times — the
 * ephemeral-storage-secret warning, the missing-authorizer warning, and the
 * ModuleGraph-fallback note. A reader cannot tell that from accidental
 * re-bootstrapping, so it just reads as noise.
 *
 * The gate is environmental because the boundary it crosses is a process boundary: the
 * runtime spawns workers with YATTA_FLEET_THREAD=1, and the printing sites stay silent
 * when they see it. The host has already printed; a worker copy of the same line
 * carries no information.
 *
 * Measured through real worker threads, because that is where the duplicated module
 * registries actually live. Each probe patches console.warn in a fresh worker (fresh
 * registry, fresh flags) and posts the lines back; worker stdout cannot be asserted on.
 */

const ROOT = join(import.meta.dir, "..", "..");

let dir: string | undefined;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** One writable dir shared by the probes; created on demand. */
function probeDir(): string {
  dir ??= mkdtempSync(join(tmpdir(), "yatta-warnprobe-"));
  return dir;
}

function probeWithWorker(
  name: string,
  body: string,
  fleetThread: boolean,
): Promise<{ warns: string[]; error?: string }> {
  dir ??= mkdtempSync(join(tmpdir(), "yatta-warnprobe-"));
  const probeFile = join(dir, `${name}.ts`);
  writeFileSync(probeFile, body);

  const options: WorkerOptions = fleetThread
    ? { env: { ...process.env, YATTA_FLEET_THREAD: "1" } }
    : {};

  // Loaded through a data URL so the probe file itself is not part of this repo.
  const worker = new Worker(
    new URL(`data:text/javascript,import(${JSON.stringify(probeFile)})`).href,
    options,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`probe ${name} timed out`)), 30_000);
    worker.onmessage = (event: MessageEvent<{ warns: string[]; error?: string }>) => {
      clearTimeout(timer);
      resolvePromise(event.data);
      worker.terminate();
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      // Worker errors arrive as ErrorEvents without a usable message; name the probe
      // instead of letting it read as a timeout.
      rejectPromise(new Error(`probe ${name} errored: ${err?.message ?? String(err)}`));
    };
  });
}

/*
 * Preamble every probe runs first: capture console.warn, then import the modules
 * freshly — the worker's registry is fresh, so per-module "warned once" flags start
 * reset. An import failure is reported in the payload rather than as a bare ErrorEvent.
 */
const PREAMBLE = `
const warns: string[] = [];
let importError: string | undefined;
const original = console.warn;
console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? "")); };

let storage: typeof import("${ROOT}/src/types/storage.ts") | undefined;
let graph: typeof import("${ROOT}/core_runtime/moduleGraph.ts") | undefined;
try {
  storage = await import("${ROOT}/src/types/storage.ts");
  graph = await import("${ROOT}/core_runtime/moduleGraph.ts");
} catch (e: any) {
  importError = \`import failed: \${e?.message ?? e}\`;
}
`;

const REPORT = `
console.warn = original;
self.postMessage({ warns, error: importError });
process.exit(0);
`;

describe("boot warnings print once for the process, not once per thread", () => {
  it("the host thread prints the storage warnings", async () => {
    const { warns, error } = await probeWithWorker(
      "host-storage",
      `const storageBase = "${probeDir()}";` + `${PREAMBLE}
if (storage) {
  storage.resolveSigningSecret();
  storage.createStorage({ default: "local", disks: { local: { driver: "local", baseDir: storageBase } } });
}
${REPORT}`,
      false,
    );

    expect(error).toBeUndefined();
    expect(warns.some((w) => w.includes("No secret provided"))).toBe(true);
    expect(warns.some((w) => w.includes("no 'authorize' callback"))).toBe(true);
  });

  it("worker threads print neither storage warning", async () => {
    const { warns, error } = await probeWithWorker(
      "fleet-storage",
      `const storageBase = "${probeDir()}";` + `${PREAMBLE}
if (storage) {
  storage.resolveSigningSecret();
  storage.createStorage({ default: "local", disks: { local: { driver: "local", baseDir: storageBase } } });
}
${REPORT}`,
      true,
    );

    expect(error).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it("the host thread prints the ModuleGraph fallback note exactly once", async () => {
    const { warns, error } = await probeWithWorker(
      "host-graph",
      `${PREAMBLE}
if (graph) {
  // Two graphs, the way a worker holding several subsystems builds them: the
  // per-registry flag must suppress the second, but the first must still print.
  // The note fires from IsolatedAppGraph construction, not from ModuleGraphManager,
  // which never warns before it has anything to mount.
  new graph.IsolatedAppGraph("host-g1", "unused-entrypoint.ts");
  new graph.IsolatedAppGraph("host-g2", "unused-entrypoint.ts");
}
${REPORT}`,
      false,
    );

    expect(error).toBeUndefined();
    const fallbacks = warns.filter((w) => w.includes("Bun.ModuleGraph is unavailable"));
    // Availability is a property of the Bun build under test, not of this code: CI runs
    // a Bun where Bun.ModuleGraph exists and the fallback legitimately never fires.
    expect(fallbacks).toHaveLength((globalThis as any).Bun?.ModuleGraph ? 0 : 1);
  });

  it("worker threads stay silent about the fallback too", async () => {
    const { warns, error } = await probeWithWorker(
      "fleet-graph",
      `${PREAMBLE}
if (graph) {
  new graph.IsolatedAppGraph("fleet-g1", "unused-entrypoint.ts");
  new graph.IsolatedAppGraph("fleet-g2", "unused-entrypoint.ts");
}
${REPORT}`,
      true,
    );

    expect(error).toBeUndefined();
    expect(warns).toEqual([]);
  });
});
