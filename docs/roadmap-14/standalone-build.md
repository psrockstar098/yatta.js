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

## Cross-compile

```sh
yatta build --standalone --target bun-linux-x64
yatta build --standalone --target bun-darwin-arm64
```

Targets are the ones Bun documents: `bun-linux-x64`,
`bun-linux-x64-musl`, `bun-linux-arm64`, `bun-linux-arm64-musl`,
`bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`. Anything else is refused with the list, rather
than passed to Bun to fail obscurely.

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
  binary, it starts empty-ish in memory and every write is lost
  when the process exits. Data lives outside, always.
- The binary is large — it embeds the Bun runtime. Expect roughly
  a hundred megabytes for a small app, before `--minify`.
- `yatta build` without `--standalone` fails. Today there is one
  build mode, and a bare `build` is treated as a mistake, not a
  default.
