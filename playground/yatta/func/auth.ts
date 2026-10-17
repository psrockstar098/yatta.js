// yatta/func/auth.ts
//
// Auth persisted through your own SQLite database. Handles Argon2id
// passwords, rotating JWTs, TOTP 2FA, WebAuthn passkeys, and API keys.
import {
  createAuth,
  type AuthStore,
  type AuthUser,
  type AuthSession,
  type AuthIdentity,
  type AuthVerificationToken,
  type AuthPasskeyCredential,
  type AuthApiKey,
} from "yatta.js/auth";
import { db } from "./db";
import { mailer } from "./mail";
import { peerAddress } from "./peer";

export class SQLiteAuthStore implements AuthStore {
  async findUserById(id: string): Promise<AuthUser | null> {
    const u = db.users.findById(id);
    return u ? this.toUser(u) : null;
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const u = db.users.findFirst({ where: { email: email.toLowerCase().trim() } });
    return u ? this.toUser(u) : null;
  }

  async createUser(
    data: Omit<AuthUser, "createdAt" | "updatedAt">,
  ): Promise<AuthUser> {
    const row = db.users.insert({
      ...data,
      email: data.email.toLowerCase().trim(),
    } as any);
    return this.toUser(row);
  }

  async updateUser(id: string, updates: Partial<AuthUser>): Promise<AuthUser> {
    const row = db.users.updateById(id, updates as any);
    if (!row) throw new Error("User not found");
    return this.toUser(row);
  }

  async deleteUser(id: string): Promise<void> {
    db.users.deleteById(id);
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    return this.toSession(db.sessions.insert(session as any));
  }

  async findSessionById(id: string): Promise<AuthSession | null> {
    const s = db.sessions.findById(id);
    if (!s || new Date(s.expiresAt) < new Date()) return null;
    return this.toSession(s);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const s = db.sessions.findFirst({ where: { sessionTokenHash: tokenHash } });
    if (!s || new Date(s.expiresAt) < new Date()) return null;
    return this.toSession(s);
  }

  async listSessionsByUserId(userId: string): Promise<AuthSession[]> {
    const now = new Date();
    return db.sessions
      .findMany({ where: { userId } })
      .filter((r) => new Date(r.expiresAt) > now)
      .map((r) => this.toSession(r));
  }

  async updateSession(id: string, updates: Partial<AuthSession>): Promise<AuthSession> {
    const row = db.sessions.updateById(id, updates as any);
    if (!row) throw new Error("Session not found");
    return this.toSession(row);
  }

  async deleteSession(id: string): Promise<void> {
    db.sessions.deleteById(id);
  }

  async deleteSessionsByUserId(userId: string): Promise<void> {
    db.sessions.delete({ where: { userId } });
  }

  async findIdentity(provider: string, providerAccountId: string): Promise<AuthIdentity | null> {
    const i = db.identities.findFirst({ where: { provider, providerAccountId } });
    return i ? this.toIdentity(i) : null;
  }

  async listIdentitiesByUserId(userId: string): Promise<AuthIdentity[]> {
    return db.identities.findMany({ where: { userId } }).map((r) => this.toIdentity(r));
  }

  async createIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    return this.toIdentity(db.identities.insert(identity as any));
  }

  async deleteIdentity(id: string): Promise<void> {
    db.identities.deleteById(id);
  }

  async createToken(token: AuthVerificationToken): Promise<AuthVerificationToken> {
    return this.toToken(db.verificationTokens.insert(token as any));
  }

  async findTokenByHash(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null> {
    const t = db.verificationTokens.findFirst({ where: { tokenHash, type } });
    if (!t || new Date(t.expiresAt) < new Date()) return null;
    return this.toToken(t);
  }

  async consumeToken(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null> {
    /*
     * Read and delete, in one place.
     *
     * AuthStore requires this, and the template did not implement it, so the
     * scaffolded project did not typecheck. It matters beyond the type: verification
     * links and magic links are redeemed through here, and a store that returns the
     * row without removing it lets one link be used twice.
     */
    const t = db.verificationTokens.findFirst({ where: { tokenHash, type } });
    if (!t || new Date(t.expiresAt) < new Date()) return null;

    db.verificationTokens.deleteById(t.id);
    return this.toToken(t);
  }

  async deleteToken(id: string): Promise<void> {
    db.verificationTokens.deleteById(id);
  }

  async deleteTokensByUserId(
    userId: string,
    type?: AuthVerificationToken["type"],
  ): Promise<void> {
    if (type) db.verificationTokens.delete({ where: { userId, type } });
    else db.verificationTokens.delete({ where: { userId } });
  }

  async savePasskey(cred: AuthPasskeyCredential): Promise<void> {
    db.passkeys.upsert({
      where: { id: cred.id },
      create: {
        id: cred.id,
        userId: cred.userId,
        name: cred.name ?? "Passkey",
        publicKey: Buffer.from(cred.publicKey).toString("base64"),
        counter: cred.counter,
        transports: cred.transports as any,
        createdAt: cred.createdAt.toISOString(),
      },
      update: {
        counter: cred.counter,
        lastUsedAt: cred.lastUsedAt?.toISOString(),
      },
    });
  }

  async findPasskeyById(id: string): Promise<AuthPasskeyCredential | null> {
    const p = db.passkeys.findById(id);
    return p ? this.toPasskey(p) : null;
  }

  async listPasskeysByUserId(userId: string): Promise<AuthPasskeyCredential[]> {
    return db.passkeys.findMany({ where: { userId } }).map((p) => this.toPasskey(p));
  }

  async updatePasskey(id: string, updates: Partial<AuthPasskeyCredential>): Promise<void> {
    const patch: any = { ...updates };
    if (updates.publicKey) patch.publicKey = Buffer.from(updates.publicKey).toString("base64");
    if (updates.lastUsedAt) patch.lastUsedAt = updates.lastUsedAt.toISOString();
    db.passkeys.updateById(id, patch);
  }

  async deletePasskey(id: string): Promise<void> {
    db.passkeys.deleteById(id);
  }

  async createApiKey(key: AuthApiKey): Promise<AuthApiKey> {
    return this.toApiKey(db.apiKeys.insert(key as any));
  }

  async findApiKeyByHash(keyHash: string): Promise<AuthApiKey | null> {
    const k = db.apiKeys.findFirst({ where: { keyHash } });
    return k ? this.toApiKey(k) : null;
  }

  async listApiKeysByUserId(userId: string): Promise<AuthApiKey[]> {
    return db.apiKeys.findMany({ where: { userId } }).map((k) => this.toApiKey(k));
  }

  async updateApiKey(id: string, updates: Partial<AuthApiKey>): Promise<void> {
    db.apiKeys.updateById(id, updates as any);
  }

  async deleteApiKey(id: string): Promise<void> {
    db.apiKeys.deleteById(id);
  }

  // ── Mappers ───────────────────────────────────────────────────────────

  private toUser(row: any): AuthUser {
    return {
      ...row,
      emailVerified: Boolean(row.emailVerified),
      twoFactorEnabled: Boolean(row.twoFactorEnabled),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private toSession(row: any): AuthSession {
    return {
      ...row,
      expiresAt: new Date(row.expiresAt),
      lastSeenAt: new Date(row.lastSeenAt),
      lastAuthenticatedAt: new Date(row.lastAuthenticatedAt),
      createdAt: new Date(row.createdAt),
    };
  }

  private toIdentity(row: any): AuthIdentity {
    return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
  }

  private toToken(row: any): AuthVerificationToken {
    return { ...row, expiresAt: new Date(row.expiresAt) };
  }

  private toPasskey(row: any): AuthPasskeyCredential {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name ?? undefined,
      publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64")),
      counter: row.counter ?? 0,
      transports: row.transports ?? undefined,
      createdAt: new Date(row.createdAt),
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : undefined,
    };
  }

  private toApiKey(row: any): AuthApiKey {
    return {
      ...row,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : undefined,
      createdAt: new Date(row.createdAt),
    };
  }
}

export const auth = createAuth({
  secret: process.env.AUTH_SECRET || "change-me-to-a-real-32-char-secret",
  store: new SQLiteAuthStore(),
  email: {
    mailer,
    appUrl: process.env.APP_URL || "http://localhost:4000",
  },
  passkeys: {
    rpName: "Yatta App",
    rpID: process.env.RP_ID || "localhost",
    origin: process.env.APP_URL || "http://localhost:4000",
  },
  security: {
    // Off in production, on everywhere else. Without this a fresh project can
    // sign a user up but can never sign them in: signUp returns
    // emailVerificationRequired, no session is issued, and the verification
    // email goes nowhere because the mailer has no real transport. Turn it on
    // in production once you have a working mailer.
    allowUnverifiedSession: process.env.NODE_ENV === "production" ? false : true,

    /*
     * Without this every request is seen as 127.0.0.1 and the per-IP rate limits
     * become one global limit — so one attacker guessing passwords locks out every
     * legitimate user at once. The framework warns at boot when it is missing, but a
     * warning is not a default, and this file is what a new project ships with.
     *
     * The address is captured in main.ts at the edge, because that is the only place
     * Bun exposes it. See func/peer.ts.
     */
    getClientIp: (req) => peerAddress(req),
  },
});
