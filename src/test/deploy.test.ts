import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";

import { detectProject } from "../deploy/detect";
import { dockerAdapter } from "../deploy/docker";
import { buildManifest, readManifest } from "../deploy/manifest";
import { buildPlan } from "../deploy/plan";
import { runDeploy } from "../deploy/cli";
import { northflankAdapter } from "../deploy/northflank";
import { railwayAdapter } from "../deploy/railway";

/*
 * `yatta deploy`: engine + Docker, Railway, and Northflank adapters.
 *
 * The engine's promises, each pinned here:
 * - detection refuses directories that are not Yatta projects;
 * - the Docker adapter generates a Bun Dockerfile, a .dockerignore, and a
 *   CI workflow that builds exactly one commit-SHA image;
 * - the Railway adapter generates .railway/railway.ts (Infrastructure as
 *   Code — never the deprecated railway.json) plus a check-only workflow;
 * - the Northflank adapter generates the same Bun Dockerfile plus a
 *   check-then-deploy workflow using the first-party Deploy action;
 * - no generated file ever contains a credential value, only references;
 * - planning refuses to overwrite an existing file that differs;
 * - configuring twice is idempotent (the second run writes nothing new).
 */

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "yatta-deploy-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

const SCAFFOLD = {
  "package.json": JSON.stringify(
    { name: "my-api", dependencies: { "yatta.js": "^1.0.5" } },
    null,
    2,
  ),
  "yatta/main.ts": "// entry\n",
};

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function track(root: string): string {
  roots.push(root);
  return root;
}

describe("detection", () => {
  it("detects a Yatta scaffold", () => {
    const root = track(fixture(SCAFFOLD));
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    expect(detected.project.name).toBe("my-api");
    expect(detected.project.entry).toBe("yatta/main.ts");
    expect(detected.project.runtime).toBe("bun");
    expect(detected.project.framework).toBe("yatta");
  });

  it("refuses a directory without an entrypoint", () => {
    const root = track(fixture({ "package.json": "{}" }));
    const detected = detectProject(root);
    expect("error" in detected).toBe(true);
  });

  it("refuses a project that is not Yatta", () => {
    const root = track(
      fixture({
        "package.json": JSON.stringify({ name: "other", dependencies: { express: "^4.0.0" } }),
        "yatta/main.ts": "// entry\n",
      }),
    );
    // A yatta/ directory counts as Yatta even without the dependency, so
    // this fixture must NOT have one: use src/main.ts instead.
    rmSync(join(root, "yatta"), { recursive: true, force: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/main.ts"), "// entry\n", "utf8");
    const detected = detectProject(root);
    expect("error" in detected).toBe(true);
  });
});

describe("docker adapter", () => {
  it("generates a Bun Dockerfile with liveness healthcheck and a data volume", () => {
    const root = track(fixture(SCAFFOLD));
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    const manifest = buildManifest("docker", "github-actions", "main", "/health/z");
    const files = dockerAdapter.generate(detected.project, manifest);
    const dockerfile = files.find((f) => f.path === "Dockerfile")!;
    expect(dockerfile.content).toContain("oven/bun");
    expect(dockerfile.content).toContain('CMD ["bun", "yatta/main.ts"]');
    expect(dockerfile.content).toContain("/health/z");
    expect(dockerfile.content).toContain('VOLUME ["/data"]');
    expect(dockerfile.content).toContain("EXPOSE 3000");
    const workflow = files.find((f) => f.path === ".github/workflows/deploy.yml")!;
    expect(workflow.content).toContain("production-deploy");
    expect(workflow.content).toContain("cancel-in-progress: false");
    expect(workflow.content).toContain("packages: write");
    expect(workflow.content).toContain("${{ github.sha }}");
    // References only: no credential value may appear in generated files.
    for (const file of files) {
      expect(file.content).not.toContain("ghp_");
      expect(file.content).not.toContain("gho_");
    }
    expect(dockerAdapter.getRequiredSecrets(manifest)).toEqual([]);
    expect(dockerAdapter.getPersistentStorage().singleInstance).toBe(true);
    expect(dockerAdapter.getHealthcheckConfig().path).toBe("/health/z");
    expect(dockerAdapter.getRollbackCapabilities().kind).toBe("image-tag");
  });

  it("requires Docker Hub secrets only for the dockerhub registry", () => {
    const manifest = buildManifest("docker", "github-actions", "main", "/health/z");
    manifest.docker = { registry: "dockerhub" };
    const names = dockerAdapter.getRequiredSecrets(manifest).map((s) => s.name);
    expect(names).toContain("DOCKERHUB_USERNAME");
    expect(names).toContain("DOCKERHUB_TOKEN");
  });
});

describe("railway adapter", () => {
  it("generates .railway/railway.ts with Railpack, liveness healthcheck, one replica, and a data volume", () => {
    const root = track(fixture(SCAFFOLD));
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    const manifest = buildManifest("railway", "native", "main", "/health/z");
    const files = railwayAdapter.generate(detected.project, manifest);
    // No Config as Code: railway.json is deprecated and unread after 2026-12-01.
    expect(files.map((f) => f.path)).not.toContain("railway.json");
    expect(files.map((f) => f.path)).not.toContain("railway.toml");
    const railwayTs = files.find((f) => f.path === ".railway/railway.ts")!;
    expect(railwayTs.content).toContain('from "railway/iac"');
    expect(railwayTs.content).toContain("defineRailway");
    expect(railwayTs.content).toContain('builder: "RAILPACK"');
    expect(railwayTs.content).toContain('start: "bun yatta/main.ts"');
    expect(railwayTs.content).toContain('healthcheck: "/health/z"');
    expect(railwayTs.content).toContain("replicas: 1");
    expect(railwayTs.content).toContain('volume("my-api-data")');
    expect(railwayTs.content).toContain('volumeMounts: { "/data": data }');
    // No Git remote in the fixture, so no source is declared — and the file
    // says so instead of guessing a repository. (The comment mentions the
    // source line as an example, so match a real code line, not the word.)
    expect(railwayTs.content).not.toContain('\n    source: github(');
    expect(railwayTs.content).toContain("No GitHub remote was found");
    const workflow = files.find((f) => f.path === ".github/workflows/deploy.yml")!;
    expect(workflow.content).toContain("name: Check");
    expect(workflow.content).toContain("bun x tsc --noEmit");
    expect(workflow.content).toContain("bun test");
    expect(workflow.content).toContain("contents: read");
    // Check only: no deploy job, no registry write permission.
    expect(workflow.content).not.toContain("packages: write");
    expect(workflow.content).not.toContain("build-and-push");
    expect(railwayAdapter.getDeploymentMode()).toBe("native");
    expect(railwayAdapter.getRequiredSecrets(manifest)).toEqual([]);
    expect(railwayAdapter.getPersistentStorage().singleInstance).toBe(true);
    expect(railwayAdapter.getPersistentStorage().mountPath).toBe("/data");
    expect(railwayAdapter.getHealthcheckConfig().path).toBe("/health/z");
    expect(railwayAdapter.getRollbackCapabilities().kind).toBe("platform-deployment");
  });

  it("declares the GitHub source when a GitHub remote exists", () => {
    const root = track(fixture(SCAFFOLD));
    spawnSync("git", ["-C", root, "init", "-q"]);
    spawnSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/web.git"]);
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    const manifest = buildManifest("railway", "native", "main", "/health/z");
    const files = railwayAdapter.generate(detected.project, manifest);
    const railwayTs = files.find((f) => f.path === ".railway/railway.ts")!;
    expect(railwayTs.content).toContain('source: github("acme/web")');
  });
});

describe("northflank adapter", () => {
  it("generates the Bun Dockerfile plus a check-then-deploy workflow using the first-party action", () => {
    const root = track(fixture(SCAFFOLD));
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    const manifest = buildManifest("northflank", "github-actions", "main", "/health/z");
    const files = northflankAdapter.generate(detected.project, manifest);
    const dockerfile = files.find((f) => f.path === "Dockerfile")!;
    expect(dockerfile.content).toContain("oven/bun");
    expect(dockerfile.content).toContain('CMD ["bun", "yatta/main.ts"]');
    expect(dockerfile.content).toContain("/health/z");
    expect(dockerfile.content).toContain('VOLUME ["/data"]');
    const workflow = files.find((f) => f.path === ".github/workflows/deploy.yml")!;
    expect(workflow.content).toContain("production-deploy");
    expect(workflow.content).toContain("cancel-in-progress: false");
    expect(workflow.content).toContain("packages: write");
    // Check job gates the deploy job, per the Mode B design.
    expect(workflow.content).toContain("bun x tsc --noEmit");
    expect(workflow.content).toContain("bun test");
    expect(workflow.content).toContain("needs: check");
    // First-party action, exactly as its action.yml defines it.
    expect(workflow.content).toContain("northflank/deploy-to-northflank@v1");
    expect(workflow.content).toContain("northflank-api-key: ${{ secrets.NORTHFLANK_API_KEY }}");
    expect(workflow.content).toContain("project-id: ${{ secrets.NORTHFLANK_PROJECT_ID }}");
    expect(workflow.content).toContain("service-id: ${{ secrets.NORTHFLANK_SERVICE_ID }}");
    expect(workflow.content).toContain("image-path: ghcr.io/${{ github.repository }}:${{ github.sha }}");
    expect(workflow.content).toContain("credentials-id: github");
    // References only: no credential value may appear in generated files.
    for (const file of files) {
      expect(file.content).not.toContain("nf_");
    }
    expect(northflankAdapter.getDeploymentMode()).toBe("github-actions");
    expect(northflankAdapter.getRequiredSecrets(manifest).map((s) => s.name)).toEqual([
      "NORTHFLANK_API_KEY",
      "NORTHFLANK_PROJECT_ID",
      "NORTHFLANK_SERVICE_ID",
    ]);
    expect(northflankAdapter.getPersistentStorage().singleInstance).toBe(true);
    expect(northflankAdapter.getHealthcheckConfig().path).toBe("/health/z");
    expect(northflankAdapter.getRollbackCapabilities().kind).toBe("image-tag");
  });
});

describe("planning", () => {
  it("refuses an existing file that differs, skips one that matches", () => {
    const root = track(fixture({ ...SCAFFOLD, Dockerfile: "MY OWN DOCKERFILE\n" }));
    const detected = detectProject(root);
    expect("error" in detected).toBe(false);
    if ("error" in detected) return;
    const manifest = buildManifest("docker", "github-actions", "main", "/health/z");
    const plan = buildPlan(detected.project, dockerAdapter, manifest, []);
    expect(plan.conflicts.map((c) => c.path)).toContain("Dockerfile");
    expect(plan.writes.map((f) => f.path)).toContain(".dockerignore");

    const matching = track(fixture(SCAFFOLD));
    const detected2 = detectProject(matching);
    if ("error" in detected2) return;
    const generated = dockerAdapter.generate(detected2.project, manifest)[0]!;
    writeFileSync(join(matching, "Dockerfile"), generated.content, "utf8");
    const plan2 = buildPlan(detected2.project, dockerAdapter, manifest, []);
    expect(plan2.conflicts.map((c) => c.path)).not.toContain("Dockerfile");
    expect(plan2.unchanged).toContain("Dockerfile");
  });
});

describe("deploy command", () => {
  it("lists providers, including planned ones it does not fake", () => {
    const root = track(fixture(SCAFFOLD));
    const outcome = runDeploy(root, ["providers"]);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("docker");
    expect(outcome.lines.join("\n")).toContain("railway");
    expect(outcome.lines.join("\n")).toContain("northflank");
    expect(outcome.lines.join("\n")).toContain("render — planned, adapter not built yet");
  });

  it("dry-run writes nothing", () => {
    const root = track(fixture(SCAFFOLD));
    const outcome = runDeploy(root, ["--dry-run", "--platform", "docker"]);
    expect(outcome.code).toBe(0);
    expect(existsSync(join(root, "Dockerfile"))).toBe(false);
    expect(existsSync(join(root, ".yatta/deploy.json"))).toBe(false);
    expect(outcome.lines.join("\n")).toContain("Dockerfile");
  });

  it("configures with --yes and is idempotent on the second run", () => {
    const root = track(fixture(SCAFFOLD));
    const first = runDeploy(root, ["--yes", "--platform", "docker"]);
    expect(first.code).toBe(0);
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
    const manifest = readManifest(root);
    expect(manifest?.platform).toBe("docker");
    expect(manifest?.healthcheck).toBe("/health/z");
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("yatta/main.ts");

    const second = runDeploy(root, ["--yes", "--platform", "docker"]);
    expect(second.code).toBe(0);
    expect(second.lines.join("\n")).toContain("already configured");
  });

  it("refuses a planned-but-unbuilt platform honestly", () => {
    const root = track(fixture(SCAFFOLD));
    const outcome = runDeploy(root, ["--yes", "--platform", "render"]);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("not built yet");
    expect(existsSync(join(root, "Dockerfile"))).toBe(false);
  });

  it("configures northflank with --yes and is idempotent on the second run", () => {
    const root = track(fixture(SCAFFOLD));
    const first = runDeploy(root, ["--yes", "--platform", "northflank"]);
    expect(first.code).toBe(0);
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
    expect(existsSync(join(root, ".github/workflows/deploy.yml"))).toBe(true);
    expect(readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8")).toContain(
      "northflank/deploy-to-northflank@v1",
    );
    const manifest = readManifest(root);
    expect(manifest?.platform).toBe("northflank");
    expect(manifest?.deployment.mode).toBe("github-actions");

    const second = runDeploy(root, ["--yes", "--platform", "northflank"]);
    expect(second.code).toBe(0);
    expect(second.lines.join("\n")).toContain("already configured");
  });

  it("configures railway with --yes and writes the IaC file", () => {
    const root = track(fixture(SCAFFOLD));
    const outcome = runDeploy(root, ["--yes", "--platform", "railway"]);
    expect(outcome.code).toBe(0);
    expect(existsSync(join(root, ".railway/railway.ts"))).toBe(true);
    expect(existsSync(join(root, ".github/workflows/deploy.yml"))).toBe(true);
    expect(existsSync(join(root, "railway.json"))).toBe(false);
    const manifest = readManifest(root);
    expect(manifest?.platform).toBe("railway");
    expect(manifest?.deployment.mode).toBe("native");
    expect(outcome.lines.join("\n")).toContain("railway config plan");

    const second = runDeploy(root, ["--yes", "--platform", "railway"]);
    expect(second.code).toBe(0);
    expect(second.lines.join("\n")).toContain("already configured");
  });

  it("doctor reports a configured project", () => {
    const root = track(fixture(SCAFFOLD));
    runDeploy(root, ["--yes", "--platform", "docker"]);
    const outcome = runDeploy(root, ["doctor"]);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("Configured: docker");
  });
});
