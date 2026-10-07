import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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