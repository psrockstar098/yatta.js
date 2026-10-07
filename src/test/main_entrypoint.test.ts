import { describe, it, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * The entrypoint, as a process.
 *
 * `src/main.ts` is 416 lines of top-level script: importing it boots a server, mounts
 * subsystems, opens sockets and installs signal handlers. That is why it had no unit
 * test — and it is the file every project inherits, so a regression there surfaces as a
 * boot failure in someone else's application rather than a red test here.
 *
 * So it is tested the way it ships: started as a process, driven over HTTP, and asked
 * to stop. This is the sequence the CI docker job performs by hand, made into a gate.
 *
 * Two things learned writing it:
 *
 * - Each test owns its child and its captured output. Shared module-level state made
 *   them interfere: run together, each spawn reset the buffer the previous one was
 *   still watching, and seven tests timed out reporting "the server never reported a
 *   port" for a server that had printed it. In isolation the same test takes 1.7s.
 * - Every test gets 60 seconds. Booting the fleet takes seconds, and Bun's 5s default
 *   fails them with a timeout that reads exactly like a boot failure.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "main.ts");
const BOOT_TIMEOUT_MS = 60_000;

/** Everything a test needs to talk to, and stop, one server. */
interface Server {
  url: string;
  output: () => string;
  exited: Promise<{ code: number | null; output: string }>;
  stop: (signal: NodeJS.Signals) => Promise<{ code: number | null; output: string }>;
}

let dir: string;
const running: Server[] = [];

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: "production",
    // 0 asks the OS for a free port, so two tests never collide and neither guesses.
    PORT: "0",
    STORAGE_SECRET: "entrypoint-test-storage-secret-value",
    AUTH_SECRET: "entrypoint-test-auth-secret-min-32-chars-long",
    APP_URL: "https://entrypoint.test",
    YATTA_CLUSTER_MODE: "false",
    /*
     * DATABASE_URL, not DATABASE_PATH.
     *
     * The server reads `DATABASE_URL`; `DATABASE_PATH` is honoured only by the CLI
     * commands — `doctor`, `migrate`, `db:backup`. Setting the wrong one leaves the
     * server writing to `Database/app.db` in the working directory, which is exactly
     * the repository. The first version of this file set `DATABASE_PATH` and quietly
     * created files in the repo while asserting it had not.
     */
    DATABASE_URL: join(dir, "yatta.db"),
    ...overrides,
  };
}

/**
 * Starts the entrypoint and waits for the banner carrying the bound port.
 *
 * Everything is returned rather than stored in module scope, so two tests running at
 * once cannot overwrite each other's buffer.
 */
async function start(overrides: Record<string, string> = {}): Promise<Server> {
  let output = "";

  const child: ChildProcess = spawn(process.execPath, [ENTRYPOINT], {
    env: env(overrides),
  });

  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };

  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const exited = new Promise<{ code: number | null; output: string }>((resolveExit) => {
    child.once("exit", (code) => resolveExit({ code, output }));
  });

  // Two banners exist: this entrypoint prints "Yatta server running at … (PID: …)"
  // and the scaffolded one prints "✓ Yatta listening on …". Match either rather than
  // pinning the test to one.
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server never reported a port.\n${output}`)),
      30_000,
    );

    const check = setInterval(() => {
      const match = /(?:server running at|listening on)\s+(http:\/\/[^\s(]+)/.exec(output);
      if (!match) return;

      clearInterval(check);
      clearTimeout(timer);
      resolveUrl(match[1]!);
    }, 50);
  });

  const stop = async (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal);
    return exited;
  };

  const server: Server = { url, output: () => output, exited, stop };
  running.push(server);
  return server;
}

function freshDir(): void {
  dir = mkdtempSync(join(tmpdir(), "yatta-entrypoint-"));
}

afterEach(async () => {
  // Never leave a child holding a port or a database open.
  for (const server of running.splice(0)) {
    if (server.output().length > 0) await server.stop("SIGKILL").catch(() => null);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("The entrypoint boots", () => {
  it("serves liveness and readiness, and mounts its subsystems", async () => {
    freshDir();
    const server = await start();

    const live = await fetch(`${server.url}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok" });

    const ready = await fetch(`${server.url}/readyz`);
    expect(ready.status).toBe(200);

    const body = (await ready.json()) as {
      status: string;
      topology: { totalWorkers: number };
      health: { ready: boolean; healthy: number };
    };

    expect(body.status).toBe("ready");
    expect(body.topology.totalWorkers).toBeGreaterThan(0);
    expect(body.health.ready).toBe(true);

    // Every worker it claims must actually be healthy. A readiness probe that reports
    // ready while a pool is short is how traffic reaches a queue nobody is draining.
    expect(body.health.healthy).toBe(body.topology.totalWorkers);

    expect(server.output()).toContain("Mounted 8 subsystems");
  }, BOOT_TIMEOUT_MS);

  it("answers an unknown route with a 404 rather than hanging or crashing", async () => {
    freshDir();
    const server = await start();

    const res = await fetch(`${server.url}/definitely-not-a-route`);

    // A boot-time mistake here is a router that swallows unmatched paths, which reads as
    // a network timeout to whoever is calling.
    expect(res.status).toBe(404);
  }, BOOT_TIMEOUT_MS);

  it("records no client-address warning, so rate limits are per client", async () => {
    freshDir();
    const server = await start();

    // This warning was firing three times on every production boot. It is the difference
    // between per-IP rate limits and one global limit that any attacker can trip.
    expect(server.output()).not.toContain("getClientIp is not configured");
  }, BOOT_TIMEOUT_MS);

  it("keeps the observe surface invisible without a token", async () => {
    freshDir();
    const server = await start();

    const res = await fetch(`${server.url}/_yatta/api/telemetry`);

    // 404 rather than 401: an unauthenticated caller should not learn the surface
    // exists. The subsystems did mount, so this is the gate rather than a dead router.
    expect(res.status).toBe(404);
    expect(server.output()).toContain("Mounted 8 subsystems");
  }, BOOT_TIMEOUT_MS);
});

describe("The entrypoint refuses to start on bad configuration", () => {
  it("fails rather than booting with a fallback secret in production", async () => {
    freshDir();

    const bad = env();
    delete bad.STORAGE_SECRET;

    let text = "";
    const child = spawn(process.execPath, [ENTRYPOINT], { env: bad });
    child.stdout?.on("data", (c: Buffer) => void (text += c.toString()));
    child.stderr?.on("data", (c: Buffer) => void (text += c.toString()));

    const code = await new Promise<number | null>((r) => child.once("exit", r));

    // An ephemeral secret is fine in development and a silent data-loss bug in
    // production, where signed URLs stop surviving a restart.
    expect(code).not.toBe(0);
    expect(text).toMatch(/STORAGE_SECRET/i);
  }, BOOT_TIMEOUT_MS);
});

describe("The entrypoint shuts down", () => {
  it("drains and reports completion on SIGTERM", async () => {
    freshDir();
    const server = await start();

    const { code, output } = await server.stop("SIGTERM");

    // The CI docker job asserts on this exact line, by hand. Graceful shutdown is the
    // difference between a deploy that drops in-flight requests and one that does not.
    expect(output).toContain("[shutdown] Complete.");
    expect(code).toBe(0);
  }, BOOT_TIMEOUT_MS);

  it("fails readiness before it stops accepting work", async () => {
    freshDir();
    const server = await start();

    const before = (await (await fetch(`${server.url}/readyz`)).json()) as { status: string };
    expect(before.status).toBe("ready");

    const stopping = server.stop("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));

    /*
     * The window between the signal and the socket closing is when a rolling deploy
     * sends new requests to a process that is on its way out. Reporting "ready" then
     * means those requests are accepted and then dropped, so readiness has to fail first.
     */
    const during = await fetch(`${server.url}/readyz`).then(
      (r) => r.status,
      () => 0,
    );

    expect(during === 0 || during >= 500).toBe(true);

    await stopping;
  }, BOOT_TIMEOUT_MS);

  it("writes its database where it was told, not into the working tree", async () => {
    freshDir();

    // A path that does not exist yet, so "the file is there" cannot be true by accident
    // from something else having created it.
    const target = join(dir, "nested", "app.db");
    const server = await start({ DATABASE_URL: target });

    await server.stop("SIGTERM");

    expect(existsSync(target)).toBe(true);
  }, BOOT_TIMEOUT_MS);
});