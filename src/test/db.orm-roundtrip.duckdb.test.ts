// Public-ORM round-trip verification for the DuckDB adapter (Phase 2).
//
// Exercises ONLY the public ORM surface (createDatabase / Table /
// QueryBuilder) against the async embedded DuckDB driver. Deliberately
// does NOT test FK cascade, nested transactions, savepoints, or
// backup/restore: DuckDB has no SAVEPOINT and a failed statement aborts
// the whole transaction (documented limits), and an in-memory database
// cannot be backed up.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createDatabase, col } from "../types/db";

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

type DB = Awaited<ReturnType<typeof createDatabase<typeof schema>>>;

let db: DB;
let adaId: number;
let bobId: number;
let cidId: number;

describe("DuckDB ORM round-trip (public surface)", () => {
  beforeAll(async () => {
    db = await createDatabase({ driver: "duckdb", path: ":memory:", schema, forceNew: true });
  }, 60_000);

  afterAll(async () => {
    await db.close();
  }, 60_000);

  it("(1) inserts 3 users + 1 post referencing a user", async () => {
    const ada = await db.users.insert({ name: "Ada", bio: "writes analytical engines", age: 36, active: true });
    const bob = await db.users.insert({ name: "Bob", bio: "builds laptop computers", age: 41, active: false });
    const cid = await db.users.insert({ name: "Cid", bio: "reads code", age: 25, active: true });
    adaId = ada.id;
    bobId = bob.id;
    cidId = cid.id;
    expect(ada.id).toBe(1);
    expect(bob.id).toBe(2);
    expect(cid.id).toBe(3);
    expect(typeof ada.createdAt).toBe("string");

    const post = await db.posts.insert({ title: "hello duckdb", authorId: ada.id });
    expect(post.id).toBe(1);
    expect(post.authorId).toBe(ada.id);

    expect(await db.users.count()).toBe(3);
    expect(await db.posts.count()).toBe(1);
  }, 60_000);

  it("(2) findMany with where + sort + limit, and the same via QueryBuilder", async () => {
    const rows = await db.users.findMany({
      where: { age: { gte: 40 } },
      orderBy: [{ age: "desc" }],
      take: 1,
    });
    expect(rows.map((r) => r.name)).toEqual(["Bob"]);
    expect(rows[0]!.age).toBe(41);

    const qbRows = await db.users
      .where({ age: { gte: 40 } })
      .orderBy([{ age: "desc" }])
      .take(1)
      .all();
    expect(qbRows.map((r) => r.name)).toEqual(["Bob"]);
    expect(qbRows[0]!.id).toBe(bobId);
  }, 60_000);

  it("(3) findFirst returns the matching row", async () => {
    const ada = await db.users.findFirst({ where: { name: "Ada" } });
    expect(ada).not.toBeNull();
    expect(ada!.id).toBe(adaId);
    expect(ada!.age).toBe(36);
    expect(ada!.bio).toBe("writes analytical engines");

    const none = await db.users.findFirst({ where: { name: "Nobody" } });
    expect(none).toBeNull();
  }, 60_000);

  it("(4) update one user's age and confirm", async () => {
    const res = await db.users.update({ where: { id: adaId }, data: { age: 37 } });
    expect(res.changes).toBe(1);
    const ada = await db.users.findFirst({ where: { id: adaId } });
    expect(ada!.age).toBe(37);
    // Other rows untouched.
    expect((await db.users.findFirst({ where: { id: bobId } }))!.age).toBe(41);
  }, 60_000);

  it("(5) delete one user and confirm count", async () => {
    // Cid has no post, so no FK cascade is involved here.
    const res = await db.users.delete({ where: { id: cidId } });
    expect(res.changes).toBe(1);
    expect(await db.users.count()).toBe(2);
    expect(await db.users.findFirst({ where: { id: cidId } })).toBeNull();
    // Ada's post is untouched.
    expect(await db.posts.count()).toBe(1);
  }, 60_000);

  it("(6) search finds the word present in one bio", async () => {
    const hits = await db.users.search("laptop");
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.name).toBe("Bob");
    expect(hits[0]!.row.bio).toBe("builds laptop computers");
    expect(typeof hits[0]!.rank).toBe("number");

    const none = await db.users.search("zebraquux");
    expect(none).toEqual([]);
  }, 60_000);

  it("(7a) transaction commit: insert inside tx is visible after", async () => {
    await db.transaction(async (tx) => {
      await tx.users.insert({ name: "Dee", bio: "tests transactions", age: 30, active: true });
    });
    expect(await db.users.count()).toBe(3);
    const dee = await db.users.findFirst({ where: { name: "Dee" } });
    expect(dee).not.toBeNull();
    expect(dee!.age).toBe(30);
  }, 60_000);

  it("(7b) transaction rollback: throw inside tx leaves the row absent", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.users.insert({ name: "Eli", bio: "never lands", age: 28, active: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.users.count()).toBe(3);
    expect(await db.users.findFirst({ where: { name: "Eli" } })).toBeNull();
  }, 60_000);
});

describe("DuckDB ORM round-trip (public surface) insertMany", () => {
  it("insertMany inserts rows through the ORM", async () => {
    const fresh: DB = await createDatabase({ driver: "duckdb", path: ":memory:", schema, forceNew: true });
    try {
      const rows = await fresh.users.insertMany([
        { name: "Bulk1", bio: "one", age: 20, active: true },
        { name: "Bulk2", bio: "two", age: 21, active: false },
        { name: "Bulk3", bio: "three", age: 22, active: true },
      ]);
      expect(rows.map((r) => r.name)).toEqual(["Bulk1", "Bulk2", "Bulk3"]);
      expect(await fresh.users.count()).toBe(3);
      expect((await fresh.users.findFirst({ where: { name: "Bulk2" } }))?.age).toBe(21);
    } finally {
      await fresh.close();
    }
  }, 60000);
});
