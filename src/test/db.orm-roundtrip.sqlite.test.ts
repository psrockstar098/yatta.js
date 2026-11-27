// ORM round-trip through the PUBLIC surface on the SQLite driver (reference).
// One describe block: insert -> findMany (+ QueryBuilder) -> findFirst ->
// update -> delete -> search -> transaction commit + rollback.
import { describe, it, expect, afterEach } from "bun:test";
import { createDatabase, col, type TypedDatabase } from "../types/db";

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
    authorId: col.integer().references("users.id", { onDelete: "CASCADE" }),
  },
};

let db: TypedDatabase<typeof schema> | null = null;
afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

describe("db.orm-roundtrip.sqlite", () => {
  it("round trip: insert, find, update, delete, search, transactions", () => {
    db = createDatabase({ path: ":memory:", schema, forceNew: true });

    // (1) insert 3 users + 1 post referencing a user
    const alice = db.users.insert({ name: "Alice", bio: "loves laptops and coffee", age: 30, active: true });
    const bob = db.users.insert({ name: "Bob", bio: "builds keyboards", age: 45, active: true });
    const carol = db.users.insert({ name: "Carol", bio: "reads about laptops", age: 52, active: false });
    expect(alice.id).toBeDefined();
    expect(bob.id).toBeDefined();
    expect(carol.id).toBeDefined();
    expect(db.users.count()).toBe(3);

    const post = db.posts.insert({ title: "Hello world", authorId: alice.id });
    expect(post.id).toBeDefined();
    expect(post.authorId).toBe(alice.id);

    // (2) findMany with where + sort + limit, and the same via QueryBuilder
    const many = db.users.findMany({
      where: { age: { gte: 40 } },
      orderBy: [{ age: "desc" }],
      take: 1,
    });
    expect(many.length).toBe(1);
    expect(many[0]!.name).toBe("Carol");
    expect(many[0]!.age).toBe(52);

    const viaBuilder = db.users.where({ age: { gte: 40 } }).orderBy({ age: "desc" }).take(1).all();
    expect(viaBuilder.length).toBe(1);
    expect(viaBuilder[0]!.name).toBe("Carol");
    expect(viaBuilder[0]!.age).toBe(52);

    // (3) findFirst
    const first = db.users.findFirst({ where: { age: { gte: 40 } }, orderBy: [{ age: "asc" }] });
    expect(first).not.toBeNull();
    expect(first!.name).toBe("Bob");
    expect(first!.age).toBe(45);

    // (4) update one user's age and confirm
    const upd = db.users.update({ where: { name: "Alice" }, data: { age: 31 } });
    expect(upd.changes).toBe(1);
    const aliceAfter = db.users.findFirst({ where: { name: "Alice" } });
    expect(aliceAfter!.age).toBe(31);

    // (5) delete one user and confirm count
    const del = db.users.delete({ where: { name: "Bob" } });
    expect(del.changes).toBe(1);
    expect(db.users.count()).toBe(2);
    expect(db.users.findFirst({ where: { name: "Bob" } })).toBeNull();

    // (6) search for a word present in one bio and confirm that row is returned
    const hits = db.users.search("laptop");
    const hitNames = hits.map((h) => h.row.name).sort();
    expect(hitNames).toContain("Alice");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.row && typeof h.row.id !== "undefined")).toBe(true);

    // (7a) transaction commit: insert inside tx, visible after
    db.transaction((tx) => {
      tx.users.insert({ name: "Dave", bio: "committed in tx", age: 28, active: true });
    });
    expect(db.users.count()).toBe(3);
    expect(db.users.findFirst({ where: { name: "Dave" } })).not.toBeNull();

    // (7b) transaction rollback: throw inside tx, row absent after
    expect(() => {
      db!.transaction((tx) => {
        tx.users.insert({ name: "Eve", bio: "rolled back", age: 99, active: false });
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(db.users.findFirst({ where: { name: "Eve" } })).toBeNull();
    expect(db.users.count()).toBe(3);
  });
});

describe("db.orm-roundtrip.sqlite insertMany", () => {
  it("insertMany inserts rows through the ORM", () => {
    const fresh = createDatabase({ path: ":memory:", schema, forceNew: true });
    try {
      const rows = fresh.users.insertMany([
        { name: "Bulk1", bio: "one", age: 20, active: true },
        { name: "Bulk2", bio: "two", age: 21, active: false },
        { name: "Bulk3", bio: "three", age: 22, active: true },
      ]);
      expect(rows.map((r) => r.name)).toEqual(["Bulk1", "Bulk2", "Bulk3"]);
      expect(fresh.users.count()).toBe(3);
      expect(fresh.users.findFirst({ where: { name: "Bulk2" } })?.age).toBe(21);
    } finally {
      fresh.close();
    }
  });
});
