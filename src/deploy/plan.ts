// src/deploy/plan.ts — deployment planning for `yatta deploy`.
//
// A plan is computed before anything is written. It lists exactly which
// files deploy would create or change, which existing files it refuses to
// touch, and which warnings the developer must see. `--dry-run` prints the
// plan and exits; the configure path writes only what the plan lists, and
// only after the developer confirms it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DeployAdapter, DeployManifest, GeneratedFile, ProjectInfo } from "./types";
import { MANIFEST_PATH } from "./manifest";

export interface DeployPlan {
  project: ProjectInfo;
  adapter: DeployAdapter;
  manifest: DeployManifest;
  /** Files to write (new, or existing with identical content already). */
  writes: GeneratedFile[];
  /** Existing files whose content differs — deploy refuses to overwrite these. */
  conflicts: { path: string; existing: string; proposed: string }[];
  /** Files already exactly as generated — no write needed. */
  unchanged: string[];
  warnings: string[];
}

function readExisting(root: string, path: string): string | null {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

export function buildPlan(
  project: ProjectInfo,
  adapter: DeployAdapter,
  manifest: DeployManifest,
  warnings: string[],
): DeployPlan {
  const generated = adapter.generate(project, manifest);
  const writes: GeneratedFile[] = [];
  const conflicts: DeployPlan["conflicts"] = [];
  const unchanged: string[] = [];

  for (const file of generated) {
    const existing = readExisting(project.root, file.path);
    if (existing === null) {
      writes.push(file);
    } else if (existing === file.content) {
      unchanged.push(file.path);
    } else {
      conflicts.push({ path: file.path, existing, proposed: file.content });
    }
  }

  // The manifest itself follows the same rule: never silently clobber a
  // hand-edited manifest that says something different.
  const existingManifest = readExisting(project.root, MANIFEST_PATH);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existingManifest === null) {
    writes.push({ path: MANIFEST_PATH, content: manifestContent });
  } else if (existingManifest === manifestContent) {
    unchanged.push(MANIFEST_PATH);
  } else {
    conflicts.push({
      path: MANIFEST_PATH,
      existing: existingManifest,
      proposed: manifestContent,
    });
  }

  return { project, adapter, manifest, writes, conflicts, unchanged, warnings };
}

export function previewLines(plan: DeployPlan): string[] {
  const lines: string[] = [
    "",
    "YATTA DEPLOY",
    `Project: ${plan.project.name}`,
    `Runtime: ${plan.project.runtime}`,
    `Framework: ${plan.project.framework}`,
    `Entry: ${plan.project.entry}`,
    `Deployment target: ${plan.adapter.label} (mode: ${plan.adapter.getDeploymentMode()})`,
    `Branch: ${plan.manifest.deployment.branch}`,
    "Changes:",
  ];
  if (plan.writes.length === 0) {
    lines.push("  (none — everything is already configured)");
  } else {
    for (const file of plan.writes) lines.push(`  + ${file.path}`);
  }
  if (plan.unchanged.length > 0) {
    lines.push("Unchanged:");
    for (const path of plan.unchanged) lines.push(`  = ${path}`);
  }
  if (plan.conflicts.length > 0) {
    lines.push("Refused (existing files differ — edit or move them first):");
    for (const conflict of plan.conflicts) lines.push(`  ! ${conflict.path}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  }
  const secrets = plan.adapter.getRequiredSecrets(plan.manifest);
  if (secrets.length > 0) {
    lines.push("Secrets to set (in GitHub repo secrets, never in files):");
    for (const secret of secrets) {
      lines.push(`  - ${secret.name}${secret.required ? " (required)" : ""}: ${secret.description}`);
    }
  } else {
    lines.push("Secrets: none beyond the automatic GitHub token.");
  }
  lines.push("");
  return lines;
}
