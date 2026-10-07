import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

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
});