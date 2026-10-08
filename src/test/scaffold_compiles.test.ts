import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A scaffolded project has to compile.
 *
 * `yatta new` emits TypeScript, and the framework's own `bun run check` cannot see any
 * of it — the templates are strings inside src/cli.ts. So a template that referenced a
 * name it did not import shipped green: the error was only visible to someone who ran
 * the CLI, and the first person to do that was checking the CLI on purpose.
 *
 * Two bugs got through this way before this file existed, both of which made a fresh
 * project unusable: `bun link yatta` when the package is `yatta.js`, and
 * `throttledReload` used by two templates without being imported.
 *
 * So this scaffolds a project, links this checkout into it, and typechecks the result.
 * It is the slowest test in the suite by some margin and that is the cost of the gate.
 */

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli.ts");

let workDir: string;

function run(args: string[], cwd: string, timeoutMs = 180_000): string {
  return execFileSync("bun", ["run", CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "yatta-scaffold-"));
  run(["link"], ROOT);
  run(["new", "probe"], workDir);
}, 240_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const project = () => join(workDir, "probe");

/**
 * Typechecks the scaffolded project.
 *
 * Returns the compiler output rather than throwing, so a failure is a readable
 * assertion instead of an opaque non-zero exit.
 */
function typecheck(cwd: string): string {
  try {
    return execFileSync("bunx", ["tsc", "--noEmit"], {
      cwd,
      encoding: "utf8",
      timeout: 240_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("a scaffolded project compiles", () => {
  it("creates the expected layout", () => {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "yatta/main.ts",
      "yatta/backend/index.ts",
      "yatta/backend/routes.ts",
      "yatta/func/db.ts",
      "yatta/func/cache.ts",
      "yatta/func/storage.ts",
    ]) {
      expect(existsSync(join(project(), file))).toBe(true);
    }
  });

  it("declares no framework dependency, because it is meant to be linked", () => {
    const pkg = JSON.parse(readFileSync(join(project(), "package.json"), "utf8"));

    expect(pkg.dependencies).toBeUndefined();
  });

  it("typechecks once this checkout is linked in", () => {
    // The name has to match package.json's, or node_modules gets a `yatta` directory
    // while every template imports `yatta.js/*` and nothing resolves.
    const name = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;

    execFileSync("bun", ["link", name], { cwd: project(), encoding: "utf8", timeout: 120_000 });

    const errors = typecheck(project());

    expect(errors.trim()).toBe("");
  }, 300_000);

  it("imports only names that the api entry point actually exports", () => {
    const barrel = readFileSync(join(ROOT, "src", "types", "index.ts"), "utf8");

    // Every identifier the templates pull from yatta.js/api has to be re-exported by
    // src/types/index.ts, which is what "./api" resolves to. Adding a name to api.ts
    // without adding it here fails only in a consumer project.
    const templates = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
    const match = templates.match(/import \{([^}]*)\} from "yatta\.js\/api";/g) ?? [];

    expect(match.length).toBeGreaterThan(0);

    for (const statement of match) {
      const names = statement
        .replace(/import \{|\} from "yatta\.js\/api";/g, "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);

      for (const name of names) {
        expect(barrel).toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it("never tells the user to link the wrong package name", () => {
    const name = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name;

    // Asserted on what the CLI prints, not on the source: the bug was `bun link yatta`
    // printed next to templates importing `yatta.js/api`, and a fresh project could not
    // typecheck while every instruction on screen looked correct.
    const output = run(["link"], ROOT);

    expect(output).toContain(`bun link ${name}`);
    expect(output).not.toMatch(/bun link yatta\b(?!\.js)/);
  }, 120_000);

  it("refuses a flag where a project name belongs", () => {
    // `yatta new --help` used to scaffold a directory called --help.
    const output = run(["new", "--help"], workDir);

    expect(output).toMatch(/yatta new <name>/);
    expect(existsSync(join(workDir, "--help"))).toBe(false);
  });

  it("refuses an unknown option rather than using it as a name", () => {
    const output = run(["new", "--bogus"], workDir);

    expect(output).toMatch(/Unknown option/);
    expect(existsSync(join(workDir, "--bogus"))).toBe(false);
  });

  it("prints usage for a subcommand that takes a path, without creating anything", () => {
    const output = run(["db:restore", "--help"], workDir);

    expect(output).toMatch(/yatta db:restore/);
    expect(existsSync(join(workDir, "--help"))).toBe(false);
  });

  it("does not let a stray flag create a file named after it", () => {
    const marker = join(workDir, "sentinel.txt");
    writeFileSync(marker, "x");

    try {
      run(["migrate:make", "--force"], workDir);
    } catch {
      // A non-zero exit is fine; what matters is the file.
    }

    expect(existsSync(join(workDir, "--force"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});