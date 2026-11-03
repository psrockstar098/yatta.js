// src/deploy/git.ts — read-only Git state for `yatta deploy`.
//
// Every helper degrades to null instead of throwing outside a Git checkout:
// deploy planning must work (with warnings) in a directory that is not a
// repo yet. Nothing here writes, commits, or pushes — the engine never
// pushes; the developer pushes, and the platform or CI deploys from that.

import { spawnSync } from "node:child_process";

function git(root: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (res.status !== 0) return null;
    const out = (res.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function gitBranch(root: string): string | null {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function gitRemote(root: string): string | null {
  return git(root, ["config", "--get", "remote.origin.url"]);
}

export function gitSha(root: string): string | null {
  return git(root, ["rev-parse", "HEAD"]);
}

/**
 * Working-tree state. "unknown" covers both "not a Git checkout" and "Git
 * failed to answer" — the planner warns on it but never claims the tree
 * is clean when it cannot see it.
 */
export function gitTreeState(root: string): "clean" | "dirty" | "unknown" {
  try {
    const res = spawnSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    if (res.status !== 0) return "unknown";
    return (res.stdout ?? "").trim() === "" ? "clean" : "dirty";
  } catch {
    return "unknown";
  }
}
