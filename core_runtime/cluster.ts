import { cpus } from "node:os";
import { randomBytes } from "node:crypto";

const requested = Number(process.env.CLUSTER_WORKERS);
const coreCount =
  Number.isInteger(requested) && requested > 0
    ? requested
    : navigator.hardwareConcurrency || cpus().length || 2;

const ENTRY = process.env.CLUSTER_ENTRY ?? "src/main.ts";
const SHUTDOWN_GRACE_MS = 15_000; // > main.ts drain (10s) + teardown
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;

console.log(
  `[Cluster] Spawning ${coreCount} master workers with SO_REUSEPORT...`,
);

// Ephemeral secret shared by all children so signed URLs verify on any of them.
// Must be unguessable: Date.now() is predictable, which would make signatures forgeable.
if (!process.env.STORAGE_SECRET) {
  process.env.STORAGE_SECRET =
    "ephemeral-cluster-secret-" + randomBytes(32).toString("hex");
}

type Child = ReturnType<typeof Bun.spawn>;

const children = new Map<number, Child>();
const restartLog = new Map<number, number[]>();
const restartTimers = new Set<ReturnType<typeof setTimeout>>();
let stopping = false;

function spawnChild(slot: number): void {
  const child = Bun.spawn({
    // execPath instead of "bun": works even when bun isn't on PATH.
    cmd: [process.execPath, ENTRY],
    env: { ...process.env, CLUSTER_WORKER_ID: String(slot) },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    onExit(_proc, exitCode, signalCode) {
      children.delete(slot);
      if (stopping) return;

      console.error(
        `[Cluster] Worker #${slot} exited (code=${exitCode}, signal=${signalCode}).`,
      );

      // Crash-loop guard: don't hot-spin a worker that dies on boot.
      const now = Date.now();
      const recent = (restartLog.get(slot) ?? []).filter(
        (t) => now - t < RESTART_WINDOW_MS,
      );
      if (recent.length >= MAX_RESTARTS_PER_WINDOW) {
        console.error(
          `[Cluster] Worker #${slot} crashed ${recent.length}x in ${RESTART_WINDOW_MS / 1000}s — not restarting.`,
        );
        if (children.size === 0) {
          console.error("[Cluster] No workers left alive; exiting.");
          process.exit(1);
        }
        return;
      }
      recent.push(now);
      restartLog.set(slot, recent);

      const delay = Math.min(5_000, 250 * 2 ** (recent.length - 1));
      const t = setTimeout(() => {
        restartTimers.delete(t);
        if (!stopping) spawnChild(slot);
      }, delay);
      restartTimers.add(t);
    },
  });
  children.set(slot, child);
}

for (let i = 0; i < coreCount; i++) spawnChild(i);

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("\n[Cluster] Shutting down cluster processes...");

  for (const t of restartTimers) clearTimeout(t);
  const live = [...children.values()];
  for (const child of live) child.kill("SIGTERM");

  // Let children finish their own graceful drain instead of orphaning them.
  const timedOut = await Promise.race([
    Promise.all(live.map((c) => c.exited)).then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SHUTDOWN_GRACE_MS)),
  ]);

  if (timedOut) {
    console.warn("[Cluster] Grace period elapsed — killing stragglers.");
    for (const child of live) child.kill("SIGKILL");
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
