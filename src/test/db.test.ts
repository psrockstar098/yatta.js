import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createDatabase,
  col,
  connect,
  and,
  or,
  YattaError,
  type InferRow,
  type InferInsert,
  type TypedDatabase,
  type DatabaseSchema,
} from "../types/db";
import fs from "node:fs";
import path from "node:path";

describe("Yatta DB — Embedded SQLite ORM", () => {
  const testSchema = {
    users: {
      id: col.uuid(),
      email: col.text().unique(),
      name: col.text(),
      age: col.integer().nullable(),
      isAdmin: col.boolean().default(false),
      preferences: col.json<{ theme: string; notifications: boolean }>().default({ theme: "light", notifications: true }),
      role: col.enum(["admin", "member", "guest"]).default("member"),
      createdAt: col.createdAt(),
      updatedAt: col.updatedAt(),
    },
    posts: {
      id: col.id(),
      userId: col.text().references("users.id", { onDelete: "CASCADE" }),
      title: col.text(),
      content: col.text().default(""),
      published: col.boolean().default(false),
      createdAt: col.createdAt(),
      updatedAt: col.updatedAt(),
    },
  };

  let db: TypedDatabase<typeof testSchema>;

  beforeEach(() => {
    db = createDatabase({
      path: ":memory:",
      schema: testSchema,
      relations: {
        users: {
          posts: { hasMany: "posts", foreignKey: "userId" },
        },
        posts: {
          author: { belongsTo: "users", foreignKey: "userId" },
        },
      },
      forceNew: true,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should accurately infer User row types from schema", () => {
      type UserRow = InferRow<typeof testSchema.users>;
      const user: UserRow = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        email: "alice@example.com",
        name: "Alice",
        age: 28,
        isAdmin: false,
        preferences: { theme: "dark", notifications: true },
        role: "admin",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      expect(user.email).toBe("alice@example.com");
      expect(user.preferences.theme).toBe("dark");
    });

    it("should infer insert types with optional defaults and auto-generated fields", () => {
      type UserInsert = InferInsert<typeof testSchema.users>;
      // id, isAdmin, preferences, role, createdAt, updatedAt have defaults/generators, so only email & name are required
      const insertData: UserInsert = {
        email: "bob@example.com",
        name: "Bob",
      };

      expect(insertData.email).toBe("bob@example.com");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should prevent SQL Injection attacks in string filters", () => {
      db.users.insert({
        email: "secure@test.com",
        name: "Normal User",
      });

      // SQL injection payload attempting tautology or statement stacking
      const maliciousInput = "test.com' OR '1'='1";
      const results = db.users.findMany({
        where: { email: { contains: maliciousInput } },
      });

      expect(results.length).toBe(0);

      const dropTablePayload = "'; DROP TABLE users; --";
      const results2 = db.users.findMany({
        where: { name: { contains: dropTablePayload } },
      });
      expect(results2.length).toBe(0);

      // Verify users table was not dropped
      expect(db.users.count()).toBe(1);
    });

    it("should prevent querying unmapped tables when schema is defined", () => {
      expect(() => {
        (db as any).table("secret_passwords");
      }).toThrow(/Table "secret_passwords" is not defined/);
    });

    it("should disallow invalid order directions", () => {
      expect(() => {
        db.users.findMany({
          orderBy: { name: "DESC; DROP TABLE users;" as any },
        });
      }).toThrow(/Invalid order direction/);
    });

    it("should enforce NOT NULL constraints and reject undefined required fields", () => {
      expect(() => {
        // Missing required 'email'
        db.users.insert({ name: "No Email" } as any);
      }).toThrow();
    });

    it("should enforce UNIQUE constraints", () => {
      db.users.insert({ email: "unique@test.com", name: "First" });
      expect(() => {
        db.users.insert({ email: "unique@test.com", name: "Duplicate" });
      }).toThrow();
    });

    it("should enforce Foreign Key constraints", () => {
      expect(() => {
        db.posts.insert({
          userId: "non-existent-user-uuid",
          title: "Ghost Post",
        });
      }).toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should automatically generate UUIDs for col.uuid()", () => {
      const user = db.users.insert({ email: "uuid@test.com", name: "UUID Test" });
      expect(user.id).toBeDefined();
      expect(user.id.length).toBeGreaterThan(20);
    });

    it("should serialize and deserialize JSON columns correctly", () => {
      const user = db.users.insert({
        email: "json@test.com",
        name: "JSON Test",
        preferences: { theme: "matrix", notifications: false },
      });

      expect(user.preferences).toEqual({ theme: "matrix", notifications: false });

      const fetched = db.users.findById(user.id);
      expect(fetched?.preferences.theme).toBe("matrix");
      expect(fetched?.preferences.notifications).toBe(false);
    });

    it("should serialize and deserialize booleans as true/false rather than 0/1", () => {
      const user = db.users.insert({
        email: "bool@test.com",
        name: "Bool Test",
        isAdmin: true,
      });

      expect(user.isAdmin).toBe(true);

      const found = db.users.findById(user.id);
      expect(found?.isAdmin).toBe(true);
    });

    it("should filter with English DSL operators", () => {
      db.users.insertMany([
        { email: "john@apple.com", name: "John Doe", age: 30 },
        { email: "jane@google.com", name: "Jane Doe", age: 25 },
        { email: "alex@amazon.com", name: "Alex Smith", age: 40 },
      ]);

      // isGreaterThan & endsWith
      const older = db.users.where((f) => f.age.isGreaterThan(28)).all();
      expect(older.length).toBe(2);

      const googleUsers = db.users.where((f) => f.email.endsWith("@google.com")).all();
      expect(googleUsers.length).toBe(1);
      expect(googleUsers[0]!.name).toBe("Jane Doe");

      // startsWith & contains
      const doeFamily = db.users.where((f) => f.name.contains("Doe")).all();
      expect(doeFamily.length).toBe(2);
    });

    it("should support and() and or() condition trees", () => {
      db.users.insertMany([
        { email: "u1@test.com", name: "User 1", age: 20 },
        { email: "u2@test.com", name: "User 2", age: 30 },
        { email: "u3@test.com", name: "User 3", age: 40 },
      ]);

      const matched = db.users
        .where((f) =>
          or(
            f.age.isEqualTo(20),
            and(f.age.isGreaterThan(25), f.name.isEqualTo("User 3")),
          ),
        )
        .all();

      expect(matched.length).toBe(2);
      const ages = matched.map((u) => u.age);
      expect(ages).toContain(20);
      expect(ages).toContain(40);
    });

    it("should support column projection with select", () => {
      db.users.insert({ email: "proj@test.com", name: "Project Me", age: 35 });
      const selected = db.users.findFirst({
        where: { email: "proj@test.com" },
        select: ["email", "name"],
      });

      expect(selected?.email).toBe("proj@test.com");
      expect(selected?.name).toBe("Project Me");
      expect((selected as any).age).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should complete full CRUD lifecycle", () => {
      // 1. CREATE
      const created = db.users.insert({ email: "crud@test.com", name: "Original Name" });
      expect(created.id).toBeDefined();

      // 2. READ
      const found = db.users.findById(created.id);
      expect(found?.name).toBe("Original Name");

      // 3. UPDATE
      const updated = db.users.updateById(created.id, { name: "Updated Name", age: 29 });
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.age).toBe(29);

      // 4. DELETE
      const deleted = db.users.deleteById(created.id);
      expect(deleted).toBe(true);

      const afterDelete = db.users.findById(created.id);
      expect(afterDelete).toBeNull();
    });

    it("should perform atomic upsert (insert new vs update existing)", () => {
      // Upsert: Create when missing
      const user1 = db.users.upsert({
        where: { email: "upsert@test.com" },
        create: { email: "upsert@test.com", name: "Upsert 1" },
        update: { name: "Upsert Updated" },
      });
      expect(user1.name).toBe("Upsert 1");

      // Upsert: Update when already present
      const user2 = db.users.upsert({
        where: { email: "upsert@test.com" },
        create: { email: "upsert@test.com", name: "Should Not Create" },
        update: { name: "Upsert Updated", age: 99 },
      });
      expect(user2.id).toBe(user1.id);
      expect(user2.name).toBe("Upsert Updated");
      expect(user2.age).toBe(99);
    });

    it("should resolve relations with include (hasMany and belongsTo)", () => {
      const user = db.users.insert({ email: "author@test.com", name: "Author" });
      db.posts.insert({ userId: user.id, title: "Post 1", published: true });
      db.posts.insert({ userId: user.id, title: "Post 2", published: false });

      // hasMany
      const userWithPosts = db.users.findFirst({
        where: { id: user.id },
        include: { posts: true },
      }) as any;

      expect(userWithPosts.posts).toBeDefined();
      expect(userWithPosts.posts.length).toBe(2);

      // belongsTo
      const postWithAuthor = db.posts.findFirst({
        where: { title: "Post 1" },
        include: { author: true },
      }) as any;

      expect(postWithAuthor.author).toBeDefined();
      expect(postWithAuthor.author.id).toBe(user.id);
      expect(postWithAuthor.author.name).toBe("Author");
    });

    it("should cascade deletes when parent is removed", () => {
      const user = db.users.insert({ email: "cascade@test.com", name: "Cascade User" });
      db.posts.insert({ userId: user.id, title: "Cascaded Post" });

      expect(db.posts.count({ userId: user.id })).toBe(1);

      db.users.deleteById(user.id);

      // Post should be deleted via SQLite CASCADE
      expect(db.posts.count({ userId: user.id })).toBe(0);
    });

    it("should rollback transactions upon failure", () => {
      expect(() => {
        db.transaction((tx) => {
          tx.users.insert({ email: "tx1@test.com", name: "TX 1" });
          tx.users.insert({ email: "tx2@test.com", name: "TX 2" });
          throw new Error("Intentional Abort");
        });
      }).toThrow("Intentional Abort");

      expect(db.users.count({ email: { in: ["tx1@test.com", "tx2@test.com"] } })).toBe(0);
    });

    it("should commit transactions upon successful execution", () => {
      db.transaction((tx) => {
        tx.users.insert({ email: "commit1@test.com", name: "Commit 1" });
        tx.users.insert({ email: "commit2@test.com", name: "Commit 2" });
      });

      expect(db.users.count({ email: { in: ["commit1@test.com", "commit2@test.com"] } })).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (Pagination & Cursors)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests (Pagination & Cursors)", () => {
    beforeEach(() => {
      const usersToInsert = Array.from({ length: 15 }).map((_, i) => ({
        email: `page_user_${String(i).padStart(2, "0")}@test.com`,
        name: `User ${i}`,
        age: 20 + i,
      }));
      db.users.insertMany(usersToInsert);
    });

    it("should handle offset pagination properly", () => {
      const res = db.users.paginate({ page: 2, limit: 5 });

      expect(res.total).toBe(15);
      expect(res.page).toBe(2);
      expect(res.limit).toBe(5);
      expect(res.totalPages).toBe(3);
      expect(res.data.length).toBe(5);
    });

    it("should perform cursor pagination across sequential pages", () => {
      // First page
      const page1 = db.users.cursorPaginate({
        limit: 5,
        cursorColumn: "age",
        tieBreaker: "id",
        orderByDirection: "asc",
      });

      expect(page1.data.length).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page using token
      const page2 = db.users.cursorPaginate({
        cursor: page1.nextCursor!,
        limit: 5,
        cursorColumn: "age",
        tieBreaker: "id",
        orderByDirection: "asc",
      });

      expect(page2.data.length).toBe(5);
      expect(page2.hasMore).toBe(true);

      // Verify no overlap between page 1 and page 2
      const emails1 = page1.data.map((u) => u.email);
      const emails2 = page2.data.map((u) => u.email);
      for (const e of emails1) {
        expect(emails2).not.toContain(e);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    it("should perform high-throughput batch inserts inside a transaction", () => {
      const batchSize = 200;
      const batchData = Array.from({ length: batchSize }).map((_, i) => ({
        email: `batch_${i}@domain.com`,
        name: `Batch User ${i}`,
        age: 20 + (i % 50),
      }));

      const start = performance.now();
      const inserted = db.users.insertMany(batchData);
      const elapsed = performance.now() - start;

      expect(inserted.length).toBe(batchSize);
      expect(db.users.count()).toBe(batchSize);
      expect(elapsed).toBeLessThan(1500); // SQLite in-memory or WAL should complete 200 inserts in < 1.5s
    });

    it("should perform parallel reads concurrently without deadlocks", async () => {
      db.users.insertMany([
        { email: "c1@test.com", name: "C1", age: 20 },
        { email: "c2@test.com", name: "C2", age: 30 },
      ]);

      const readOps = Array.from({ length: 50 }).map(async () => {
        return db.users.count();
      });

      const counts = await Promise.all(readOps);
      expect(counts.every((c) => c === 2)).toBe(true);
    });

    it("should perform backup and verified restore on disk", () => {
      const tmpDir = path.resolve("./storage/test_db_backup");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const fileDbPath = path.join(tmpDir, "source.db");
      const backupPath = path.join(tmpDir, "backup.db");

      try {
        if (fs.existsSync(fileDbPath)) fs.unlinkSync(fileDbPath);
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

        const diskDb = createDatabase({
          path: fileDbPath,
          schema: testSchema,
          forceNew: true,
        });

        diskDb.users.insert({ email: "disk_user@test.com", name: "Disk User" });
        expect(diskDb.users.count()).toBe(1);

        // Perform VACUUM INTO backup
        const backupResult = diskDb.backup(backupPath);
        expect(backupResult.success).toBe(true);
        expect(fs.existsSync(backupPath)).toBe(true);

        // Add more records to source
        diskDb.users.insert({ email: "after_backup@test.com", name: "After Backup" });
        expect(diskDb.users.count()).toBe(2);

        // Restore backup to revert to the 1-record snapshot
        const restoreResult = diskDb.restore(backupPath);
        expect(restoreResult.success).toBe(true);
        expect(diskDb.users.count()).toBe(1);

        diskDb.close();
      } finally {
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});

describe("ORM — JSON column defaults", () => {
  // Each gets its own file: ":memory:" is a single shared registry key, so a
  // second in-memory database closes the first one.
  let n = 0;
  const fresh = (schema: Record<string, unknown>) =>
    createDatabase({
      path: `/tmp/yatta-json-default-${process.pid}-${n++}.db`,
      schema: schema as DatabaseSchema,
      forceNew: true,
    }) as unknown as { table: (name: string) => any };

  it("serializes a structured default instead of coercing it", () => {
    const db = fresh({
      jsonDefaultUsers: {
        id: col.uuid(),
        // String(["user"]) is "user" — the value that used to be written.
        roles: col.json<string[]>().default(["user"]),
        prefs: col.json<Record<string, unknown>>().default({ theme: "dark" }),
        tags: col.json<string[]>().default([]),
      },
    });

    const table = db.table("jsonDefaultUsers");
    const row = table.insert({});

    // A bare "user" string instead of ["user"] is what a coerced default gives.
    expect(row.roles).toEqual(["user"]);
    expect(row.prefs).toEqual({ theme: "dark" });
    expect(row.tags).toEqual([]);

    // It must survive a round trip through storage, not just the insert.
    const read = table.findById(row.id);
    expect(read.roles).toEqual(["user"]);
    expect(read.prefs).toEqual({ theme: "dark" });
  });

  it("keeps scalar defaults unchanged", () => {
    const db = fresh({
      scalarDefaults: {
        id: col.uuid(),
        name: col.text().default("unnamed"),
        count: col.integer().default(0),
        enabled: col.boolean().default(true),
      },
    });

    const row = db.table("scalarDefaults").insert({});
    expect(row.name).toBe("unnamed");
    expect(row.count).toBe(0);
    expect(row.enabled).toBe(true);
  });

  it("preserves a JSON default containing an apostrophe", () => {
    const db = fresh({
      quotedDocs: {
        id: col.uuid(),
        meta: col.json<{ label: string }>().default({ label: "it's fine" }),
      },
    });

    expect(db.table("quotedDocs").insert({}).meta).toEqual({ label: "it's fine" });
  });

  it("overrides the default with an explicit value", () => {
    const db = fresh({
      overrideRoles: {
        id: col.uuid(),
        roles: col.json<string[]>().default(["user"]),
      },
    });

    expect(db.table("overrideRoles").insert({ roles: ["admin"] }).roles).toEqual(["admin"]);
  });
});

describe("ORM — WHERE clause validation", () => {
  let n = 1000;
  const fresh = (schema: Record<string, unknown>) =>
    createDatabase({
      path: `/tmp/yatta-where-${process.pid}-${n++}.db`,
      schema: schema as DatabaseSchema,
      forceNew: true,
    }) as unknown as { table: (name: string) => any };

  it("rejects a misspelled column instead of matching nothing", () => {
    const db = fresh({ typo: { id: col.uuid(), email: col.text() } });
    const table = db.table("typo");
    table.insert({ email: "ada@test.dev" });

    /*
     * SQLite treats an unresolvable double-quoted identifier as a string
     * literal, so `"emial" = 'ada@test.dev'` compared the literal "emial" and
     * matched nothing — a typo that looked like a correct query returning no
     * rows.
     */
    expect(() => table.findMany({ where: { emial: "ada@test.dev" } as never })).toThrow(
      /does not exist on table "typo"/,
    );
  });

  it("rejects an unrecognised operator instead of dropping the filter", () => {
    const db = fresh({ badop: { id: col.uuid(), status: col.text() } });
    const table = db.table("badop");
    table.insert({ status: "active" });
    table.insert({ status: "archived" });

    // The filter used to compile to nothing, so this returned both rows —
    // a query that looked like it filtered and did not.
    expect(() => table.findMany({ where: { status: { statuss: "active" } } as never })).toThrow(
      /Unknown filter operator "statuss"/,
    );
  });

  it("still accepts every supported operator", () => {
    const db = fresh({ ops: { id: col.uuid(), name: col.text(), n: col.integer() } });
    const table = db.table("ops");
    table.insert({ name: "ada", n: 30 });
    table.insert({ name: "alan", n: 41 });

    expect(table.findMany({ where: { name: { eq: "ada" } } })).toHaveLength(1);
    expect(table.findMany({ where: { name: { neq: "ada" } } })).toHaveLength(1);
    expect(table.findMany({ where: { n: { gte: 40 } } })).toHaveLength(1);
    // 30 > 29 and 30 < 40; 41 fails both bounds.
    expect(table.findMany({ where: { n: { gt: 29, lt: 40 } } })).toHaveLength(1);
    expect(table.findMany({ where: { name: { contains: "la" } } })).toHaveLength(1);
    expect(table.findMany({ where: { name: { startsWith: "a" } } })).toHaveLength(2);
    expect(table.findMany({ where: { name: { endsWith: "n" } } })).toHaveLength(1);
    expect(table.findMany({ where: { name: { like: "a%" } } })).toHaveLength(2);
    expect(table.findMany({ where: { name: { in: ["ada", "alan"] } } })).toHaveLength(2);
    expect(table.findMany({ where: { name: { notIn: ["ada"] } } })).toHaveLength(1);
  });

  it("validates columns inside AND/OR groups", () => {
    const db = fresh({ grouped: { id: col.uuid(), email: col.text() } });
    const table = db.table("grouped");
    table.insert({ email: "ada@test.dev" });

    expect(() =>
      table.findMany({ where: { OR: [{ emial: "x" }, { email: "ada@test.dev" }] } as never }),
    ).toThrow(/does not exist/);
  });

  it("lists the available columns so the fix is actionable", () => {
    const db = fresh({ listing: { id: col.uuid(), email: col.text() } });

    try {
      db.table("listing").findMany({ where: { nope: 1 } as never });
      throw new Error("expected a YattaError");
    } catch (err) {
      expect((err as Error).message).toContain("id");
      expect((err as Error).message).toContain("email");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Regressions: each of these was live and silently destructive
// ────────────────────────────────────────────────────────────────────────────

/** Schema for the destructive-guard suite, which sits outside the main describe. */
const guardSchema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    name: col.text(),
    age: col.integer().nullable(),
    isAdmin: col.boolean().default(false),
    preferences: col.json<{ theme: string }>().default({ theme: "light" }),
    role: col.enum(["admin", "member", "guest"]).default("member"),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
  posts: {
    id: col.id(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    title: col.text(),
    content: col.text().default(""),
    published: col.boolean().default(false),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
};

describe("Yatta DB — destructive-operation guards", () => {
  let db: TypedDatabase<typeof guardSchema>;

  beforeEach(() => {
    db = createDatabase({
      path: ":memory:",
      schema: guardSchema,
      relations: {
        users: { posts: { hasMany: "posts", foreignKey: "userId" } },
        posts: { author: { belongsTo: "users", foreignKey: "userId" } },
      },
      forceNew: true,
    });
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  const seed = () => {
    db.users.insert({ email: "a@x.dev", name: "A" });
    db.users.insert({ email: "b@x.dev", name: "B" });
    db.users.insert({ email: "c@x.dev", name: "C" });
  };

  describe("unscoped delete/update", () => {
    it("refuses delete({ where: {} }) and leaves the table intact", () => {
      seed();
      expect(() => db.users.delete({ where: {} })).toThrow(/requires a filter/);
      expect(db.users.count()).toBe(3);
    });

    it("refuses update({ where: {} }) and leaves the rows unchanged", () => {
      seed();
      expect(() =>
        db.users.update({ where: {}, data: { name: "WIPED" } }),
      ).toThrow(/requires a filter/);
      expect(db.users.count()).toBe(3);
      expect(db.users.findFirst({ where: { email: "a@x.dev" } })!.name).toBe("A");
    });

    it("says how to actually mean it", () => {
      expect(() => db.users.delete({ where: {} })).toThrow(/allowAll/);
      expect(() => db.users.update({ where: {}, data: { name: "x" } })).toThrow(
        /allowAll/,
      );
    });

    it("still allows a deliberate wipe via allowAll", () => {
      seed();
      db.users.delete({ where: {}, allowAll: true });
      expect(db.users.count()).toBe(0);
    });

    it("still allows a filtered delete", () => {
      seed();
      const res = db.users.delete({ where: { email: "a@x.dev" } });
      expect(res.changes).toBe(1);
      expect(db.users.count()).toBe(2);
    });
  });

  describe("insert with no fields", () => {
    it("inserts into a table where every column has a default", () => {
      const local = createDatabase({
        path: ":memory:",
        forceNew: true,
        schema: { rows: { n: col.integer().default(7), s: col.text().default("x") } },
      });
      const row = local.rows.insert({} as never);
      expect(row.n).toBe(7);
      expect(row.s).toBe("x");
      local.close();
    });
  });

  describe("close() registry", () => {
    it("evicts the closed database so the next open gets a live handle", () => {
      const path = `/tmp/opencode/db-close-${Date.now()}.db`;
      const first = createDatabase({ path, forceNew: true, schema: guardSchema });
      first.users.insert({ email: "z@x.dev", name: "Z" });
      first.close();

      // Previously handed back the closed handle and threw on first use.
      const second = createDatabase({ path, schema: guardSchema });
      expect(() => second.users.findFirst()).not.toThrow();
      expect(second.users.count()).toBe(1);
      second.close();
    });
  });

  describe("hasOne relations", () => {
    const local = () =>
      createDatabase({
        path: ":memory:",
        forceNew: true,
        schema: {
          users: { id: col.uuid(), name: col.text() },
          profiles: { id: col.id(), userId: col.text(), bio: col.text() },
        },
        relations: {
          users: { profile: { hasOne: "profiles", foreignKey: "userId" } },
        },
      });

    it("resolves the child row", () => {
      const d = local();
      const u = d.users.insert({ name: "Ada" });
      d.profiles.insert({ userId: u.id, bio: "hello" });

      const got = d.users.findFirst({ include: { profile: true } } as never) as any;
      // The foreign key lives on the child, not the parent — reading it off the
      // parent made this permanently null.
      expect(got.profile?.bio).toBe("hello");
      d.close();
    });

    it("returns null when the parent has no child", () => {
      const d = local();
      d.users.insert({ name: "Bob" });
      const got = d.users.findFirst({ include: { profile: true } } as never) as any;
      expect(got.profile).toBeNull();
      d.close();
    });

    it("still resolves belongsTo", () => {
      const user = db.users.insert({ email: "d@x.dev", name: "D" });
      const post = db.posts.insert({ userId: user.id, title: "t" });
      const withAuthor = db.posts.findFirst({ where: { id: post.id }, include: { author: true } } as never) as any;
      expect(withAuthor.author?.email)
        .toBe("d@x.dev");
    });
  });

  describe("paginate projections", () => {
    it("honours select instead of returning every column", () => {
      db.users.insert({ email: "e@x.dev", name: "E" });
      const page = db.users.paginate({ select: ["id", "name"] } as never);

      const keys = Object.keys(page.data[0] as object);
      expect(keys).toContain("name");
      expect(keys).not.toContain("email");
    });
  });

  describe("binary values in a filter", () => {
    it("does not mistake a Buffer for a set of operators", () => {
      expect(() =>
        db.users.findFirst({ where: { email: Buffer.from("x") as never } }),
      ).not.toThrow();
    });

    it("handles a Uint8Array", () => {
      expect(() =>
        db.users.findFirst({ where: { email: new Uint8Array([1, 2]) as never } }),
      ).not.toThrow();
    });
  });

  describe("async transaction callbacks", () => {
    it("refuses one and rolls the write back", () => {
      let threw = false;
      try {
        (db as any).transaction(async () => {
          db.users.insert({ email: "async@x.dev", name: "N" });
          await Promise.resolve();
        });
      } catch {
        threw = true;
      }

      // Previously committed immediately and resolved, leaving the awaited work
      // running outside the transaction with no error raised.
      expect(threw).toBe(true);
      expect(db.users.count()).toBe(0);
    });

    it("still runs a synchronous transaction", () => {
      (db as any).transaction(() => {
        db.users.insert({ email: "sync@x.dev", name: "N" });
        db.users.insert({ email: "sync2@x.dev", name: "N" });
      });
      expect(db.users.count()).toBe(2);
    });

    it("explains why", () => {
      // The message has to name the cause and the way out. A message that only
      // says "invalid" leaves the reader to work out that a bun:sqlite
      // transaction ends at the first await.
      expect(() => (db as any).transaction((async () => {}) as never)).toThrow(
        /needs a sync function/,
      );

      try {
        (db as any).transaction((async () => {}) as never);
      } catch (err) {
        const message = (err as Error).message;
        // Names the mechanism.
        expect(message).toMatch(/transaction saves the work the moment the function returns/);
        // And says what to do instead.
        expect(message).toMatch(/Do the async work first/);
      }
    });
  });

  describe("cursor pagination", () => {
    it("rejects a cursor that decodes to an empty array", () => {
      const cursor = Buffer.from("[]", "utf-8").toString("base64url");
      // Previously built no filter at all, silently returning page one forever.
      expect(() => db.users.cursorPaginate({ limit: 1, cursor })).toThrow(
        /Invalid cursor/,
      );
    });

    it("rejects a cursor whose entries are objects", () => {
      const cursor = Buffer.from('[{"a":1}]', "utf-8").toString("base64url");
      expect(() => db.users.cursorPaginate({ limit: 1, cursor })).toThrow(
        /Invalid cursor/,
      );
    });

    it("paginates normally with a real cursor", () => {
      db.users.insert({ email: "1@x.dev", name: "N" });
      db.users.insert({ email: "2@x.dev", name: "N" });
      db.users.insert({ email: "3@x.dev", name: "N" });

      const first = db.users.cursorPaginate({ limit: 2 });
      expect(first.data).toHaveLength(2);
      expect(first.hasMore).toBe(true);

      const second = db.users.cursorPaginate({
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.data).toHaveLength(1);
    });
  });
});

describe("connect()", () => {
  it("links an already-loaded record", () => {
    const row = { id: 1, ref: { id: 9 } };
    expect(connect(row)).toBe(row);
  });

  it("builds a database when given options", () => {
    const path = `/tmp/opencode/db-connect-${Date.now()}.db`;
    const db = connect({ path, schema: guardSchema });
    expect(typeof (db as any).users.insert).toBe("function");
    (db as unknown as { close(): void }).close();
  });
});

describe("Yatta DB — backup", () => {
  it("creates the destination directory instead of failing opaquely", () => {
    const dir = `/tmp/opencode/db-backup-${Date.now()}/nested`;
    const target = `${dir}/backup.db`;
    // VACUUM INTO will not create intermediate directories, so asking for a
    // path under a folder that does not exist used to fail with
    // "unable to open database" — which says nothing about the real cause.
    expect(fs.existsSync(dir)).toBe(false);

    // No schema needed: backup only needs an open database.
    const local = createDatabase({ path: ":memory:", forceNew: true });
    const result = local.backup(target);

    expect(result.success).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    local.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Yatta DB — range filters on date columns", () => {
  const dateSchema = {
    events: {
      id: col.uuid(),
      name: col.text(),
      startsAt: col.date(),
      dueAt: col.date().nullable(),
      createdAt: col.createdAt(),
    },
  };

  it("compares ISO date strings with gt/gte/lt/lte", () => {
    const local = createDatabase({
      path: `/tmp/opencode/db-dates-${Date.now()}.db`,
      schema: dateSchema,
      forceNew: true,
    });

    local.events.insert({ name: "early", startsAt: "2026-01-10T00:00:00.000Z", dueAt: null });
    local.events.insert({ name: "middle", startsAt: "2026-02-15T00:00:00.000Z", dueAt: null });
    local.events.insert({ name: "late", startsAt: "2026-03-20T00:00:00.000Z", dueAt: null });

    // SQLite compares TEXT by storage class, and ISO-8601 sorts
    // lexicographically, so these are true date ranges rather than string
    // prefixes.
    const inFebruary = local.events.findMany({
      where: { startsAt: { gte: "2026-02-01T00:00:00.000Z", lte: "2026-02-28T23:59:59.999Z" } },
    });
    expect(inFebruary.map((e) => e.name)).toEqual(["middle"]);

    const afterFebruary = local.events.findMany({
      where: { startsAt: { gt: "2026-02-28T23:59:59.999Z" } },
    });
    expect(afterFebruary.map((e) => e.name)).toEqual(["late"]);

    const window = local.events.findMany({
      where: { startsAt: { gte: "2026-01-01T00:00:00.000Z", lt: "2026-03-01T00:00:00.000Z" } },
    });
    expect(window.map((e) => e.name)).toEqual(["early", "middle"]);

    local.close();
  });

  it("excludes nulls from a range without an explicit isNull", () => {
    const local = createDatabase({
      path: `/tmp/opencode/db-dates-null-${Date.now()}.db`,
      schema: dateSchema,
      forceNew: true,
    });

    local.events.insert({ name: "dated", startsAt: "2026-01-10T00:00:00.000Z", dueAt: null });
    local.events.insert({ name: "undated", startsAt: "2026-01-11T00:00:00.000Z", dueAt: null });

    local.events.updateById(
      local.events.findFirst({ where: { name: "dated" } })!.id,
      { dueAt: "2026-02-01T00:00:00.000Z" },
    );

    const overdue = local.events.findMany({ where: { dueAt: { lt: "2026-01-15T00:00:00.000Z" } } });

    // NULL fails every comparison, so an undated task is not "overdue" — which
    // is the correct reading, and worth pinning so a change to the compiler
    // that mapped IS NULL into the range cannot make undated tasks look late.
    expect(overdue.map((e) => e.name)).toEqual([]);

    const dated = local.events.findMany({ where: { dueAt: { isNull: true } } });
    expect(dated.map((e) => e.name)).toEqual(["undated"]);

    local.close();
  });
});

describe("Yatta DB — SET NULL implies a nullable column", () => {
  it("does not build a NOT NULL column that SET NULL could never satisfy", () => {
    const schema = {
      authors: {
        id: col.uuid(),
        name: col.text(),
        createdAt: col.createdAt(),
      },
      books: {
        id: col.uuid(),
        title: col.text(),
        // A book can outlive its author, with the link cleared.
        authorId: col.text().references("authors.id", { onDelete: "SET NULL" }),
        createdAt: col.createdAt(),
      },
      // A post cannot outlive its author, so this one stays required.
      posts: {
        id: col.uuid(),
        authorId: col.text().references("authors.id", { onDelete: "CASCADE" }),
        createdAt: col.createdAt(),
      },
    };

    const local = createDatabase({
      path: `/tmp/opencode/db-setnull-${Date.now()}.db`,
      schema,
      forceNew: true,
    });

    const author = local.authors.insert({ name: "Ursula" });
    local.books.insert({ title: "A Wizard of Earthsea", authorId: author.id });
    local.posts.insert({ authorId: author.id });

    // Previously this raised "Cannot set NULL on NOT NULL column authorId" from
    // inside SQLite — the declared referential action contradicting the
    // column's own NOT NULL.
    local.authors.deleteById(author.id);

    expect(local.books.count()).toBe(1);
    expect(local.books.findFirst({ where: {} })!.authorId).toBeNull();
    // CASCADE is unaffected: the dependent row goes with its parent.
    expect(local.posts.count()).toBe(0);

    local.close();
  });
});

describe("Yatta DB — skip without take", () => {
  const pagedSchema = {
    items: {
      id: col.id(),
      name: col.text(),
      createdAt: col.createdAt(),
    },
  };

  it("paginates with skip alone instead of emitting invalid SQL", () => {
    const local = createDatabase({
      path: `/tmp/opencode/db-skip-${Date.now()}.db`,
      schema: pagedSchema,
      forceNew: true,
    });

    for (const name of ["a", "b", "c", "d", "e"]) local.items.insert({ name });

    // SQLite accepts OFFSET only inside `LIMIT … OFFSET …`, so `skip` on its
    // own used to compile to `SELECT * FROM "items" OFFSET 2;` and throw a
    // syntax error near "OFFSET".
    const skipped = local.items.findMany({ skip: 2, orderBy: { id: "asc" } });
    expect(skipped.map((i) => i.name)).toEqual(["c", "d", "e"]);

    // The builder path reached the same broken SQL.
    const viaBuilder = local.items.where({}).skip(3).all();
    expect(viaBuilder.map((i) => i.name)).toEqual(["d", "e"]);

    // And skip=0 must stay valid.
    expect(local.items.findMany({ skip: 0 }).length).toBe(5);

    local.close();
  });
});

describe("Yatta DB — timestamp columns hold one format", () => {
  const tsSchema = {
    events: {
      id: col.id(),
      name: col.text(),
      createdAt: col.createdAt(),
      updatedAt: col.updatedAt(),
    },
  };

  it("writes the same format on insert and on update", () => {
    const local = createDatabase({
      path: `/tmp/opencode/db-ts-${Date.now()}.db`,
      schema: tsSchema,
      forceNew: true,
    });

    const inserted = local.events.insert({ name: "insert-only" });
    const touched = local.events.insert({ name: "touched" });
    // Only this row gets its updatedAt rewritten, which is what used to give
    // the column two different formats.
    local.events.updateById(touched.id, { name: "touched-again" });

    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    expect(inserted.createdAt).toMatch(iso);
    expect(touched.createdAt).toMatch(iso);
    expect(inserted.updatedAt).toMatch(iso);

    const rows = local.events.findMany({ orderBy: { id: "asc" } });
    for (const row of rows) {
      expect(row.createdAt).toMatch(iso);
      expect(row.updatedAt).toMatch(iso);
    }

    local.close();
  });

  it("sorts and range-filters correctly across freshly written rows", () => {
    const local = createDatabase({
      path: `/tmp/opencode/db-ts2-${Date.now()}.db`,
      schema: tsSchema,
      forceNew: true,
    });

    // Explicit values a day apart, because two default-inserted rows can land in
    // the same millisecond and the window would be empty for the right reason.
    local.events.insert({ name: "older", createdAt: "2026-01-01T00:00:00.000Z" });
    local.events.insert({ name: "newer", createdAt: "2026-01-02T00:00:00.000Z" });

    // With a bare CURRENT_TIMESTAMP default, these never-updated rows carried a
    // space instead of a T ("2026-01-02 00:00:00"), and ' ' < 'T' put them
    // *before* the ISO boundary — so a `gte` on the 2nd returned nothing.
    const inWindow = local.events.findMany({
      where: { createdAt: { gte: "2026-01-02T00:00:00.000Z" } },
      orderBy: { createdAt: "asc" },
    });

    expect(inWindow.map((e) => e.name)).toEqual(["newer"]);

    // Descending order must agree with the explicit range.
    const descending = local.events.findMany({ orderBy: { createdAt: "desc" } });
    expect(descending[0]!.createdAt >= descending[1]!.createdAt).toBe(true);

    local.close();
  });
});

describe("Yatta DB — migrations", () => {
  const migSchema = {
    notes: {
      id: col.id(),
      body: col.text(),
      createdAt: col.createdAt(),
    },
  };

  it("awaits an async migration and records it once", async () => {
    const path = `/tmp/opencode/db-mig-${Date.now()}.db`;
    const local = createDatabase({ path, schema: migSchema, forceNew: true });

    let ran = 0;

    const migrations = [
      {
        name: "add-flag",
        up: async (db: any) => {
          await Bun.sleep(10);
          db.exec("ALTER TABLE notes ADD COLUMN flag INTEGER DEFAULT 0");
          ran++;
        },
        down: async () => {},
      },
    ];

    const first = await local.migrate(migrations);
    expect(first.applied).toEqual(["add-flag"]);
    // The awaited work finished before migrate() resolved. Previously the
    // transaction committed the moment the callback returned, so this could be
    // 0 — with the migration still reported as applied.
    expect(ran).toBe(1);

    // Running again is a no-op, because the marker row exists.
    const second = await local.migrate(migrations);
    expect(second.applied).toEqual([]);
    expect(ran).toBe(1);

    local.close();
  });

  it("surfaces a failure from an async migration instead of reporting success", async () => {
    const path = `/tmp/opencode/db-migfail-${Date.now()}.db`;
    const local = createDatabase({ path, schema: migSchema, forceNew: true });

    let markerInserted = false;

    await expect(
      local.migrate([
        {
          name: "boom",
          up: async () => {
            await Bun.sleep(5);
            throw new Error("migration failed");
          },
          down: async () => {},
        },
      ]),
    ).rejects.toThrow(/migration failed/);

    const row = local.rawGet<{ c: number }>(
      "SELECT COUNT(*) AS c FROM _yatta_migrations WHERE name = 'boom'",
    );
    markerInserted = (row?.c ?? 0) > 0;

    // A migration that threw must not be recorded as applied, or the next run
    // skips it and the schema is permanently wrong.
    expect(markerInserted).toBe(false);

    local.close();
  });

  it("rolls a failing synchronous migration back", async () => {
    const path = `/tmp/opencode/db-migsync-${Date.now()}.db`;
    const local = createDatabase({ path, schema: migSchema, forceNew: true });

    await expect(
      local.migrate([
        {
          name: "sync-boom",
          up: (db: any) => {
            db.exec("ALTER TABLE notes ADD COLUMN half_done INTEGER");
            throw new Error("sync failure");
          },
          down: () => {},
        },
      ]),
    ).rejects.toThrow(/sync failure/);

    const columns = await local.rawAll<{ name: string }>("PRAGMA table_info(notes)");
    expect(columns.some((c) => c.name === "half_done")).toBe(false);

    local.close();
  });
});
