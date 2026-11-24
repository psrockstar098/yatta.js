import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdDoctor } from "../cli_doctor";

/*
 * `yatta doctor` promises a disk-space check in its header and must
 * catch a production project that would not boot — AUTH_SECRET is
 * required in production by env.ts, and doctor used to say "All checks
 * passed" without it.
 */

let dir: string;
let savedEnv: Record<string, string | undefined>;

function capture(fn: () => number): { code: number; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg = "") => void lines.push(String(msg));
  try {
    return { code: fn(), lines };
  } finally {
    console.log = original;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yatta-doctor-"));
  savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    STORAGE_SECRET: process.env.STORAGE_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    APP_URL: process.env.APP_URL,
  };
  delete process.env.NODE_ENV;
  delete process.env.STORAGE_SECRET;
  delete process.env.AUTH_SECRET;
  delete process.env.APP_URL;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("yatta doctor", () => {
  it("fails in production without AUTH_SECRET, passes with it", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_SECRET = "s3cret";
    process.env.APP_URL = "https://example.com";
    const without = capture(() => cmdDoctor(dir));
    expect(without.code).toBe(1);
    expect(without.lines.join("\n")).toMatch(/AUTH_SECRET.*required in production/);

    process.env.AUTH_SECRET = "auth-secret";
    const withSecret = capture(() => cmdDoctor(dir));
    expect(withSecret.code).toBe(0);
    expect(withSecret.lines.join("\n")).toContain("All checks passed");
  });

  it("reports disk space instead of only promising it", () => {
    process.env.STORAGE_SECRET = "s3cret";
    const { lines } = capture(() => cmdDoctor(dir));
    expect(lines.join("\n")).toMatch(/Disk space: .* MB free/);
  });
});
