// src/build_standalone.ts — `yatta build --standalone`.
//
// Compiles a project into one executable with Bun's compile step
// (`bun build --compile`). The binary holds the app code, the schema
// definitions (they are code), and the public static assets. It never
// holds data or secrets — those live next to the binary and are read
// from the environment at runtime.
//
// What Bun embeds, per the Bun docs (bun.sh/docs/compiler/executables):
// only files the entrypoint imports, plus directories passed with
// `--asset`. A file that merely sits next to the entrypoint — a SQLite
// file, an uploads directory, a .env file — is not embedded, because
// nothing imports it and it is not passed as an asset. This module
// leans on that: it builds the input set explicitly, and refuses any
// asset path that looks like data or a secret, so the exclusion is a
// check at build time, not a hope about the output.
//
// Two things the docs call out that shape the defaults here:
// - `.env` files are loaded at runtime from the directory the binary
//   runs in. That is the config mechanism, not a leak: the build never
//   reads the project's .env, and nothing from it is baked in.
// - `--sourcemap` is not passed, on purpose: an embedded sourcemap
//   carries the build machine's paths into the binary.
// - A compiled binary resolves a SQLite path relative to the working
//   directory, not to the binary. So `DATABASE_URL=./data/app.db`
//   means "next to where you run it", which is where data belongs.

import {
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export interface BuildOutcome {
  code: number;
  lines: string[];
  /** Absolute path of the binary, when the build succeeded. */
  outPath?: string;
}

/** Entrypoints, in the same order `yatta dev` and `yatta start` look. */
export const BUILD_ENTRYPOINTS = ["yatta/main.ts", "src/main.ts"] as const;

/** Default output, relative to the project root. */
export const DEFAULT_OUT = "dist/app";

/**
 * Targets Bun documents for `bun build --compile --target`.
 * The `-baseline` and `-modern` suffixes still parse, but Bun resolves
 * them to the same binary, so only the plain names are accepted here.
 */
export const BUILD_TARGETS = [
  "bun-linux-x64",
  "bun-linux-x64-musl",
  "bun-linux-arm64",
  "bun-linux-arm64-musl",
  "bun-windows-x64",
  "bun-windows-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

/** File extensions that mean "data", never "asset". */
const DATA_EXTENSIONS = new Set([
  ".db",
  ".sqlite",
  ".sqlite3",
  ".db-wal",
  ".db-shm",
]);

/** File extensions that mean "secret material", never "asset". */
const SECRET_EXTENSIONS = new Set([".pem", ".key"]);

/** Directory names that mean "data lives here", never "asset". */
const DATA_DIRS = new Set([
  "uploads",
  "storage",
  "database",
  "Database",
  "node_modules",
  ".git",
]);

/**
 * Whether a path looks like data or a secret, and so must never be
 * bundled into the binary.
 *
 * Checked on every path segment, not just the last one: an asset root
 * of `./storage` is refused even though the directory name alone is
 * not a file, and `data/app.db` is refused even though `data` is
 * innocent. A `.env` file is refused under any name that ends in
 * `.env`, and key files by their usual names and extensions.
 */
export function isDataOrSecretPath(path: string): string | null {
  const parts = path.split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (DATA_DIRS.has(part)) return `directory "${part}" holds data, not static assets`;
    if (part === ".env" || part.startsWith(".env.") || part.endsWith(".env")) {
      return `file "${part}" is environment config, not a static asset`;
    }
    if (part.startsWith("id_rsa") || part.startsWith("id_ed25519")) {
      return `file "${part}" looks like a private key`;
    }
    const lower = part.toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot) : "";
    if (DATA_EXTENSIONS.has(ext)) return `file "${part}" is a database file, not a static asset`;
    if (SECRET_EXTENSIONS.has(ext)) return `file "${part}" looks like secret material`;
  }
  return null;
}

/** Walks a directory tree, returning relative file paths. */
function walkFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

interface BuildArgs {
  standalone: boolean;
  entry: string | null;
  out: string;
  target: string | null;
  assets: string[];
  minify: boolean;
}

function parseArgs(args: string[]): { parsed: BuildArgs } | { error: string } {
  const parsed: BuildArgs = {
    standalone: false,
    entry: null,
    out: DEFAULT_OUT,
    target: null,
    assets: [],
    minify: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--standalone") {
      parsed.standalone = true;
    } else if (arg === "--minify") {
      parsed.minify = true;
    } else if (arg === "--entry") {
      const value = args[++i];
      if (!value) return { error: "`--entry` needs a value, e.g. `--entry yatta/main.ts`." };
      parsed.entry = value;
    } else if (arg === "--out") {
      const value = args[++i];
      if (!value) return { error: "`--out` needs a value, e.g. `--out dist/app`." };
      parsed.out = value;
    } else if (arg === "--target") {
      const value = args[++i];
      if (!value) return { error: "`--target` needs a value, e.g. `--target bun-linux-x64`." };
      if (!(BUILD_TARGETS as readonly string[]).includes(value)) {
        return {
          error:
            `\`--target ${value}\` is not a documented compile target. ` +
            `Use one of: ${BUILD_TARGETS.join(", ")}.`,
        };
      }
      parsed.target = value;
    } else if (arg === "--asset") {
      const value = args[++i];
      if (!value) return { error: "`--asset` needs a value, e.g. `--asset public`." };
      parsed.assets.push(value);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option "${arg}".` };
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
    "  yatta build --standalone [--entry <file>] [--out <file>] [--target <target>] [--asset <dir>] [--minify]",
    "",
    "Builds one executable from the project entrypoint with `bun build --compile`.",
    "Code, schema definitions, and public static assets go in the binary.",
    "Data and secrets never do: databases, uploads, and .env files stay",
    "outside, beside the binary, and config comes from the environment",
    "at runtime.",
    "",
    "  --entry    Entrypoint; default: yatta/main.ts, then src/main.ts.",
    "  --out      Output binary; default: dist/app.",
    "  --target   Cross-compile target, e.g. bun-linux-x64, bun-darwin-arm64.",
    "  --asset    Directory to embed, repeatable. ./public is embedded",
    "             automatically when it exists. A path that looks like",
    "             data or a secret is refused, not bundled.",
    "  --minify   Minify the bundled code before compiling.",
    "",
  ];
}

/**
 * Finds the entrypoint: an explicit `--entry` first, then the same
 * candidates `yatta dev` looks for. Returns the path as given (kept
 * relative when it is relative), so the bundler records the embedded
 * files under its own root instead of the build machine's path.
 */
function resolveEntry(cwd: string, explicit: string | null): string | null {
  if (explicit) {
    return existsSync(resolve(cwd, explicit)) ? explicit : null;
  }
  for (const candidate of BUILD_ENTRYPOINTS) {
    if (existsSync(join(cwd, candidate))) return candidate;
  }
  return null;
}

/**
 * The asset directories for this build: every explicit `--asset`, plus
 * `./public` when it exists and was not already named. Each one is
 * checked for data or secret paths before anything is compiled.
 */
function resolveAssets(
  cwd: string,
  explicit: string[],
): { assets: string[] } | { error: string } {
  const assets = [...explicit];
  if (!assets.includes("public") && !assets.includes("./public")) {
    if (existsSync(join(cwd, "public"))) assets.push("public");
  }
  for (const asset of assets) {
    const reason = isDataOrSecretPath(asset);
    if (reason) {
      return { error: `Refusing --asset "${asset}": ${reason}.` };
    }
    const abs = resolve(cwd, asset);
    if (!existsSync(abs)) {
      return { error: `Asset path "${asset}" does not exist.` };
    }
    if (!statSync(abs).isDirectory()) {
      return { error: `Asset path "${asset}" is not a directory; --asset takes a directory.` };
    }
    // A directory can hide a data file inside it. Walk it and refuse
    // the whole asset rather than silently dropping one file: a build
    // that quietly embeds all-but-one file is a build nobody trusts.
    for (const file of walkFiles(abs, "")) {
      const fileReason = isDataOrSecretPath(file);
      if (fileReason) {
        return {
          error:
            `Refusing --asset "${asset}": it contains "${file}", and ${fileReason}. ` +
            `Move data out of the asset directory and rebuild.`,
        };
      }
    }
  }
  return { assets };
}

export function runBuild(cwd: string, args: string[]): BuildOutcome {
  const parsedArgs = parseArgs(args);
  if ("error" in parsedArgs) {
    return { code: 1, lines: ["", `yatta build: ${parsedArgs.error}`, ...usageLines()] };
  }
  const opts = parsedArgs.parsed;

  // Today there is exactly one build mode. A bare `yatta build` is a
  // mistake, not a default: failing here beats producing a binary the
  // caller did not ask for in a form they did not choose.
  if (!opts.standalone) {
    return {
      code: 1,
      lines: [
        "",
        "yatta build: nothing to build without --standalone.",
        ...usageLines(),
      ],
    };
  }

  const entry = resolveEntry(cwd, opts.entry);
  if (!entry) {
    if (opts.entry) {
      return {
        code: 1,
        lines: ["", `yatta build: entrypoint "${opts.entry}" does not exist in ${cwd}.`],
      };
    }
    return {
      code: 1,
      lines: [
        "",
        `yatta build: no entrypoint found in ${cwd}.`,
        `  Looked for ${BUILD_ENTRYPOINTS.join(" or ")}.`,
        "  Pass one explicitly: yatta build --standalone --entry <file>.",
      ],
    };
  }

  const entryReason = isDataOrSecretPath(entry);
  if (entryReason) {
    return { code: 1, lines: ["", `yatta build: refusing entrypoint "${entry}": ${entryReason}.`] };
  }

  const resolvedAssets = resolveAssets(cwd, opts.assets);
  if ("error" in resolvedAssets) {
    return { code: 1, lines: ["", `yatta build: ${resolvedAssets.error}`] };
  }

  const outAbs = resolve(cwd, opts.out);
  const bunArgs = ["build", "--compile", entry, "--outfile", outAbs];
  for (const asset of resolvedAssets.assets) bunArgs.push("--asset", asset);
  if (opts.target) bunArgs.push("--target", opts.target);
  if (opts.minify) bunArgs.push("--minify");

  // No --sourcemap: an embedded sourcemap carries the build machine's
  // paths into the binary. No --bytecode either: it is a startup
  // optimisation, not a correctness need, and it stays opt-in by hand.
  const res = spawnSync("bun", bunArgs, { cwd, encoding: "utf8" });
  if (res.error) {
    return { code: 1, lines: ["", `yatta build: could not run \`bun\`: ${res.error.message}`] };
  }
  if (res.status !== 0) {
    const detail = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return {
      code: res.status ?? 1,
      lines: ["", "yatta build: `bun build --compile` failed.", ...(detail ? [detail] : [])],
    };
  }
  if (!existsSync(outAbs)) {
    return {
      code: 1,
      lines: ["", `yatta build: bun reported success but ${outAbs} is missing.`],
    };
  }

  // Bun sets the executable bit on its own; make it explicit so a
  // build on a filesystem that drops it still ships runnable.
  try {
    chmodSync(outAbs, 0o755);
  } catch {
    // A filesystem that drops the bit fails here but the binary itself
    // is still usable; the size line below says what was produced.
  }

  const size = statSync(outAbs).size;
  const lines = [
    "",
    `✓ Built ${outAbs} (${size} bytes) from ${entry}.`,
    ...(resolvedAssets.assets.length > 0
      ? [`  assets embedded: ${resolvedAssets.assets.join(", ")}`]
      : ["  no asset directory embedded (no ./public, no --asset)"]),
    "  Data and secrets are NOT in this binary: keep your database and",
    "  uploads beside it, and set config (including .env) where it runs.",
  ];
  return { code: 0, lines, outPath: outAbs };
}

/** CLI entry: prints the outcome lines, returns the exit code. */
export function cmdBuild(args: string[]): number {
  const outcome = runBuild(process.cwd(), args);
  for (const line of outcome.lines) console.log(line);
  return outcome.code;
}
