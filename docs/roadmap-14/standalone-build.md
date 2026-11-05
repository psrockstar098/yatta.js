# Standalone binary build

Deployment today is source-based: install Bun, install dependencies,
run the entrypoint. `yatta build --standalone` gives you the other
option — one executable file that runs with nothing installed but
itself.

```sh
yatta build --standalone
./dist/app
```

The binary holds the app code, the schema definitions (they are
code), and the public static assets. It runs on any machine for the
target platform, with no Bun install and no `node_modules` to copy.

## What goes in, what stays out

In:

```sh
yatta build --standalone --entry yatta/main.ts --out dist/app
```

- Code: the entrypoint and everything it imports, bundled by
  `bun build --compile`.
- Static assets: `./public` is embedded automatically when it
  exists, and `--asset <dir>` embeds more directories, repeatable.
  At runtime the files live under `import.meta.dir`, so the app
  reads them the same way it does under `bun run`:

```ts
import { join } from "node:path";

// Serves public/hello.txt from inside the binary — or from disk
// under bun run, where import.meta.dir is the source directory.
Bun.file(join(import.meta.dir, "public", "hello.txt"));
```

- Frontend code, when the entrypoint imports an HTML file: Bun
  bundles the page's scripts and assets into the same executable,
  so a full-stack app ships as one unit with no extra flag. That is
  Bun's native HTML-import behaviour, not a Yatta step.

Out, by design:

- SQLite database files. A compiled binary resolves a database path
  relative to the working directory, not to the binary, so the data
  lives beside it: run the binary from the directory that holds
  `data/app.db`, and point `DATABASE_URL` there.
- Uploads and storage directories. Same reason: they grow at
  runtime, and a binary cannot grow.
- `.env` files and secrets. The build never reads the project's
  `.env`, and nothing from it is baked in. A compiled binary still
  loads a `.env` file from the directory it runs in — that is the
  config mechanism, not a leak: put the deployment's `.env` next to
  the binary, not in the build.

```sh
# On the server: the binary, the data, and the config sit together.
./dist/app            # the app
./data/app.db         # the database, created on first run
./.env                # read at runtime, never baked in
```

## Two modes: JIT bundle and AOT

The default bundles the JavaScript and runs it with the JIT. It is
the stable mode, and the only one that cross-compiles:

```sh
yatta build --standalone --no-aot
```

`--aot` compiles to machine code at build time instead:

```sh
yatta build --standalone --aot
```

What changes on a Bun that fully supports it: faster startup, less
memory (no bytecode, no JIT, no profiling data), and typed code
runs faster because a property access becomes a load from a fixed
offset. What it costs: the build takes longer, it builds only for
the machine it runs on (build in CI or a container per platform —
a foreign `--target` with `--aot` is refused), built-in objects
become read-only, code from a string runs interpreted, and untyped
hot code can run slower than under the JIT, because the JIT learns
from real traffic and the compiler has to prove everything up
front.

Version note, measured on Bun 1.4.4: there is no standalone
`bun compile` command — only the `bun build --compile` form, which
is what this command uses. `bun build --compile --aot` is accepted
there, and the resulting binary builds, runs, and serves — but
whether it changes codegen on 1.4.4 is unverified, because that
Bun's `bun build` silently ignores flags it does not know and no
`--explain` output exists to confirm anything. So on 1.4.4 the
AOT speed and memory wins are not claimed: the mode is offered,
the binary is verified end to end, and the benefit needs a newer
Bun to measure. The same holds for `--trim`: it passes through,
and its size effect is unverified on 1.4.4.

So do not pick on principle. Build the same entrypoint both ways
and measure under load that does what production does. Run the
load twice and keep the second result, so the JIT has warmed up.
If the hot code is untyped JavaScript from npm, or peak throughput
matters most, the JIT bundle usually wins; if startup time and
memory matter most, AOT usually wins.

`--explain` (with `--aot`) lists the code that compiled to a slow
path, worst first, with a fix for each — the tool for keeping hot
paths well-typed. It is not available on Bun 1.4.4, where it just
bundles normally with no report, so asking for it there fails
rather than pretending a report was made:

```sh
yatta build --standalone --aot --explain
```

`--trim` drops the Bun and Node APIs the code never calls, for a
smaller binary. It is experimental, and it does not turn on the
string-to-code ban by itself (see below).

AOT and the type gate: AOT relies on types, so it type-checks the
whole program first. On a Bun that has it, `yatta build
--standalone --aot` runs `bun check --aot` on the entrypoint
before compiling. On Bun 1.4.4 that flag does not exist, so the
gate falls back to plain `bun check` plus a successful
`bun build --compile` — and the fallback is printed in the build
output, not hidden. Either way, a type error stops the build with
no binary written. For JIT builds the same gate is opt-in:

```sh
yatta build --standalone --check
```

Two frictions, both from Bun's own docs. First, TypeScript 7
defaults changed: `strict` is on, and `types` is empty unless the
project lists it — a project that relied on ambient `@types/bun`
without listing it fails the gate until `tsconfig.json` says
`"types": ["bun"]`. Second, if `package.json` has a `check`
script, bare `bun check` runs that script instead of the
typechecker; the gate passes `--no-script` so it always gets the
checker. The framework's own `tsc` typecheck stays the push gate;
`bun check` is the build gate, not a replacement for it.

## Cross-compile

```sh
yatta build --standalone --target bun-linux-x64
yatta build --standalone --target bun-darwin-arm64
```

Targets are the ones Bun documents: `bun-linux-x64`,
`bun-linux-x64-musl`, `bun-linux-arm64`, `bun-linux-arm64-musl`,
`bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`. Anything else is refused with the list, rather
than passed to Bun to fail obscurely. Cross-compiling needs the
JIT mode: `--aot` with a foreign target is refused, because AOT
only builds for the machine it runs on.

## Build config file

Flags are enough for one-off builds. For a repeatable build, put
the options in a file and point at it:

```sh
yatta build --standalone --config yatta.build.json5
```

```json5
{
  // Comments and trailing commas are fine: this is JSON5, parsed
  // by the CLI at build time. The file is never embedded.
  entry: "yatta/main.ts",
  out: "dist/app",
  target: "bun-linux-x64",
  assets: ["public"],
  minify: true,
}
```

CLI flags win over config values. Unknown keys are refused, not
ignored: a misspelled key that quietly did nothing would be a
build the caller did not actually request.

## Hardening: bake runtime flags into the binary

Runtime flags can be baked in at build time, so the binary runs
with them every time, with no arguments:

```sh
# Less memory at a performance cost (GC runs more often). An
# explicit knob for a small box — never a default.
yatta build --standalone --smol

# Refuse native addons, and refuse bun:ffi's C compiler.
yatta build --standalone --no-addons
yatta build --standalone --no-ffi-cc
```

The string-to-code ban is the one that changes what code can do:

```sh
yatta build --standalone --disallow-code-generation
yatta build --standalone --disallow-code-generation=strict
```

With the ban baked in, `eval()` and `new Function()` throw a
synchronous `EvalError` for the whole process, and `BUN_OPTIONS`
can raise the level but never lower it. The `=strict` level bans
every string-to-code path — `node:vm`, data-URL imports, workers
started from a string, macros — and a strict binary loads code
from the executable only, never from disk. Write the level with
`=`: a space-separated `strict` becomes a stray argument the
binary ignores, and the build writes it with `=` for that reason.

Compatibility check: if the entrypoint itself generates code with
`eval(` or `new Function(`, the build refuses the combination
instead of shipping a binary that throws at runtime. The check
covers the entrypoint only, on purpose — a naive scan over every
dependency would refuse builds for a match inside a comment or a
string. So a dependency that generates code (some validators and
serializers do) still breaks under the ban at runtime, which is
why the ban stays opt-in. If you turn it on, run the app's suite
against the hardened binary before shipping it.

`--expose-gc` exists as a debugging aid (it exposes `gc()` on the
global object); it is not a build flag here and not something a
production binary needs.

## The build refuses data-looking assets

Only imported files and `--asset` directories are embedded — a
file that merely sits next to the entrypoint is not. On top of
that, the build checks every asset path before compiling, and
refuses the whole build instead of silently dropping a file:

```sh
yatta build --standalone --asset uploads
# Refusing --asset "uploads": directory "uploads" holds data, not static assets.
```

Refused: `.env` files (including `.env.local` and friends),
database files (`.db`, `.sqlite`, `.sqlite3`), key material
(`.pem`, `.key`, `id_rsa*`), and directories named `uploads`,
`storage`, or `Database` — including a data file hiding inside an
otherwise innocent asset directory.

## Gotchas

- No `--sourcemap`. An embedded sourcemap carries the build
  machine's paths into the binary, so the build does not pass the
  flag. If you need stack traces to map back, keep the build
  machine's source tree, not a sourcemap in the artifact.
- Old Bun, new flags: Bun's `bun build` silently ignores flags it
  does not know. `--aot` and `--trim` pass through anyway (they are
  accepted on 1.4.4, and the binary is verified to build and run),
  with the honest caveat that their effect is unverified there.
  `--explain` is the exception: its whole value is the report, so
  on a Bun that produces none it fails with an upgrade pointer
  rather than pretending a report was made.
- The entrypoint must live inside the project directory. `bun
  build` resolves bare imports from the entry's location, so an entry
  outside the package bundles almost nothing (one module in the
  minimal repro) and the binary fails at runtime with "Cannot find
  package 'otplib'", then "'@simplewebauthn/server'". The build
  refuses such an entry instead of shipping that binary — move the
  entry inside the project and rebuild.
- The build imports `reflect-metadata` first. A binary without it
  crashes at startup with "tsyringe requires a reflect polyfill"
  (thrown from tsyringe's lazy init, reached through
  @simplewebauthn/server, which the framework's auth imports). The
  polyfill's code is in the bundle either way — it rides in via
  @simplewebauthn/server's certificate helpers — but with dynamic
  `await import(...)` (as in the framework's own main.ts) Bun
  evaluates the framework modules first and tsyringe's init runs
  before the polyfill code, so it is in the bundle but too late.
  The build compiles a generated entry inside the project that
  imports `reflect-metadata` first, then the real entrypoint, and
  deletes the generated file after the build. If your entry already
  imports it, the duplicate is harmless.
- Worker entrypoints are not auto-detected. Bun compiles the
  entrypoints it is given; a worker spawned from a URL string at
  runtime is not an import, so it is not bundled. A single-entrypoint
  app — one `Bun.serve` entry that does its own work — compiles
  and runs as-is. An app that leans on the framework's multi-worker
  runtime pools needs its worker files handled before this build
  covers it; that is a known gap, not a silent fallback.
- Do not import a database with an embed attribute. Bun can embed
  a SQLite file if the import asks for it — this build never does,
  and your app must not either. If a database file is inside the
  binary, it starts in memory and every write is lost when the
  process exits. Data lives outside, always.
- The binary is large — it embeds the Bun runtime. Expect roughly
  a hundred megabytes for a small app, before `--minify` or
  `--trim`.
- `yatta build` without `--standalone` fails. Today there is one
  build mode family, and a bare `build` is treated as a mistake,
  not a default.

## Decisions taken from the Bun docs, and what was not used

- C under Bun (`bun:ffi` `cc()`, TinyCC, no external toolchain)
  is the sanctioned path when a profiler proves a hot path needs
  it — and only then. It is not used here: nothing in this build
  was profiler-proven hot, and TinyCC compiles fast but does not
  optimise, so it is not a max-speed claim either.
- `Bun.build()`'s `files` map (bundle entirely from memory, or
  override files on disk) is the right tool for a codegen step
  that has no files yet. This build has no codegen step — it
  shells out to `bun build` — so the map has nothing to do here.
  If a codegen step is ever added, it should use the map rather
  than temp files.
- `bun run --aot` and `bun test --aot` (check like an AOT build,
  then run from source) are the development counterparts of the
  AOT build: use them to catch AOT problems without building.
  `bun test --aot` is verified working on Bun 1.4.4 even though
  `bun check --aot` is not.
