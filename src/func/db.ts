import { col, createDatabase, connect } from "../types/db";
import { loadEnv } from "./env";

export const schema = {
  users: {
    id: col.uuid(),
    email: col.text().unique(),
    passwordHash: col.text().nullable(),
    roles: col.json<string[]>().default(["user"]),
    emailVerified: col.boolean().default(false),
    twoFactorEnabled: col.boolean().default(false),
    encryptedTwoFactorSecret: col.text().nullable(),
    twoFactorRecoveryCodes: col.json<string[]>().nullable(),
    credentialVersion: col.integer().default(1),
    metadata: col.json<Record<string, unknown>>().nullable(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
  sessions: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    sessionTokenHash: col.text().unique(),
    refreshTokenHash: col.text().nullable(),
    expiresAt: col.date(),
    refreshVersion: col.integer().default(0),
    userAgent: col.text().nullable(),
    ip: col.text().nullable(),
    lastSeenAt: col.createdAt(),
    lastAuthenticatedAt: col.createdAt(),
    createdAt: col.createdAt(),
  },
  identities: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    provider: col.text(),
    providerAccountId: col.text(),
    email: col.text().nullable(),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
  verificationTokens: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    tokenHash: col.text().unique(),
    type: col.text(),
    expiresAt: col.date(),
  },
  passkeys: {
    id: col.text().primaryKey(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    name: col.text().default("Passkey"),
    publicKey: col.text(), // stored as base64 string
    counter: col.integer().default(0),
    transports: col.json<string[]>().nullable(),
    createdAt: col.createdAt(),
    lastUsedAt: col.date().nullable(),
  },
  apiKeys: {
    id: col.uuid(),
    userId: col.text().references("users.id", { onDelete: "CASCADE" }),
    name: col.text(),
    keyHash: col.text().unique(),
    prefix: col.text(),
    scopes: col.json<string[]>().default(["*"]),
    expiresAt: col.date().nullable(),
    lastUsedAt: col.date().nullable(),
    createdAt: col.createdAt(),
  },
  posts: {
    id: col.id(),
    title: col.text(),
    content: col.text().default(""),
    published: col.boolean().default(false),
    authorId: col.text().belongsTo("users", { onDelete: "CASCADE" }),
    createdAt: col.createdAt(),
    updatedAt: col.updatedAt(),
  },
};

declare module "../types/db" {
  interface Register {
    schema: typeof schema;
  }
}

export const db = createDatabase({
  // DATABASE_URL takes precedence so deployments (and cluster members) can
  // point at a shared volume or managed SQLite file.
  path: loadEnv().DATABASE_URL || "Database/app.db",
  schema,
});

export { connect };
