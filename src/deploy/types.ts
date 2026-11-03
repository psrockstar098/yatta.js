// src/deploy/types.ts — the one-command deployment engine's shared types.
//
// The engine owns detection, the manifest, planning, safety, and Git state.
// A platform adapter owns exactly one provider: its files, its mode, its
// secrets, its storage story, its healthcheck, and its rollback story.
// Adding a provider means adding one adapter, never rewriting the engine.

export type DeploymentMode = "native" | "github-actions";

export interface ProjectInfo {
  /** Absolute path of the project root (where `yatta deploy` runs). */
  root: string;
  /** package.json name, or the directory name when there is no package.json. */
  name: string;
  /** Server entrypoint relative to root, e.g. "yatta/main.ts". */
  entry: string;
  /** Yatta is Bun-first; a detected Yatta project always reports "bun". */
  runtime: "bun";
  framework: "yatta";
}

export interface GeneratedFile {
  /** Path relative to the project root, e.g. "Dockerfile". */
  path: string;
  content: string;
}

export interface SecretDefinition {
  name: string;
  required: boolean;
  description: string;
}

export interface StorageCapabilities {
  kind: "volume" | "ephemeral" | "managed";
  /** Where durable data lives, when the platform has a volume concept. */
  mountPath?: string;
  /** True when the app must run as exactly one instance (SQLite on a volume). */
  singleInstance: boolean;
  /** What backup actually exists — never "a disk is a backup". */
  backup: string;
}

export interface HealthcheckConfig {
  path: string;
  kind: "liveness" | "readiness";
}

export interface RollbackCapabilities {
  kind: "image-tag" | "platform-deployment" | "none";
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DeployAdapter {
  /** Stable id used in the manifest and on the CLI, e.g. "docker". */
  id: string;
  label: string;
  getDeploymentMode(): DeploymentMode;
  /** Secrets the developer must set. The manifest matters: GHCR needs none
   * beyond the automatic token, Docker Hub needs account secrets. */
  getRequiredSecrets(manifest: DeployManifest): SecretDefinition[];
  getPersistentStorage(): StorageCapabilities;
  getHealthcheckConfig(): HealthcheckConfig;
  getRollbackCapabilities(): RollbackCapabilities;
  validate(project: ProjectInfo): ValidationResult;
  generate(project: ProjectInfo, manifest: DeployManifest): GeneratedFile[];
}

/**
 * `.yatta/deploy.json` — intent, not a dump of every platform option.
 * A developer can read it, edit it by hand, and re-running `yatta deploy`
 * must produce the same files from it.
 */
export interface DeployManifest {
  version: 1;
  platform: string;
  runtime: "bun";
  region: string;
  instances: number;
  healthcheck: string;
  database: { type: string; persistent: boolean };
  deployment: { mode: DeploymentMode; branch: string };
  /** Template version that generated the platform files (see §5 of the design). */
  templateVersion: number;
  /** Docker-adapter-only options; absent for every other adapter. */
  docker?: { registry?: "ghcr" | "dockerhub" };
}

/** Bump when a generated file template changes shape. */
export const DEPLOY_TEMPLATE_VERSION = 1;
