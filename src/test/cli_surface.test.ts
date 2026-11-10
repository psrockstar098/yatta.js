import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../cli";

/*
 * `yatta help` and `yatta <command>` must not drift.
 *
 * They used to be two hand-maintained lists: a `switch` in `main()` and a table of
 * coloured strings in `cmdUsage()`. Six commands had been added to the switch without
 * appearing in the help — `migrate`, `migrate:make`, `migrate:status`, `db:backup`,
 * `db:restore` and `doctor` — so a command that existed could not be discovered
 * without reading the source.
 *
 * Deriving the table from the switch is the fix, and this is what keeps it fixed.
 */

const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

/** Command names the dispatch switch handles. */
function dispatched(): string[] {
  const body = cliSource.slice(
    cliSource.indexOf("export async function main"),
    cliSource.indexOf("export async function main") + 4000,
  );

  const names: string[] = [];

  for (const match of body.matchAll(/case\s+"([^"]+)":/g)) {
    const name = match[1]!;

    // Flags are aliases for commands, not commands of their own.
    if (name.startsWith("-") || name === "undefined") continue;
    names.push(name);
  }

  return names.sort();
}

/** Command names the help text mentions. */
function documented(): string[] {
  const body = cliSource.slice(
    cliSource.indexOf("function cmdUsage"),
    cliSource.indexOf("function cmdUsage") + 3000,
  );

  const names = new Set<string>();

  // `yatta migrate` and `yatta db:backup`, in whatever colouring wraps them.
  for (const match of body.matchAll(/yatta\s+([a-z][a-z:-]*)/g)) {
    const name = match[1]!;
    if (name === "new" && body.includes("yatta new <name>")) names.add("new");
    else names.add(name);
  }

  return [...names].sort();
}

describe("Every command is discoverable", () => {
  it("lists in help everything main accepts", () => {
    const missing = dispatched().filter((name) => !documented().includes(name));

    // The failure this prevents: a command that works and that nobody can find.
    expect(missing).toEqual([]);
  });

  it("documents nothing that main rejects", () => {
    const extra = documented().filter((name) => !dispatched().includes(name));

    // A documented command that errors with "Unknown command" is worse than a missing
    // one, because the reader trusts it.
    expect(extra).toEqual([]);
  });

  it("keeps the two lists the same size as a sanity check", () => {
    // If the extraction above ever stops matching anything, the two tests above pass
    // vacuously. This fails loudly instead.
    expect(dispatched().length).toBeGreaterThan(10);
    expect(documented().length).toBeGreaterThan(10);
  });

  it("rejects an unknown command with a pointer to help", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg = "") => void lines.push(String(msg));

    let code: number;
    try {
      code = await main(["definitely-not-a-command"]);
    } finally {
      console.log = original;
    }

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/yatta help/);
  });

  it("prints help rather than failing when asked", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg = "") => void lines.push(String(msg));

    let code: number;
    try {
      code = await main(["help"]);
    } finally {
      console.log = original;
    }

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Commands/);
  });

  it("version and help banner agree with package.json (never a hardcoded stale version)", async () => {
    const pkgVersion = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version as string;
    expect(pkgVersion).not.toBe("1.0.0");

    const lines: string[] = [];
    const original = console.log;
    console.log = (msg = "") => void lines.push(String(msg));
    try {
      expect(await main(["version"])).toBe(0);
      expect(lines).toContain(pkgVersion);
      lines.length = 0;
      expect(await main(["help"])).toBe(0);
      expect(lines.join("\n")).toContain(`v${pkgVersion}`);
    } finally {
      console.log = original;
    }
  });

  it("never shells out to bunx: check uses bun x, and the scaffold check script does too", () => {
    expect(cliSource).not.toContain('run("bunx"');
    expect(cliSource).toContain('run("bun", ["x", "tsc", "--noEmit"])');
    expect(cliSource).toContain('check: "bun x tsc --noEmit"');
  });

  it("cluster resolves cluster.ts from the framework root, not the project entrypoint", () => {
    const clusterCase = cliSource.slice(
      cliSource.indexOf('case "cluster"'),
      cliSource.indexOf('case "check"'),
    );
    expect(clusterCase).toContain('join(frameworkRoot(), "core_runtime", "cluster.ts")');
    expect(clusterCase).not.toContain('join(dirname(entry)');
    expect(clusterCase).toContain("CLUSTER_ENTRY");
  });
});
const ROOT = new URL("../..", import.meta.url).pathname;

describe("check and migrate:generate flags (F1, F2, F5)", () => {
  /**
   * Captures console.log while main() runs, and restores it after.
   * The child processes main() spawns (tsc, bun test) still stream to
   * the test log — only the CLI's own lines are captured.
   */
  async function runMainCaptured(argv: string[]): Promise<{ code: number; lines: string }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg = "") => void lines.push(String(msg));
    try {
      const code = await main(argv);
      return { code, lines: lines.join("\n") };
    } finally {
      console.log = original;
    }
  }

  /** Runs body with cwd switched to dir, then restores it. */
  async function inDir<T>(dir: string, body: () => Promise<T>): Promise<T> {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return await body();
    } finally {
      process.chdir(cwd);
    }
  }

  /** A minimal typecheckable project: tsconfig + one source file, no tests. */
  function bareProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "yatta-check-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src/**/*.ts"] }),
    );
    writeFileSync(join(dir, "src", "a.ts"), "export const x: number = 1;\n");
    // `bun x tsc` resolves the binary from the project's own
    // node_modules; point those at this checkout's typescript so the
    // test never touches the network.
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules", "typescript"), join(dir, "node_modules", "typescript"), "dir");
    symlinkSync(join(ROOT, "node_modules", ".bin", "tsc"), join(dir, "node_modules", ".bin", "tsc"));
    return dir;
  }

  it("check --bogus exits 1, not 0 with usage (F5)", async () => {
    const { code, lines } = await runMainCaptured(["check", "--bogus"]);
    expect(code).toBe(1);
    expect(lines).toMatch(/Unknown option "--bogus"/);
  });

  it("migrate:generate --bogus exits 1 (F5)", async () => {
    const { code, lines } = await runMainCaptured(["migrate:generate", "--bogus"]);
    expect(code).toBe(1);
    expect(lines).toMatch(/Unknown option "--bogus"/);
  });

  it("migrate:generate --schema reaches the subcommand (F2)", async () => {
    // Before the fix the flag guard refused --schema before the
    // subcommand ever saw it ("Unknown option --schema"). Now it
    // reaches cmdMigrateGenerate, which reports the file itself as
    // missing. An empty live database file gets past the "no live
    // database" early return so the schema load is actually attempted.
    const dir = mkdtempSync(join(tmpdir(), "yatta-migrate-flag-"));
    try {
      mkdirSync(join(dir, "Database"));
      writeFileSync(join(dir, "Database", "yatta.db"), "");
      const { code, lines } = await inDir(dir, () =>
        runMainCaptured(["migrate:generate", "--schema", "nope.ts"]),
      );
      expect(code).toBe(1);
      expect(lines).not.toMatch(/Unknown option/);
      expect(lines).toMatch(/Schema file not found: nope\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrate:generate looks for the scaffold's schema at yatta/func/db.ts (F2)", () => {
    const migrateSource = readFileSync(new URL("../cli_migrate.ts", import.meta.url), "utf8");
    expect(migrateSource).toContain('"yatta/func/db.ts"');
  });

  it("check passes on a project with no test files (F1)", async () => {
    const dir = bareProject();
    try {
      const { code, lines } = await inDir(dir, () => runMainCaptured(["check"]));
      expect(code).toBe(0);
      expect(lines).toMatch(/no test files found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("check still runs the suite when tests exist (F1)", async () => {
    const dir = bareProject();
    try {
      // A failing test, written without a bun:test import so tsc
      // passes on it (the test global is declared, not imported).
      writeFileSync(
        join(dir, "src", "x.test.ts"),
        'declare const test: any;\ntest("fails", () => { throw new Error("boom"); });\n',
      );
      const { code } = await inDir(dir, () => runMainCaptured(["check"]));
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
