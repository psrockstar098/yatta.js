import { describe, it, expect } from "bun:test";
import { createDatabase, col, YattaError } from "../types/db";

describe("Security pass 2026-10-25 — DDL identifier escaping", () => {
  it("does not let a crafted column name break out of CREATE INDEX", () => {
    const db: any = createDatabase({
      path: ":memory:", forceNew: true,
      schema: {
        t: {
          id: col.integer().primaryKey(),
          'x" ON "t" ("id"); CREATE TABLE pwned(x); --': col.text().index(),
        },
      },
    });
    const tables = db.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).not.toContain("pwned");
    expect(tables).toContain("t");
  });

  it("rejects a non-whitelisted column type at runtime", () => {
    expect(
      () =>
        createDatabase({
          path: ":memory:", forceNew: true,
          schema: {
            t: {
              id: col.integer().primaryKey(),
              evil: new (col.text().constructor as any)("TEXT); DROP TABLE t; --"),
            },
          },
        }),
    ).toThrow(YattaError);
  });

  it("rejects a non-whitelisted ON DELETE action at runtime", () => {
    expect(
      () =>
        createDatabase({
          path: ":memory:", forceNew: true,
          schema: {
            users: { id: col.integer().primaryKey() },
            posts: {
              id: col.integer().primaryKey(),
              userId: col
                .integer()
                .references("users.id", { onDelete: "CASCADE; DROP TABLE users; --" as any }),
            },
          },
        }),
    ).toThrow(YattaError);
  });
});
