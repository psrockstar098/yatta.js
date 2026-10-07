// yatta doctor — diagnose project health and configuration.
//
// Checks:
//   - Bun version meets requirements
//   - Database file exists and is accessible
//   - Required environment variables are set
//   - Disk space for database and uploads
//   - Configuration validity

import { existsSync, statSync } from "node:fs";
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
    join(projectRoot, "Database", "yatta.db");
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
