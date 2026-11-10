// src/build_standalone.ts — `yatta build --standalone`.
//
// Compiles a project into one executable with Bun's compile step
// (`bun build --compile`). The binary holds the app code, the schema
// definitions (they are code), and the public static assets. It never
// holds data or secrets — those live next to the binary and are read
// from the environment at runtime.
//
// What Bun embeds, per the Bun docs (bun.com/docs/compiler/
// executables): only files the entrypoint imports, plus directories
// passed with `--asset`. A file that merely sits next to the
// entrypoint — a SQLite file, an uploads directory, a .env file — is
// not embedded, because nothing imports it and it is not passed as an
// asset. This module leans on that: it builds the input set
// explicitly, and refuses any asset path that looks like data or a
// secret, so the exclusion is a check at build time, not a hope about
// the output.
//
// Two build modes (bun.com/docs/compiler/aot). The default bundles
// the JavaScript and runs it with the JIT — the stable mode, and the
// only one that cross-compiles. `--aot` compiles to machine code at
// build time instead: faster startup, less memory, no JIT — but it
// builds only for the machine it runs on, type errors stop it, and
// untyped hot code can run slower than under the JIT. The docs say
// to build both and measure under real load, keeping the second JIT
// run (warmed up); this command offers both spellings, it does not
// pick for you.
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
//
// Version honesty, measured on Bun 1.4.4 (this VM):
// - There is no standalone `bun compile` command ("Script not
//   found"), so only the `bun build --compile` form is ever used.
// - `bun build --compile --aot` is accepted (exit 0), but whether it
//   changes codegen on 1.4.4 is unverified: `bun build` silently
//   ignores flags it does not know (proven: `--bogusflag` and
//   `--minif` both produced binaries, byte-identical in size to the
//   plain build), and no `--explain` output exists here to confirm
//   anything. So `--aot` and `--trim` pass through as requested, the
//   binary is verified to build and run, and the output says plainly
//   that AOT speed/memory wins are unverified on this Bun — never
//   claimed, never silently substituted.
// - `--explain` is different: its whole value is the report, and on
//   1.4.4 it just bundles normally with no report. So `--explain` is
//   accepted only when `bun build --help` lists it, and otherwise the
//   build stops with the Bun version and an upgrade pointer.
// - `bun check --aot` does not exist on 1.4.4 ("Unknown flag"), so
//   the type gate falls back to plain `bun check` there, and says so
//   in the output. The `--aot` gate needs a newer Bun to verify.
//
// Two standalone requirements, measured on Bun 1.4.4 (perf round 2):
// - The entrypoint must live inside the project directory. `bun build`
//   resolves bare imports from the entry's location, so an entry
//   outside the package bundles almost nothing (1 module in the
//   minimal repro) and the binary fails at runtime with "Cannot find
//   package 'otplib'", then "'@simplewebauthn/server'". The build
//   refuses such an entry instead of shipping that binary.
// - The binary needs `import "reflect-metadata"` FIRST. Without it the
//   binary crashes at startup: "tsyringe requires a reflect polyfill"
//   (thrown from tsyringe's lazy init, reached through
//   @simplewebauthn/server, which the framework's auth imports).
//   The polyfill's code is in the bundle either way — it rides in
//   via @simplewebauthn/server's certificate helpers — but with
//   dynamic `await import(...)` (as in the framework's own main.ts)
//   Bun evaluates the framework modules first and tsyringe's init
//   runs before the polyfill code, so it is in the bundle but too
//   late. The build therefore compiles a generated shim entry inside
//   the project that imports reflect-metadata first, then the real
//   entrypoint, and deletes the shim after the build. The bare
//   specifier resolves from the project's node_modules first: trusted
//   code, the same boundary as `bun run`.
// - File-based routes need the same treatment in reverse. The
//   scaffold's router builds a `Bun.FileSystemRouter` over
//   `yatta/backend/`, but a compiled binary has no backend directory
//   on disk — every module is bundled into one file, so
//   `import.meta.dir` is `/$bunfs/root` and the router throws
//   "Unable to find directory" at startup. The build therefore lists
//   the backend routes with Bun's own FileSystemRouter (so the table
//   is exactly what `bun run` would match) and bakes the table into
//   the shim: each route file is imported, so it is bundled as code,
//   and the table is set on `globalThis` for the router to match
//   against. Nothing is read from `$bunfs` at runtime — an embedded
//   `.ts` file loads untranspiled there, so it could not be imported
//   anyway. The router reads the table lazily, on the first request,
//   because imports evaluate before the shim body assigns it.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";

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

/** Reports `bun compile --explain` accepts, per the AOT docs. */
const EXPLAIN_REPORTS = [
  "json",
  "guards",
  "guards-json",
  "trim",
  "missed-optimizations",
  "allocations",
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
 * innocent. An env file is refused in any case (`.ENV` is `.env` on
 * a case-insensitive filesystem), under any name that contains
 * `.env.` (backups like `my.env.bak`), and as `.envrc` — and key
 * files by their usual names and extensions.
 */
export function isDataOrSecretPath(path: string): string | null {
  const parts = path.split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (DATA_DIRS.has(part)) return `directory "${part}" holds data, not static assets`;
    // Env files, in any case and under any env-ish name: compare
    // lowercased, and treat any `.env.` segment as an env file, not
    // just a leading one — a backup holds the same secrets as the
    // file itself, and `.envrc` is direnv's env file.
    const lower = part.toLowerCase();
    if (
      lower === ".env" ||
      lower === ".envrc" ||
      lower.startsWith(".envrc.") ||
      lower.endsWith(".env") ||
      lower.includes(".env.")
    ) {
      return `file "${part}" is environment config, not a static asset`;
    }
    if (part.startsWith("id_rsa") || part.startsWith("id_ed25519")) {
      return `file "${part}" looks like a private key`;
    }
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

type DisallowLevel = "normal" | "strict";

interface BuildArgs {
  standalone: boolean;
  entry: string | null;
  out: string;
  target: string | null;
  assets: string[];
  minify: boolean;
  aot: boolean;
  noAot: boolean;
  explain: string | null;
  trim: boolean;
  smol: boolean;
  noAddons: boolean;
  noFfiCc: boolean;
  disallowCodeGeneration: DisallowLevel | null;
  check: boolean;
  config: string | null;
}

function defaultArgs(): BuildArgs {
  return {
    standalone: false,
    entry: null,
    out: DEFAULT_OUT,
    target: null,
    assets: [],
    minify: false,
    aot: false,
    noAot: false,
    explain: null,
    trim: false,
    smol: false,
    noAddons: false,
    noFfiCc: false,
    disallowCodeGeneration: null,
    check: false,
    config: null,
  };
}

function parseArgs(args: string[]): { parsed: BuildArgs; given: Set<string> } | { error: string } {
  const parsed = defaultArgs();
  const given = new Set<string>();
  const takeValue = (i: number): string | null => {
    const value = args[i + 1];
    if (!value) return null;
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--standalone") {
      parsed.standalone = true;
      given.add("standalone");
    } else if (arg === "--minify") {
      parsed.minify = true;
      given.add("minify");
    } else if (arg === "--aot") {
      parsed.aot = true;
      given.add("aot");
    } else if (arg === "--no-aot") {
      parsed.noAot = true;
      given.add("noAot");
    } else if (arg === "--trim") {
      parsed.trim = true;
      given.add("trim");
    } else if (arg === "--smol") {
      parsed.smol = true;
      given.add("smol");
    } else if (arg === "--no-addons") {
      parsed.noAddons = true;
      given.add("noAddons");
    } else if (arg === "--no-ffi-cc") {
      parsed.noFfiCc = true;
      given.add("noFfiCc");
    } else if (arg === "--check") {
      parsed.check = true;
      given.add("check");
    } else if (arg === "--explain") {
      parsed.explain = "";
      given.add("explain");
    } else if (arg.startsWith("--explain=")) {
      const report = arg.slice("--explain=".length);
      if (!(EXPLAIN_REPORTS as readonly string[]).includes(report)) {
        return {
          error:
            `\`--explain=${report}\` is not a known report. ` +
            `Use --explain, or one of: ${EXPLAIN_REPORTS.join(", ")}.`,
        };
      }
      parsed.explain = report;
      given.add("explain");
    } else if (arg === "--disallow-code-generation") {
      parsed.disallowCodeGeneration = "normal";
      given.add("disallowCodeGeneration");
    } else if (arg.startsWith("--disallow-code-generation=")) {
      const level = arg.slice("--disallow-code-generation=".length);
      if (level !== "strict") {
        return { error: "`--disallow-code-generation` takes only `=strict` as a value." };
      }
      parsed.disallowCodeGeneration = "strict";
      given.add("disallowCodeGeneration");
    } else if (arg === "--entry" || arg === "--out" || arg === "--target" || arg === "--config") {
      const value = takeValue(i);
      if (!value) return { error: `\`${arg}\` needs a value.` };
      i++;
      given.add(arg.slice(2));
      if (arg === "--entry") parsed.entry = value;
      if (arg === "--out") parsed.out = value;
      if (arg === "--config") parsed.config = value;
      if (arg === "--target") {
        if (!(BUILD_TARGETS as readonly string[]).includes(value)) {
          return {
            error:
              `\`--target ${value}\` is not a documented compile target. ` +
              `Use one of: ${BUILD_TARGETS.join(", ")}.`,
          };
        }
        parsed.target = value;
      }
    } else if (arg === "--asset") {
      const value = takeValue(i);
      if (!value) return { error: "`--asset` needs a value, e.g. `--asset public`." };
      i++;
      given.add("assets");
      parsed.assets.push(value);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option "${arg}".` };
    } else {
      return { error: `Unexpected argument "${arg}".` };
    }
  }
  return { parsed, given };
}

/**
 * Keys a build config file may set. Anything else is an error, not a
 * silent ignore: a misspelled key that quietly did nothing would be
 * a build the caller did not actually request.
 */
const CONFIG_KEYS = [
  "entry",
  "out",
  "target",
  "assets",
  "minify",
  "aot",
  "trim",
  "smol",
  "noAddons",
  "noFfiCc",
  "disallowCodeGeneration",
  "explain",
  "check",
] as const;

/**
 * Reads a build config file. JSON5 on purpose: a hand-edited config
 * with comments and trailing commas is friendlier than strict JSON,
 * and Bun parses it at build time with zero runtime cost — the file
 * is read here, by the CLI, and never embedded in the binary.
 * CLI flags win over config values; --asset appends only when no
 * --asset flag was given.
 */
function applyConfig(
  cwd: string,
  opts: BuildArgs,
  given: Set<string>,
): { ok: true } | { error: string } {
  if (!opts.config) return { ok: true };
  const path = resolve(cwd, opts.config);
  if (!existsSync(path)) {
    return { error: `Config file "${opts.config}" does not exist.` };
  }
  let raw: unknown;
  try {
    raw = Bun.JSON5.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      error: `Config file "${opts.config}" did not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `Config file "${opts.config}" must hold one JSON object.` };
  }
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      return {
        error:
          `Config file "${opts.config}" sets unknown key "${key}". ` +
          `Known keys: ${CONFIG_KEYS.join(", ")}.`,
      };
    }
  }
  const asString = (key: string): string | null => {
    const value = config[key];
    if (value === undefined) return null;
    if (typeof value !== "string") return null;
    return value;
  };
  const asBool = (key: string): boolean | null => {
    const value = config[key];
    if (value === undefined) return null;
    if (typeof value !== "boolean") return null;
    return value;
  };
  if (!given.has("entry")) {
    const value = asString("entry");
    if (value !== null) opts.entry = value;
    else if (config.entry !== undefined) return { error: `Config key "entry" must be a string.` };
  }
  if (!given.has("out")) {
    const value = asString("out");
    if (value !== null) opts.out = value;
    else if (config.out !== undefined) return { error: `Config key "out" must be a string.` };
  }
  if (!given.has("target")) {
    const value = asString("target");
    if (value !== null) {
      if (!(BUILD_TARGETS as readonly string[]).includes(value)) {
        return { error: `Config key "target" must be one of: ${BUILD_TARGETS.join(", ")}.` };
      }
      opts.target = value;
    } else if (config.target !== undefined) return { error: `Config key "target" must be a string.` };
  }
  if (!given.has("assets")) {
    const value = config.assets;
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return { error: `Config key "assets" must be an array of strings.` };
      }
      opts.assets = [...value];
    }
  }
  for (const key of ["minify", "aot", "trim", "smol", "noAddons", "noFfiCc", "check"] as const) {
    if (!given.has(key)) {
      const value = asBool(key);
      if (value !== null) opts[key] = value;
      else if (config[key] !== undefined) return { error: `Config key "${key}" must be a boolean.` };
    }
  }
  if (!given.has("disallowCodeGeneration")) {
    const value = config.disallowCodeGeneration;
    if (value !== undefined) {
      if (value === true) opts.disallowCodeGeneration = "normal";
      else if (value === "strict") opts.disallowCodeGeneration = "strict";
      else if (value === false) opts.disallowCodeGeneration = null;
      else {
        return { error: `Config key "disallowCodeGeneration" must be true, false, or "strict".` };
      }
    }
  }
  if (!given.has("explain")) {
    const value = config.explain;
    if (value !== undefined) {
      if (value === true) opts.explain = "";
      else if (value === false) opts.explain = null;
      else if (typeof value === "string" && (EXPLAIN_REPORTS as readonly string[]).includes(value)) {
        opts.explain = value;
      } else {
        return { error: `Config key "explain" must be true, false, or one of: ${EXPLAIN_REPORTS.join(", ")}.` };
      }
    }
  }
  return { ok: true };
}

function usageLines(): string[] {
  return [
    "",
    "Usage:",
    "  yatta build --standalone [--entry <file>] [--out <file>] [--target <target>] [--asset <dir>] [--config <file>]",
    "    [--aot | --no-aot] [--explain[=<report>]] [--trim] [--minify] [--check]",
    "    [--smol] [--no-addons] [--no-ffi-cc] [--disallow-code-generation[=strict]]",
    "",
    "Builds one executable from the project entrypoint with `bun build --compile`.",
    "Code, schema definitions, and public static assets go in the binary.",
    "Data and secrets never do: databases, uploads, and .env files stay",
    "outside, beside the binary, and config comes from the environment",
    "at runtime.",
    "",
    "  --entry    Entrypoint; default: yatta/main.ts, then src/main.ts.",
    "             Must live inside the project directory: bun build",
    "             resolves bare imports from the entry's location, so an",
    "             entry outside the package bundles almost nothing.",
    "  --out      Output binary; default: dist/app.",
    "             Refuses to overwrite the entrypoint, or an existing",
    "             file that is not a previous build output.",
    "  --target   Cross-compile target, e.g. bun-linux-x64, bun-darwin-arm64.",
    "  --asset    Directory to embed, repeatable. ./public is embedded",
    "             automatically when it exists. A path that looks like",
    "             data or a secret is refused, not bundled.",
    "  --config   Build config file (JSON or JSON5: comments and trailing",
    "             commas allowed). CLI flags win over config values.",
    "  --aot      Compile to machine code (bun build --compile --aot).",
    "             Faster startup, less memory — but only for the machine",
    "             it runs on, and type errors stop the build.",
    "  --no-aot   Bundle the JavaScript and run it with the JIT (default).",
    "             The only mode that cross-compiles.",
    "  --explain  With --aot, list slow paths worst-first with a fix each.",
    "  --trim     Drop Bun/Node APIs the code never calls (smaller binary).",
    "  --minify   Minify the bundled code before compiling.",
    "  --check    Type-check the entrypoint with `bun check` first.",
    "             Always on for --aot; opt-in for JIT builds.",
    "             An entry that only uses top-level await must be a",
    "             module: add `export {};` to it, or the gate fails",
    "             with TS1375.",
    "  --smol     Bake --smol into the binary: less memory, more GC.",
    "             An explicit knob for small boxes, never a default.",
    "  --no-addons  Bake --no-addons: refuse dlopen and bun:ffi cc().",
    "  --no-ffi-cc  Bake --no-ffi-cc: refuse bun:ffi cc() only.",
    "  --disallow-code-generation[=strict]  Bake the string-to-code ban",
    "             into the binary: eval and new Function throw EvalError.",
    "             =strict bans every string-to-code path. Refused at",
    "             build time when the entrypoint itself generates code.",
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
 * Whether a file lives inside a directory, after resolving symlinks
 * on both sides: a symlinked /tmp or a symlinked entry must not
 * defeat the check, and a path that only looks inside (`..` that
 * stays put) must pass.
 */
export function isInsideDir(dir: string, file: string): boolean {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    root = resolve(dir);
  }
  let abs: string;
  try {
    abs = realpathSync(file);
  } catch {
    abs = resolve(file);
  }
  // The root itself already ends in the separator ("/" on POSIX,
  // "C:\" on Windows), so appending another one would require "//"
  // and nothing would ever pass.
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs === root || abs.startsWith(prefix);
}

/**
 * Whether a file looks like a compiled executable: the ELF, Mach-O,
 * or PE signature at its start. `yatta build --standalone` writes
 * one of these, so a file that has one is a previous build output
 * and may be overwritten by a rebuild; anything else at the output
 * path is the user's file, not the build's.
 */
function looksLikeCompiledBinary(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(64);
    const read = readSync(fd, header, 0, 64, 0);
    if (read >= 4) {
      const magic = header.subarray(0, 4);
      // ELF.
      if (magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46) {
        return true;
      }
      // Mach-O 64/32, both endiannesses, and the universal (fat) magic.
      if (
        (magic[0] === 0xcf && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe) ||
        (magic[0] === 0xfe && magic[1] === 0xed && magic[2] === 0xfa && magic[3] === 0xcf) ||
        (magic[0] === 0xce && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe) ||
        (magic[0] === 0xfe && magic[1] === 0xed && magic[2] === 0xfa && magic[3] === 0xce) ||
        (magic[0] === 0xca && magic[1] === 0xfe && magic[2] === 0xba && magic[3] === 0xbe)
      ) {
        return true;
      }
    }
    // PE (Windows): an "MZ" header with a "PE\0\0" signature at the
    // offset stored at 0x3c.
    if (read >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
      const peOffset = header.readUInt32LE(0x3c);
      const signature = Buffer.alloc(4);
      const got = readSync(fd, signature, 0, 4, peOffset);
      if (
        got === 4 &&
        signature[0] === 0x50 &&
        signature[1] === 0x45 &&
        signature[2] === 0x00 &&
        signature[3] === 0x00
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read already answered; a close failure changes nothing.
      }
    }
  }
}

/**
 * The output destination must never destroy the entrypoint or the
 * user's data: `bun build --compile --outfile` overwrites whatever
 * it names, with no warning. So --out is refused when it is the
 * entrypoint itself (compared after resolving symlinks, so
 * `--out ./server.ts` and `--out sub/../server.ts` are both caught),
 * and refused when it names an existing file that is not already a
 * binary this command produced — a rebuild overwrites its own
 * previous output, anything else must be moved or deleted by hand
 * first. There is deliberately no --force: overwriting a file you
 * did not mean to is a typo away, and deleting it first is the
 * explicit act.
 */
function guardOutPath(
  display: string,
  outAbs: string,
  entryAbs: string,
): { ok: true } | { error: string } {
  let isEntry = outAbs === entryAbs;
  if (!isEntry && existsSync(outAbs)) {
    try {
      isEntry = realpathSync(outAbs) === realpathSync(entryAbs);
    } catch {
      // Unresolvable paths are not the entry; the checks below decide.
    }
  }
  if (isEntry) {
    return {
      error:
        `--out "${display}" is the entrypoint itself. ` +
        `The build would replace your source with the binary; choose another --out.`,
    };
  }
  let stat;
  try {
    stat = statSync(outAbs);
  } catch {
    return { ok: true };
  }
  if (stat.isDirectory()) {
    return { error: `--out "${display}" is a directory; pass a file path for the binary.` };
  }
  if (!stat.isFile()) {
    return { error: `--out "${display}" exists but is not a regular file; choose another --out.` };
  }
  if (looksLikeCompiledBinary(outAbs)) return { ok: true };
  return {
    error:
      `--out "${display}" already exists and is not a previous build output. ` +
      `Move or delete it first, or choose another --out.`,
  };
}

/** Generated entrypoint filename prefix. Random suffix, deleted after the build. */
const SHIM_PREFIX = ".yatta-standalone-entry-";

/**
 * A shim is stale when it is older than this: a build takes seconds,
 * so a shim older than ten minutes cannot belong to a build that is
 * still running. The age bar is what makes the sweep safe for
 * concurrent builds in the same project — a live build's shim is
 * seconds old and is never touched.
 */
const STALE_SHIM_MAX_AGE_MS = 10 * 60 * 1000;

/** The exact name shape this tool generates: prefix + 8 hex + ".ts". */
const STALE_SHIM_RE = /^\.yatta-standalone-entry-[0-9a-f]{8}\.ts$/;

/**
 * Best-effort removal of shims left by builds that were killed
 * mid-compile. Only files with the exact generated name and older
 * than STALE_SHIM_MAX_AGE_MS are removed, so a concurrent build's
 * live shim (seconds old) is never touched, and nothing the user
 * wrote is ever matched. Failures are swallowed: a leftover shim is
 * inert, and the build must not fail for a cleanup it could not do.
 */
function sweepStaleShims(cwd: string): void {
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_SHIM_MAX_AGE_MS;
  for (const name of names) {
    if (!STALE_SHIM_RE.test(name)) continue;
    const path = join(cwd, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

/**
 * Where `reflect-metadata` resolves from, for the generated entry.
 * Returns the import specifier for the shim — the bare name when the
 * package resolves from inside the project, the absolute file
 * otherwise — or null when it resolves nowhere at all.
 */
function resolveReflectMetadata(cwd: string): string | null {
  // The bare name is only safe when the resolved file actually lives
  // inside the project: `Bun.resolveSync` also consults Bun's global
  // install cache, and `bun build` does NOT resolve a bare specifier
  // from there — a fixture with no node_modules proved it, failing
  // the build with "Could not resolve: 'reflect-metadata'". So the
  // resolution is checked against the project directory, and anything
  // outside it is imported by absolute file path, which the bundler
  // always accepts.
  //
  // Precedence: the project's own install first (the app's copy wins,
  // matching `bun run`); the framework's install second (it always
  // carries the package, transitive via @simplewebauthn/server, so a
  // project that imports the framework can be shimmed even when its
  // own node_modules does not hoist it); the global-cache copy last.
  let fromProject: string | null = null;
  try {
    fromProject = Bun.resolveSync("reflect-metadata", cwd);
  } catch {
    fromProject = null;
  }
  if (fromProject !== null && isInsideDir(cwd, fromProject)) {
    return "reflect-metadata";
  }
  try {
    const fromFramework = Bun.resolveSync("reflect-metadata", join(import.meta.dir, ".."));
    return fromFramework.split(sep).join("/");
  } catch {
    // Not in the framework's install either; fall through.
  }
  if (fromProject !== null) {
    return fromProject.split(sep).join("/");
  }
  return null;
}

/** Specifiers that need the polyfill: the framework and its passkey stack. */
function isFrameworkSpecifier(spec: string): boolean {
  return (
    spec === "yatta.js" ||
    spec.startsWith("yatta.js/") ||
    spec === "@simplewebauthn/server" ||
    spec.startsWith("@simplewebauthn/server/") ||
    spec === "tsyringe" ||
    spec.startsWith("tsyringe/") ||
    spec.includes("simplewebauthn") ||
    spec.includes("types/auth") ||
    spec.includes("func/auth")
  );
}

/** How deep the transitive scan follows relative imports (entry + 4 hops). */
const MAX_POLYFILL_SCAN_DEPTH = 4;

/**
 * Whether the entry source imports the framework (or its passkey
 * stack) — the only callers that need the polyfill. A heuristic,
 * used only when reflect-metadata resolves nowhere: it decides
 * between refusing the build and building without the shim, and a
 * false positive there fails closed with a clear message.
 *
 * Beyond static and dynamic imports it also matches `require()`
 * calls, dynamic imports through a `const NAME = "..."` binding in
 * the same file, and relative imports followed transitively — an
 * entry that only reaches the framework through a local helper
 * still needs the polyfill, and so does one that imports framework
 * source by relative path (a monorepo checkout). Only real files
 * are followed, never node_modules, and a missing or unreadable
 * file simply ends that branch; a visited set keeps cycles from
 * looping. Anything subtler (a specifier built at runtime, a
 * template literal) is still missed — the heuristic is a tripwire,
 * not a proof, and the null branch it guards is nearly unreachable
 * on a normal machine.
 */
export function entryNeedsPolyfill(source: string, entryDir?: string): boolean {
  return scanForFramework(source, entryDir, 0, new Set<string>());
}

function scanForFramework(
  source: string,
  entryDir: string | undefined,
  depth: number,
  visited: Set<string>,
): boolean {
  // `const NAME = "literal"` bindings, so `import(NAME)` and
  // `require(NAME)` can be resolved to the string they hold.
  const bindings = new Map<string, string>();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g,
  )) {
    bindings.set(match[1]!, match[2]!);
  }
  const re =
    /(?:from\s+|import\s+|import\(\s*|require\(\s*)(?:"([^"']+)"|'([^"']+)'|([A-Za-z_$][\w$]*))/g;
  for (const match of source.matchAll(re)) {
    let spec: string | null = match[1] ?? match[2] ?? null;
    if (spec === null && match[3] !== undefined) {
      spec = bindings.get(match[3]) ?? null;
    }
    if (spec === null) continue;
    if (isFrameworkSpecifier(spec)) return true;
    if (entryDir !== undefined && spec.startsWith(".") && depth < MAX_POLYFILL_SCAN_DEPTH) {
      const resolved = resolveRelativeImport(entryDir, spec);
      if (resolved !== null && !visited.has(resolved)) {
        visited.add(resolved);
        let next = "";
        try {
          next = readFileSync(resolved, "utf8");
        } catch {
          next = "";
        }
        if (next !== "" && scanForFramework(next, dirname(resolved), depth + 1, visited)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Resolve a relative import to a real file, trying the usual
 * extensions and index files. Never follows into node_modules: a
 * relative import that lands there is not the app's own code, and
 * the scan has no business reading dependency sources.
 */
function resolveRelativeImport(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  if (base.split(sep).includes("node_modules")) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.tsx`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one; try the next candidate.
    }
  }
  return null;
}

/**
 * One file-based route, as the build bakes it into the binary.
 *
 * `pattern` is the Next.js-style route (`/` or `/posts/[id]`), exactly as
 * Bun's own FileSystemRouter reports it. `file` is the route file's path
 * relative to the project root — never absolute, so the binary carries no
 * build-machine paths. `abs` is the build-time absolute path, used only
 * while generating the shim.
 */
export interface StandaloneRouteEntry {
  pattern: string;
  file: string;
  abs: string;
}

/**
 * The file-route table for the standalone binary, or null when the
 * entrypoint has no `backend/` directory next to it.
 *
 * A compiled binary has no backend directory on disk: every module is
 * bundled into one file, so `import.meta.dir` is `/$bunfs/root` and a
 * `Bun.FileSystemRouter` over the backend directory throws
 * "Unable to find directory" at startup — the binary dies before it
 * serves anything. The routes are therefore baked in at build time:
 * this lists them with Bun's own FileSystemRouter, so the table is
 * exactly what the file router would have matched under `bun run`
 * (same files, same patterns, same `[param]` segments). The shim
 * imports each route file, so the modules ride in the binary as code,
 * and the router matches against the table instead of the filesystem.
 * Nothing is read from `$bunfs` at runtime — an embedded `.ts` file
 * loads untranspiled there, so it could not be imported anyway.
 */
function buildRouteManifest(
  cwd: string,
  entry: string,
): { manifest: StandaloneRouteEntry[] | null; backendRel: string | null } | { error: string } {
  const backendDir = resolve(cwd, dirname(entry), "backend");
  const backendRel = relative(cwd, backendDir).split(sep).join("/");
  let stat;
  try {
    stat = statSync(backendDir);
  } catch {
    return { manifest: null, backendRel: null };
  }
  if (!stat.isDirectory()) return { manifest: null, backendRel: null };
  let routes: Record<string, string>;
  try {
    const router = new Bun.FileSystemRouter({ style: "nextjs", dir: backendDir });
    routes = (router as unknown as { routes: Record<string, string> }).routes;
  } catch (err) {
    return {
      error:
        `could not list the backend routes in "${backendRel}": ` +
        `${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  const manifest = Object.entries(routes)
    .map(([pattern, abs]) => ({
      pattern,
      file: relative(cwd, abs).split(sep).join("/"),
      abs,
    }))
    .sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return { manifest, backendRel };
}

/**
 * The generated entrypoint: the polyfill first, then the real entry.
 * The import is first on purpose — decorators run at import time, so
 * a later import would be too late — and the entry is imported, not
 * copied, so its `import.meta.dir` is unchanged.
 *
 * When the entrypoint has a `backend/` directory, the route table is
 * baked in here too (see buildRouteManifest): each route file is
 * imported, so it is bundled as code, and the table is set on
 * `globalThis` for the router to read. The table is set in the shim
 * body and read lazily by the router on the first request — imports
 * evaluate before this assignment runs, so nothing may read it at
 * module top level.
 */
function shimSource(
  polyfillSpecifier: string | null,
  entrySpecifier: string,
  manifest: StandaloneRouteEntry[] | null,
): string {
  const lines = [
    "// Generated by `yatta build --standalone`. Deleted after the build.",
    "//",
  ];
  if (polyfillSpecifier !== null) {
    lines.push(
      "// The reflect-metadata polyfill must load before anything that uses",
      "// tsyringe (reached through @simplewebauthn/server, which the",
      "// framework's auth imports). Under `bun run` the runtime resolves",
      "// it; a compiled binary without this import crashes at startup",
      "// with \"tsyringe requires a reflect polyfill\".",
      "//",
      "// Trust assumption: the bare specifier resolves from the project's",
      "// node_modules first, and that is trusted code — the same boundary",
      "// as `bun run`. A compromised project dependency executes at this",
      "// import exactly as it would at runtime, and the shim imports it",
      "// even for apps that never touch tsyringe, because the entry may",
      "// reach the framework only through a dynamic import the build",
      "// cannot see statically.",
      `import ${JSON.stringify(polyfillSpecifier)};`,
    );
  }
  if (manifest !== null) {
    manifest.forEach((route, i) => {
      lines.push(`import * as __yatta_route_${i} from ${JSON.stringify(`./${route.file}`)};`);
    });
    lines.push(
      "//",
      "// File-based routes, baked in at build time (see buildRouteManifest).",
      "// A compiled binary has no backend directory on disk, so the file",
      "// router cannot scan it; the table below is what the router matches",
      "// against instead. The modules are imported above, so they are",
      "// bundled as code — nothing is read from $bunfs at runtime.",
      `(globalThis as any).__yattaStandaloneRoutes = [`,
      ...manifest.map(
        (route, i) =>
          `  { pattern: ${JSON.stringify(route.pattern)}, file: ${JSON.stringify(route.file)}, module: __yatta_route_${i} },`,
      ),
      `];`,
    );
  }
  lines.push(`import ${JSON.stringify(entrySpecifier)};`, "");
  return lines.join("\n");
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

// ── AOT support detection ─────────────────────────────────────────────
// `bun build` ignores flags it does not know, so passing --aot to an
// old Bun would silently build a JIT binary and call it AOT. The help
// text is the detector: a Bun that supports a flag lists it.

let buildHelpCache: string | null = null;

function bunBuildHelp(): string {
  if (buildHelpCache === null) {
    try {
      const res = spawnSync("bun", ["build", "--help"], { encoding: "utf8" });
      buildHelpCache = [res.stdout, res.stderr].filter(Boolean).join("\n");
    } catch {
      buildHelpCache = "";
    }
  }
  return buildHelpCache;
}

function bunSupportsBuildFlag(flag: string): boolean {
  return bunBuildHelp().includes(flag);
}

function bunVersion(): string {
  try {
    return Bun.version;
  } catch {
    return "unknown";
  }
}

/** The compile target for the machine this build runs on, or null. */
function hostTarget(): string | null {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : null;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!os || !arch) return null;
  return `bun-${os}-${arch}`;
}

// ── Code-generation compatibility check ───────────────────────────────
// When the string-to-code ban is baked in, an app that generates code
// at runtime breaks: eval and new Function throw EvalError. The build
// refuses to ship that combination — but only on evidence it can see.
// The entrypoint is scanned; dependencies are not, because a naive
// scan over every dependency would refuse builds for a match inside
// a comment or a string literal. That gap is documented, not hidden:
// a dependency that generates code still breaks at runtime under the
// ban, which is why the ban stays opt-in.

const CODEGEN_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\beval\s*\(/, name: "eval(" },
  { pattern: /new\s+Function\s*\(/, name: "new Function(" },
  { pattern: /new\s+AsyncFunction\s*\(/, name: "new AsyncFunction(" },
  { pattern: /new\s+GeneratorFunction\s*\(/, name: "new GeneratorFunction(" },
  { pattern: /new\s+AsyncGeneratorFunction\s*\(/, name: "new AsyncGeneratorFunction(" },
];

function findCodeGeneration(source: string): string | null {
  for (const { pattern, name } of CODEGEN_PATTERNS) {
    if (pattern.test(source)) return name;
  }
  return null;
}

// ── Type gate ─────────────────────────────────────────────────────────
// AOT relies on types to generate machine code, so `bun check --aot`
// is the exact gate on a Bun that has it: it reports what the build
// would fail on, and builds nothing. On Bun 1.4.4 that flag does not
// exist, so an AOT-aspiring build falls back to plain `bun check`
// plus a successful `bun build --compile` — and the fallback is
// reported in the output, not hidden. For JIT builds the same gate
// is opt-in via --check, because a JIT build never typechecked
// before and must not start failing projects that never asked for it.

function runCheck(
  cwd: string,
  entry: string,
  aot: boolean,
): { status: number; output: string; error?: string } {
  // --no-script is not optional: a project with a `check` script in
  // package.json (the scaffolded template has one) would otherwise run
  // that script instead of the typechecker. The docs say it plainly:
  // in projects you do not control, --no-script is always the checker.
  const args = ["check", "--no-script"];
  if (aot) args.push("--aot");
  args.push(entry);
  const res = spawnSync("bun", args, { cwd, encoding: "utf8" });
  if (res.error) {
    return { status: 1, output: "", error: `could not run \`bun check\`: ${res.error.message}` };
  }
  return {
    status: res.status ?? 1,
    output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim(),
  };
}

/**
 * Whether a `bun check` failure is only TS1375: the entrypoint uses
 * top-level await but is not a module. That is the framework's own
 * entry shape (dynamic `await import(...)`, no static imports), and
 * the fix is one line in the entry — so the gate says so instead of
 * failing with the raw checker text alone.
 */
function isTs1375Only(output: string): boolean {
  const codes = new Set([...output.matchAll(/TS(\d+)/g)].map((m) => m[1]));
  return codes.size === 1 && codes.has("1375");
}

/**
 * Whether the Bun running this build has no `check` subcommand at all.
 *
 * `bun check` is newer than the `engines` floor in package.json, and on an
 * older Bun the word is resolved as a package script instead. The spawn then
 * exits 1 with `Script not found "check"`, which the gate used to report as
 * "the entrypoint does not type-check" — a false accusation with a real cost:
 * the user goes looking for a type error that does not exist, and the build
 * is refused for a reason unrelated to their code.
 *
 * `--no-script` is always passed, so a Bun that has `check` can never produce
 * this message by honouring a project's package.json instead.
 */
function isMissingCheckCommand(output: string): boolean {
  return (
    /Script not found "check"/.test(output) ||
    /\bunknown command[:\s]+["'`]?check\b/i.test(output)
  );
}

/** A type-gate failure, with the TS1375 pointer when it applies. */
function typeGateError(output: string): string {
  const base = `Type gate failed — the entrypoint does not type-check:\n${output}`;
  if (!isTs1375Only(output)) return base;
  return (
    `${base}\n` +
    `  The only error is TS1375: the entrypoint uses top-level await but is not a module.\n` +
    `  Add \`export {};\` to the entrypoint to make it a module, then rebuild.`
  );
}

function runTypeGate(
  cwd: string,
  entry: string,
  aot: boolean,
  required: boolean,
): { ok: true; note?: string } | { error: string } {
  const first = runCheck(cwd, entry, aot);
  if (first.error) return { error: first.error };
  if (first.status === 0) return { ok: true };

  /*
   * No `bun check` on this Bun. An explicitly requested gate fails, because
   * skipping it would answer "checked" to a request that was not checked. The
   * implicit AOT gate skips with a note instead: AOT is the thing the user
   * asked for, and refusing the build over an unrelated Bun version leaves
   * them with no binary and no way forward. The note says the types are
   * unverified rather than implying they passed.
   */
  if (isMissingCheckCommand(first.output)) {
    if (required) {
      return {
        error:
          `this Bun (${bunVersion()}) has no \`bun check\`, so --check cannot run.\n` +
          `  Upgrade Bun, or drop --check to build without a type gate.`,
      };
    }
    return {
      ok: true,
      note:
        `type gate: skipped (Bun ${bunVersion()} has no \`bun check\`; ` +
        `the entrypoint's types are unverified)`,
    };
  }

  // The --aot gate needs a newer Bun. Fall back to plain `bun check`
  // rather than refusing the build outright: the fallback still stops
  // type errors, and the build step itself is verified separately.
  if (aot && first.output.includes('Unknown flag "--aot"')) {
    const fallback = runCheck(cwd, entry, false);
    if (fallback.error) return { error: fallback.error };
    if (fallback.status !== 0) {
      return { error: typeGateError(fallback.output) };
    }
    return {
      ok: true,
      note:
        `type gate: plain bun check (bun check --aot needs a newer Bun; ` +
        `this Bun is ${bunVersion()}). AOT codegen benefit is unverified here.`,
    };
  }
  return { error: typeGateError(first.output) };
}

export function runBuild(cwd: string, args: string[]): BuildOutcome {
  const parsedArgs = parseArgs(args);
  if ("error" in parsedArgs) {
    return { code: 1, lines: ["", `yatta build: ${parsedArgs.error}`, ...usageLines()] };
  }
  const opts = parsedArgs.parsed;

  const configResult = applyConfig(cwd, opts, parsedArgs.given);
  if ("error" in configResult) {
    return { code: 1, lines: ["", `yatta build: ${configResult.error}`] };
  }

  // Today there is exactly one build mode family. A bare `yatta build`
  // is a mistake, not a default: failing here beats producing a binary
  // the caller did not ask for in a form they did not choose.
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

  if (opts.aot && opts.noAot) {
    return { code: 1, lines: ["", "yatta build: --aot and --no-aot cannot be combined."] };
  }
  if (opts.explain !== null && !opts.aot) {
    return { code: 1, lines: ["", "yatta build: --explain needs --aot; it reports on AOT slow paths."] };
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

  // The entrypoint must live inside the project: `bun build` resolves
  // bare imports from the entry's location, so an entry outside the
  // package bundles almost nothing and the binary fails at runtime
  // ("Cannot find package 'otplib'", then "'@simplewebauthn/server'").
  // Refuse it here, with the reason, rather than ship that binary.
  const entryAbs = resolve(cwd, entry);
  if (!isInsideDir(cwd, entryAbs)) {
    return {
      code: 1,
      lines: [
        "",
        `yatta build: entrypoint "${entry}" is outside the project directory ${cwd}.`,
        "  bun build resolves bare imports from the entry's location, so an entry",
        "  outside the package bundles almost nothing and the binary fails at",
        "  runtime (\"Cannot find package 'otplib'\", then",
        "  \"@simplewebauthn/server\"). Move the entry inside the project.",
      ],
    };
  }

  // The output must never destroy the entrypoint or the user's data
  // (see guardOutPath): check the destination before any work that
  // could create artifacts, not at the end.
  const outAbs = resolve(cwd, opts.out);
  const outGuard = guardOutPath(opts.out, outAbs, entryAbs);
  if ("error" in outGuard) {
    return { code: 1, lines: ["", `yatta build: ${outGuard.error}`] };
  }

  const resolvedAssets = resolveAssets(cwd, opts.assets);
  if ("error" in resolvedAssets) {
    return { code: 1, lines: ["", `yatta build: ${resolvedAssets.error}`] };
  }

  // AOT builds only for the machine they run on. Refuse a foreign
  // target here, with the host named, rather than letting Bun fail
  // obscurely or silently build something else.
  if (opts.aot && opts.target) {
    const host = hostTarget();
    if (host === null || opts.target !== host) {
      return {
        code: 1,
        lines: [
          "",
          `yatta build: --aot builds only for the machine it runs on${host ? ` (${host})` : ""}.`,
          `  Asked for --target ${opts.target}: drop --aot to cross-compile, or build on the target machine.`,
        ],
      };
    }
  }

  // --explain is the one flag whose whole value is output Bun may
  // not produce: on 1.4.4 it just bundles normally with no report.
  // So it is accepted only when this Bun lists it, and otherwise the
  // build stops with the Bun version and an upgrade pointer, rather
  // than pretending a report was produced. --aot and --trim pass
  // through (see the header comment): they are accepted by this Bun,
  // their effect is verified only as far as build-and-run, and the
  // output says so where it matters.
  if (opts.explain !== null && !bunSupportsBuildFlag("--explain")) {
    return {
      code: 1,
      lines: [
        "",
        `yatta build: this Bun (${bunVersion()}) does not produce --explain reports.`,
        "  Upgrade Bun to use --explain; refusing to build rather than",
        "  silently shipping a binary with no report.",
      ],
    };
  }

  // Compatibility: baking the string-to-code ban into a binary whose
  // entrypoint generates code ships a binary that throws at runtime.
  // Refuse it, and say which construct was found and how to proceed.
  if (opts.disallowCodeGeneration !== null) {
    let source = "";
    try {
      source = readFileSync(resolve(cwd, entry), "utf8");
    } catch {
      source = "";
    }
    const found = findCodeGeneration(source);
    if (found) {
      return {
        code: 1,
        lines: [
          "",
          `yatta build: refusing --disallow-code-generation: the entrypoint uses ${found}.`,
          "  With the ban baked in, that call throws EvalError at runtime.",
          "  Remove the construct, or drop the flag and keep the JIT build unhardened.",
        ],
      };
    }
  }

  // Type gate: always for AOT, opt-in for JIT.
  let gateNote: string | undefined;
  if (opts.aot || opts.check) {
    const gate = runTypeGate(cwd, entry, opts.aot, opts.check);
    if ("error" in gate) {
      return { code: 1, lines: ["", `yatta build: ${gate.error}`] };
    }
    gateNote = gate.note;
  }

  // A build killed mid-compile leaves its generated entry behind,
  // and nothing cleaned it up. Sweep stale ones now (see
  // sweepStaleShims: exact name, older than ten minutes, so a
  // concurrent build's live shim is never touched).
  sweepStaleShims(cwd);

  // The standalone entry is a generated shim inside the project that
  // imports reflect-metadata first, then the real entrypoint (see the
  // header comment for why the order matters). The shim lives in the
  // project root so its bare imports resolve like the app's own, and
  // it is deleted after the build whether the build succeeds or not.
  // When reflect-metadata resolves nowhere: a plain app does not need
  // it and builds as before, but an app that imports the framework
  // would crash at startup without it, so that build is refused
  // instead of shipping a binary that cannot boot.
  //
  // The shim is also generated when the entrypoint has a backend/
  // directory, even without the polyfill: it carries the file-route
  // table the binary needs (see buildRouteManifest).
  const manifestResult = buildRouteManifest(cwd, entry);
  if ("error" in manifestResult) {
    return { code: 1, lines: ["", `yatta build: ${manifestResult.error}`] };
  }
  const manifest = manifestResult.manifest;

  let buildEntry = entry;
  let shimPath: string | null = null;
  const polyfill = resolveReflectMetadata(cwd);
  if (polyfill === null) {
    let source = "";
    try {
      source = readFileSync(entryAbs, "utf8");
    } catch {
      source = "";
    }
    if (entryNeedsPolyfill(source, dirname(entryAbs))) {
      return {
        code: 1,
        lines: [
          "",
          "yatta build: this app imports the framework, which needs the reflect-metadata",
          "  polyfill at startup, but reflect-metadata does not resolve from the project",
          "  or from the framework's install. Reinstall dependencies and rebuild;",
          "  without the polyfill the binary crashes with",
          "  \"tsyringe requires a reflect polyfill\".",
        ],
      };
    }
  }
  if (polyfill !== null || manifest !== null) {
    const rel = relative(cwd, entryAbs).split(sep).join("/");
    const entrySpecifier = rel.startsWith(".") ? rel : `./${rel}`;
    // The name is picked and the file is created with "wx" in one
    // step, so two concurrent builds can never claim the same name:
    // the loser gets EEXIST and picks another. A partial write (a
    // throw after the file exists) is removed best-effort here,
    // because this early return never reaches the finally that
    // deletes the shim on the normal paths.
    let name = "";
    let wrote = false;
    for (let attempt = 0; attempt < 3 && !wrote; attempt++) {
      name = `${SHIM_PREFIX}${randomUUID().slice(0, 8)}.ts`;
      shimPath = join(cwd, name);
      try {
        writeFileSync(shimPath, shimSource(polyfill, entrySpecifier, manifest), { flag: "wx" });
        wrote = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue;
        try {
          rmSync(shimPath, { force: true });
        } catch {
          // A partial file may remain; its name is distinctive and
          // the next build's stale sweep removes it once it ages out.
        }
        return {
          code: 1,
          lines: [
            "",
            `yatta build: could not write the generated entry "${name}": ${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
    }
    if (!wrote) {
      return {
        code: 1,
        lines: ["", "yatta build: could not pick a fresh name for the generated entry."],
      };
    }
    buildEntry = name;
  }

  const bunArgs = ["build", "--compile", buildEntry, "--outfile", outAbs];
  for (const asset of resolvedAssets.assets) bunArgs.push("--asset", asset);
  if (opts.target) bunArgs.push("--target", opts.target);
  if (opts.minify) bunArgs.push("--minify");
  if (opts.aot) bunArgs.push("--aot");
  if (opts.trim) bunArgs.push("--trim");
  if (opts.explain !== null) {
    bunArgs.push(opts.explain === "" ? "--explain" : `--explain=${opts.explain}`);
  }

  // Runtime flags baked into the binary, as one space-joined value.
  // Repeated --compile-exec-argv flags do not accumulate — the last
  // one wins — so every baked flag goes in a single argument, and the
  // strict level is written with `=` (a space-separated `strict`
  // becomes a stray argument the binary ignores).
  const execArgv: string[] = [];
  if (opts.smol) execArgv.push("--smol");
  if (opts.noAddons) execArgv.push("--no-addons");
  if (opts.noFfiCc) execArgv.push("--no-ffi-cc");
  if (opts.disallowCodeGeneration === "normal") {
    execArgv.push("--disallow-code-generation-from-strings");
  } else if (opts.disallowCodeGeneration === "strict") {
    execArgv.push("--disallow-code-generation-from-strings=strict");
  }
  if (execArgv.length > 0) bunArgs.push("--compile-exec-argv", execArgv.join(" "));

  // No --sourcemap: an embedded sourcemap carries the build machine's
  // paths into the binary. No --bytecode either: it is a startup
  // optimisation, not a correctness need, and it stays opt-in by hand.
  try {
    const res = spawnSync("bun", bunArgs, { cwd, encoding: "utf8" });
    if (res.error) {
      return { code: 1, lines: ["", `yatta build: could not run \`bun\`: ${res.error.message}`] };
    }
    if (res.status !== 0) {
      const detail = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      return {
        code: res.status ?? 1,
        lines: [
          "",
          "yatta build: `bun build --compile` failed.",
          ...(gateNote ? [`  note: ${gateNote}`] : []),
          ...(detail ? [detail] : []),
        ],
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
      `  mode: ${opts.aot ? "AOT (machine code)" : "JIT bundle"}.`,
      ...(shimPath
        ? ["  reflect-metadata polyfill imported first (standalone binaries crash without it)."]
        : []),
      ...(manifest !== null
        ? [
            `  routes embedded: ${manifest.length} file route(s) from ${manifestResult.backendRel} (standalone manifest).`,
          ]
        : []),
      ...(gateNote ? [`  note: ${gateNote}`] : []),
      ...(resolvedAssets.assets.length > 0
        ? [`  assets embedded: ${resolvedAssets.assets.join(", ")}`]
        : ["  no asset directory embedded (no ./public, no --asset)"]),
      ...(execArgv.length > 0 ? [`  baked runtime flags: ${execArgv.join(" ")}`] : []),
      "  Data and secrets are NOT in this binary: keep your database and",
      "  uploads beside it, and set config (including .env) where it runs.",
      "  Worker fleet does not run in this binary: subsystem execution",
      "  (runtime.execute) needs `bun run`; HTTP serving is unaffected.",
    ];
    return { code: 0, lines, outPath: outAbs };
  } finally {
    if (shimPath) {
      try {
        rmSync(shimPath, { force: true });
      } catch {
        // A leftover shim is inert (nothing imports it), but its name
        // is distinctive so it is easy to spot and delete by hand.
      }
    }
  }
}

/** CLI entry: prints the outcome lines, returns the exit code. */
export function cmdBuild(args: string[]): number {
  const outcome = runBuild(process.cwd(), args);
  for (const line of outcome.lines) console.log(line);
  return outcome.code;
}
