// src/deploy/manifest.ts — `.yatta/deploy.json`, read and written by the engine.
//
// The manifest is the single source of truth for what `yatta deploy`
// configured. Re-running deploy from an existing manifest must be
// predictable: same platform, same mode, same branch, same template version.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEPLOY_TEMPLATE_VERSION, type DeploymentMode, type DeployManifest } from "./types";

export const MANIFEST_PATH = ".yatta/deploy.json";

export function manifestPath(root: string): string {
  return join(root, MANIFEST_PATH);
}

export function buildManifest(
  platform: string,
  mode: DeploymentMode,
  branch: string,
  healthcheck: string,
): DeployManifest {
  return {
    version: 1,
    platform,
    runtime: "bun",
    region: "auto",
    instances: 1,
    healthcheck,
    database: { type: "sqlite", persistent: true },
    deployment: { mode, branch },
    templateVersion: DEPLOY_TEMPLATE_VERSION,
  };
}

export function readManifest(root: string): DeployManifest | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { platform?: unknown }).platform !== "string"
    ) {
      return null;
    }
    return parsed as DeployManifest;
  } catch {
    return null;
  }
}

export function writeManifest(root: string, manifest: DeployManifest): void {
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
