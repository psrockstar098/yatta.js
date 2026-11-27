// ORM round-trip verification for the PGlite driver, through the PUBLIC
// ORM surface only (createDatabase / Table / QueryBuilder) — no session or
// adapter internals. One describe block, one in-memory PGlite instance
// (forceNew: true so runs are isolated).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createDatabase, col } from "../types/db";
import type { AsyncTypedDatabase } from "../types/db";

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

type DB = AsyncTypedDatabase<typeof schema>;

describe("ORM round-trip (pglite)", () => {
  let db: DB;

  beforeAll(async () => {
    db = await createDatabase({ driver: "pglite", schema, forceNew: true });
  }, 60000);

  afterAll(async () => {
    await db.close();
  });

  it("(1) inserts 3 users + 1 post referencing a user", async () => {
    const ada = await db.users.insert({ name: "Ada", bio: "writes analytical engines", age: 36, active: true });
    const bob = await db.users.insert({ name: "Bob", bio: "builds laptop computers", age: 41, active: false });
    const cid = await db.users.insert({ name: "Cid", bio: "reads code all day", age: 45, active: true });
    expect(ada.id).toBe(1);
    expect(bob.id).toBe(2);
    expect(cid.id).toBe(3);
    expect(typeof ada.createdAt).toBe("string");

    const post = await db.posts.insert({ title: "Hello Postgres", authorId: ada.id });
    expect(post.id).toBe(1);
    expect(post.authorId).toBe(ada.id);
    expect(await db.users.count()).toBe(3);
    expect(await db.posts.count()).toBe(1);
  }, 60000);

  it("(2) findMany with where + sort + limit, and the same via QueryBuilder", async () => {
    const rows = await db.users.findMany({
      where: { age: { gte: 40 } },
      orderBy: [{ age: "desc" }],
      take: 1,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("Cid");
    expect(rows[0]!.age).toBe(45);

    const qb = await db.users.where({ age: { gte: 40 } }).orderBy([{ age: "desc" }]).take(1).all();
    expect(qb.length).toBe(1);
    expect(qb[0]!.name).toBe("Cid");
    expect(qb[0]!.age).toBe(45);
  }, 60000);

  it("(3) findFirst", async () => {
    const first = await db.users.findFirst({ where: { name: "Bob" } });
    expect(first).not.toBeNull();
    expect(first!.name).toBe("Bob");
    expect(first!.age).toBe(41);
    expect(first!.active).toBe(false);
  }, 60000);

  it("(4) update one user's age and confirm", async () => {
    const { changes } = await db.users.update({ where: { name: "Ada" }, data: { age: 37 } });
    expect(changes).toBe(1);
    const again = await db.users.findFirst({ where: { name: "Ada" } });
    expect(again!.age).toBe(37);
  }, 60000);

  it("(5) delete one user and confirm count", async () => {
    const { changes } = await db.users.delete({ where: { name: "Cid" } });
    expect(changes).toBe(1);
    expect(await db.users.count()).toBe(2);
    const gone = await db.users.findFirst({ where: { name: "Cid" } });
    expect(gone).toBeNull();
  }, 60000);

  it("(6) search for a word present in one bio returns that row (tsvector path)", async () => {
    const hits = await db.users.search("laptop");
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.name).toBe("Bob");
    expect(hits[0]!.row.bio).toContain("laptop");
    expect(typeof hits[0]!.rank).toBe("number");
  }, 60000);

  it("(7) transaction commit visible after, rollback absent after", async () => {
    await db.transaction(async (tx) => {
      await tx.users.insert({ name: "Dee", bio: "committed inside tx", age: 25, active: true });
    });
    expect(await db.users.count()).toBe(3);
    const dee = await db.users.findFirst({ where: { name: "Dee" } });
    expect(dee).not.toBeNull();
    expect(dee!.age).toBe(25);

    await expect(
      db.transaction(async (tx) => {
        await tx.users.insert({ name: "Eli", bio: "rolled back", age: 30, active: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.users.count()).toBe(3);
    const eli = await db.users.findFirst({ where: { name: "Eli" } });
    expect(eli).toBeNull();
  }, 60000);
});

describe("ORM round-trip (pglite) insertMany", () => {
  it("insertMany inserts rows through the ORM", async () => {
    const fresh: DB = await createDatabase({ driver: "pglite", schema, forceNew: true });
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
