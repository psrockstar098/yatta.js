// yatta doctor — diagnose project health and configuration.
//
// Checks:
//   - Bun version meets requirements
//   - Database file exists and is accessible
//   - Required environment variables are set
//   - Disk space for database and uploads
//   - Configuration validity

import { existsSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  reset: `\x1b[0m`,
};

interface Check {
  name: string;
  pass: boolean;
  message: string;
}

export function cmdDoctor(projectRoot: string = process.cwd()): number {
  const checks: Check[] = [];

  // Bun version
  try {
    const version = Bun.version;
    const parts = version.split(".").map(Number);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const ok = major > 1 || (major === 1 && minor >= 4);
    checks.push({
      name: "Bun version",
      pass: ok,
      message: ok ? `${version} (>= 1.4.0 required)` : `${version} — upgrade to >= 1.4.0`,
    });
  } catch {
    checks.push({ name: "Bun version", pass: false, message: "Bun not found" });
  }

  // Database file
  // Same precedence as the server: `DATABASE_URL`, then the `DATABASE_PATH` alias.
  const dbPath =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PATH ||
    join(projectRoot, "Database", "app.db");
  if (existsSync(dbPath)) {
    try {
      const stat = statSync(dbPath);
      const writable = (() => {
        try {
          const fs = require("node:fs");
          fs.accessSync(dbPath, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })();
      checks.push({
        name: "Database file",
        pass: writable,
        message: writable
          ? `${dbPath} (${(stat.size / 1024).toFixed(1)} KB, writable)`
          : `${dbPath} exists but is not writable`,
      });
    } catch (e) {
      checks.push({ name: "Database file", pass: false, message: `Cannot stat ${dbPath}: ${e}` });
    }
  } else {
    checks.push({
      name: "Database file",
      pass: true, // Not an error — will be created on first run
      message: `${dbPath} not found (will be created on first run)`,
    });
  }

  // Required env vars
  const required = ["STORAGE_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  checks.push({
    name: "Environment",
    pass: missing.length === 0,
    message:
      missing.length === 0
        ? "All required variables set"
        : `Missing: ${missing.join(", ")}`,
  });

  // APP_URL for production
  if (process.env.NODE_ENV === "production" && !process.env.APP_URL) {
    checks.push({
      name: "Production config",
      pass: false,
      message: "APP_URL is required in production (for auth callbacks)",
    });
  } else {
    checks.push({
      name: "Production config",
      pass: true,
      message: process.env.NODE_ENV === "production" ? "APP_URL set" : "Not production, skipping",
    });
  }

  // AUTH_SECRET, production only — env.ts requires it there, because
  // without it JWTs can be forged and encrypted 2FA secrets decrypted.
  // Doctor used to say "All checks passed" on a project that would not
  // boot in production for exactly this reason.
  if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET) {
    checks.push({
      name: "AUTH_SECRET",
      pass: false,
      message: "AUTH_SECRET is required in production — generate one with: openssl rand -base64 32",
    });
  } else {
    checks.push({
      name: "AUTH_SECRET",
      pass: true,
      message: process.env.NODE_ENV === "production" ? "AUTH_SECRET set" : "Not production, skipping",
    });
  }

  // Disk space — the header promised this check and it was never
  // implemented. Fails under 100 MB free on the project volume: a
  // database and uploads need headroom, and a full disk corrupts
  // SQLite writes rather than failing cleanly.
  try {
    const fs = statfsSync(projectRoot);
    const freeMb = (fs.bavail * fs.bsize) / (1024 * 1024);
    const ok = freeMb >= 100;
    checks.push({
      name: "Disk space",
      pass: ok,
      message: ok
        ? `${freeMb.toFixed(0)} MB free on the project volume`
        : `Only ${freeMb.toFixed(1)} MB free on the project volume — free space before the database grows`,
    });
  } catch {
    checks.push({
      name: "Disk space",
      pass: true,
      message: "Could not measure free disk space (skipped)",
    });
  }

  // Print results
  console.log("");
  console.log(`  ${c.bold("yatta doctor")}`);
  console.log("");
  let failed = 0;
  for (const check of checks) {
    const icon = check.pass ? c.green("✓") : c.red("✗");
    console.log(`  ${icon} ${check.name}: ${check.message}`);
    if (!check.pass) failed++;
  }
  console.log("");
  if (failed > 0) {
    console.log(`  ${c.red(`${failed} check(s) failed`)}`);
  } else {
    console.log(`  ${c.green("All checks passed")}`);
  }
  console.log("");

  return failed > 0 ? 1 : 0;
}
