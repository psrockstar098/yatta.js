// src/deploy/cli.ts — `yatta deploy` and its lifecycle subcommands.
//
// Subcommands implemented in Phase 1: configure (default), --dry-run,
// --platform, --yes, providers, config, status, doctor. Later phases add
// logs, history, rollback, storage, backup-check, and destroy — until then
// those names print the usage instead of pretending to work.
//
// Safety rules the flags cannot bypass: generated files are never written
// over differing existing files (conflicts refuse the whole configure run);
// no push ever happens here (the developer pushes; CI or the platform
// deploys from that push); secrets are only ever referenced, never written.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProject } from "./detect";
import { dockerAdapter } from "./docker";
import { gitBranch, gitRemote, gitSha, gitTreeState } from "./git";
import { buildManifest, MANIFEST_PATH, readManifest, writeManifest } from "./manifest";
import { buildPlan, previewLines } from "./plan";
import type { DeployAdapter, DeployManifest } from "./types";

export interface DeployOutcome {
  code: number;
  lines: string[];
}

/** Adapters that exist today. The rest of Dominic's list is planned, not faked. */
const ADAPTERS: DeployAdapter[] = [dockerAdapter];
const PLANNED = ["northflank", "railway", "render"];

function adapterFor(id: string): DeployAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

interface DeployArgs {
  subcommand: string | null;
  platform: string | null;
  registry: "ghcr" | "dockerhub" | null;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(args: string[]): { parsed: DeployArgs } | { error: string } {
  const parsed: DeployArgs = {
    subcommand: null,
    platform: null,
    registry: null,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--yes") {
      parsed.yes = true;
    } else if (arg === "--platform") {
      const value = args[++i];
      if (!value) return { error: "`--platform` needs a value, e.g. `--platform docker`." };
      parsed.platform = value;
    } else if (arg === "--registry") {
      const value = args[++i];
      if (value !== "ghcr" && value !== "dockerhub") {
        return { error: "`--registry` must be `ghcr` or `dockerhub`." };
      }
      parsed.registry = value;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option "${arg}".` };
    } else if (parsed.subcommand === null) {
      parsed.subcommand = arg;
    } else {
      return { error: `Unexpected argument "${arg}".` };
    }
  }
  return { parsed };
}

function usageLines(): string[] {
  return [
    "",
    "Usage:",
    "  yatta deploy [--platform docker] [--registry ghcr|dockerhub] [--dry-run] [--yes]",
    "  yatta deploy providers",
    "  yatta deploy config",
    "  yatta deploy status",
    "  yatta deploy doctor",
    "",
    "Configure (the default) previews the plan, then writes the platform",
    "files and .yatta/deploy.json after you confirm — or with --yes.",
    "--dry-run prints the plan and changes nothing. Deploy never pushes;",
    "you push, and CI or the platform deploys from that push.",
    "",
  ];
}

/** Interactive confirmation. Non-TTY input cannot confirm: re-run with --yes. */
function confirmed(): boolean {
  if (!process.stdin.isTTY) return false;
  process.stdout.write("Ready to configure deployment? [y/N] ");
  try {
    const answer = readFileSync(0, "utf8").split("\n")[0]!.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}

function providersLines(): string[] {
  const lines = ["", "Deploy providers:"];
  for (const adapter of ADAPTERS) {
    lines.push(`  ${adapter.id} — ${adapter.label} (mode: ${adapter.getDeploymentMode()})`);
  }
  for (const id of PLANNED) {
    lines.push(`  ${id} — planned, adapter not built yet`);
  }
  lines.push("");
  return lines;
}

function doctorLines(root: string): string[] {
  const lines: string[] = ["", "Deploy doctor:"];
  const detected = detectProject(root);
  if ("error" in detected) {
    lines.push(`  ✗ ${detected.error}`, "");
    return lines;
  }
  const { project } = detected;
  const treeState = gitTreeState(root);
  const branch = gitBranch(root);
  lines.push(`  ✓ Project: ${project.name} (${project.entry})`);
  lines.push(
    `  ${treeState === "clean" ? "✓" : "!"} Git tree: ${treeState}` +
      (branch ? ` (branch ${branch})` : " (no branch found)"),
  );
  if (!gitRemote(root)) lines.push("  ! No git remote `origin` — push has nowhere to go yet.");
  const manifest = readManifest(root);
  if (!manifest) {
    lines.push("  ! Not configured yet — run `yatta deploy` to configure.");
    lines.push("");
    return lines;
  }
  lines.push(`  ✓ Configured: ${manifest.platform} (template v${manifest.templateVersion})`);
  const adapter = adapterFor(manifest.platform);
  if (!adapter) {
    lines.push(`  ! No adapter for platform "${manifest.platform}" in this build.`);
    lines.push("");
    return lines;
  }
  const plan = buildPlan(project, adapter, manifest, []);
  if (plan.conflicts.length > 0) {
    lines.push("  ! Generated files drifted from the template:");
    for (const conflict of plan.conflicts) lines.push(`    ! ${conflict.path}`);
  } else {
    lines.push("  ✓ Generated files match the template.");
  }
  const workflow = plan.writes.find((file) => file.path.endsWith("deploy.yml")) ??
    (plan.unchanged.includes(".github/workflows/deploy.yml")
      ? { path: ".github/workflows/deploy.yml", content: readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8") }
      : null);
  if (workflow && /uses: [^@\s]+@v?\d/i.test(workflow.content)) {
    lines.push("  ! Workflow actions are tag-pinned, not SHA-pinned — pin them before production use.");
  }
  lines.push("");
  return lines;
}

export function runDeploy(root: string, args: string[]): DeployOutcome {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    return { code: 1, lines: [`✗ ${parsed.error}`, ...usageLines()] };
  }
  const opts = parsed.parsed;

  if (opts.subcommand === "providers") {
    return { code: 0, lines: providersLines() };
  }

  if (opts.subcommand === "config") {
    const manifest = readManifest(root);
    if (!manifest) {
      return { code: 1, lines: ["", "Not configured yet — run `yatta deploy` to configure.", ""] };
    }
    return { code: 0, lines: ["", JSON.stringify(manifest, null, 2), ""] };
  }

  if (opts.subcommand === "status") {
    const manifest = readManifest(root);
    if (!manifest) {
      return { code: 0, lines: ["", "Deployment state: not configured", ""] };
    }
    return {
      code: 0,
      lines: [
        "",
        "Deployment state: configured",
        `Platform: ${manifest.platform} (mode: ${manifest.deployment.mode})`,
        `Branch: ${manifest.deployment.branch}`,
        `Healthcheck: ${manifest.healthcheck}`,
        `Instances: ${manifest.instances} (SQLite on a volume must stay at 1)`,
        ...(gitSha(root) ? [`Local commit: ${gitSha(root)}`] : []),
        "",
      ],
    };
  }

  if (opts.subcommand === "doctor") {
    return { code: 0, lines: doctorLines(root) };
  }

  if (opts.subcommand !== null) {
    return {
      code: 1,
      lines: [`✗ Unknown deploy subcommand "${opts.subcommand}".`, ...usageLines()],
    };
  }

  // Configure path.
  const detected = detectProject(root);
  if ("error" in detected) {
    return { code: 1, lines: ["", `✗ ${detected.error}`, ""] };
  }
  const { project } = detected;

  const existing = readManifest(root);
  const platform = opts.platform ?? existing?.platform ?? "docker";
  const adapter = adapterFor(platform);
  if (!adapter) {
    if (PLANNED.includes(platform)) {
      return {
        code: 1,
        lines: ["", `✗ The ${platform} adapter is planned but not built yet. Available now: docker.`, ""],
      };
    }
    return { code: 1, lines: ["", `✗ Unknown platform "${platform}".`, ...providersLines()] };
  }

  const validation = adapter.validate(project);
  const branch = gitBranch(root) ?? "main";
  const manifest: DeployManifest = buildManifest(
    platform,
    adapter.getDeploymentMode(),
    branch,
    adapter.getHealthcheckConfig().path,
  );
  if (platform === "docker" && opts.registry) manifest.docker = { registry: opts.registry };
  if (existing?.docker && platform === "docker" && !opts.registry) {
    manifest.docker = existing.docker;
  }

  const warnings = [...validation.warnings];
  const treeState = gitTreeState(root);
  if (treeState === "dirty") {
    warnings.push("Working tree has uncommitted changes — commit them before pushing, or the deploy will run on an older commit.");
  }
  if (treeState === "unknown") {
    warnings.push("Git state unknown here — run inside a Git checkout so branch and commit detection work.");
  }
  if (!gitRemote(root)) {
    warnings.push("No git remote `origin` — configure a remote before pushing, or nothing will deploy.");
  }
  const storage = adapter.getPersistentStorage();
  if (storage.singleInstance) {
    warnings.push(`SQLite lives on a ${storage.kind} (${storage.mountPath ?? "no mount"}) — keep instances at 1.`);
  }
  warnings.push(storage.backup);

  const plan = buildPlan(project, adapter, manifest, warnings);
  const lines = previewLines(plan);

  if (!validation.ok) {
    return { code: 1, lines: [...lines, ...validation.errors.map((e) => `✗ ${e}`), ""] };
  }
  if (plan.conflicts.length > 0) {
    return {
      code: 1,
      lines: [...lines, "✗ Refusing to overwrite the files above. Edit or move them, then re-run.", ""],
    };
  }
  if (opts.dryRun) {
    return { code: 0, lines: [...lines, "(dry run — nothing was written.)", ""] };
  }
  if (!opts.yes && !confirmed()) {
    return {
      code: 0,
      lines: [...lines, "Not confirmed. Re-run with --yes to configure without asking.", ""],
    };
  }

  for (const file of plan.writes) {
    const full = join(root, file.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, file.content, "utf8");
  }
  writeManifest(root, manifest);

  const next = [
    "✓ Deployment configured.",
    "Next steps:",
    "  1. Review the generated files, then commit and push.",
    "  2. On push, CI builds the commit-SHA image and pushes it to your registry.",
  ];
  if (platform === "docker") {
    next.push(
      "  3. Run it on a Docker host, mounting a volume at /data:",
      // The image reference stays a placeholder: the developer's repo path
      // is theirs, and guessing it here would print a wrong command.
      "     docker run -d -p 3000:3000 -v yatta-data:/data ghcr.io/<owner>/<repo>:<sha>",
    );
  }
  next.push("");
  return { code: 0, lines: [...lines, ...next] };
}

export function cmdDeploy(args: string[]): number {
  const outcome = runDeploy(process.cwd(), args);
  for (const line of outcome.lines) console.log(line);
  return outcome.code;
}
