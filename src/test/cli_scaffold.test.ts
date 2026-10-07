import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scaffoldInto, writeYattaFolder, TEMPLATE_MAIN } from "../cli";

/*
 * `yatta new` produces the first project anyone touches, and it had thirteen
 * unresolved imports.
 *
 * `cmdNew` wrote `TEMPLATE_MAIN` to `src/main.ts` and handed it a package.json whose
 * scripts ran `yatta/main.ts`. That entrypoint's own header says `yatta/main.ts`, and
 * it imports eleven subsystems plus two backend files — none of which `new` wrote. So
 * a fresh project could not typecheck and could not start, and the "Next steps" it
 * printed led straight to the failure.
 *
 * The templates are string literals, so `tsc --noEmit` in this repo never sees them.
 * That is the whole reason this went unnoticed, and the reason these tests exist.
 */

const scratch = mkdtempSync(join(tmpdir(), "yatta-new-"));
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh project, exactly as `yatta new <name>` would leave it. */
function newProject(name: string): string {
  const dir = join(scratch, name);
  scaffoldInto(dir);
  created.push(dir);
  return dir;
}

/**
 * Every relative import in the project's TypeScript, resolved against the filesystem.
 *
 * This is the check that matters. A scaffold that only fails at runtime is worth
 * catching; one that fails to typecheck is worse, because the first thing a developer
 * runs is usually `check`.
 */
function unresolvedImports(dir: string): string[] {
  const missing: string[] = [];

  const walk = (folder: string): void => {
    for (const entry of require("node:fs").readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      const path = join(folder, entry.name);

      if (entry.isDirectory()) {
        walk(path);
        continue;
      }

      if (!entry.name.endsWith(".ts")) continue;

      const source = readFileSync(path, "utf8");

      // Bare `yatta/...` specifiers need the dependency linked, which is a separate
      // concern from whether the files this project generates exist.
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const specifier = match[1]!;
        const base = join(folder, specifier);
        const found =
          existsSync(base) ||
          existsSync(`${base}.ts`) ||
          existsSync(join(base, "index.ts"));

        if (!found) missing.push(`${path.slice(dir.length + 1)} → ${specifier}`);
      }
    }
  };

  walk(dir);
  return missing;
}

describe("A scaffolded project is complete", () => {
  it("writes the entrypoint where the scripts expect it", () => {
    const dir = newProject("layout");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    // The scripts and the file have to agree. They did not: the scripts ran
    // `yatta/main.ts` and the file was written to `src/main.ts`.
    const entry = pkg.scripts.dev.replace("bun --watch ", "");
    expect(existsSync(join(dir, entry))).toBe(true);
    expect(pkg.scripts.start.replace("bun ", "")).toBe(entry);
  });

  it("places the entrypoint where the template says it goes", () => {
    const dir = newProject("header");

    // The template's first line names its own path. Writing it anywhere else makes the
    // file lie about where it lives.
    const declared = TEMPLATE_MAIN.split("\n")[0]!.replace("// ", "");
    expect(declared).toBe("yatta/main.ts — the server entrypoint.");
    expect(existsSync(join(dir, "yatta", "main.ts"))).toBe(true);
  });

  it("has no unresolved relative imports", () => {
    const dir = newProject("imports");

    // This is the property that was broken. `yatta new` produced thirteen of these.
    expect(unresolvedImports(dir)).toEqual([]);
  });

  it("writes every file the entrypoint imports", () => {
    const dir = newProject("files");

    for (const file of [
      "yatta/main.ts",
      "yatta/backend/routes.ts",
      "yatta/backend/auth.ts",
      "yatta/backend/health.ts",
      "yatta/backend/index.ts",
      "yatta/backend/_router.ts",
      "yatta/func/routerHelper.ts",
      "yatta/func/db.ts",
      "yatta/func/auth.ts",
      "yatta/func/cache.ts",
      "yatta/func/mail.ts",
      "yatta/func/storage.ts",
      "yatta/func/jobs.ts",
      "yatta/func/events.ts",
      "yatta/func/cron.ts",
      "yatta/func/workers.ts",
      "yatta/func/realtime.ts",
      "yatta/func/observe.ts",
    ]) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
  });

  it("leaves no placeholder behind", () => {
    const dir = newProject("clean");

    // `src/hello.ts` was written next to an entrypoint that needs eleven subsystems —
    // a two-line subsystem beside a broken project.
    expect(existsSync(join(dir, "src"))).toBe(false);
  });
});

describe("`yatta new` and `yatta init` write the same folder", () => {
  it("produces an identical file set either way", () => {
    const viaNew = newProject("same-new");
    const viaInit = join(scratch, "same-init");
    writeYattaFolder(join(viaInit, "yatta"));

    const list = (dir: string): string[] => {
      const out: string[] = [];
      const walk = (folder: string, prefix: string): void => {
        for (const entry of require("node:fs").readdirSync(folder, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const path = join(folder, entry.name);
          if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
          else out.push(`${prefix}${entry.name}`);
        }
      };
      walk(dir, "");
      return out.sort();
    };

    /*
     * They diverged: `new` wrote two files into `src/`, `init` wrote nineteen into
     * `yatta/`, and both went through the same templates. Two writers over one set of
     * templates is how the entrypoint ended up somewhere its own imports could not
     * reach.
     */
    expect(list(join(viaNew, "yatta"))).toEqual(list(join(viaInit, "yatta")));
  });
});

describe("The run commands find the entrypoint the scaffold wrote", () => {
  it("resolves yatta/main.ts in a project built by yatta new", () => {
    const dir = newProject("run-cmd");

    /*
     * `yatta dev`, `yatta start` and `yatta cluster` hardcoded `src/main.ts`, and every
     * scaffold writes `yatta/main.ts`. So `yatta new app && cd app && yatta dev`
     * answered "No src/main.ts found" — in a project that was sitting right there,
     * correctly scaffolded, whose own package.json `dev` script would have worked.
     *
     * `bun run dev` working while `yatta dev` did not is the worst shape of that bug:
     * two ways of starting the server disagreeing about where the server is.
     */
    expect(existsSync(join(dir, "yatta", "main.ts"))).toBe(true);

    // The CLI's own lookup, not a copy of the rule.
    const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    expect(cli).toContain("yatta/main.ts");
    // No hardcoded entrypoint left in the run commands.
    expect(cli).not.toMatch(/\["--watch",\s*"src\/main\.ts"\]/);
    expect(cli).not.toMatch(/\["run",\s*"src\/main\.ts"\]/);
  });

  it("still recognises src/main.ts, which the framework checkout uses", () => {
    const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    // `bun run dev` and `yatta check` have to keep working in this repo, whose own
    // entrypoint is `src/main.ts`. Dropping it to fix the scaffold would have traded
    // one broken command for another.
    expect(cli).toContain("src/main.ts");
    expect(existsSync(join(import.meta.dir, "..", "main.ts"))).toBe(true);
  });
});

describe("The scaffolded auth routes handle a second factor", () => {
  const route = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

  it("does not treat a pending second factor as a session", () => {
    const template = readFileSync(
      new URL("../cli.ts", import.meta.url),
      "utf8",
    ).split("const TEMPLATE_BACKEND_AUTH")[1]!.split("\n`;")[0]!;

    /*
     * `signIn` returns a ticket rather than a session when 2FA is on, and that object
     * has no `cookies`. The route built its response from `result.cookies`
     * unconditionally, so a 2FA user got a 500 from a fresh project.
     */
    expect(template).toContain("isMfaChallenge(result)");
    expect(template).toContain('api.post("/mfa"');
    expect(template).toContain("auth.completeMfa({ ticket, code, recoveryCode");
  });

  it("names the missing response shape", () => {
    // Guard against the helper being deleted while its call site stays.
    expect(route).toContain("function isMfaChallenge(");
  });
});