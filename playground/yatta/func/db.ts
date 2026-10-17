// yatta/func/db.ts
//
// The ORM. Edit the schema to match your app; the table types are inferred.
import { col, createDatabase, connect } from "yatta.js/db";

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
    publicKey: col.text(),
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
};

// This makes db.users, db.sessions, … fully typed.
declare module "yatta.js/db" {
  interface Register {
    schema: typeof schema;
  }
}

export const db = createDatabase({
  // WAL + busy_timeout are applied on open, so cluster mode is safe.
  path: process.env.DATABASE_URL || "Database/app.db",
  schema,
});

export { connect };
