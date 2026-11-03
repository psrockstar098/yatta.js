// src/deploy/detect.ts — project detection for `yatta deploy`.
//
// Detection mirrors what the CLI already knows: a Yatta project is a directory
// with `yatta/main.ts` (or `src/main.ts`) as its entrypoint, the same two
// entrypoints `yatta dev`/`start` accept. Nothing here guesses a framework
// from a file name alone — the yatta/ directory or a yatta.js dependency
// must be present, or this is not a Yatta project and deploy refuses.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ProjectInfo } from "./types";

const ENTRYPOINTS = ["yatta/main.ts", "src/main.ts"] as const;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const names: string[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = pkg[key];
    if (deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
      names.push(...Object.keys(deps as Record<string, unknown>));
    }
  }
  return names;
}

/**
 * Detect a Yatta project at `root`, or return null with the reason why
 * this directory is not one. Detection never writes anything.
 */
export function detectProject(
  root: string,
): { project: ProjectInfo } | { error: string } {
  const pkg = readJson(join(root, "package.json"));
  const entry = ENTRYPOINTS.find((candidate) => existsSync(join(root, candidate)));

  if (!entry) {
    return {
      error:
        "No yatta/main.ts or src/main.ts found here. `yatta deploy` must run from inside a Yatta project.",
    };
  }

  const isYatta =
    existsSync(join(root, "yatta")) ||
    dependencyNames(pkg).includes("yatta.js");

  if (!isYatta) {
    return {
      error:
        "This does not look like a Yatta project: no yatta/ directory and no yatta.js dependency. `yatta deploy` only deploys Yatta apps.",
    };
  }

  const name =
    typeof pkg?.name === "string" && pkg.name.length > 0
      ? pkg.name
      : basename(root);

  return { project: { root, name, entry, runtime: "bun", framework: "yatta" } };
}
