import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { loadEnv, EnvValidationError } from "../func/env";

/*
 * Environment validation.
 *
 * The gate between "a typo in a deploy" and "the process is quietly wrong". Every
 * case here is one that previously either started with a broken value or refused a
 * legitimate one.
 */

const ORIGINAL = { ...process.env };

/** Sets the environment for one test and puts it back afterwards. */
function withEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** A valid baseline, so each test varies one thing. */
function baseline(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "test",
    STORAGE_SECRET: "a-sufficiently-long-test-secret-value-1234",
    ...overrides,
  };
}

describe("Env — PORT", () => {
  it("accepts 0, which means any free port", () => {
    withEnv(baseline({ PORT: "0" }));

    // Refused before. A test could not bind ephemerally, and hard-coding a port in
    // a test is how two suites collide on a shared machine.
    expect(loadEnv().PORT).toBe(0);
  });

  it("accepts a normal port", () => {
    withEnv(baseline({ PORT: "4000" }));
    expect(loadEnv().PORT).toBe(4000);
  });

  it("defaults when unset", () => {
    withEnv(baseline({ PORT: undefined }));
    expect(loadEnv().PORT).toBe(4000);
  });

  it("rejects a port above the range", () => {
    withEnv(baseline({ PORT: "70000" }));
    expect(() => loadEnv()).toThrow(EnvValidationError);
  });

  it("rejects a port that is not a plain number", () => {
    // "4000abc", "0x10", "12.5" all reach Number() as something.
    for (const value of ["4000abc", "0x10", "12.5", "-1"]) {
      withEnv(baseline({ PORT: value }));
      expect(() => loadEnv()).toThrow(EnvValidationError);
    }
  });
});

describe("Env — the observe token", () => {
  it("is read when set", () => {
    withEnv(baseline({ YATTA_OBSERVE_TOKEN: "s3cret" }));
    expect(loadEnv().YATTA_OBSERVE_TOKEN).toBe("s3cret");
  });

  it("is undefined when unset, rather than an invented default", () => {
    withEnv(baseline({ YATTA_OBSERVE_TOKEN: undefined }));
    // A value silently invented here is a value nobody can find again.
    expect(loadEnv().YATTA_OBSERVE_TOKEN).toBeUndefined();
  });
});

describe("Env — an ephemeral secret", () => {
  it("is already refused in production", () => {
    withEnv({
      NODE_ENV: "production",
      STORAGE_SECRET: undefined,
      PORT: undefined,
    });

    // Not new: unset in production was always an error. Recorded because it is worth
    // being sure the gate holds — a secret that exists at all in production means
    // every restart invalidates every signed URL.
    expect(() => loadEnv()).toThrow(/STORAGE_SECRET is required/);
  });

  it("is refused in a cluster, which was the real gap", () => {
    // The case that was missed, because it did not look like production: a cluster
    // running under NODE_ENV=test or development still generates one secret per
    // worker, so a signed URL minted by worker 1 fails on worker 2 — intermittently,
    // depending on which worker serves the request. That is a failure to debug, not
    // one to log.
    withEnv({
      NODE_ENV: "development",
      STORAGE_SECRET: undefined,
      CLUSTER_WORKER_ID: "1",
      PORT: undefined,
    });

    expect(() => loadEnv()).toThrow(/ephemeral/);
    expect(() => loadEnv()).toThrow(/cluster/i);
  });

  it("is refused in a cluster even with NODE_ENV unset", () => {
    // A missing NODE_ENV defaults to development, which is where the gap was widest.
    withEnv({
      NODE_ENV: undefined,
      STORAGE_SECRET: undefined,
      CLUSTER_WORKER_ID: "0",
      PORT: undefined,
    });

    expect(() => loadEnv()).toThrow(/ephemeral/);
  });

  it("is allowed in development, where a restart is cheap", () => {
    withEnv({
      NODE_ENV: "development",
      STORAGE_SECRET: undefined,
      PORT: undefined,
    });

    // Refusing here would make the first run of a new project fail for a reason that
    // only matters in production.
    expect(loadEnv().isEphemeralSecret).toBe(true);
  });
});

describe("Env — transport limits", () => {
  it("reads both when set", () => {
    withEnv(baseline({ IDLE_TIMEOUT_SEC: "300", MAX_REQUEST_BODY_BYTES: "1048576" }));

    const env = loadEnv();
    expect(env.IDLE_TIMEOUT_SEC).toBe(300);
    expect(env.MAX_REQUEST_BODY_BYTES).toBe(1_048_576);
  });

  it("reports a malformed value rather than silently defaulting", () => {
    withEnv(baseline({ IDLE_TIMEOUT_SEC: "abc" }));

    // A default here would look like it had been configured, and the failure would
    // be an SSE stream that disappears with nothing in the log.
    expect(() => loadEnv()).toThrow(/IDLE_TIMEOUT_SEC/);
  });

  it("rejects zero for a limit", () => {
    withEnv(baseline({ MAX_REQUEST_BODY_BYTES: "0" }));
    // Zero bytes would reject every request, which is not what "unlimited" means.
    expect(() => loadEnv()).toThrow(/greater than 0/);
  });
});

// The environment is process-wide, so it is restored once at the end rather than
// left to interleave with another file's tests.
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
});