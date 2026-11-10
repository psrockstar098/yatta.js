import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { entryNeedsPolyfill, isDataOrSecretPath, isInsideDir, runBuild } from "../build_standalone";
import { main } from "../cli";

/*
 * `yatta build --standalone` compiles a project into one executable.
 *
 * The binary must hold the code, the schema, and the public static
 * assets — and nothing else. A database file, an uploads directory,
 * or a .env file that sits next to the entrypoint must not end up
 * inside it, because Bun only embeds what the entrypoint imports plus
 * what is passed with --asset, and this command refuses data-looking
 * asset paths outright.
 *
 * One fixture binary is built for the whole file (a compile embeds a
 * full Bun runtime, so each build is a large file and slow); every
 * test below reads a different property of that same binary.
 */

const SENTINEL_ENV = "BUILDTEST_ENV_SENTINEL_7f3a";
const SENTINEL_DB = "BUILDTEST_DB_SENTINEL_7f3a";
const SENTINEL_UPLOAD = "BUILDTEST_UPLOAD_SENTINEL_7f3a";
const ASSET_TEXT = "BUILDTEST_ASSET_TEXT_7f3a";
const EXTRA_TEXT = "BUILDTEST_EXTRA_TEXT_7f3a";

const ENTRY = `import { join } from "node:path";

const port = Number(process.env.PORT) || 0;
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/static") {
      return new Response(Bun.file(join(import.meta.dir, "public", "hello.txt")));
    }
    if (url.pathname === "/extra") {
      return new Response(Bun.file(join(import.meta.dir, "extra", "extra.txt")));
    }
    if (url.pathname === "/schema") {
      // A schema definition is code: it rides in the binary like any import.
      return Response.json({ tables: ["users", "posts"] });
    }
    return Response.json({ ok: true });
  },
});
console.log(\`READY \${server.port}\`);
`;

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yatta-build-"));
  writeFileSync(join(dir, "server.ts"), ENTRY);
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "hello.txt"), ASSET_TEXT);
  mkdirSync(join(dir, "extra"));
  writeFileSync(join(dir, "extra", "extra.txt"), EXTRA_TEXT);
  // Data and secrets that sit next to the entrypoint. Nothing imports
  // them and none is passed as an asset, so none may reach the binary.
  writeFileSync(join(dir, ".env"), `AUTH_SECRET=${SENTINEL_ENV}\n`);
  writeFileSync(join(dir, "app.db"), SENTINEL_DB);
  mkdirSync(join(dir, "uploads"));
  writeFileSync(join(dir, "uploads", "secret.txt"), SENTINEL_UPLOAD);
  return dir;
}

/** Starts the binary, waits for its READY line, returns port + child. */
async function startBinary(
  binary: string,
  cwd: string,
): Promise<{ port: number; child: ChildProcess }> {
  const child = spawn(binary, [], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errOut = "";
  const port = await new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`binary did not print READY; got: ${out} ${errOut}`)),
      60_000,
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(Number(match[1]));
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errOut += chunk.toString();
    });
    // A binary that crashes at startup never prints READY: fail fast
    // with its stderr instead of waiting out the whole timeout.
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`binary exited with code ${code} before READY; stdout: ${out} stderr: ${errOut}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { port, child };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.on("exit", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5000)),
  ]);
}

let dir = "";
let outPath = "";

beforeAll(() => {
  dir = fixtureDir();
  const outcome = runBuild(dir, ["--standalone", "--entry", "server.ts", "--asset", "extra"]);
  expect(outcome.code).toBe(0);
  expect(outcome.outPath).toBeDefined();
  outPath = outcome.outPath!;
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("yatta build --standalone", () => {
  it("produces one executable file", () => {
    expect(existsSync(outPath)).toBe(true);
    const stat = statSync(outPath);
    expect(stat.isFile()).toBe(true);
    // The executable bit is what makes it runnable without `bun`.
    expect(stat.mode & 0o111).not.toBe(0);
    // A compile embeds the Bun runtime, so the file is large.
    expect(stat.size).toBeGreaterThan(1_000_000);
  });

  it("boots and serves the baked-in app and schema", async () => {
    const { port, child } = await startBinary(outPath, dir);
    try {
      const root = await (await fetch(`http://localhost:${port}/`)).json();
      expect(root).toEqual({ ok: true });
      const schema = await (await fetch(`http://localhost:${port}/schema`)).json();
      expect(schema).toEqual({ tables: ["users", "posts"] });
    } finally {
      await stop(child);
    }
  });

  it("serves embedded static assets even from a foreign working directory", async () => {
    // Running from an empty directory proves the asset came from the
    // binary, not from a file read off disk at runtime.
    const elsewhere = mkdtempSync(join(tmpdir(), "yatta-build-elsewhere-"));
    try {
      const { port, child } = await startBinary(outPath, elsewhere);
      try {
        expect(await (await fetch(`http://localhost:${port}/static`)).text()).toBe(ASSET_TEXT);
        expect(await (await fetch(`http://localhost:${port}/extra`)).text()).toBe(EXTRA_TEXT);
      } finally {
        await stop(child);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("contains the assets but none of the data, secrets, or build-machine paths", () => {
    const bytes = readFileSync(outPath);
    const has = (needle: string) => bytes.includes(Buffer.from(needle));
    expect(has(ASSET_TEXT)).toBe(true);
    expect(has(EXTRA_TEXT)).toBe(true);
    expect(has(SENTINEL_ENV)).toBe(false);
    expect(has(SENTINEL_DB)).toBe(false);
    expect(has(SENTINEL_UPLOAD)).toBe(false);
    // Bun records embedded files under its own root, not the path the
    // build ran in, so the binary must not name the fixture directory.
    expect(has(dir)).toBe(false);
  });

  it("refuses an asset directory that holds data", () => {
    const mixed = mkdtempSync(join(tmpdir(), "yatta-build-mixed-"));
    try {
      writeFileSync(join(mixed, "server.ts"), ENTRY);
      mkdirSync(join(mixed, "mixed"));
      writeFileSync(join(mixed, "mixed", "app.db"), SENTINEL_DB);
      const outcome = runBuild(mixed, ["--standalone", "--entry", "server.ts", "--asset", "mixed"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/Refusing/);
      expect(existsSync(join(mixed, "dist", "app"))).toBe(false);
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
  });

  it("refuses an uploads directory and a .env file as assets", () => {
    const outcomeUploads = runBuild(dir, [
      "--standalone",
      "--entry",
      "server.ts",
      "--asset",
      "uploads",
    ]);
    expect(outcomeUploads.code).toBe(1);
    expect(outcomeUploads.lines.join("\n")).toMatch(/Refusing/);

    const outcomeEnv = runBuild(dir, [
      "--standalone",
      "--entry",
      "server.ts",
      "--asset",
      ".env",
    ]);
    expect(outcomeEnv.code).toBe(1);
    expect(outcomeEnv.lines.join("\n")).toMatch(/Refusing/);
  });

  it("refuses a .ENV file as an asset, in any case", () => {
    const mixed = mkdtempSync(join(tmpdir(), "yatta-build-upper-env-"));
    try {
      writeFileSync(join(mixed, "server.ts"), ENTRY);
      mkdirSync(join(mixed, "public"));
      writeFileSync(join(mixed, "public", ".ENV"), `AUTH_SECRET=${SENTINEL_ENV}\n`);
      const outcome = runBuild(mixed, ["--standalone", "--entry", "server.ts", "--asset", "public"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/Refusing/);
      expect(existsSync(join(mixed, "dist", "app"))).toBe(false);
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
  });

  it("fails cleanly with no entrypoint", () => {
    const empty = mkdtempSync(join(tmpdir(), "yatta-build-empty-"));
    try {
      const outcome = runBuild(empty, ["--standalone"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/no entrypoint found/);
      expect(outcome.lines.join("\n")).toMatch(/yatta\/main\.ts/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails cleanly without --standalone and rejects unknown flags", () => {
    expect(runBuild(dir, []).code).toBe(1);
    expect(runBuild(dir, []).lines.join("\n")).toMatch(/--standalone/);
    const bad = runBuild(dir, ["--standalone", "--bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.lines.join("\n")).toMatch(/Unknown option/);
    const badTarget = runBuild(dir, ["--standalone", "--target", "bun-node"]);
    expect(badTarget.code).toBe(1);
    expect(badTarget.lines.join("\n")).toMatch(/not a documented compile target/);
  });

  it("is reachable from the CLI dispatch and listed in help", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg = "") => void lines.push(String(msg));
    try {
      expect(await main(["build"])).toBe(1);
      expect(lines.join("\n")).toMatch(/--standalone/);
      lines.length = 0;
      expect(await main(["help"])).toBe(0);
      expect(lines.join("\n")).toMatch(/yatta build/);
    } finally {
      console.log = original;
    }
  });
});

describe("output destination guard", () => {
  it("refuses --out equal to the entrypoint, leaving it intact", () => {
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-out-entry-"));
    try {
      writeFileSync(join(proj, "server.ts"), ENTRY);
      const before = readFileSync(join(proj, "server.ts"), "utf8");
      const outcome = runBuild(proj, ["--standalone", "--entry", "server.ts", "--out", "server.ts"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/--out/);
      expect(outcome.lines.join("\n")).toMatch(/entrypoint/);
      expect(readFileSync(join(proj, "server.ts"), "utf8")).toBe(before);
      expect(existsSync(join(proj, "dist", "app"))).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("refuses --out naming an existing data file, leaving it intact", () => {
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-out-data-"));
    try {
      writeFileSync(join(proj, "server.ts"), ENTRY);
      writeFileSync(join(proj, "notes.txt"), "DO NOT DELETE — user data\n");
      const outcome = runBuild(proj, ["--standalone", "--entry", "server.ts", "--out", "notes.txt"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/already exists/);
      expect(readFileSync(join(proj, "notes.txt"), "utf8")).toBe("DO NOT DELETE — user data\n");
      expect(existsSync(join(proj, "dist", "app"))).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("refuses --out naming an existing directory", () => {
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-out-dir-"));
    try {
      writeFileSync(join(proj, "server.ts"), ENTRY);
      mkdirSync(join(proj, "dist2"));
      const outcome = runBuild(proj, ["--standalone", "--entry", "server.ts", "--out", "dist2"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/directory/);
      expect(existsSync(join(proj, "dist", "app"))).toBe(false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("rebuilds over its own previous output", () => {
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-rebuild-"));
    try {
      writeFileSync(join(proj, "server.ts"), ENTRY);
      const first = runBuild(proj, ["--standalone", "--entry", "server.ts"]);
      expect(first.code).toBe(0);
      expect(statSync(join(proj, "dist", "app")).size).toBeGreaterThan(1_000_000);
      const second = runBuild(proj, ["--standalone", "--entry", "server.ts"]);
      expect(second.code).toBe(0);
      expect(statSync(join(proj, "dist", "app")).size).toBeGreaterThan(1_000_000);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("isDataOrSecretPath", () => {
  it("flags databases, env files, keys, and data directories", () => {
    for (const path of [
      ".env",
      "config/.env.local",
      "app.db",
      "data/app.sqlite3",
      "cert.pem",
      "id_rsa",
      "uploads/avatar.png",
      "storage/file.txt",
      "Database/app.db",
    ]) {
      expect(isDataOrSecretPath(path)).not.toBeNull();
    }
  });

  it("flags env files in any case and under env-ish names", () => {
    for (const path of [
      ".ENV",
      "FOO.ENV",
      ".Env",
      "config/.ENV.local",
      "my.env.bak",
      "public/.env.bak",
      ".envrc",
      ".envrc.local",
      "a/b.env.c",
    ]) {
      expect(isDataOrSecretPath(path)).not.toBeNull();
    }
  });

  it("leaves ordinary code and public assets alone", () => {
    for (const path of ["server.ts", "public/hello.txt", "extra/extra.txt", "src/main.ts"]) {
      expect(isDataOrSecretPath(path)).toBeNull();
    }
  });
});

describe("entryNeedsPolyfill", () => {
  it("already detects static and dynamic framework imports", () => {
    expect(entryNeedsPolyfill(`import { createAPI } from "yatta.js/api";`)).toBe(true);
    expect(entryNeedsPolyfill(`const a = await import("yatta.js/auth");`)).toBe(true);
    expect(entryNeedsPolyfill(`export * from "yatta.js/api";`)).toBe(true);
  });

  it("detects require() of the framework", () => {
    expect(entryNeedsPolyfill(`const { createAPI } = require("yatta.js/api");`)).toBe(true);
    expect(entryNeedsPolyfill(`const auth = require("yatta.js/auth");`)).toBe(true);
  });

  it("detects a variable dynamic import bound to the framework", () => {
    const src = `const pkg = "yatta.js/api";\nconst a = await import(pkg);\n`;
    expect(entryNeedsPolyfill(src)).toBe(true);
    const req = `const pkg = "yatta.js/api";\nconst a = require(pkg);\n`;
    expect(entryNeedsPolyfill(req)).toBe(true);
  });

  it("follows relative imports transitively, including framework source", () => {
    // Entry -> local helper -> framework.
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-polyfill-helper-"));
    try {
      writeFileSync(join(proj, "server.ts"), `import { setup } from "./helper";\nsetup();\n`);
      writeFileSync(join(proj, "helper.ts"), `import { createAPI } from "yatta.js/auth";\nexport const setup = () => createAPI;\n`);
      expect(entryNeedsPolyfill(readFileSync(join(proj, "server.ts"), "utf8"), proj)).toBe(true);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
    // Entry -> relative import of framework source -> framework.
    // (A monorepo checkout imports the framework by relative path.)
    const mono = mkdtempSync(join(tmpdir(), "yatta-build-polyfill-mono-"));
    try {
      mkdirSync(join(mono, "app"), { recursive: true });
      mkdirSync(join(mono, "fw", "src"), { recursive: true });
      writeFileSync(join(mono, "app", "server.ts"), `import { createAPI } from "../fw/src/api";\ncreateAPI;\n`);
      writeFileSync(join(mono, "fw", "src", "api.ts"), `import { createAPI } from "yatta.js/api";\nexport { createAPI };\n`);
      expect(
        entryNeedsPolyfill(readFileSync(join(mono, "app", "server.ts"), "utf8"), join(mono, "app")),
      ).toBe(true);
    } finally {
      rmSync(mono, { recursive: true, force: true });
    }
  });

  it("ignores non-framework imports and terminates on cycles", () => {
    expect(entryNeedsPolyfill(`import { join } from "node:path";\nconsole.log(join);\n`)).toBe(false);
    expect(entryNeedsPolyfill(`const pkg = "node:path";\nconst a = await import(pkg);\n`)).toBe(false);
    // A helper that imports the entry back: the scan must terminate
    // and still answer false when no framework import exists anywhere.
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-polyfill-cycle-"));
    try {
      writeFileSync(join(proj, "server.ts"), `import { helper } from "./helper";\nhelper();\n`);
      writeFileSync(join(proj, "helper.ts"), `import "./server";\nexport const helper = () => 1;\n`);
      expect(entryNeedsPolyfill(readFileSync(join(proj, "server.ts"), "utf8"), proj)).toBe(false);
      // And the same cycle with a framework import one hop in.
      writeFileSync(join(proj, "helper.ts"), `import "./server";\nimport "yatta.js/api";\nexport const helper = () => 1;\n`);
      expect(entryNeedsPolyfill(readFileSync(join(proj, "server.ts"), "utf8"), proj)).toBe(true);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("isInsideDir", () => {
  it("treats the filesystem root as containing everything", () => {
    expect(isInsideDir("/", "/")).toBe(true);
    expect(isInsideDir("/", "/etc/passwd")).toBe(true);
    expect(isInsideDir("/", "/tmp")).toBe(true);
  });

  it("keeps the existing inside/outside behavior", () => {
    expect(isInsideDir("/tmp", "/tmp/foo")).toBe(true);
    expect(isInsideDir("/tmp", "/tmp")).toBe(true);
    expect(isInsideDir("/tmp", "/etc/passwd")).toBe(false);
    expect(isInsideDir("/a/b", "/a/b/c/d")).toBe(true);
    expect(isInsideDir("/a/b", "/a/bc")).toBe(false);
  });
});

describe("JIT and AOT modes", () => {
  // Bun 1.4.4 (this VM) has no standalone `bun compile` command and no
  // `bun check --aot`, and its `bun build` silently ignores flags it
  // does not know — so whether --aot changes codegen here is
  // unverified. What is verified: the --aot build builds, runs, and
  // serves, and the fallback type gate still stops type errors. The
  // speed/memory wins are not claimed on this Bun.
  function aotFixture(entrySource: string): string {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-aot-"));
    writeFileSync(join(fixture, "server.ts"), entrySource);
    writeFileSync(
      join(fixture, "globals.d.ts"),
      "declare const Bun: any;\ndeclare const console: any;\ndeclare const process: any;\n",
    );
    writeFileSync(
      join(fixture, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [] },
        include: ["server.ts", "globals.d.ts"],
      }),
    );
    return fixture;
  }

  const servingEntry = `const port = Number(process.env.PORT) || 0;\nconst server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });\nconsole.log(\`READY \${server.port}\`);\n`;

  it("--aot passes through, builds, runs, and says the gate fell back", async () => {
    const fixture = aotFixture(servingEntry);
    try {
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--aot"]);
      expect(outcome.code).toBe(0);
      expect(outcome.lines.join("\n")).toMatch(/mode: AOT/);
      // The fallback is reported, not hidden.
      expect(outcome.lines.join("\n")).toMatch(/plain bun check/);
      expect(outcome.lines.join("\n")).toMatch(/unverified here/);
      const { port, child } = await startBinary(outcome.outPath!, fixture);
      try {
        expect(await (await fetch(`http://localhost:${port}/`)).json()).toEqual({ ok: true });
      } finally {
        await stop(child);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("--aot with a type error is stopped by the fallback plain gate", () => {
    const fixture = aotFixture(`const n: number = "not-a-number";\nconsole.log(n);\n`);
    try {
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--aot"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/Type gate failed/);
      expect(outcome.lines.join("\n")).toMatch(/TS2322/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("--trim passes through on this Bun", () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-trim-"));
    try {
      writeFileSync(join(fixture, "server.ts"), servingEntry);
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--trim"]);
      expect(outcome.code).toBe(0);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses --explain without --aot, with --aot on a Bun that produces no reports, and --aot with a foreign target", () => {
    const explain = runBuild(dir, ["--standalone", "--entry", "server.ts", "--explain"]);
    expect(explain.code).toBe(1);
    expect(explain.lines.join("\n")).toMatch(/--explain needs --aot/);

    // On this Bun --explain just bundles normally with no report, so
    // asking for it must fail rather than pretend a report was made.
    const explainAot = runBuild(dir, ["--standalone", "--entry", "server.ts", "--aot", "--explain"]);
    expect(explainAot.code).toBe(1);
    expect(explainAot.lines.join("\n")).toMatch(/does not produce --explain reports/);

    const foreign = runBuild(dir, [
      "--standalone",
      "--entry",
      "server.ts",
      "--aot",
      "--target",
      "bun-darwin-arm64",
    ]);
    expect(foreign.code).toBe(1);
    expect(foreign.lines.join("\n")).toMatch(/only for the machine it runs on/);
  });

  it("accepts --no-aot as the explicit JIT spelling", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "yatta-build-noaot-"));
    try {
      writeFileSync(join(elsewhere, "server.ts"), ENTRY);
      const outcome = runBuild(elsewhere, ["--standalone", "--no-aot", "--entry", "server.ts"]);
      expect(outcome.code).toBe(0);
      expect(outcome.lines.join("\n")).toMatch(/mode: JIT bundle/);
      expect(existsSync(join(elsewhere, "dist", "app"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

const HARDENED_ENTRY = `import { makeFn } from "./helper";

const port = Number(process.env.PORT) || 0;
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/execargv") {
      return Response.json({ execArgv: process.execArgv });
    }
    if (url.pathname === "/eval") {
      try {
        return Response.json({ value: makeFn()() });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    return Response.json({ ok: true });
  },
});
console.log(\`READY \${server.port}\`);
`;

// The code generation lives in a dependency, not the entrypoint, so
// the entrypoint scan passes and the binary itself must enforce it.
const HELPER = `export function makeFn() {
  return new Function("return 42");
}
`;

function hardenedFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "yatta-build-hardened-"));
  writeFileSync(join(fixture, "server.ts"), HARDENED_ENTRY);
  writeFileSync(join(fixture, "helper.ts"), HELPER);
  return fixture;
}

describe("baked runtime flags and the string-to-code ban", () => {
  it("bakes --smol, --no-addons, and the ban into execArgv, and the ban throws at runtime", async () => {
    const fixture = hardenedFixture();
    try {
      const outcome = runBuild(fixture, [
        "--standalone",
        "--no-aot",
        "--entry",
        "server.ts",
        "--smol",
        "--no-addons",
        "--disallow-code-generation",
      ]);
      expect(outcome.code).toBe(0);
      const binary = outcome.outPath!;
      const { port, child } = await startBinary(binary, fixture);
      try {
        const argv = await (await fetch(`http://localhost:${port}/execargv`)).json();
        expect(argv.execArgv).toContain("--smol");
        expect(argv.execArgv).toContain("--no-addons");
        expect(argv.execArgv).toContain("--disallow-code-generation-from-strings");
        const evalRes = await fetch(`http://localhost:${port}/eval`);
        expect(evalRes.status).toBe(500);
        const body = await evalRes.json();
        expect(body.error).toMatch(/EvalError/);
      } finally {
        await stop(child);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("bakes the =strict level the same way", async () => {
    const fixture = hardenedFixture();
    try {
      const outcome = runBuild(fixture, [
        "--standalone",
        "--entry",
        "server.ts",
        "--disallow-code-generation=strict",
      ]);
      expect(outcome.code).toBe(0);
      const { port, child } = await startBinary(outcome.outPath!, fixture);
      try {
        const argv = await (await fetch(`http://localhost:${port}/execargv`)).json();
        expect(argv.execArgv).toContain("--disallow-code-generation-from-strings=strict");
        const evalRes = await fetch(`http://localhost:${port}/eval`);
        expect(evalRes.status).toBe(500);
      } finally {
        await stop(child);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses the ban when the entrypoint itself generates code", () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-codegen-"));
    try {
      writeFileSync(
        join(fixture, "server.ts"),
        `const f = new Function("return 1");\nconsole.log(f());\n`,
      );
      const outcome = runBuild(fixture, [
        "--standalone",
        "--entry",
        "server.ts",
        "--disallow-code-generation",
      ]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/refusing --disallow-code-generation/);
      expect(outcome.lines.join("\n")).toMatch(/new Function\(/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
      // Without the ban the same entry builds fine: the refusal is
      // about the combination, not the code.
      const plain = runBuild(fixture, ["--standalone", "--entry", "server.ts"]);
      expect(plain.code).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("JSON5 build config", () => {
  it("reads a config with comments and trailing commas, and CLI flags win over it", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-config-"));
    try {
      writeFileSync(
        join(fixture, "server.ts"),
        `const port = Number(process.env.PORT) || 0;\nconst server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });\nconsole.log(\`READY \${server.port}\`);\n`,
      );
      writeFileSync(
        join(fixture, "yatta.build.json5"),
        `{
          // The entrypoint and output for this project.
          entry: "server.ts",
          out: "dist/from-config",
        }\n`,
      );
      const fromConfig = runBuild(fixture, ["--standalone", "--no-aot", "--config", "yatta.build.json5"]);
      expect(fromConfig.code).toBe(0);
      expect(fromConfig.outPath).toBe(join(fixture, "dist", "from-config"));
      const { port, child } = await startBinary(fromConfig.outPath!, fixture);
      try {
        expect(await (await fetch(`http://localhost:${port}/`)).json()).toEqual({ ok: true });
      } finally {
        await stop(child);
      }

      const overridden = runBuild(fixture, [
        "--standalone",
        "--config",
        "yatta.build.json5",
        "--out",
        "dist/override",
      ]);
      expect(overridden.code).toBe(0);
      expect(overridden.outPath).toBe(join(fixture, "dist", "override"));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects unknown config keys instead of silently ignoring them", () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-config-bad-"));
    try {
      writeFileSync(join(fixture, "server.ts"), "console.log(1);\n");
      writeFileSync(join(fixture, "yatta.build.json5"), `{ entry: "server.ts", outp: "dist/x" }\n`);
      const outcome = runBuild(fixture, ["--standalone", "--config", "yatta.build.json5"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/unknown key "outp"/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("bun check type gate", () => {
  function gateFixture(entrySource: string): string {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-build-gate-"));
    writeFileSync(join(fixture, "server.ts"), entrySource);
    // Ambient declarations stand in for @types/bun: the gate fixture
    // must not depend on an installed node_modules to be checkable.
    writeFileSync(
      join(fixture, "globals.d.ts"),
      "declare const Bun: any;\ndeclare const console: any;\ndeclare const process: any;\n",
    );
    writeFileSync(
      join(fixture, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [] },
        include: ["server.ts", "globals.d.ts"],
      }),
    );
    return fixture;
  }

  const goodEntry = `const port = Number(process.env.PORT) || 0;\nconst server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });\nconsole.log(\`READY \${server.port}\`);\n`;

  it("passes a clean entry and builds it", () => {
    const fixture = gateFixture(goodEntry);
    try {
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--check"]);
      expect(outcome.code).toBe(0);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("stops the build on a type error, writing no binary", () => {
    const fixture = gateFixture(`const n: number = "not-a-number";\nconsole.log(n);\n`);
    try {
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--check"]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/Type gate failed/);
      expect(outcome.lines.join("\n")).toMatch(/TS2322/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("points a top-level-await-only entry at `export {};` (TS1375)", () => {
    const fixture = gateFixture(`const value = await Promise.resolve(42);\nconsole.log(value);\n`);
    try {
      // --aot runs the gate (with the plain-check fallback on this Bun).
      const aot = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--aot"]);
      expect(aot.code).toBe(1);
      expect(aot.lines.join("\n")).toMatch(/TS1375/);
      // The pointer is the fix's own line — the raw checker output
      // says "Consider adding an empty 'export {}'", which is not this.
      expect(aot.lines.join("\n")).toMatch(/Add `export \{\};` to the entrypoint/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
      // The --check gate on a JIT build gets the same pointer.
      const jit = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--check"]);
      expect(jit.code).toBe(1);
      expect(jit.lines.join("\n")).toMatch(/TS1375/);
      expect(jit.lines.join("\n")).toMatch(/Add `export \{\};` to the entrypoint/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("builds a top-level-await entry under --aot once it is a module", () => {
    const fixture = gateFixture(
      `const value = await Promise.resolve(42);\nconsole.log(value);\nexport {};\n`,
    );
    try {
      const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--aot"]);
      expect(outcome.code).toBe(0);
      expect(outcome.lines.join("\n")).toMatch(/mode: AOT/);
      expect(existsSync(join(fixture, "dist", "app"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("a Bun without `bun check`", () => {
  /*
   * `bun check` is a recent subcommand. On an older Bun the word is read as a
   * package script, so the spawn fails with `Script not found "check"` — which
   * is not a type error. Reporting it as "the entrypoint does not type-check"
   * sent users looking for a bug in code that was fine, and blocked the build.
   *
   * A fake `bun` on PATH reproduces that Bun deterministically, on any Bun.
   */
  function withFakeBun<T>(body: (restore: () => void) => T): T {
    const bin = mkdtempSync(join(tmpdir(), "yatta-fake-bun-"));
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\necho 'error: Script not found "check"' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original ?? ""}`;
    const restore = () => {
      process.env.PATH = original;
      rmSync(bin, { recursive: true, force: true });
    };
    try {
      return body(restore);
    } finally {
      restore();
    }
  }

  const entry = `const port = 0;\nconst server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });\nconsole.log(server.port);\n`;

  it("names the missing checker instead of blaming the entrypoint with --check", () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-no-check-"));
    writeFileSync(join(fixture, "server.ts"), entry);
    try {
      withFakeBun(() => {
        const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--check"]);
        const text = outcome.lines.join("\n");
        expect(outcome.code).toBe(1);
        expect(text).toMatch(/has no `bun check`/);
        expect(text).not.toMatch(/does not type-check/);
        expect(existsSync(join(fixture, "dist", "app"))).toBe(false);
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("skips the implicit AOT gate with a note rather than refusing to build", () => {
    const fixture = mkdtempSync(join(tmpdir(), "yatta-no-check-aot-"));
    writeFileSync(join(fixture, "server.ts"), entry);
    try {
      withFakeBun(() => {
        const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts", "--aot"]);
        const text = outcome.lines.join("\n");
        // The fake bun also fails the compile, but the gate must not claim
        // the entrypoint is broken: the note says the gate was skipped.
        expect(text).not.toMatch(/Type gate failed/);
        expect(text).toMatch(/type gate: skipped/);
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("build machinery is CLI-only", () => {
  it("is not imported by the server entrypoint", () => {
    const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(mainSource).not.toContain("build_standalone");
  });
});

const ROOT = join(import.meta.dir, "..", "..");

// A minimal app that imports the framework's api, db, and auth the
// way the perf round-2 app does (which pulls @simplewebauthn/server,
// which pulls tsyringe, which needs the reflect-metadata polyfill at
// import time because its decorators run then). The entry deliberately
// never imports reflect-metadata itself: the build has to supply it,
// first.
//
// The imports MUST be dynamic `await import(...)`, as in the round-2
// app and in the framework's own main.ts: with static imports the
// binary boots even without the polyfill, because Bun then evaluates
// the polyfill's side-effect import (which rides in via
// @simplewebauthn/server's certificate helpers) before tsyringe's
// lazy init. With dynamic imports Bun evaluates the framework modules
// first and tsyringe's init runs before the polyfill code — the
// polyfill is in the bundle but too late — and the binary crashes at
// startup with "tsyringe requires a reflect polyfill". An auth-only
// entry does not reproduce it either: the trigger needs the full
// api+db+auth shape with dynamic imports. So the fixture mirrors
// the round-2 app's top-level calls, cut down to one route each.
const FRAMEWORK_ENTRY = `const { createAPI, API } = await import("yatta.js/api");
const { createDatabase, col } = await import("yatta.js/db");
const { createAuth, MemoryAuthStore, MemoryChallengeStore, MemoryRateLimitStore } = await import("yatta.js/auth");

const TOKEN = "perf-test-bearer-token";
const schema = {
  users: { id: col.text(), name: col.text(), email: col.text() },
  visits: { id: col.id(), userId: col.text(), path: col.text() },
};
const db = createDatabase({ path: ":memory:", schema, forceNew: true });
db.users.insert({ id: "u1", name: "Perf User", email: "perf@example.com" });

const store = new MemoryAuthStore();
const auth = createAuth({
  secret: "standalone-shim-test-secret-0123456789abcdef",
  store,
  challengeStore: new MemoryChallengeStore(),
  rateLimitStore: new MemoryRateLimitStore(),
  security: { allowUnverifiedSession: true },
});
await store.createUser({
  id: "u1",
  email: "perf@example.com",
  roles: ["viewer"],
  emailVerified: true,
  twoFactorEnabled: false,
  credentialVersion: 1,
});
const now = new Date();
const later = new Date(Date.now() + 3600_000);
await store.createSession({
  id: "s1",
  userId: "u1",
  sessionTokenHash: auth.crypto.hash(TOKEN),
  expiresAt: later,
  lastSeenAt: now,
  lastAuthenticatedAt: now,
  createdAt: now,
  refreshVersion: 1,
});

const apiJson = createAPI();
apiJson.get("/json", () => API.json({ hello: "world", n: 42, ok: true }));

const api = createAPI();
api.use(async (ctx: any, next: any) => {
  const session = await auth.getSession(ctx.req, { autoRefresh: false });
  if (!session) return API.json({ error: "Unauthorized" }, { status: 401 });
  ctx.state.user = session.user;
  return next();
});
api.get("/profile", (ctx: any) => {
  const user = db.users.where({ id: "u1" }).first();
  if (!user) return API.json({ error: "Not Found" }, { status: 404 });
  const visit = db.visits.insert({ userId: "u1", path: "/profile" });
  return API.json({ hello: "world", user: user.name, visit: visit.id });
});

const port = Number(process.env.PORT) || 0;
const server = Bun.serve({
  port,
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    return path === "/profile" ? api.handle(req, {}) : apiJson.handle(req, {});
  },
});
console.log(\`READY \${server.port}\`);
`;

/**
 * A project that imports the framework the way a real user project
 * does: node_modules/yatta.js points at this checkout, and
 * reflect-metadata sits hoisted next to it as a real directory (a
 * copy, not a symlink: the shim uses the bare specifier only when
 * the package resolves from inside the project, and a symlink would
 * resolve to the checkout instead). The plain fixtures elsewhere in
 * this file have no node_modules at all, so they cover the
 * framework-fallback branch.
 */
function frameworkFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "yatta-build-shim-"));
  mkdirSync(join(fixture, "node_modules"));
  symlinkSync(ROOT, join(fixture, "node_modules", "yatta.js"), "dir");
  cpSync(join(ROOT, "node_modules", "reflect-metadata"), join(fixture, "node_modules", "reflect-metadata"), {
    recursive: true,
  });
  writeFileSync(join(fixture, "server.ts"), FRAMEWORK_ENTRY);
  return fixture;
}

describe("standalone reflect-metadata shim and entry-inside-package", () => {
  let fixture = "";
  let binary = "";

  beforeAll(() => {
    fixture = frameworkFixture();
    const outcome = runBuild(fixture, ["--standalone", "--entry", "server.ts"]);
    expect(outcome.code).toBe(0);
    binary = outcome.outPath!;
  }, 180_000);

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it("boots a framework app whose entry never imports reflect-metadata", async () => {
    // Without the shim the binary crashes at startup: "tsyringe
    // requires a reflect polyfill". The entry has no such import, so
    // the build itself must supply it, first.
    const { port, child } = await startBinary(binary, fixture);
    try {
      expect(await (await fetch(`http://localhost:${port}/json`)).json()).toEqual({
        hello: "world",
        n: 42,
        ok: true,
      });
      // The authenticated route proves the auth stack (and the
      // session seeded at startup) works in the binary, not just
      // that the process stayed up.
      const profile = await fetch(`http://localhost:${port}/profile`, {
        headers: { Authorization: "Bearer perf-test-bearer-token" },
      });
      expect(profile.status).toBe(200);
      const body = await profile.json();
      expect(body.user).toBe("Perf User");
    } finally {
      await stop(child);
    }
  }, 120_000);

  it("bundles the polyfill and leaves no generated entry behind", () => {
    const bytes = readFileSync(binary);
    expect(bytes.includes(Buffer.from("Reflect.metadata"))).toBe(true);
    const leftovers = readdirSync(fixture).filter((f) =>
      f.startsWith(".yatta-standalone-entry"),
    );
    expect(leftovers).toEqual([]);
  });

  it("still builds and boots when the entry already imports reflect-metadata", async () => {
    writeFileSync(
      join(fixture, "server-with-polyfill.ts"),
      `import "reflect-metadata";\n${FRAMEWORK_ENTRY}`,
    );
    const outcome = runBuild(fixture, [
      "--standalone",
      "--entry",
      "server-with-polyfill.ts",
      "--out",
      "dist/app-polyfill",
    ]);
    expect(outcome.code).toBe(0);
    const { port, child } = await startBinary(outcome.outPath!, fixture);
    try {
      expect(await (await fetch(`http://localhost:${port}/json`)).json()).toEqual({
        hello: "world",
        n: 42,
        ok: true,
      });
    } finally {
      await stop(child);
    }
  }, 180_000);

  it("refuses an entrypoint outside the project directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "yatta-build-outside-"));
    try {
      writeFileSync(join(outside, "server.ts"), ENTRY);
      const outcome = runBuild(fixture, [
        "--standalone",
        "--entry",
        join(outside, "server.ts"),
        "--out",
        "dist/app-outside",
      ]);
      expect(outcome.code).toBe(1);
      expect(outcome.lines.join("\n")).toMatch(/outside the project/);
      expect(existsSync(join(fixture, "dist", "app-outside"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("stale shim cleanup", () => {
  it("a later build removes a stale shim but keeps a fresh one", () => {
    const proj = mkdtempSync(join(tmpdir(), "yatta-build-stale-shim-"));
    try {
      writeFileSync(join(proj, "server.ts"), ENTRY);
      // A shim left by a build killed mid-compile (see the hack test's
      // q3-killed repro): same name shape, mtime one hour ago.
      const stale = join(proj, ".yatta-standalone-entry-abcdef01.ts");
      writeFileSync(stale, "// leftover from a killed build\n");
      const hourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(stale, hourAgo, hourAgo);
      // A shim from a build that is still running in the same project
      // (the concurrent-build case): current mtime, must survive.
      const fresh = join(proj, ".yatta-standalone-entry-abcdef02.ts");
      writeFileSync(fresh, "// a concurrent build's live shim\n");
      const outcome = runBuild(proj, ["--standalone", "--entry", "server.ts"]);
      expect(outcome.code).toBe(0);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(join(proj, "dist", "app"))).toBe(true);
      // The build's own shim is gone too: only the fresh planted one
      // remains, which the next build's sweep will age out.
      expect(readdirSync(proj).filter((f) => f.startsWith(".yatta-standalone-entry"))).toEqual([
        ".yatta-standalone-entry-abcdef02.ts",
      ]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("a fresh scaffold's standalone binary (F3)", () => {
  /*
   * The regression that shipped 1.0.6: `yatta build --standalone` exited 0
   * on a fresh scaffold, but the binary died on boot with
   * "Unable to find directory: /$bunfs/backend" — the file router scanned
   * a directory that does not exist in a compiled binary. The tiny
   * server.ts fixture above never caught it: its entry never builds a
   * FileSystemRouter. Only a real scaffold does, so this fixture builds
   * one with `yatta new` and boots the binary it produces.
   *
   * The binary must also survive the second boot failure the router fix
   * exposed: the runtime's worker fleet cannot spawn in a binary either
   * (Bun's compiler never embeds the worker entrypoint), so the fleet
   * stays down and the server still boots and serves.
   */
  let proj = "";
  let appDir = "";
  let binary = "";

  beforeAll(async () => {
    proj = mkdtempSync(join(tmpdir(), "yatta-build-scaffold-"));
    const cwd = process.cwd();
    process.chdir(proj);
    try {
      expect(await main(["new", "app"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    appDir = join(proj, "app");
    // The scaffold resolves the framework the way a real user project
    // does: node_modules/yatta.js points at this checkout, and
    // reflect-metadata sits hoisted next to it as a real directory.
    mkdirSync(join(appDir, "node_modules"));
    symlinkSync(ROOT, join(appDir, "node_modules", "yatta.js"), "dir");
    cpSync(join(ROOT, "node_modules", "reflect-metadata"), join(appDir, "node_modules", "reflect-metadata"), {
      recursive: true,
    });
    const outcome = runBuild(appDir, ["--standalone"]);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join("\n")).toMatch(/routes embedded: 5 file route\(s\)/);
    binary = outcome.outPath!;
  }, 180_000);

  afterAll(() => {
    if (proj) rmSync(proj, { recursive: true, force: true });
  });

  /** A free port for the scaffold binary (it takes PORT, default 4000). */
  function freePort(): number {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = srv.port!;
    srv.stop();
    return port;
  }

  /**
   * Starts the scaffold binary, waiting for its "Yatta listening" line.
   * The port is known up front (passed via PORT), so the line is the
   * readiness signal, not a port announcement.
   */
  async function startScaffold(
    bin: string,
    cwd: string,
    port: number,
  ): Promise<ChildProcess> {
    const child = spawn(bin, [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port) },
    });
    let out = "";
    let errOut = "";
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`scaffold binary did not start listening; got: ${out} ${errOut}`)),
        60_000,
      );
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("Yatta listening")) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errOut += chunk.toString();
      });
      // A binary that crashes at startup never prints the line: fail
      // fast with its stderr instead of waiting out the whole timeout.
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`scaffold binary exited with code ${code} before listening; stdout: ${out} stderr: ${errOut}`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return child;
  }

  it("boots and serves / and /health", async () => {
    const port = freePort();
    const child = await startScaffold(binary, appDir, port);
    try {
      const root = await fetch(`http://localhost:${port}/`);
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual({
        ok: true,
        message: "Edit yatta/backend/ to add your routes.",
      });
      const health = await fetch(`http://localhost:${port}/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.service).toBe("app");
    } finally {
      await stop(child);
    }
  }, 120_000);

  it("serves the file routes from a foreign working directory", async () => {
    // Running from an empty directory proves the routes came from the
    // manifest baked into the binary, not from files read off disk —
    // there is no yatta/backend here to scan.
    const elsewhere = mkdtempSync(join(tmpdir(), "yatta-build-scaffold-elsewhere-"));
    try {
      const port = freePort();
      const child = await startScaffold(binary, elsewhere, port);
      try {
        const root = await fetch(`http://localhost:${port}/`);
        expect(root.status).toBe(200);
        expect(await root.json()).toEqual({
          ok: true,
          message: "Edit yatta/backend/ to add your routes.",
        });
      } finally {
        await stop(child);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  it("carries no build-machine paths", () => {
    const bytes = readFileSync(binary);
    expect(bytes.includes(Buffer.from(proj))).toBe(false);
  });
});
