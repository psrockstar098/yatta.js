// ORM round-trip through the PUBLIC surface on the Turso (libSQL) driver.
// One describe block: insert, findMany + QueryBuilder, findFirst, update,
// delete, FTS5 search, transaction commit + rollback. :memory: + forceNew
// so every run is isolated. FK cascade / nested tx / savepoints /
// backup-restore are documented per-driver limits and are NOT asserted here.
import { describe, it, expect, afterAll } from "bun:test";
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

describe("ORM round-trip (Turso)", () => {
  let db: Awaited<ReturnType<typeof createDatabase<typeof schema>>>;
  let adaId: number;
  let bobId: number;
  let cidId: number;

  it("round trip: insert, query, update, delete, search, transactions", async () => {
    db = await createDatabase({ driver: "turso", url: ":memory:", schema, forceNew: true });

    // (1) insert 3 users + 1 post referencing a user
    const ada = await db.users.insert({ name: "Ada", bio: "writes analytical engines", age: 36, active: true });
    const bob = await db.users.insert({ name: "Bob", bio: "builds laptop computers", age: 41, active: false });
    const cid = await db.users.insert({ name: "Cid", bio: "reads code", age: 52, active: true });
    adaId = ada.id; bobId = bob.id; cidId = cid.id;
    expect(ada.id).toBe(1);
    expect(bob.id).toBe(2);
    expect(cid.id).toBe(3);
    expect(typeof ada.createdAt).toBe("string");
    const post = await db.posts.insert({ title: "Hello Turso", authorId: ada.id });
    expect(post.id).toBe(1);
    expect(post.authorId).toBe(ada.id);
    expect(await db.users.count()).toBe(3);
    expect(await db.posts.count()).toBe(1);

    // (2) findMany with where + sort + limit, and the same via QueryBuilder
    const older = await db.users.findMany({
      where: { age: { gte: 40 } },
      orderBy: [{ age: "desc" }],
      take: 1,
    });
    expect(older.map((u) => u.name)).toEqual(["Cid"]);
    const olderQb = await db.users
      .where({ age: { gte: 40 } })
      .orderBy({ age: "desc" })
      .take(1)
      .all();
    expect(olderQb.map((u) => u.name)).toEqual(["Cid"]);
    const allOlder = await db.users.findMany({
      where: { age: { gte: 40 } },
      orderBy: [{ age: "desc" }],
    });
    expect(allOlder.map((u) => u.name)).toEqual(["Cid", "Bob"]);

    // (3) findFirst
    const first = await db.users.findFirst({ where: { name: "Bob" } });
    expect(first).not.toBeNull();
    expect(first!.age).toBe(41);
    expect(first!.bio).toBe("builds laptop computers");
    expect(await db.users.findFirst({ where: { name: "Nobody" } })).toBeNull();

    // (4) update one user's age and confirm
    const upd = await db.users.update({ where: { name: "Ada" }, data: { age: 37 } });
    expect(upd.changes).toBe(1);
    const adaAfter = await db.users.findFirst({ where: { name: "Ada" } });
    expect(adaAfter!.age).toBe(37);

    // (5) delete one user and confirm count
    const del = await db.users.delete({ where: { name: "Cid" } });
    expect(del.changes).toBe(1);
    expect(await db.users.count()).toBe(2);
    expect(await db.users.findFirst({ where: { name: "Cid" } })).toBeNull();

    // (6) search for a word present in one bio and confirm that row is returned
    const hits = await db.users.search("laptop");
    expect(hits.length).toBe(1);
    expect(hits[0]!.row.name).toBe("Bob");
    expect(hits[0]!.row.bio).toBe("builds laptop computers");
    expect(typeof hits[0]!.rank).toBe("number");
    expect(await db.users.search("nonexistentwordxyz")).toEqual([]);

    // (7a) transaction commit: insert inside tx, visible after
    await db.transaction(async (tx) => {
      await tx.users.insert({ name: "Dee", bio: "tests transactions", age: 25, active: true });
    });
    expect(await db.users.count()).toBe(3);
    expect((await db.users.findFirst({ where: { name: "Dee" } }))?.age).toBe(25);

    // (7b) transaction rollback: throw inside tx, row absent after
    await expect(
      db.transaction(async (tx) => {
        await tx.users.insert({ name: "Eli", bio: "should roll back", age: 30, active: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.users.count()).toBe(3);
    expect(await db.users.findFirst({ where: { name: "Eli" } })).toBeNull();
  }, 60000);

  afterAll(async () => {
    if (db) await db.close();
  });
});

describe("ORM round-trip (Turso) insertMany", () => {
  it("insertMany inserts rows through the ORM (regression: concurrent savepoints failed on libSQL)", async () => {
    const fresh = await createDatabase({ driver: "turso", url: ":memory:", schema, forceNew: true });
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
