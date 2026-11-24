// Step 6 — MemoryAdapter seam smoke test (test-only).
//
// Drives the DatabaseSession contract directly against a non-SQL,
// Map-backed driver. If the core's session interface were SQLite-shaped
// (raw SQL strings, prepared statements, pragmas), a Map store could not
// implement it — so this file passing is the proof the seam is real.
// The MemoryAdapter itself is test-only: createAdapter never returns it.

import { describe, it, expect } from "bun:test";
import { col, YattaError } from "../types/db";
import { MemoryAdapter, MEMORY_CAPABILITIES } from "./memory_adapter";

const schema = {
  users: {
    id: col.id(),
    name: col.text().searchable(),
    bio: col.text().searchable(),
    age: col.integer(),
    active: col.boolean(),
    createdAt: col.createdAt(),
  },
  posts: {
    id: col.id(),
    title: col.text().searchable(),
    authorId: col.integer(),
  },
  plain: {
    id: col.id(),
    label: col.text(),
  },
};

function fresh() {
  const adapter = new MemoryAdapter();
  adapter.syncSchema(schema);
  return adapter;
}

function seedUsers(adapter: MemoryAdapter) {
  const ada = adapter.insert("users", schema.users, {
    name: "Ada Lovelace",
    bio: "builds analytical engines",
    age: 36,
    active: true,
  });
  const bob = adapter.insert("users", schema.users, {
    name: "Bob",
    bio: "writes laptop reviews",
    age: 28,
    active: false,
  });
  const cyd = adapter.insert("users", schema.users, {
    name: "Cyd",
    bio: "laptop laptop laptop",
    age: 41,
    active: true,
  });
  return { ada, bob, cyd };
}

describe("MemoryAdapter seam smoke test", () => {
  it("reports honest capabilities for a non-SQL driver", () => {
    const adapter = fresh();
    expect(adapter.capabilities).toEqual(MEMORY_CAPABILITIES);
    expect(adapter.capabilities.mode).toBe("sync");
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.foreignKeys).toBe(false);
    expect(adapter.capabilities.fullTextSearch).toBe("like_fallback");
    expect(adapter.capabilities.vectors).toBe("none");
    expect(adapter.capabilities.backupRestore).toBe("none");
    expect(adapter.capabilities.multiProcessSafe).toBe(false);
    expect(adapter.listTables()).toEqual(["plain", "posts", "users"]);
    expect(adapter.listColumns("users").find((c) => c.name === "id")).toEqual({
      name: "id",
      type: "INTEGER",
      nullable: false,
      primaryKey: true,
    });
    expect(adapter.listColumns("missing")).toEqual([]);
    adapter.ready();
    adapter.close();
  });

  it("inserts with auto ids, explicit ids, and CURRENT_TIMESTAMP defaults", () => {
    const adapter = fresh();
    const { ada, bob } = seedUsers(adapter);
    expect(ada.id).toBe(1);
    expect(bob.id).toBe(2);
    expect(typeof ada.createdAt).toBe("string");
    expect(ada.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // An explicit high id moves the counter, so the next auto id cannot collide.
    const zed = adapter.insert("users", schema.users, {
      id: 10,
      name: "Zed",
      bio: "explicit",
      age: 30,
      active: true,
    });
    expect(zed.id).toBe(10);
    const next = adapter.insert("users", schema.users, {
      name: "Next",
      bio: "auto after explicit",
      age: 30,
      active: true,
    });
    expect(next.id).toBe(11);
    expect(() =>
      adapter.insert("users", schema.users, { id: 1, name: "dup", bio: "", age: 0, active: false }),
    ).toThrow(YattaError);
    expect(() => adapter.insert("missing", schema.users, { name: "x" })).toThrow(/does not exist/);
    adapter.close();
  });

  it("finds with where operators, AND/OR nesting, order, take/skip, and select", () => {
    const adapter = fresh();
    seedUsers(adapter);
    expect(adapter.count("users", schema.users)).toBe(3);
    expect(adapter.count("users", schema.users, { age: { gte: 36 } })).toBe(2);
    expect(adapter.count("users", schema.users, { active: true })).toBe(2);
    expect(
      adapter.find("users", schema.users, { where: { name: { contains: "ada" } } }).map((r) => r.name),
    ).toEqual(["Ada Lovelace"]);
    expect(
      adapter
        .find("users", schema.users, {
          where: { OR: [{ age: { lt: 30 } }, { name: { startsWith: "Cy" } }] },
          orderBy: [{ age: "asc" }],
        })
        .map((r) => r.name),
    ).toEqual(["Bob", "Cyd"]);
    expect(
      adapter
        .find("users", schema.users, {
          where: { AND: [{ active: true }, { age: { lte: 36 } }] },
        })
        .map((r) => r.name),
    ).toEqual(["Ada Lovelace"]);
    expect(
      adapter
        .find("users", schema.users, { orderBy: [{ age: "desc" }], take: 2 })
        .map((r) => r.name),
    ).toEqual(["Cyd", "Ada Lovelace"]);
    expect(
      adapter
        .find("users", schema.users, { orderBy: [{ age: "asc" }], skip: 1, take: 1 })
        .map((r) => r.name),
    ).toEqual(["Ada Lovelace"]);
    expect(
      adapter.find("users", schema.users, { where: { age: { in: [28, 41] } }, select: ["name"] }),
    ).toEqual([{ name: "Bob" }, { name: "Cyd" }]);
    expect(
      adapter.find("users", schema.users, { where: { age: { notIn: [28, 36, 41] } } }),
    ).toEqual([]);
    expect(
      adapter.find("users", schema.users, { where: { bio: { like: "%laptop%" } } }).map((r) => r.name),
    ).toEqual(["Bob", "Cyd"]);
    expect(
      adapter.find("users", schema.users, { where: { bio: { isNull: false } } }).length,
    ).toBe(3);
    expect(
      adapter.find("users", schema.users, { where: { name: { endsWith: "yd" } } }).map((r) => r.name),
    ).toEqual(["Cyd"]);
    expect(() =>
      adapter.find("users", schema.users, { where: { age: { bogus: 1 } as any } }),
    ).toThrow(/Unknown filter operator/);
    adapter.close();
  });

  it("updates, deletes, and upserts find-first", () => {
    const adapter = fresh();
    const { ada, bob } = seedUsers(adapter);
    expect(adapter.update("users", schema.users, { id: ada.id }, {})).toEqual([]);
    const updated = adapter.update("users", schema.users, { id: bob.id }, { age: 29, active: true });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.age).toBe(29);
    expect(updated[0]!.active).toBe(true);
    expect(updated[0]!.name).toBe("Bob");
    expect(adapter.count("users", schema.users, { active: true })).toBe(3);
    expect(adapter.delete("users", schema.users, { age: { lt: 30 } })).toBe(1);
    expect(adapter.count("users", schema.users)).toBe(2);

    const upserted = adapter.upsert("users", schema.users, {
      where: { id: ada.id },
      conflictColumns: ["id"],
      createRow: { name: "Ada?", bio: "", age: 0, active: false },
      updateRow: { age: 37 },
    });
    expect(upserted.id).toBe(ada.id);
    expect(upserted.age).toBe(37);
    expect(adapter.count("users", schema.users)).toBe(2);
    const created = adapter.upsert("users", schema.users, {
      where: { id: 99 },
      conflictColumns: ["id"],
      createRow: { id: 99, name: "New", bio: "fresh", age: 20, active: true },
      updateRow: { age: 21 },
    });
    expect(created.id).toBe(99);
    expect(created.age).toBe(20);
    expect(adapter.count("users", schema.users)).toBe(3);
    adapter.close();
  });

  it("insertMany runs in one transaction", () => {
    const adapter = fresh();
    const rows = adapter.insertMany("posts", schema.posts, [
      { title: "one", authorId: 1 },
      { title: "two", authorId: 1 },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(adapter.count("posts", schema.posts)).toBe(2);
    expect(() =>
      adapter.insertMany("posts", schema.posts, [
        { title: "three", authorId: 1 },
        { id: 1, title: "dup", authorId: 1 },
      ]),
    ).toThrow(YattaError);
    // The failed batch rolled back: "three" is not there.
    expect(adapter.count("posts", schema.posts)).toBe(2);
    adapter.close();
  });

  it("searches with the LIKE fallback, ranked most-relevant first", () => {
    const adapter = fresh();
    const { ada, bob, cyd } = seedUsers(adapter);
    const hits = adapter.search("users", schema.users, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"], ["notebook"]]],
      columns: ["name", "bio"],
      typoCorrection: false,
    });
    // Cyd says "laptop" three times, Bob once; Ada never does.
    expect(hits.map((h) => h.row.id)).toEqual([cyd.id, bob.id]);
    expect(hits[0]!.rank).toBeLessThan(hits[1]!.rank);
    expect(hits.every((h) => h.rank < 0)).toBe(true);
    // Synonym group: "notebook" is an alternative of the same group, not a second token.
    const synonymHits = adapter.search("users", schema.users, {
      tokens: ["notebook"],
      expandedGroups: [[["laptop"], ["notebook"]]],
      columns: ["name", "bio"],
      typoCorrection: false,
    });
    expect(synonymHits.map((h) => h.row.id)).toEqual([cyd.id, bob.id]);
    // A where filter applies after ranking.
    const filtered = adapter.search("users", schema.users, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["name", "bio"],
      where: { active: false },
      typoCorrection: false,
    });
    expect(filtered.map((h) => h.row.id)).toEqual([bob.id]);
    // Limit/offset.
    const limited = adapter.search("users", schema.users, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["name", "bio"],
      limit: 1,
      typoCorrection: false,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.row.id).toBe(cyd.id);
    const offset = adapter.search("users", schema.users, {
      tokens: ["laptop"],
      expandedGroups: [[["laptop"]]],
      columns: ["name", "bio"],
      limit: 1,
      offset: 1,
      typoCorrection: false,
    });
    expect(offset.map((h) => h.row.id)).toEqual([bob.id]);
    // Two groups AND: no row mentions both "laptop" and "analytical".
    expect(
      adapter.search("users", schema.users, {
        tokens: ["laptop", "analytical"],
        expandedGroups: [[["laptop"]], [["analytical"]]],
        columns: ["name", "bio"],
        typoCorrection: false,
      }),
    ).toEqual([]);
    // No searchable columns at all: plain refusal, like the SQLite session.
    expect(() =>
      adapter.search("plain", schema.plain, {
        tokens: ["x"],
        expandedGroups: [[["x"]]],
        columns: [],
        typoCorrection: false,
      }),
    ).toThrow(YattaError);
    expect(ada.name).toBe("Ada Lovelace");
    adapter.close();
  });

  it("returns the vocabulary and no-ops the FTS maintenance methods", () => {
    const adapter = fresh();
    seedUsers(adapter);
    const vocab = adapter.searchVocabulary("users", schema.users);
    expect(vocab.has("laptop")).toBe(true);
    expect(vocab.has("analytical")).toBe(true);
    expect(vocab.has("engines")).toBe(true);
    adapter.syncSearchRow("users", schema.users, { id: 1, name: "x", bio: "y" }, "insert");
    adapter.syncSearchRow("users", schema.users, { id: 1, name: "x", bio: "y" }, "update");
    adapter.syncSearchRow("users", schema.users, { id: 1 }, "delete");
    adapter.rebuildSearchIndex("users", schema.users);
    expect(adapter.count("users", schema.users)).toBe(3);
    adapter.close();
  });

  it("transacts atomically, nests as savepoints, and refuses thenables", () => {
    const adapter = fresh();
    const committed = adapter.transaction(() => {
      adapter.insert("users", schema.users, { name: "In", bio: "tx", age: 1, active: true });
      return "done";
    });
    expect(committed).toBe("done");
    expect(adapter.count("users", schema.users)).toBe(1);
    expect(() =>
      adapter.transaction(() => {
        adapter.insert("users", schema.users, { name: "Out", bio: "tx", age: 2, active: true });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(adapter.count("users", schema.users)).toBe(1);
    // Nested: the inner rollback undoes only the inner work.
    adapter.transaction(() => {
      adapter.insert("users", schema.users, { name: "Outer", bio: "tx", age: 3, active: true });
      expect(() =>
        adapter.transaction(() => {
          adapter.insert("users", schema.users, { name: "Inner", bio: "tx", age: 4, active: true });
          throw new Error("inner boom");
        }),
      ).toThrow("inner boom");
      expect(adapter.count("users", schema.users)).toBe(2);
    });
    expect(adapter.count("users", schema.users)).toBe(2);
    expect(
      adapter.find("users", schema.users, { orderBy: [{ age: "asc" }] }).map((r) => r.name),
    ).toEqual(["In", "Outer"]);
    expect(() =>
      adapter.transaction(() => Promise.resolve("async") as unknown as string),
    ).toThrow(/sync function/);
    expect(adapter.count("users", schema.users)).toBe(2);
    expect(adapter.withMigrationLock(() => 42)).toBe(42);
    adapter.close();
  });

  it("is honest about what a Map store cannot do", () => {
    const adapter = fresh();
    expect(() => adapter.executeRaw("SELECT 1")).toThrow(/raw SQL/);
    expect(() => adapter.executeBatch("CREATE TABLE x (a)")).toThrow(/raw SQL/);
    expect(() => adapter.backup("/tmp/memory.db")).toThrow(/no backup/);
    expect(() => adapter.restore("/tmp/memory.db")).toThrow(/no restore/);
    adapter.close();
    expect(() => adapter.insert("users", schema.users, { name: "x" })).toThrow(/closed/);
    expect(() => adapter.count("users", schema.users)).toThrow(/closed/);
    expect(() => adapter.listTables()).toThrow(/closed/);
  });
});
