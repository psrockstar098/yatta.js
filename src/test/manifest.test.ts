import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/*
 * The manifest, checked the way a consumer's tools check it.
 *
 * `package.json` had a trailing comma. Bun's own loader tolerates that, so `bun run
 * check` was green and said nothing — but `cli.ts` reads this file with `JSON.parse`,
 * and `yatta info` and `yatta link` both died on it. The failure mode is the worst
 * kind: everything locally looks fine and the shipped artefact is unusable.
 *
 * The second half of this file is about the opposite failure: declaring packages that
 * nothing imports. That one is easy to fix by hand and easy to reintroduce, so it is
 * pinned.
 */

const root = join(import.meta.dir, "..", "..");
const raw = readFileSync(join(root, "package.json"), "utf8");

// Parsed at module scope, with JSON.parse rather than Bun's loader, so an unparseable
// manifest fails the file instead of quietly working here and breaking on publish.
const manifest = JSON.parse(raw) as Record<string, any>;

describe("package.json is valid JSON", () => {
  it("parses with JSON.parse, which is stricter than Bun's loader", () => {
    expect(typeof manifest.version).toBe("string");
  });

  it("has no trailing commas", () => {
    // A targeted check, so a failure points at the shape rather than a byte offset.
    expect(raw).not.toMatch(/,\s*[}\]]/);
  });

  it("points every export and bin at a file that exists", () => {
    const referenced: string[] = [];

    for (const target of Object.values<any>(manifest.exports)) {
      referenced.push(typeof target === "string" ? target : target.default);
    }
    referenced.push(manifest.bin.yatta, manifest.module);

    const missing = referenced.filter((path) => !existsSync(join(root, path)));

    // Or the published package is missing a file its own metadata promises, which is
    // an install-time error rather than a compile-time one.
    expect(missing).toEqual([]);
  });

  it("ships the files it lists", () => {
    // `files` decides what npm actually packs. A listed path that does not exist is
    // harmless; a source file that is not listed is silently absent from the package.
    const shipped = manifest.files.filter((f: string) => !f.startsWith("!"));

    expect(shipped).toContain("src/types");
    expect(shipped).toContain("src/func");
    expect(shipped).toContain("core_runtime");
  });

  /*
   * Pack the tarball and check what is actually inside it.
   *
   * This ran once as `cli_doctor.ts`, `cli_migrate.ts` and `cli_backup.ts`: the CLI
   * imported them, nothing shipped them, and every local check — including this file's
   * `files` whitelist assertions — stayed green because `files` said nothing about the
   * CLI beyond `src/cli.ts` itself. The published package had a `yatta` command that
   * crashed on most subcommands before the user saw a single line of output.
   *
   * npm's own walk is the only authority here; a re-implementation of npm-packlist
   * semantics would agree with itself and not with npm. `--dry-run` writes no tarball,
   * so the test litters nothing.
   */
  describe("the tarball npm would actually publish", () => {
    let packStatus = 1;
    const packed = new Set<string>();

    beforeAll(() => {
      const result = spawnSync("npm", ["pack", "--dry-run"], { cwd: root, encoding: "utf8" });
      packStatus = result.status ?? 1;

      // npm's file list goes to stderr, not stdout.
      const output = [result.stdout, result.stderr].join("\n");
      for (const line of output.split("\n")) {
        // `npm notice 82.4kB src/cli.ts` — size, then the path inside the tarball.
        const match = line.match(/^npm notice\s+\d+(?:\.\d+)?[kMG]?B\s+(\S.*)$/);
        if (match) packed.add(match[1]!.trim());
      }
    });

    it("packs without error and lists its contents", () => {
      expect(packStatus).toBe(0);

      // If the parse produced nothing, the assertions below would pass on an empty
      // walk for the wrong reason, so pin the parse itself.
      expect(packed.size).toBeGreaterThan(10);
      expect(packed.has("package.json")).toBe(true);
    });

    it("contains the bin npm is being told about", () => {
      /*
       * npm strips an invalid `bin` entry with a warning and publishes a package that
       * installs no command at all. It removed `bin.yatta = src/cli.ts` this way on a
       * real publish, so the rule is pinned twice: the target may not be TypeScript,
       * and whatever it is must survive into the tarball.
       */
      const binTarget = manifest.bin.yatta.replace(/^\.\//, "");
      expect(manifest.bin.yatta).not.toMatch(/\.ts$/);
      expect(existsSync(join(root, binTarget))).toBe(true);
      expect(packed.has(binTarget)).toBe(true);
    });

    it("contains every module the bin transitively imports", () => {
      /*
       * `cli_doctor.ts`, `cli_migrate.ts` and `cli_backup.ts` were here: the CLI
       * imported them, `files` shipped only `src/cli.ts`, and the published `yatta`
       * command crashed on most subcommands. A repo-side import walk cannot see this
       * because in the repo everything resolves — only the tarball can.
       *
       * The specifiers come from Bun's scanner, not a regex over the source: `cli.ts`
       * builds other files from template literals, and a regex reads the imports
       * *inside those templates* `—` files that must not ship because they are not
       * modules of this package.
       */
      const binTarget = manifest.bin.yatta.replace(/^\.\//, "");
      const transpiler = new Bun.Transpiler({ loader: "ts" });

      const unresolved: string[] = [];
      const seen = new Set<string>();

      const walk = (rawPath: string): void => {
        const path = rawPath.replace(/^\.\//, "");
        if (seen.has(path)) return;
        seen.add(path);

        // A reached code file that npm would not pack is a shipped-crash-in-waiting,
        // so the entry is kept (and named) even when it cannot be walked further.
        const fullPath = join(root, path);
        // Bun resolves extensionless relative specifiers against `.ts`; npm packs
        // whole files, so the resolution has to happen here for the pack to answer.
        if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
          const withTs = `${fullPath}.ts`;
          if (existsSync(withTs) && statSync(withTs).isFile()) {
            walk(`${path}.ts`);
            return;
          }
          unresolved.push(path);
          return;
        }

        const isCode = /\.(ts|js|mjs)$/.test(path);
        if (!isCode || !packed.has(path)) {
          unresolved.push(path);
          if (!isCode) return;
        }

        // The shebang trips the scanner under the plain `ts` loader; it is not code.
        const source = readFileSync(fullPath, "utf8").replace(/^#![^\n]*\n/, "");
        for (const { path: specifier } of transpiler.scanImports(source)) {
          if (!specifier.startsWith(".")) continue;
          walk(join(path, "..", specifier));
        }
      };

      walk(binTarget);

      expect(unresolved).toEqual([]);
    });

    it("starts through the bin shim, the way an installed user would run it", async () => {
      const proc = Bun.spawn([process.execPath, manifest.bin.yatta, "help"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      // `yatta help` with no project present still succeeds, which exercises the
      // import chain — cli_doctor, cli_migrate, cli_backup — that the tarball once
      // shipped without.
      expect(code).toBe(0);
      expect(stdout).toContain("Commands");
    });
  });
});

describe("Nothing is declared that nothing imports", () => {
  /** Every bare specifier imported anywhere in the source tree. */
  function importedPackages(): Set<string> {
    const found = new Set<string>();

    const walk = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist"].includes(entry.name)) continue;

        const path = join(folder, entry.name);

        if (entry.isDirectory()) {
          walk(path);
          continue;
        }

        if (!/\.(ts|tsx)$/.test(entry.name)) continue;

        /*
         * Comments are stripped before matching.
         *
         * Without that, a package named in a doc comment counts as used — which is how
         * `resend` survived as a dependency for as long as it did, named in a
         * transport-name union with no SDK behind it.
         */
        const raw = readFileSync(path, "utf8");
        const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

        /*
         * Matches a static import, a dynamic one, and a require.
         *
         * The dynamic form matters: `await import("express")` has a `(` between the
         * keyword and the quote, so a pattern that only allows `\s*` after `import`
         * silently misses it. That is how `comparison_benchmark.ts` stopped counting its
         * five comparison frameworks as used and the test began reporting them as
         * dead weight.
         */
        const pattern = /(?:from|import|require)\s*\(?\s*["']([^"'][^"']*)["']/g;

        for (const match of source.matchAll(pattern)) {
          const specifier = match[1];
          if (!specifier) continue;

          // A scoped name keeps its slash; everything else is the package name.
          found.add(
            specifier.startsWith("@")
              ? specifier.split("/").slice(0, 2).join("/")
              : specifier.split("/")[0]!,
          );
        }
      }
    };

    for (const folder of ["src", "core_runtime"]) walk(join(root, folder));
    return found;
  }

  /** Packages named in tsconfig's `types`, as `@types/*`. */
  function tsconfigTypes(): Set<string> {
    const tsconfig = readFileSync(join(root, "tsconfig.json"), "utf8");
    const block = tsconfig.match(/"types"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";

    return new Set(
      block
        .split(",")
        .map((entry) => entry.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
        .map((name) => (name.startsWith("@types/") ? name : `@types/${name}`)),
    );
  }

  /**
   * A declared package counts as used if the source imports it, or if it is the type
   * package for something the source imports, or tsconfig pulls its types in directly.
   *
   * The middle case matters: `express` ships no types of its own, so `@types/express`
   * appears in no import statement anywhere while being exactly as load-bearing.
   */
  function unused(declared: string[], used: Set<string>, alsoUsed: Set<string>): string[] {
    return declared.filter((name) => {
      if (used.has(name) || alsoUsed.has(name)) return false;

      // `@types/koa` is used by virtue of `koa` being imported.
      const bare = name.startsWith("@types/") ? name.slice("@types/".length) : null;
      return !bare || !used.has(bare);
    });
  }

  it("declares no devDependency the source never reaches", () => {
    const used = importedPackages();

    expect(unused(Object.keys(manifest.devDependencies), used, tsconfigTypes())).toEqual([]);
  });

  it("declares no dependency the source never reaches", () => {
    const used = importedPackages();

    /*
     * Fifteen of the twenty declared dependencies were imported nowhere.
     *
     * `oauth` and `resend` read as used if you grep loosely — auth.ts implements OAuth
     * itself, and `resend` appears only as a member of a transport-name union. So the
     * scan strips comments before matching, or a dependency named in prose counts as a
     * dependency in use.
     *
     * Every one of these is installed on every machine that installs Yatta, whether or
     * not the feature behind it is ever used.
     */
    expect(unused(Object.keys(manifest.dependencies ?? {}), used, tsconfigTypes())).toEqual([]);
  });

  it("declares no peerDependency the source never reaches", () => {
    const used = importedPackages();

    /*
     * `typescript` is the exception and always will be: it is the compiler, so no
     * source file imports it. Everything else has to earn its place — `react` was
     * still advertised as an optional peer after the frontend layer was removed, which
     * is how a package ends up prompting for an install it never uses.
     */
    const allowed = new Set(["typescript"]);

    expect(unused(Object.keys(manifest.peerDependencies ?? {}), used, allowed)).toEqual([]);
  });

  it("makes every source module reachable from an export path", () => {
    const exportPaths = Object.values<any>(manifest.exports)
      .map((target) => (typeof target === "string" ? target : target.default))
      .filter((path) => typeof path === "string");

    // Walk out from each export path and collect every source module it reaches.
    const reachable = new Set<string>();

    // Export targets are written `./src/types/auth.ts` while the orphan scan produces
    // `src/types/auth.ts`. Normalised here so the two sets can actually be compared.
    const walk = (raw: string): void => {
      const path = raw.replace(/^\.\//, "");
      if (!path.endsWith(".ts") || reachable.has(path)) return;
      if (!existsSync(join(root, path))) return;

      reachable.add(path);

      const source = readFileSync(join(root, path), "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const from = join(path, "..", match[1]!);
        const resolved = existsSync(from) ? from : `${from}.ts`;
        if (existsSync(resolved)) walk(resolved);
      }
    };

    for (const path of exportPaths) walk(path);

    /*
     * `src/types/rpc.ts` was in this state: a real module with a passing test suite,
     * and no `exports` entry or barrel re-export pointing at it. `yatta/rpc` had been
     * removed, so nothing outside its own test could import it — it looked shipped and
     * was not.
     *
     * Every module under src/types must be reachable from `.`, `./api`, or one of the
     * subsystem entries. A module nobody can import is not a feature, it is a file.
     */
    const orphans: string[] = [];

    const scan = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist"].includes(entry.name)) continue;

        const path = join(folder, entry.name);

        if (entry.isDirectory()) {
          scan(path);
          continue;
        }

        // `.d.ts` files are ambient declarations picked up by tsconfig rather than by
        // an import, so they are not modules and have no reachable path.
        if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;

        const relative = path.slice(root.length + 1);
        if (!reachable.has(relative)) orphans.push(relative);
      }
    };

    scan(join(root, "src", "types"));

    expect(orphans).toEqual([]);
  });

  it("declares no frontend framework package at all", () => {
    /*
     * The blunt version of the check above, kept because it names the specific
     * regression. Ten packages survived the removal of src/react and src/frameworks —
     * react, react-dom, @types/react, @types/react-dom, vue, @vue/server-renderer,
     * svelte, solid-js, @angular/core, @builder.io/qwik. Nothing imports them, so
     * every install and every CI run paid for a layer that no longer exists.
     */
    const ui = [
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      "preact",
      "vue",
      "@vue/server-renderer",
      "svelte",
      "solid-js",
      "@angular/core",
      "@builder.io/qwik",
    ];

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.peerDependenciesMeta ?? {}),
    ];

    expect(declared.filter((name) => ui.includes(name))).toEqual([]);
  });
});