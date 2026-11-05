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

import {
  chmodSync,
  existsSync,
  readFileSync,
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
    "  --out      Output binary; default: dist/app.",
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

function runTypeGate(
  cwd: string,
  entry: string,
  aot: boolean,
): { ok: true; note?: string } | { error: string } {
  const first = runCheck(cwd, entry, aot);
  if (first.error) return { error: first.error };
  if (first.status === 0) return { ok: true };
  // The --aot gate needs a newer Bun. Fall back to plain `bun check`
  // rather than refusing the build outright: the fallback still stops
  // type errors, and the build step itself is verified separately.
  if (aot && first.output.includes('Unknown flag "--aot"')) {
    const fallback = runCheck(cwd, entry, false);
    if (fallback.error) return { error: fallback.error };
    if (fallback.status !== 0) {
      return {
        error:
          `Type gate failed — the entrypoint does not type-check:\n${fallback.output}`,
      };
    }
    return {
      ok: true,
      note:
        `type gate: plain bun check (bun check --aot needs a newer Bun; ` +
        `this Bun is ${bunVersion()}). AOT codegen benefit is unverified here.`,
    };
  }
  return {
    error:
      `Type gate failed — the entrypoint does not type-check:\n${first.output}`,
  };
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
    const gate = runTypeGate(cwd, entry, opts.aot);
    if ("error" in gate) {
      return { code: 1, lines: ["", `yatta build: ${gate.error}`] };
    }
    gateNote = gate.note;
  }

  const outAbs = resolve(cwd, opts.out);
  const bunArgs = ["build", "--compile", entry, "--outfile", outAbs];
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
    `  mode: ${opts.aot ? "AOT (machine code)" : "JIT bundle"}.`,
    ...(gateNote ? [`  note: ${gateNote}`] : []),
    ...(resolvedAssets.assets.length > 0
      ? [`  assets embedded: ${resolvedAssets.assets.join(", ")}`]
      : ["  no asset directory embedded (no ./public, no --asset)"]),
    ...(execArgv.length > 0 ? [`  baked runtime flags: ${execArgv.join(" ")}`] : []),
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
