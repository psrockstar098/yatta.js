import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProject } from "../deploy/detect";
import { dockerAdapter } from "../deploy/docker";
import { buildManifest, readManifest } from "../deploy/manifest";
import { buildPlan } from "../deploy/plan";
import { runDeploy } from "../deploy/cli";

/*
 * `yatta deploy` Phase 1: engine + Docker adapter.
 *
 * The engine's promises, each pinned here:
 * - detection refuses directories that are not Yatta projects;
 * - the Docker adapter generates a Bun Dockerfile, a .dockerignore, and a
 *   CI workflow that builds exactly one commit-SHA image;
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
    const outcome = runDeploy(root, ["--yes", "--platform", "railway"]);
    expect(outcome.code).toBe(1);
    expect(outcome.lines.join("\n")).toContain("not built yet");
    expect(existsSync(join(root, "Dockerfile"))).toBe(false);
  });

  it("doctor reports a configured project", () => {
    const root = track(fixture(SCAFFOLD));
    runDeploy(root, ["--yes", "--platform", "docker"]);
    const outcome = runDeploy(root, ["doctor"]);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toContain("Configured: docker");
  });
});
