// Byte-identical SQL tests for the Step 2 compiler extraction.
//
// Contract: for the SqliteDialect, every statement SqlCompiler produces
// is character-for-character the statement the pre-refactor Table /
// YattaDB code produced for the same input. These tests pin that output.
// If one fails, the compiler or the dialect is wrong — never edit the
// expected string to match new behaviour. (The one deliberate quirk
// pinned here is select: ["*"] compiling to `"*"` — the old code quoted
// it too, so the compiler reproduces it.)

import { describe, expect, test } from "bun:test";
import { SqliteDialect } from "../types/db/adapters/sqlite_dialect";
import { SqlCompiler } from "../types/db/sql_compiler";
import type { ColumnDefinition, TableSchema } from "../types/db/schema";

const dialect = new SqliteDialect();
const compiler = new SqlCompiler(dialect);

const usersCols = new Map<string, ColumnDefinition>([
  ["id", { type: "INTEGER", primaryKey: true, autoIncrement: true }],
  ["name", { type: "TEXT", notNull: true }],
  ["email", { type: "TEXT", notNull: true, unique: true }],
  ["age", { type: "INTEGER" }],
  ["role", { type: "TEXT", notNull: true, defaultValue: "guest" }],
  ["score", { type: "REAL" }],
  ["active", { type: "INTEGER", isBoolean: true }],
  ["meta", { type: "TEXT", isJson: true }],
  ["createdAt", { type: "TEXT", notNull: true, defaultValue: "CURRENT_TIMESTAMP" }],
  ["blob", { type: "BLOB" }],
]);

const usersSchema: TableSchema = {
  id: { def: { type: "INTEGER", primaryKey: true, autoIncrement: true } },
  name: { def: { type: "TEXT", notNull: true } },
  email: { def: { type: "TEXT", notNull: true, unique: true } },
  age: { def: { type: "INTEGER", isIndex: true } },
  createdAt: { def: { type: "TEXT", notNull: true, defaultValue: "CURRENT_TIMESTAMP", isTimeSeries: true } },
} as unknown as TableSchema;

describe("compileWhere", () => {
  test("scalar equality", () => {
    const r = compiler.compileWhere("users", usersCols, { name: "Bob" });
    expect(r.clause).toBe('"name" = ?');
    expect(r.params).toEqual(["Bob"]);
  });

  test("null equality is IS NULL", () => {
    const r = compiler.compileWhere("users", usersCols, { name: null });
    expect(r.clause).toBe('"name" IS NULL');
    expect(r.params).toEqual([]);
  });

  test("every comparison operator", () => {
    expect(compiler.compileWhere("users", usersCols, { age: { eq: 5 } }).clause).toBe('"age" = ?');
    expect(compiler.compileWhere("users", usersCols, { age: { neq: 5 } }).clause).toBe('"age" != ?');
    expect(compiler.compileWhere("users", usersCols, { age: { gt: 5 } }).clause).toBe('"age" > ?');
    expect(compiler.compileWhere("users", usersCols, { age: { gte: 5 } }).clause).toBe('"age" >= ?');
    expect(compiler.compileWhere("users", usersCols, { age: { lt: 5 } }).clause).toBe('"age" < ?');
    expect(compiler.compileWhere("users", usersCols, { age: { lte: 5 } }).clause).toBe('"age" <= ?');
    expect(compiler.compileWhere("users", usersCols, { age: { eq: null } }).clause).toBe('"age" IS NULL');
    expect(compiler.compileWhere("users", usersCols, { age: { neq: null } }).clause).toBe('"age" IS NOT NULL');
    expect(compiler.compileWhere("users", usersCols, { age: { isNull: true } }).clause).toBe('"age" IS NULL');
    expect(compiler.compileWhere("users", usersCols, { age: { isNull: false } }).clause).toBe('"age" IS NOT NULL');
  });

  test("like is raw, contains/startsWith/endsWith escape wildcards", () => {
    const like = compiler.compileWhere("users", usersCols, { name: { like: "Bo%" } });
    expect(like.clause).toBe('"name" LIKE ?');
    expect(like.params).toEqual(["Bo%"]);

    const contains = compiler.compileWhere("users", usersCols, { name: { contains: "a%b_c" } });
    expect(contains.clause).toBe('"name" LIKE ? ESCAPE \'\\\'');
    expect(contains.params).toEqual(["%a\\%b\\_c%"]);

    const starts = compiler.compileWhere("users", usersCols, { name: { startsWith: "Bo" } });
    expect(starts.clause).toBe('"name" LIKE ? ESCAPE \'\\\'');
    expect(starts.params).toEqual(["Bo%"]);

    const ends = compiler.compileWhere("users", usersCols, { name: { endsWith: "ob" } });
    expect(ends.clause).toBe('"name" LIKE ? ESCAPE \'\\\'');
    expect(ends.params).toEqual(["%ob"]);
  });

  test("in / notIn, including empty-array sentinels", () => {
    const r = compiler.compileWhere("users", usersCols, { age: { in: [1, 2, 3] } });
    expect(r.clause).toBe('"age" IN (?, ?, ?)');
    expect(r.params).toEqual([1, 2, 3]);

    expect(compiler.compileWhere("users", usersCols, { age: { in: [] } }).clause).toBe("0 = 1");
    expect(compiler.compileWhere("users", usersCols, { age: { notIn: [] } }).clause).toBe("1 = 1");
    expect(compiler.compileWhere("users", usersCols, { age: { notIn: [1] } }).clause).toBe('"age" NOT IN (?)');
  });

  test("AND / OR nesting, single-nested is bare, empty is a sentinel", () => {
    const and = compiler.compileWhere("users", usersCols, {
      AND: [{ age: { gt: 17 } }, { role: "admin" }],
    });
    expect(and.clause).toBe('("age" > ? AND "role" = ?)');
    expect(and.params).toEqual([17, "admin"]);

    const orOne = compiler.compileWhere("users", usersCols, { OR: [{ age: 5 }] });
    expect(orOne.clause).toBe('"age" = ?');

    expect(compiler.compileWhere("users", usersCols, { OR: [] }).clause).toBe("0 = 1");
    expect(compiler.compileWhere("users", usersCols, { AND: [] }).clause).toBe("1 = 1");
    expect(compiler.compileWhere("users", usersCols, { AND: [{}, {}] }).clause).toBe("1 = 1");
    expect(compiler.compileWhere("users", usersCols, { OR: [{}, {}] }).clause).toBe("0 = 1");
  });

  test("multiple top-level keys AND together", () => {
    const r = compiler.compileWhere("users", usersCols, { age: { gt: 17 }, role: "admin" });
    expect(r.clause).toBe('"age" > ? AND "role" = ?');
    expect(r.params).toEqual([17, "admin"]);
  });

  test("boolean and json values serialize through the dialect", () => {
    expect(compiler.compileWhere("users", usersCols, { active: true }).params).toEqual([1]);
    expect(compiler.compileWhere("users", usersCols, { active: { eq: false } }).params).toEqual([0]);
    expect(compiler.compileWhere("users", usersCols, { meta: { eq: { a: 1 } } }).params).toEqual(['{"a":1}']);
    expect(
      compiler.compileWhere("users", usersCols, { createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") } }).params,
    ).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  test("unknown column, unknown operator, unreadable where all throw", () => {
    expect(() => compiler.compileWhere("users", usersCols, { emial: "x" })).toThrow(/does not exist on table "users"/);
    expect(() => compiler.compileWhere("users", usersCols, { name: { statuss: "x" } as any })).toThrow(
      /Unknown filter operator "statuss"/,
    );
    expect(() => compiler.compileWhere("users", usersCols, "x" as any)).toThrow(/must be an object filter/);
    expect(() => compiler.compileWhere("users", usersCols, [] as any)).toThrow(/got an array/);
    expect(() => compiler.compileWhere("users", usersCols, { AND: { age: 5 } as any })).toThrow(
      /"AND" condition must be an array/,
    );
    expect(() => compiler.compileWhere("users", usersCols, { age: { in: 5 } as any })).toThrow(
      /"in" filter on "age" must be an array/,
    );
  });

  test("empty where compiles to nothing", () => {
    expect(compiler.compileWhere("users", usersCols, {})).toEqual({ clause: "", params: [], nextParam: 1 });
    expect(compiler.compileWhere("users", usersCols, undefined)).toEqual({ clause: "", params: [], nextParam: 1 });
  });
});

describe("compileOrderBy", () => {
  test("single and multiple orders", () => {
    expect(compiler.compileOrderBy("users", usersCols, { name: "asc" })).toBe('ORDER BY "name" ASC');
    expect(
      compiler.compileOrderBy("users", usersCols, [{ age: "desc" }, { name: "asc" }]),
    ).toBe('ORDER BY "age" DESC, "name" ASC');
    expect(compiler.compileOrderBy("users", usersCols, undefined)).toBe("");
  });

  test("invalid direction and unknown column throw", () => {
    expect(() => compiler.compileOrderBy("users", usersCols, { name: "sideways" as any })).toThrow(
      /Invalid order direction/,
    );
    expect(() => compiler.compileOrderBy("users", usersCols, { emial: "asc" })).toThrow(/does not exist on table/);
  });
});

describe("compileSelect", () => {
  test("bare select", () => {
    const r = compiler.compileSelect("users", usersCols);
    expect(r.sql).toBe('SELECT * FROM "users";');
    expect(r.params).toEqual([]);
  });

  test("where + order + take + skip", () => {
    const r = compiler.compileSelect("users", usersCols, {
      where: { age: { gt: 17 } },
      orderBy: { name: "asc" },
      take: 10,
      skip: 5,
    });
    expect(r.sql).toBe('SELECT * FROM "users" WHERE "age" > ? ORDER BY "name" ASC LIMIT 10 OFFSET 5;');
    expect(r.params).toEqual([17]);
  });

  test("bare skip gets LIMIT -1", () => {
    const r = compiler.compileSelect("users", usersCols, { skip: 3 });
    expect(r.sql).toBe('SELECT * FROM "users" LIMIT -1 OFFSET 3;');
  });

  test("explicit column list, including the quoted-star quirk", () => {
    expect(compiler.compileSelect("users", usersCols, { select: ["id", "name"] }).sql).toBe(
      'SELECT "id", "name" FROM "users";',
    );
    expect(compiler.compileSelect("users", usersCols, { select: ["*"] }).sql).toBe('SELECT "*" FROM "users";');
  });
});

describe("compileInsert", () => {
  test("single row with RETURNING", () => {
    const r = compiler.compileInsert("users", usersCols, { name: "Bob", age: 30 });
    expect(r.sql).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?) RETURNING *;');
    expect(r.params).toEqual(["Bob", 30]);
  });

  test("empty payload is DEFAULT VALUES", () => {
    const r = compiler.compileInsert("users", usersCols, {});
    expect(r.sql).toBe('INSERT INTO "users" DEFAULT VALUES RETURNING *;');
    expect(r.params).toEqual([]);
  });

  test("insertMany is one single-row statement per item", () => {
    const rs = compiler.compileInsertMany("users", usersCols, [{ name: "A" }, { name: "B" }]);
    expect(rs).toHaveLength(2);
    expect(rs[0]!.sql).toBe('INSERT INTO "users" ("name") VALUES (?) RETURNING *;');
    expect(rs[0]!.params).toEqual(["A"]);
    expect(rs[1]!.sql).toBe('INSERT INTO "users" ("name") VALUES (?) RETURNING *;');
    expect(rs[1]!.params).toEqual(["B"]);
  });
});

describe("compileUpdate / compileDelete / compileCount / compileExists / compilePkSelect", () => {
  test("update: SET params before WHERE params", () => {
    const r = compiler.compileUpdate("users", usersCols, { role: "member" }, { age: { gt: 17 } });
    expect(r.sql).toBe('UPDATE "users" SET "role" = ? WHERE "age" > ?;');
    expect(r.params).toEqual(["member", 17]);
  });

  test("updateById shape: WHERE on the pk plus RETURNING", () => {
    const r = compiler.compileUpdate("users", usersCols, { role: "member" }, { id: 1 }, { returning: true });
    expect(r.sql).toBe('UPDATE "users" SET "role" = ? WHERE "id" = ? RETURNING *;');
    expect(r.params).toEqual(["member", 1]);
  });

  test("delete", () => {
    expect(compiler.compileDelete("users", usersCols, { role: "guest" }).sql).toBe(
      'DELETE FROM "users" WHERE "role" = ?;',
    );
    expect(compiler.compileDelete("users", usersCols, {}).sql).toBe('DELETE FROM "users";');
  });

  test("count and exists", () => {
    expect(compiler.compileCount("users", usersCols, { age: { gte: 18 } }).sql).toBe(
      'SELECT COUNT(*) as count FROM "users" WHERE "age" >= ?;',
    );
    expect(compiler.compileCount("users", usersCols).sql).toBe('SELECT COUNT(*) as count FROM "users";');
    expect(compiler.compileExists("users", usersCols, { age: { gte: 18 } }).sql).toBe(
      'SELECT 1 FROM "users" WHERE "age" >= ? LIMIT 1;',
    );
  });

  test("pk select for FTS maintenance", () => {
    expect(compiler.compilePkSelect("users", usersCols, "id", { role: "admin" }).sql).toBe(
      'SELECT "id" AS pk FROM "users" WHERE "role" = ?;',
    );
  });
});

describe("serializeValue / decodeRow", () => {
  test("undefined is null, null on NOT NULL throws, null on nullable passes", () => {
    expect(compiler.serializeValue("users", "age", usersCols.get("age"), undefined)).toBeNull();
    expect(compiler.serializeValue("users", "age", usersCols.get("age"), null)).toBeNull();
    expect(() => compiler.serializeValue("users", "name", usersCols.get("name"), null)).toThrow(
      /Cannot set NULL on NOT NULL column "name"/,
    );
  });

  test("objects need a json column", () => {
    expect(() => compiler.serializeValue("users", "name", usersCols.get("name"), { a: 1 })).toThrow(
      /Cannot serialize object for column "name"/,
    );
    expect(compiler.serializeValue("users", "meta", usersCols.get("meta"), { a: 1 })).toBe('{"a":1}');
    expect(compiler.serializeValue("users", "nope", undefined, { a: 1 })).toBe('{"a":1}');
  });

  test("decodeRow reverses the dialect encoding", () => {
    const row = compiler.decodeRow(usersCols, { active: 1, meta: '{"a":1}', name: "Bob", extra: '{"x":1}' });
    expect(row).toEqual({ active: true, meta: { a: 1 }, name: "Bob", extra: { x: 1 } });
    expect(compiler.decodeRow(usersCols, { active: null }).active).toBeNull();
  });
});

describe("SqliteDialect DDL", () => {
  test("CURRENT_TIMESTAMP default is the strftime expression, not bare CURRENT_TIMESTAMP", () => {
    expect(dialect.compileColumnDefault({ type: "TEXT", defaultValue: "CURRENT_TIMESTAMP" })).toBe(
      "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    );
    expect(dialect.compileColumnDefault({ type: "TEXT", defaultValue: null })).toBe("NULL");
    expect(dialect.compileColumnDefault({ type: "INTEGER", isBoolean: true, defaultValue: true })).toBe("1");
    expect(dialect.compileColumnDefault({ type: "INTEGER", defaultValue: 42 })).toBe("42");
    expect(dialect.compileColumnDefault({ type: "TEXT", defaultValue: "guest" })).toBe("'guest'");
    expect(dialect.compileColumnDefault({ type: "TEXT", isJson: true, defaultValue: { a: 1 } })).toBe('\'{"a":1}\'');
  });

  test("column fragments, create mode", () => {
    expect(dialect.compileColumnFragment("id", { type: "INTEGER", primaryKey: true, autoIncrement: true }, "create")).toBe(
      '"id" INTEGER PRIMARY KEY AUTOINCREMENT',
    );
    expect(dialect.compileColumnFragment("name", { type: "TEXT", notNull: true }, "create")).toBe(
      '"name" TEXT NOT NULL',
    );
    expect(dialect.compileColumnFragment("email", { type: "TEXT", notNull: true, unique: true }, "create")).toBe(
      '"email" TEXT NOT NULL UNIQUE',
    );
    expect(
      dialect.compileColumnFragment("createdAt", { type: "TEXT", notNull: true, defaultValue: "CURRENT_TIMESTAMP" }, "create"),
    ).toBe('"createdAt" TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))');
    expect(
      dialect.compileColumnFragment(
        "authorId",
        { type: "INTEGER", references: { table: "posts", column: "id", onDelete: "CASCADE" } },
        "create",
      ),
    ).toBe('"authorId" INTEGER REFERENCES "posts"("id") ON DELETE CASCADE');
    expect(
      dialect.compileColumnFragment("role", { type: "TEXT", checkValues: ["admin", "guest"] }, "create"),
    ).toBe(`"role" TEXT CHECK("role" IN ('admin', 'guest'))`);
  });

  test("column fragments, alter mode guards", () => {
    expect(() =>
      dialect.compileColumnFragment("id", { type: "INTEGER", primaryKey: true }, "alter"),
    ).toThrow(/Cannot add PRIMARY KEY column/);
    expect(() =>
      dialect.compileColumnFragment("name", { type: "TEXT", notNull: true }, "alter"),
    ).toThrow(/Cannot add NOT NULL column "name" without a default value/);
    expect(() =>
      dialect.compileColumnFragment("x", { type: "VARCHAR" as any }, "create"),
    ).toThrow(/Invalid column type "VARCHAR"/);
    expect(() =>
      dialect.compileColumnFragment(
        "authorId",
        { type: "INTEGER", references: { table: "posts", column: "id", onDelete: "DROP" } },
        "create",
      ),
    ).toThrow(/Invalid ON DELETE action "DROP"/);
  });

  test("create-table statements: CREATE plus indexes in schema order", () => {
    const stmts = dialect.compileCreateTableStatements("users", usersSchema);
    expect(stmts).toEqual([
      'CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "age" INTEGER, "createdAt" TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')));',
      'CREATE INDEX IF NOT EXISTS "idx_users_age" ON "users" ("age");',
      'CREATE INDEX IF NOT EXISTS "idx_timeseries_users_createdAt" ON "users" ("createdAt");',
    ]);
  });

  test("index and alter statements", () => {
    expect(dialect.compileIndexSql("users", "age", "plain")).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_users_age" ON "users" ("age");',
    );
    expect(dialect.compileIndexSql("users", "email", "unique")).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uniq_users_email" ON "users" ("email");',
    );
    expect(dialect.compileIndexSql("users", "createdAt", "timeseries")).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_timeseries_users_createdAt" ON "users" ("createdAt");',
    );
    expect(dialect.compileAddColumnSql("users", '"age" INTEGER')).toBe(
      'ALTER TABLE "users" ADD COLUMN "age" INTEGER;',
    );
  });

  test("upsert has no atomic form on SQLite", () => {
    expect(
      dialect.compileUpsert({ table: "users", columns: usersCols, where: { id: 1 }, create: {}, update: {} }),
    ).toBeNull();
  });
});

describe("placeholder numbering (Postgres-shaped stub dialect)", () => {
  // Extends the SQLite dialect and changes only the numbering surface:
  // $n placeholders, ILIKE, explicit NULLS ordering. Proves the compiler
  // threads one counter through a statement in parameter order.
  class StubDialect extends SqliteDialect {
    override placeholder(n: number): string {
      return `$${n}`;
    }
    override compileLikePredicate(quotedCol: string, placeholder: string, _escape: boolean): string {
      return `${quotedCol} ILIKE ${placeholder}`;
    }
    override compileOrderNulls(dir: "ASC" | "DESC"): string {
      return dir === "ASC" ? " NULLS FIRST" : " NULLS LAST";
    }
  }

  const stub = new SqlCompiler(new StubDialect());

  test("UPDATE numbers SET params before WHERE params", () => {
    const r = stub.compileUpdate(
      "users",
      usersCols,
      { role: "member", age: 31 },
      { AND: [{ age: { gt: 17 } }, { active: true }] },
      { returning: true },
    );
    expect(r.sql).toBe(
      'UPDATE "users" SET "role" = $1, "age" = $2 WHERE ("age" > $3 AND "active" = $4) RETURNING *;',
    );
    expect(r.params).toEqual(["member", 31, 17, 1]);
  });

  test("IN list and ORDER BY number in order", () => {
    const r = stub.compileSelect("users", usersCols, {
      where: { age: { in: [1, 2] }, name: { contains: "bo" } },
      orderBy: { age: "desc" },
    });
    expect(r.sql).toBe(
      'SELECT * FROM "users" WHERE "age" IN ($1, $2) AND "name" ILIKE $3 ORDER BY "age" DESC NULLS LAST;',
    );
    expect(r.params).toEqual([1, 2, "%bo%"]);
  });
});
