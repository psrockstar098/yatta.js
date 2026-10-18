#!/usr/bin/env bun
// The bin npm will install. npm strips a `bin` entry written in TypeScript with
// nothing more than a warning, so the real CLI (`src/cli.ts`, TypeScript) gets this
// one-Plain-file shim to hand execution over to Bun.
//
// `main` has to be called explicitly: imported from here, `src/cli.ts`'s own
// `import.meta.main` guard is false, so the CLI would start and do nothing.
import { main } from "../src/cli.ts";

process.exit(await main(process.argv.slice(2)));
