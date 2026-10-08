import { describe, it, expect, beforeEach } from "bun:test";

import { and, col, createDatabase, or, YattaError, type TypedDatabase } from "../types/db";

/*
 * Filters that were never exercised, and three ways one of them failed silently.
 *
 * The existing db suites cover insert/findMany/update/delete well, so this file is
 * aimed at the surface with no coverage at all: `exists`, `orderBy`, `take`/`skip`, the
 * `isIn`/`isNull` family, LIKE escaping, `and`/`or` composition, cursor pagination and
 * the `skip`/`take` argument validation.
 *
 * Three of the tests here fail against the code as it was before this file existed, and
 * each says which behaviour it is pinning.
 */

const schema = {
  users: {
    id: col.id(),
    name: col.text(),
    email: col.text(),
    age: col.integer(),
    nickname: col.text().nullable(),
  },
};

let db: TypedDatabase<typeof schema>;
let users: TypedDatabase<typeof schema>["users"];

beforeEach(() => {
  db = createDatabase({ path: ":memory:", schema, forceNew: true });
  users = db.users;

  users.insert({ name: "Ada", email: "ada@x.dev", age: 36, nickname: "ada" });
  users.insert({ name: "Bob", email: "bob@x.dev", age: 41, nickname: null });
  users.insert({ name: "Cy", email: "cy@x.dev", age: 17, nickname: "100%_real" });
  users.insert({ name: "Dee", email: "dee@x.dev", age: 55, nickname: "a.b" });
});

const names = (rows: { name: string }[]): string[] => rows.map((r) => r.name);

/*
 * A `where` that cannot be read must not become "no filter".
 *
 * `Object.keys(fn)` is `[]`, so a function filter skipped the empty-object branch and
 * every row came back. Measured before the fix: `findMany({ where: f => f.age.gt(17) })`
 * returned all four rows where two matched, and `count` with the same filter said 4.
 *
 * This reads as a filter and behaves as its absence, which for a tenant-scoped query is
 * a data leak rather than a wrong page count. TypeScript rejects the form — `WhereClause`
 * is an object type — so this is reached through an `any` at a handler boundary or from
 * plain JavaScript, which is why the type alone was not a defence.
 */
describe("a where that cannot be read is rejected, not ignored", () => {
  it("rejects a function filter in findMany rather than returning every row", () => {
    expect(() => users.findMany({ where: ((f: unknown) => f) as never })).toThrow(YattaError);

    // The specific failure being prevented, spelled out so the intent survives a rename.
    expect(users.findMany({ where: { age: { gt: 17 } } as never })).toHaveLength(3);
  });

  it("rejects a function filter in count, which reported the total of an unfiltered table", () => {
    expect(users.count({ age: { gt: 17 } } as never)).toBe(3);
    expect(() => users.count(((f: unknown) => f) as never)).toThrow(YattaError);
  });

  it("rejects a function filter in exists, which answered about the whole table", () => {
    expect(users.exists({ age: { gt: 99 } } as never)).toBe(false);
    expect(() => users.exists(((f: unknown) => f) as never)).toThrow(YattaError);
  });

  it("rejects a function filter in findFirst", () => {
    expect(() => users.findFirst({ where: ((f: unknown) => f) as never })).toThrow(YattaError);
  });

  it("rejects an array and a string, the other unreadable shapes", () => {
    // `Object.keys([])` is `[]` too, so an empty array was another silent no-filter.
    expect(() => users.findMany({ where: [] as never })).toThrow(YattaError);
    expect(() => users.findMany({ where: "active" as never })).toThrow(YattaError);
  });

  it("names the table and points at the two forms that do work", () => {
    let message = "";
    try {
      users.findMany({ where: ((f: unknown) => f) as never });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("users");
    expect(message).toContain("where(");
  });

  it("leaves the documented object form, and an empty one, working", () => {
    expect(names(users.findMany({ where: { name: "Ada" } }))).toEqual(["Ada"]);
    // No filter at all is still legitimate and still returns everything.
    expect(users.findMany({})).toHaveLength(4);
    expect(users.findMany({ where: {} })).toHaveLength(4);
  });
});

/*
 * `and`/`or` are exported helpers whose only constructor is the field proxy, which is
 * handed to the callback by `where`. Composition therefore works through the builder:
 *
 *   db.users.where((f) => and(f.age.isGreaterThan(17), f.age.isLessThan(40)))
 *
 * There is no way to build a Condition outside that callback, so these tests double as
 * the check that the composition actually filters — `where(f => and(...))` used to hand
 * a function to `findMany` and return all four rows.
 */
describe("and/or composition filters", () => {
  it("ANDs two conditions on one column", () => {
    const rows = users
      .where((f) => and(f.age.isGreaterThan(17), f.age.isLessThan(40)))
      .all();

    // Ada only. Before the `where` fix this returned all four.
    expect(names(rows)).toEqual(["Ada"]);
  });

  it("ORs two conditions", () => {
    const rows = users
      .where((f) => or(f.name.isEqualTo("Ada"), f.name.isEqualTo("Cy")))
      .all();

    expect(names(rows)).toEqual(["Ada", "Cy"]);
  });

  it("takes more than two conditions", () => {
    const rows = users
      .where((f) =>
        and(
          f.age.isGreaterThan(10),
          f.name.isNot("Bob"),
          f.nickname.isNotNull(),
        ),
      )
      .all();

    expect(names(rows)).toEqual(["Ada", "Cy", "Dee"]);
  });

  it("nests one composition inside another", () => {
    const rows = users
      .where((f) => and(f.age.isGreaterThan(10), or(f.name.isEqualTo("Bob"), f.name.isEqualTo("Cy"))))
      .all();

    expect(names(rows)).toEqual(["Bob", "Cy"]);
  });

  it("rejects a plain where-clause, naming which argument was wrong", () => {
    // The object form is what `findMany` takes, so this is an easy mistake to make. It
    // used to fail as "undefined is not an object (evaluating 'node.kind')", which named
    // neither the argument nor the alternative.
    let message = "";
    try {
      and({ age: { gt: 1 } } as never, { age: { lt: 40 } } as never);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("and()");
    expect(message).toContain("argument 1");
    expect(message).toContain("where(");
  });

  it("treats an empty AND as everything and an empty OR as nothing", () => {
    // `[]` compiles to `1 = 1` and `0 = 1` respectively — the identities, not a crash.
    expect(users.where(() => and()).all()).toHaveLength(4);
    expect(users.where(() => or()).all()).toHaveLength(0);
  });
});

/*
 * `skip` and `take` are interpolated into the SQL text, so `Number()` decides their
 * value and a non-number becomes `NaN`. Every other spliced value in db.ts — column
 * names, sort directions, filter operators — is validated; these two were not.
 */
describe("skip and take are validated", () => {
  it("names the field for a non-numeric offset", () => {
    // "no such column: NaN" is what this used to say.
    expect(() => users.findMany({ skip: "abc" as never })).toThrow(
      /skip on "users" must be a finite number, got NaN\./,
    );
  });

  it("rejects a fractional offset instead of letting SQLite complain about itself", () => {
    expect(() => users.findMany({ skip: 1.7 })).toThrow(/skip.*integer/);
    expect(() => users.findMany({ take: 1.7 })).toThrow(/take.*integer/);
  });

  it("rejects a negative offset", () => {
    // SQLite reads a negative OFFSET as 0, so this silently returned the first rows.
    expect(() => users.findMany({ skip: -5 })).toThrow(/skip.*integer/);
    expect(() => users.findMany({ take: -5 })).toThrow(/take.*integer/);
  });

  it("keeps take(-1), which is SQLite's own unbounded read", () => {
    expect(users.findMany({ take: -1 })).toHaveLength(4);
  });

  it("rejects a NaN offset with a message that says NaN", () => {
    // JSON.stringify(NaN) is the string "null", so the first version of this message
    // read "must be a finite number, got null." — naming the wrong thing.
    //
    // Asserted against our own wording rather than "contains NaN": unvalidated,
    // SQLite's own "no such column: NaN" also contains NaN, so the looser assertion
    // passed with and without the fix and proved nothing.
    let error: unknown;
    try {
      users.findMany({ skip: Number("nope") });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(YattaError);
    expect((error as Error).message).toBe('skip on "users" must be a finite number, got NaN.');
  });

  it("leaves the ordinary values alone", () => {
    expect(users.findMany({ skip: 0 })).toHaveLength(4);
    expect(users.findMany({ take: 2 })).toHaveLength(2);
    expect(names(users.findMany({ skip: 2, take: 1 }))).toEqual(["Cy"]);
    // `skip` with no `take` needs SQLite's `LIMIT -1` to be valid at all.
    expect(users.findMany({ skip: 3 })).toHaveLength(1);
  });

  it("defaults paginate's page rather than propagating NaN into the offset", () => {
    // `Math.max(1, NaN)` is NaN, so the ordinary `Number(req.query.page)` with the
    // parameter absent used to reach SQLite as an offset of NaN.
    const page = users.paginate({ page: Number("nope"), limit: 2 });

    expect(page.page).toBe(1);
    expect(page.data).toHaveLength(2);
  });

  it("floors a fractional page and clamps a zero limit", () => {
    expect(users.paginate({ page: 2.5, limit: 2 }).page).toBe(2);
    expect(users.paginate({ page: 1, limit: 0 }).limit).toBe(1);
  });
});

describe("exists", () => {
  it("is true for a table with rows and false for an empty filter result", () => {
    expect(users.exists()).toBe(true);
    expect(users.exists({ age: { gt: 17 } } as never)).toBe(true);
    expect(users.exists({ age: { gt: 99 } } as never)).toBe(false);
  });

  it("is false on an empty table", () => {
    const empty = createDatabase({ path: ":memory:", schema, forceNew: true });
    expect(empty.users.exists()).toBe(false);
    expect(empty.users.exists({ age: { gt: 0 } } as never)).toBe(false);
  });

  it("agrees with count", () => {
    const where = { age: { gte: 36 } } as never;
    expect(users.exists(where)).toBe(users.count(where) > 0);
  });
});

describe("orderBy", () => {
  it("sorts ascending and descending", () => {
    expect(users.findMany({ orderBy: { age: "asc" } }).map((r) => r.age)).toEqual([17, 36, 41, 55]);
    expect(users.findMany({ orderBy: { age: "desc" } }).map((r) => r.age)).toEqual([55, 41, 36, 17]);
  });

  it("accepts an array of sort keys in order of precedence", () => {
    const rows = users.findMany({ orderBy: [{ age: "asc" }, { name: "desc" }] });
    expect(names(rows)).toEqual(["Cy", "Ada", "Bob", "Dee"]);
  });

  it("rejects an unknown column", () => {
    // The column is spliced into the SQL, so an unchecked one would be injectable.
    expect(() => users.findMany({ orderBy: { nope: "asc" } as never })).toThrow(/nope/);
  });

  it("rejects a direction that is not ASC or DESC", () => {
    expect(() => users.findMany({ orderBy: { age: "sideways" } as never })).toThrow(/sideways/);
  });

  it("works together with take", () => {
    expect(names(users.findMany({ orderBy: { age: "desc" }, take: 2 }))).toEqual(["Dee", "Bob"]);
  });
});

describe("in, notIn and null filters", () => {
  it("treats an empty `in` as no match, not as a SQL error", () => {
    // `IN ()` is a syntax error in SQLite, so the empty case has to be special-cased.
    expect(users.findMany({ where: { age: { in: [] } } as never })).toHaveLength(0);
  });

  it("treats an empty `notIn` as every row", () => {
    expect(users.findMany({ where: { age: { notIn: [] } } as never })).toHaveLength(4);
  });

  it("filters by membership", () => {
    const rows = users.findMany({ where: { name: { in: ["Ada", "Cy"] } } as never });
    expect(names(rows)).toEqual(["Ada", "Cy"]);

    const others = users.findMany({ where: { name: { notIn: ["Ada", "Cy"] } } as never });
    expect(names(others)).toEqual(["Bob", "Dee"]);
  });

  it("reads a bare null as IS NULL", () => {
    expect(names(users.findMany({ where: { nickname: null } as never }))).toEqual(["Bob"]);
  });

  it("reads isNull true and false", () => {
    expect(names(users.findMany({ where: { nickname: { isNull: true } } as never }))).toEqual(["Bob"]);
    expect(names(users.findMany({ where: { nickname: { isNull: false } } as never }))).toEqual([
      "Ada",
      "Cy",
      "Dee",
    ]);
  });

  it("rejects a non-array `in`", () => {
    expect(() => users.findMany({ where: { age: { in: 5 } } as never })).toThrow(/must be an array/);
  });
});

/*
 * `%` and `_` are LIKE wildcards, so a value containing them has to be escaped or the
 * filter matches more than the caller asked for. "100%_real" and "a.b" exist in the
 * fixture for exactly this.
 */
describe("LIKE metacharacters in a value are escaped", () => {
  it("treats % and _ in `contains` as literals", () => {
    expect(names(users.findMany({ where: { nickname: { contains: "100%_" } } as never }))).toEqual(["Cy"]);
    expect(names(users.findMany({ where: { nickname: { contains: "00%" } } as never }))).toEqual(["Cy"]);
  });

  it("treats a dot in `contains` as a literal, not as any-character", () => {
    // Unescaped, `.` would match "ada" too.
    expect(names(users.findMany({ where: { nickname: { contains: "a.b" } } as never }))).toEqual(["Dee"]);
  });

  it("still matches on a prefix and a suffix", () => {
    const nicks = (rows: { nickname: string | null }[]): (string | null)[] =>
      rows.map((r) => r.nickname);

    expect(nicks(users.findMany({ where: { nickname: { startsWith: "a" } } as never }))).toEqual([
      "ada",
      "a.b",
    ]);
    expect(nicks(users.findMany({ where: { nickname: { endsWith: ".b" } } as never }))).toEqual(["a.b"]);
  });

  it("does not escape a raw `like` pattern, which is meant to be a pattern", () => {
    const nicks = (rows: { nickname: string | null }[]): (string | null)[] =>
      rows.map((r) => r.nickname);

    expect(nicks(users.findMany({ where: { nickname: { like: "a%" } } as never }))).toEqual([
      "ada",
      "a.b",
    ]);
  });
});

describe("cursorPaginate", () => {
  it("walks the whole set once with a limit, in one direction", () => {
    // cursorPaginate sorts on a cursor column rather than an arbitrary orderBy, and
    // defaults to descending — so page two is the *earlier* rows.
    const first = users.cursorPaginate({ limit: 2, orderByDirection: "asc" });

    expect(first.data.map((r) => r.name)).toEqual(["Ada", "Bob"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = users.cursorPaginate({
      limit: 2,
      orderByDirection: "asc",
      cursor: first.nextCursor!,
    });

    expect(second.data.map((r) => r.name)).toEqual(["Cy", "Dee"]);
    expect(second.hasMore).toBe(false);
  });

  it("reaches every row exactly once, in both directions", () => {
    for (const orderByDirection of ["asc", "desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;

      do {
        const page = users.cursorPaginate({ limit: 2, orderByDirection, cursor });
        seen.push(...page.data.map((r) => r.name));
        cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
      } while (cursor);

      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    }
  });

  it("rejects a cursor it did not issue", () => {
    // A caller-supplied cursor becomes part of the query, so it has to be rejected
    // rather than interpolated.
    expect(() => users.cursorPaginate({ limit: 2, cursor: "not-a-cursor" })).toThrow(
      /Invalid cursor token/,
    );
  });
});

describe("update and delete refuse an empty filter", () => {
  it("refuses to update every row by accident", () => {
    expect(() => users.update({ where: {}, data: { age: 99 } })).toThrow(/requires a filter/);
    expect(users.findMany({}).map((r) => r.age)).toEqual([36, 41, 17, 55]);
  });

  it("refuses to delete every row by accident", () => {
    expect(() => users.delete({ where: {} })).toThrow(/requires a filter/);
    expect(users.count()).toBe(4);
  });

  it("allows it when asked explicitly", () => {
    expect(users.update({ where: {}, data: { age: 1 }, allowAll: true }).changes).toBe(4);
  });

  it("reports no change when nothing matched", () => {
    expect(users.update({ where: { name: "Nobody" }, data: { age: 1 } }).changes).toBe(0);
  });

  it("reports a missing row rather than pretending", () => {
    expect(users.updateById(9999, { age: 1 })).toBeNull();
    expect(users.deleteById(9999)).toBe(false);
  });
});

describe("an unknown column or operator is loud", () => {
  it("rejects a column that does not exist", () => {
    // SQLite reads an unresolvable quoted identifier as a string literal, so a typo
    // compared a literal to a value and matched nothing.
    expect(() => users.findMany({ where: { emial: "ada@x.dev" } as never })).toThrow(/emial/);
  });

  it("rejects an operator that does not exist", () => {
    expect(() => users.findMany({ where: { nickname: { statuss: "active" } } as never })).toThrow(
      /statuss/,
    );
  });

  it("lists what is available", () => {
    let message = "";
    try {
      users.findMany({ where: { emial: "x" } as never });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("email");
  });
});