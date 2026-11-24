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

/**
 * Why a manifest on disk is unusable, or null when it is fine or absent.
 *
 * `readManifest` returns null for both "no manifest yet" and "manifest is
 * corrupt", and callers need to tell those apart: a missing manifest means
 * "not configured", a corrupt one means "re-run deploy" — and a half-written
 * manifest must never reach a caller that reads `manifest.deployment.mode`
 * and crashes with a TypeError on `undefined`.
 */
export function readManifestError(root: string): string | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "it is not valid JSON";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "it is not a JSON object";
  }
  const m = parsed as Record<string, unknown>;
  if (m.version !== 1) return "its `version` is not 1";
  if (typeof m.platform !== "string" || m.platform === "") return "its `platform` is missing";
  if (typeof m.healthcheck !== "string" || m.healthcheck === "") return "its `healthcheck` is missing";
  if (typeof m.instances !== "number") return "its `instances` is missing";
  if (typeof m.templateVersion !== "number") return "its `templateVersion` is missing";
  const deployment = m.deployment as Record<string, unknown> | undefined;
  if (deployment === null || typeof deployment !== "object" || Array.isArray(deployment)) {
    return "its `deployment` section is missing";
  }
  if (typeof deployment.mode !== "string" || deployment.mode === "") {
    return "its `deployment.mode` is missing";
  }
  if (typeof deployment.branch !== "string" || deployment.branch === "") {
    return "its `deployment.branch` is missing";
  }
  return null;
}

export function readManifest(root: string): DeployManifest | null {
  if (readManifestError(root) !== null) return null;
  try {
    return JSON.parse(readFileSync(manifestPath(root), "utf8")) as DeployManifest;
  } catch {
    return null;
  }
}

export function writeManifest(root: string, manifest: DeployManifest): void {
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
