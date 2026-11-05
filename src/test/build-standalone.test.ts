import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDataOrSecretPath, runBuild } from "../build_standalone";
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
  const port = await new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`binary did not print READY; got: ${out}`)),
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

  it("leaves ordinary code and public assets alone", () => {
    for (const path of ["server.ts", "public/hello.txt", "extra/extra.txt", "src/main.ts"]) {
      expect(isDataOrSecretPath(path)).toBeNull();
    }
  });
});

describe("JIT and AOT modes", () => {
  it("refuses --aot on a Bun that does not advertise it, instead of silently building JIT", () => {
    // This Bun (1.4.4) lists neither --aot nor --trim in `bun build --help`,
    // and silently ignores unknown build flags — so a requested AOT or
    // trimmed build must fail here with an upgrade pointer, never ship
    // a JIT binary wearing the AOT label.
    const aot = runBuild(dir, ["--standalone", "--entry", "server.ts", "--aot"]);
    expect(aot.code).toBe(1);
    expect(aot.lines.join("\n")).toMatch(/does not support --aot/);
    expect(aot.lines.join("\n")).toMatch(/Upgrade Bun/);

    const trim = runBuild(dir, ["--standalone", "--entry", "server.ts", "--trim"]);
    expect(trim.code).toBe(1);
    expect(trim.lines.join("\n")).toMatch(/does not support --trim/);
  });

  it("refuses --explain without --aot, and --aot with a foreign target", () => {
    const explain = runBuild(dir, ["--standalone", "--entry", "server.ts", "--explain"]);
    expect(explain.code).toBe(1);
    expect(explain.lines.join("\n")).toMatch(/--explain needs --aot/);

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
});

describe("build machinery is CLI-only", () => {
  it("is not imported by the server entrypoint", () => {
    const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(mainSource).not.toContain("build_standalone");
  });
});
