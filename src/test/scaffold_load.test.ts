import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A scaffolded server, under load, through its file-based routes.
 *
 * The defect this exists for was invisible to every other test: the file router called
 * `reload()` on every request, which mutates the route table while `match()` reads it.
 * Measured on a fresh scaffold it failed 40 of 100 concurrent requests to a file-routed
 * path with a 500, while the same handler reached through `/api` was 75/75 clean — so
 * it looked like a bug in the health route, and the route was fine.
 *
 * A unit test for the throttle proves the function. This proves the symptom, on the
 * path it was reported from, which is the only version of the claim that means anything.
 */

const ROOT = join(import.meta.dir, "..", "..");
const PORT = 4187;
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let server: ChildProcess | undefined;

/**
 * Waits until the server answers at all.
 *
 * Deliberately accepts a 500 as "up". Requiring a healthy status here would make the
 * very failure this file exists for abort the suite in `beforeAll`, so every assertion
 * below — the ones that name the symptom — would be skipped instead of reporting it.
 */
async function waitForUp(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/health`);
      return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");

  dir = mkdtempSync(join(tmpdir(), "yatta-load-"));
  execFileSync("bun", ["run", join(ROOT, "src", "cli.ts"), "link"], { cwd: ROOT, timeout: 180_000 });
  execFileSync("bun", ["run", join(ROOT, "src", "cli.ts"), "new", "app"], { cwd: dir, timeout: 180_000 });

  const app = join(dir, "app");
  execFileSync("bun", ["install"], { cwd: app, timeout: 180_000 });
  execFileSync("bun", ["link", "yatta.js"], { cwd: app, timeout: 180_000 });

  if (!existsSync(join(app, "node_modules", "yatta.js"))) {
    throw new Error("scaffold did not link; the load test below would be meaningless");
  }

  server = spawn("bun", ["run", "start"], {
    cwd: app,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!(await waitForUp())) throw new Error("scaffolded server did not come up");
}, 420_000);

afterAll(() => {
  server?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** One request. Status and body come from the same response — two `curl`s per sample
 *  is how this was first measured wrong, reporting a status from one request beside the
 *  body of the next. */
async function probe(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

describe("a scaffolded server under concurrent load", () => {
  it("serves every concurrent request to a file-routed path", async () => {
    /*
     * 40 of 100 failed before the throttle. 100 is not a magic number — it is what
     * reliably reproduced the race, and a test that passes at 8 would not have caught
     * anything.
     */
    const results = await Promise.all(Array.from({ length: 100 }, () => probe("/health")));

    const failures = results.filter((r) => r.status >= 500);

    expect(failures.map((f) => f.status)).toEqual([]);
    expect(results.filter((r) => r.body.includes('"error"'))).toEqual([]);
  });

  it("gives the same answer to every one of them", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => probe("/health")));

    // A shared or cached Response would show up here as one body with another request's
    // status. Distinct bodies mean nothing is being reused across in-flight requests.
    const shapes = new Set(results.map((r) => r.body.slice(0, 24)));

    expect(shapes.size).toBe(1);
    expect(new Set(results.map((r) => r.status)).size).toBe(1);
  });

  it("still routes /api paths, which do not go through the file router", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => probe("/api/auth/me")),
    );

    // 401 is the correct answer without a token; what matters is that it is consistent
    // and never a 5xx.
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([401]));
  });

  it("serves the root route, which is the other file-routed path", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => probe("/")));

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(new Set(results.map((r) => r.status)).size).toBe(1);
  });

  it("recovers immediately — no 5xx on the request right after a burst", async () => {
    await Promise.all(Array.from({ length: 30 }, () => probe("/health")));

    expect((await probe("/health")).status).toBe(200);
  });
});