#!/usr/bin/env node
/*
 * Block until CI has finished for the current commit, and fail if any run failed.
 *
 * Why this exists: "I pushed and it's done" was asserted five times in a row while the
 * docs CI was red, because nothing in the local workflow required looking. A green
 * `bun run check` locally says nothing about what GitHub Actions did with the push, and
 * the api-surface gate in particular passes happily on a docs page that does not
 * compile.
 *
 * So the claim becomes something a command can answer instead of something to remember:
 * run this after a push, and a red run is a non-zero exit like any other failure.
 *
 *   node scripts/verify-ci.mjs                 # this repo, current HEAD
 *   node scripts/verify-ci.mjs ../yatta-docs   # another checkout of yours
 *   node scripts/verify-ci.mjs --timeout 900
 *   node scripts/verify-ci.mjs ../yatta-docs --sha 44b3280   # re-check an old commit
 *
 * Requires the `gh` CLI, authenticated, with access to the repository.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
}

const targetDir = resolve(args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? ".");
const timeoutMs = flag("timeout", 900) * 1000;
const pollMs = flag("poll", 10) * 1000;

function git(...argv) {
  return execFileSync("git", argv, { cwd: targetDir, encoding: "utf8" }).trim();
}

function gh(...argv) {
  return JSON.parse(
    execFileSync("gh", argv, { cwd: targetDir, encoding: "utf8", maxBuffer: 8 << 20 }),
  );
}

// `gh run list --commit` matches on the full SHA, so an abbreviated one has to be
// expanded or it matches nothing and the script waits out its whole timeout.
const shaArg = args.indexOf("--sha");
const sha = git("rev-parse", shaArg === -1 ? "HEAD" : args[shaArg + 1]);
const short = sha.slice(0, 7);
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

let inFlight = false;

console.log(`verify-ci: ${targetDir}`);
console.log(`  commit ${short} on ${branch}`);

const deadline = Date.now() + timeoutMs;

while (true) {
  let runs = [];
  try {
    runs = gh("run", "list", "--commit", sha, "--limit", "20", "--json",
      "name,status,conclusion,url,workflowName");
  } catch (err) {
    // gh exits non-zero with a message when there is no run for this commit yet, which
    // is the normal state for the first few seconds after a push.
    if (!inFlight) {
      console.log("  waiting for a run to appear…");
      inFlight = true;
    }
  }

  const pending = runs.filter((r) => r.status !== "completed");

  if (runs.length > 0 && pending.length === 0) {
    const failed = runs.filter((r) => r.conclusion !== "success");

    for (const run of runs) {
      const name = run.workflowName || run.name;
      const mark = run.conclusion === "success" ? "✓" : "✗";
      console.log(`  ${mark} ${name} — ${run.conclusion}`);
    }

    if (failed.length > 0) {
      console.error("");
      for (const run of failed) {
        console.error(`FAILED: ${run.workflowName || run.name}  ${run.url}`);
      }
      console.error("");
      console.error("Not done. The push is red — fix it before saying this works.");
      process.exit(1);
    }

    console.log("");
    console.log(`All ${runs.length} workflow(s) green for ${short}.`);
    process.exit(0);
  }

  if (pending.length > 0 && !inFlight) {
    console.log(`  running: ${pending.map((r) => r.workflowName || r.name).join(", ")}…`);
    inFlight = true;
  }

  if (Date.now() > deadline) {
    console.error("");
    console.error(`verify-ci: still not finished after ${timeoutMs / 1000}s. Not a pass.`);
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, pollMs));
}