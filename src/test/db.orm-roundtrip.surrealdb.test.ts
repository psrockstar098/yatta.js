// ORM round-trip through the PUBLIC ORM surface on SurrealDB (mem://).
//
// Exercises Table/QueryBuilder over the session path (compilerSql: false):
// insert, findMany (where + sort + limit), QueryBuilder, findFirst, update,
// delete, count, BM25 search, transaction commit + rollback.
import { describe, it, expect, afterEach } from "bun:test";
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

describe("SurrealDB ORM round-trip (public surface)", () => {
  it("insert -> findMany/QueryBuilder -> findFirst -> update -> delete -> search -> tx commit/rollback", async () => {
    const db = await createDatabase({ driver: "surrealdb", url: "mem://", schema, forceNew: true });
    try {
      // (1) insert 3 users + 1 post referencing a user
      const ada = await db.users.insert({ name: "Ada", bio: "writes code", age: 36, active: true });
      const bob = await db.users.insert({ name: "Bob", bio: "builds laptop computers", age: 41, active: false });
      const cid = await db.users.insert({ name: "Cid", bio: "writes tests", age: 20, active: true });
      expect(ada.id).toBe(1);
      expect(bob.id).toBe(2);
      expect(cid.id).toBe(3);
      expect(typeof ada.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(ada.createdAt as string))).toBe(false);

      const post = await db.posts.insert({ title: "Hello Surreal", authorId: ada.id });
      expect(post.id).toBe(1);
      expect(post.authorId).toBe(ada.id);
      expect(await db.users.count()).toBe(3);
      expect(await db.posts.count()).toBe(1);

      // (2) findMany with where filter + sort + limit, and the same via QueryBuilder
      const older = await db.users.findMany({
        where: { age: { gte: 40 } },
        orderBy: [{ age: "desc" }],
        take: 1,
      });
      expect(older.map((r) => r.name)).toEqual(["Bob"]);

      const olderQb = await db.users
        .where({ age: { gte: 40 } })
        .orderBy([{ age: "desc" }])
        .take(1)
        .all();
      expect(olderQb.map((r) => r.name)).toEqual(["Bob"]);

      // (3) findFirst
      const first = await db.users.findFirst({ where: { age: { gte: 40 } }, orderBy: [{ age: "asc" }] });
      expect(first?.name).toBe("Bob");
      expect(await db.users.findFirst({ where: { name: "Nobody" } })).toBeNull();

      // (4) update one user's age and confirm
      const upd = await db.users.update({ where: { name: "Ada" }, data: { age: 37 } });
      expect(upd.changes).toBe(1);
      const adaAfter = await db.users.findFirst({ where: { name: "Ada" } });
      expect(adaAfter?.age).toBe(37);

      // (5) delete one user and confirm count
      const del = await db.users.delete({ where: { name: "Cid" } });
      expect(del.changes).toBe(1);
      expect(await db.users.count()).toBe(2);
      expect(await db.users.count({ active: true })).toBe(1);

      // (6) search for a word present in one bio and confirm that row is returned
      const hits = await db.users.search("laptop");
      expect(hits.length).toBe(1);
      expect(hits[0]!.row.name).toBe("Bob");
      expect(typeof hits[0]!.rank).toBe("number");
      expect(hits[0]!.rank).toBeLessThan(0);
      expect(await db.users.search("nonexistentwordxyz")).toEqual([]);

      // (7a) transaction commit: insert inside tx, visible after
      await db.transaction(async (tx) => {
        await tx.users.insert({ name: "Dee", bio: "joins late", age: 28, active: true });
        expect(await tx.users.count()).toBe(3);
        // At ORM level `db` inside fn is the same proxy bound to the
        // transaction session (engine.ts: sessionOverride), so it sees
        // the tx's writes too — 3, not 2. Proven identical on SQLite.
        // "Not visible outside" is covered by (7b): the rolled-back row
        // is absent after the transaction ends.
        expect(await db.users.count()).toBe(3);
      });
      expect(await db.users.count()).toBe(3);
      expect((await db.users.findFirst({ where: { name: "Dee" } }))?.age).toBe(28);

      // (7b) transaction rollback: throw inside tx, row absent after
      await expect(
        db.transaction(async (tx) => {
          await tx.users.insert({ name: "Eve", bio: "never lands", age: 33, active: true });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.users.count()).toBe(3);
      expect(await db.users.findFirst({ where: { name: "Eve" } })).toBeNull();
    } finally {
      await db.close();
    }
  }, 60000);
});

describe("SurrealDB ORM round-trip (public surface) insertMany", () => {
  it("insertMany inserts rows through the ORM", async () => {
    const fresh = await createDatabase({ driver: "surrealdb", url: "mem://", schema, forceNew: true });
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
