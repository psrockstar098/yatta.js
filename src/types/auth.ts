/**
 * ============================================================================
 *  YATTA AUTH — Enterprise Security & Authentication Engine for Bun
 * ============================================================================
 */

import crypto from "node:crypto";
import { authenticator } from "otplib";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { Mail, type YattaMailer, type EmailAddress } from "./mail";

// ──────────────────────────────────────────────────────────────────────────
// 0. Errors
// ──────────────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class UnauthorizedError extends AuthError {
  constructor(message = "Authentication required") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = "Forbidden: Insufficient permissions") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export class RateLimitError extends AuthError {
  constructor(message = "Too many attempts. Please try again later.") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

export class SecurityReauthRequiredError extends AuthError {
  constructor(
    message = "Recent authentication required for this sensitive action",
  ) {
    super(message, 403);
    this.name = "SecurityReauthRequiredError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Models & Types
// ──────────────────────────────────────────────────────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  roles: string[];
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUser extends PublicUser {
  passwordHash?: string;
  encryptedTwoFactorSecret?: string | null;
  twoFactorRecoveryCodes?: string[] | null;
  lastMfaStep?: number;
  credentialVersion: number;
}

export interface PublicSession {
  id: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  lastAuthenticatedAt: Date;
  createdAt: Date;
  userAgent?: string;
  ip?: string;
  deviceId?: string;
  deviceName?: string;
}

export interface AuthSession extends PublicSession {
  sessionTokenHash: string;
  refreshTokenHash?: string;
  previousRefreshTokenHash?: string;
  rotatedAt?: Date;
  refreshVersion: number;
}

export interface AuthIdentity {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthVerificationToken {
  id: string;
  userId: string;
  tokenHash: string;
  type: "email_verification" | "password_reset" | "magic_link";
  expiresAt: Date;
}

export interface AuthPasskeyCredential {
  id: string;
  userId: string;
  name?: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransport[];
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface AuthApiKey {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
}

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface AuthMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export interface AuthChallenge {
  id: string;
  /**
   * The lookup key, and by convention also the payload.
   *
   * The store indexes on this field, so it must be the value the caller will
   * look up later. WebAuthn satisfies both at once, because the challenge string
   * *is* the thing being verified.
   */
  challenge: string;
  type: "registration" | "authentication";
  userId?: string;
  /**
   * Extra payload, for a challenge whose key is not its own payload.
   *
   * MFA enrolment is the case that needs it: the caller to look up later is
   * known only by user id, while the value worth keeping is the TOTP seed. The
   * seed lives here (encrypted) and the key is derived from the user id.
   */
  data?: string;
  expiresAt: Date;
  ip?: string;
}

/**
 * Challenge-store key for a user's pending MFA enrolment.
 *
 * Prefixed so it can never collide with a base64url WebAuthn challenge, and
 * built from the user id so `confirmSetup` — which knows nothing else — can find
 * it. Storing the encrypted seed as the key instead meant the lookup never
 * matched and 2FA could never be turned on.
 */
export function mfaSetupKey(userId: string): string {
  return `mfa-setup:${userId}`;
}

export interface AuthEvent {
  id: string;
  userId?: string;
  type: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResult {
  user: PublicUser;
  session: PublicSession;
  tokens: TokenPair;
  cookies: string[];
  toResponse(body?: Record<string, unknown>, status?: number): Response;
}

export interface PasswordPolicyConfig {
  minLength?: number;
  maxLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireNumbers?: boolean;
  requireSymbols?: boolean;
}

export interface SessionConfig {
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  sessionTtlSec?: number;
  activityThrottleSec?: number;
  autoRefreshOnCookieAuth?: boolean;
}

export interface CookieOptions {
  sessionCookieName?: string;
  refreshCookieName?: string;
  csrfCookieName?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export interface SecurityConfig {
  /**
   * Trust `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` for the client IP.
   *
   * Only enable when a proxy you control sets them and **strips any incoming copy**.
   * Otherwise a client can send the header itself and rotate apparent IPs to walk
   * straight past the rate limiter.
   */
  trustProxy?: boolean;
  /**
   * How many proxies sit in front of this process and are trusted to append to
   * `x-forwarded-for`.
   *
   * Defaults to 1. `x-forwarded-for` reads `client, proxy1, proxy2…`, and the client
   * writes the leftmost entry — so the client IP is found by counting back from the
   * right, past every proxy you trust. One proxy means the second-to-last entry; a
   * CDN plus a load balancer means the third-to-last.
   *
   * Getting this wrong in the permissive direction is a rate-limit bypass, and in
   * the strict direction every client appears to be your proxy. Set it from your
   * topology rather than guessing.
   */
  trustedProxyCount?: number;
  /**
   * Resolve the peer address of a request.
   *
   * Bun does not expose it on `Request`; read it from the server instead:
   * `getClientIp: (req) => server.requestIP(req)?.address`. Without this, every
   * client is seen as 127.0.0.1 and all per-IP rate limits become global.
   */
  getClientIp?: (req: Request) => string | undefined;
  recentAuthWindowSec?: number;
  allowUnverifiedSession?: boolean;
  preventAccountEnumeration?: boolean;
  encryptionKey?: string;
}

export interface RateLimitConfig {
  enabled?: boolean;
  login?: { maxAttempts: number; windowSec: number; lockoutSec: number };
  signup?: { maxAttempts: number; windowSec: number; lockoutSec: number };
  passwordReset?: {
    maxAttempts: number;
    windowSec: number;
    lockoutSec: number;
  };
  magicLink?: { maxAttempts: number; windowSec: number; lockoutSec: number };
  passkey?: { maxAttempts: number; windowSec: number; lockoutSec: number };
}

export interface AuthEmailTemplateData {
  email: string;
  link: string;
  token: string;
}

export interface AuthEmailConfig {
  from?: EmailAddress;
  appUrl?: string;
  mailer?: YattaMailer;
  resendCooldownSec?: number;
  templates?: {
    verification?: (data: AuthEmailTemplateData) => {
      subject: string;
      html: string;
      text?: string;
    };
    passwordReset?: (data: AuthEmailTemplateData) => {
      subject: string;
      html: string;
      text?: string;
    };
    magicLink?: (data: AuthEmailTemplateData) => {
      subject: string;
      html: string;
      text?: string;
    };
  };
}

export type RoleDefinitions = Record<
  string,
  string[] | { can: string[]; inherits?: string[] }
>;

export interface AuthConfig {
  secret: string;
  store?: AuthStore;
  challengeStore?: AuthChallengeStore;
  /** Two-factor settings. Applies to every sign-in route, not just passwords. */
  mfa?: {
    /**
     * Lifetime of a pending second-factor ticket, in seconds.
     *
     * Defaults to 300. The ticket authorises nothing by itself, but it is half of a
     * two-factor check, so a longer life is a wider window for a captured value.
     */
    challengeTtlSec?: number;
  };
  rateLimitStore?: RateLimitStore;
  auditStore?: AuthAuditStore;
  session?: SessionConfig;
  passwordPolicy?: PasswordPolicyConfig;
  security?: SecurityConfig;
  rateLimits?: RateLimitConfig;
  cookies?: CookieOptions;
  email?: AuthEmailConfig;
  passkeys?: {
    rpName: string;
    rpID: string;
    origin: string;
  };
  roles?: RoleDefinitions;
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Storage Adapters
// ──────────────────────────────────────────────────────────────────────────

export interface AuthStore {
  findUserById(id: string): Promise<AuthUser | null>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  createUser(
    user: Omit<AuthUser, "createdAt" | "updatedAt">,
  ): Promise<AuthUser>;
  updateUser(id: string, updates: Partial<AuthUser>): Promise<AuthUser>;
  deleteUser(id: string): Promise<void>;

  createSession(session: AuthSession): Promise<AuthSession>;
  findSessionById(id: string): Promise<AuthSession | null>;
  findSessionByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  listSessionsByUserId(userId: string): Promise<AuthSession[]>;
  updateSession(
    id: string,
    updates: Partial<AuthSession>,
  ): Promise<AuthSession>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsByUserId(userId: string): Promise<void>;

  findIdentity(
    provider: string,
    providerAccountId: string,
  ): Promise<AuthIdentity | null>;
  listIdentitiesByUserId(userId: string): Promise<AuthIdentity[]>;
  createIdentity(identity: AuthIdentity): Promise<AuthIdentity>;
  deleteIdentity(id: string): Promise<void>;

  createToken(token: AuthVerificationToken): Promise<AuthVerificationToken>;
  findTokenByHash(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null>;
  consumeToken(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ): Promise<AuthVerificationToken | null>;
  deleteToken(id: string): Promise<void>;
  deleteTokensByUserId(
    userId: string,
    type?: AuthVerificationToken["type"],
  ): Promise<void>;

  savePasskey(cred: AuthPasskeyCredential): Promise<void>;
  findPasskeyById(id: string): Promise<AuthPasskeyCredential | null>;
  listPasskeysByUserId(userId: string): Promise<AuthPasskeyCredential[]>;
  updatePasskey(
    id: string,
    updates: Partial<AuthPasskeyCredential>,
  ): Promise<void>;
  deletePasskey(id: string): Promise<void>;

  createApiKey(key: AuthApiKey): Promise<AuthApiKey>;
  findApiKeyByHash(keyHash: string): Promise<AuthApiKey | null>;
  listApiKeysByUserId(userId: string): Promise<AuthApiKey[]>;
  updateApiKey(id: string, updates: Partial<AuthApiKey>): Promise<void>;
  deleteApiKey(id: string): Promise<void>;

  createOrganization?(org: AuthOrganization): Promise<AuthOrganization>;
  findOrganizationById?(id: string): Promise<AuthOrganization | null>;
  findOrganizationBySlug?(slug: string): Promise<AuthOrganization | null>;
  createMembership?(membership: AuthMembership): Promise<AuthMembership>;
  findMembership?(
    orgId: string,
    userId: string,
  ): Promise<AuthMembership | null>;
  listMembershipsByUserId?(userId: string): Promise<AuthMembership[]>;
}

export interface AuthChallengeStore {
  set(challenge: AuthChallenge): Promise<void>;
  get(challengeString: string): Promise<AuthChallenge | null>;
  delete(challengeString: string): Promise<void>;

  /**
   * Reads and removes a challenge in one step.
   *
   * Optional, and the caller must fall back to `get` + `delete` when it is absent.
   * That fallback is racy across workers — two callers can both pass the `get` — so
   * anything spent on its way in (an MFA ticket, a one-time link) needs this to be a
   * real atomic take rather than a read followed by a hope.
   */
  consume?(challengeString: string): Promise<AuthChallenge | null>;
}

export interface RateLimitStore {
  get(key: string): Promise<{ hits: number[]; lockoutUntil?: number } | null>;
  set(
    key: string,
    data: { hits: number[]; lockoutUntil?: number },
    ttlSec: number,
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuthAuditStore {
  record(event: AuthEvent): Promise<void>;
  listByUser(userId: string, limit?: number): Promise<AuthEvent[]>;
}

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, AuthUser>();
  private sessions = new Map<string, AuthSession>();
  private identities = new Map<string, AuthIdentity>();
  private tokens = new Map<string, AuthVerificationToken>();
  private passkeys = new Map<string, AuthPasskeyCredential>();
  private apiKeys = new Map<string, AuthApiKey>();

  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async findUserByEmail(email: string) {
    return (
      [...this.users.values()].find(
        (u) => u.email.toLowerCase() === email.toLowerCase(),
      ) ?? null
    );
  }
  async createUser(data: Omit<AuthUser, "createdAt" | "updatedAt">) {
    const user: AuthUser = {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }
  async updateUser(id: string, updates: Partial<AuthUser>) {
    const user = this.users.get(id);
    if (!user) throw new AuthError("User not found", 404);
    const updated = { ...user, ...updates, updatedAt: new Date() };
    this.users.set(id, updated);
    return updated;
  }
  async deleteUser(id: string) {
    this.users.delete(id);
    await this.deleteSessionsByUserId(id);
  }

  async createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
    return session;
  }
  async findSessionById(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.expiresAt < new Date()) return null;
    return s;
  }
  async findSessionByTokenHash(tokenHash: string) {
    const s = [...this.sessions.values()].find(
      (sess) => sess.sessionTokenHash === tokenHash,
    );
    if (!s || s.expiresAt < new Date()) return null;
    return s;
  }
  async listSessionsByUserId(userId: string) {
    const now = new Date();
    return [...this.sessions.values()].filter(
      (s) => s.userId === userId && s.expiresAt > now,
    );
  }
  async updateSession(id: string, updates: Partial<AuthSession>) {
    const s = this.sessions.get(id);
    if (!s) throw new AuthError("Session not found", 404);
    const updated = { ...s, ...updates };
    this.sessions.set(id, updated);
    return updated;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async deleteSessionsByUserId(userId: string) {
    for (const [id, s] of this.sessions.entries()) {
      if (s.userId === userId) this.sessions.delete(id);
    }
  }

  async findIdentity(provider: string, providerAccountId: string) {
    return (
      [...this.identities.values()].find(
        (i) =>
          i.provider === provider && i.providerAccountId === providerAccountId,
      ) ?? null
    );
  }
  async listIdentitiesByUserId(userId: string) {
    return [...this.identities.values()].filter((i) => i.userId === userId);
  }
  async createIdentity(identity: AuthIdentity) {
    this.identities.set(identity.id, identity);
    return identity;
  }
  async deleteIdentity(id: string) {
    this.identities.delete(id);
  }

  async createToken(token: AuthVerificationToken) {
    this.tokens.set(token.id, token);
    return token;
  }
  async findTokenByHash(
    tokenHash: string,
    type: AuthVerificationToken["type"],
  ) {
    return (
      [...this.tokens.values()].find(
        (t) =>
          t.tokenHash === tokenHash &&
          t.type === type &&
          t.expiresAt > new Date(),
      ) ?? null
    );
  }
  async consumeToken(tokenHash: string, type: AuthVerificationToken["type"]) {
    const record = await this.findTokenByHash(tokenHash, type);
    if (record) {
      this.tokens.delete(record.id);
    }
    return record;
  }
  async deleteToken(id: string) {
    this.tokens.delete(id);
  }
  async deleteTokensByUserId(
    userId: string,
    type?: AuthVerificationToken["type"],
  ) {
    for (const [id, t] of this.tokens.entries()) {
      if (t.userId === userId && (!type || t.type === type))
        this.tokens.delete(id);
    }
  }

  async savePasskey(cred: AuthPasskeyCredential) {
    this.passkeys.set(cred.id, cred);
  }
  async findPasskeyById(id: string) {
    return this.passkeys.get(id) ?? null;
  }
  async listPasskeysByUserId(userId: string) {
    return [...this.passkeys.values()].filter((p) => p.userId === userId);
  }
  async updatePasskey(id: string, updates: Partial<AuthPasskeyCredential>) {
    const p = this.passkeys.get(id);
    if (p) Object.assign(p, updates);
  }
  async deletePasskey(id: string) {
    this.passkeys.delete(id);
  }

  async createApiKey(key: AuthApiKey) {
    this.apiKeys.set(key.id, key);
    return key;
  }
  async findApiKeyByHash(keyHash: string) {
    return (
      [...this.apiKeys.values()].find((k) => k.keyHash === keyHash) ?? null
    );
  }
  async listApiKeysByUserId(userId: string) {
    return [...this.apiKeys.values()].filter((k) => k.userId === userId);
  }
  async updateApiKey(id: string, updates: Partial<AuthApiKey>) {
    const k = this.apiKeys.get(id);
    if (k) Object.assign(k, updates);
  }
  async deleteApiKey(id: string) {
    this.apiKeys.delete(id);
  }
}

export class MemoryChallengeStore implements AuthChallengeStore {
  private challenges = new Map<string, AuthChallenge>();

  constructor() {
    setInterval(() => {
      const now = new Date();
      for (const [key, item] of this.challenges.entries()) {
        if (item.expiresAt < now) this.challenges.delete(key);
      }
    }, 60000).unref?.();
  }

  async set(challenge: AuthChallenge): Promise<void> {
    this.challenges.set(challenge.challenge, challenge);
  }
  async get(challengeString: string): Promise<AuthChallenge | null> {
    const c = this.challenges.get(challengeString);
    if (!c || c.expiresAt < new Date()) {
      this.challenges.delete(challengeString);
      return null;
    }
    return c;
  }
  /**
   * Reads and removes in one step.
   *
   * Atomic for this store: the map is synchronous and nothing awaits between the
   * read and the delete, so two concurrent calls cannot both see the entry.
   */
  async consume(challengeString: string): Promise<AuthChallenge | null> {
    const challenge = this.challenges.get(challengeString);
    if (!challenge) return null;

    this.challenges.delete(challengeString);

    if (challenge.expiresAt < new Date()) return null;
    return challenge;
  }

  async delete(challengeString: string): Promise<void> {
    this.challenges.delete(challengeString);
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<
    string,
    { data: { hits: number[]; lockoutUntil?: number }; expires: number }
  >();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, item] of this.store.entries()) {
        if (item.expires < now) this.store.delete(key);
      }
    }, 60000).unref?.();
  }

  async get(key: string) {
    const item = this.store.get(key);
    if (!item || item.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.data;
  }
  async set(
    key: string,
    data: { hits: number[]; lockoutUntil?: number },
    ttlSec: number,
  ) {
    this.store.set(key, { data, expires: Date.now() + ttlSec * 1000 });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

export class MemoryAuditStore implements AuthAuditStore {
  private events: AuthEvent[] = [];

  async record(event: AuthEvent): Promise<void> {
    this.events.unshift(event);
    if (this.events.length > 2000) this.events.pop();
  }
  async listByUser(userId: string, limit = 50): Promise<AuthEvent[]> {
    return this.events.filter((e) => e.userId === userId).slice(0, limit);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Cryptographic Engine & HKDF Key Derivation
// ──────────────────────────────────────────────────────────────────────────

export class AuthCrypto {
  readonly encKey: Buffer;
  readonly jwtKey: Buffer;
  readonly oauthKey: Buffer;
  readonly recoveryKey: Buffer;

  constructor(secret: string, customEncKey?: string) {
    if (customEncKey) {
      const buf = Buffer.from(customEncKey, "hex");
      if (buf.length !== 32) {
        throw new AuthError(
          "customEncKey must be exactly 32 bytes (64 hex characters)",
        );
      }
      this.encKey = buf;
    } else {
      this.encKey = Buffer.from(
        crypto.hkdfSync(
          "sha256",
          secret,
          "yatta-auth-salt",
          "yatta-aes-encryption",
          32,
        ),
      );
    }

    this.jwtKey = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        secret,
        "yatta-auth-salt",
        "yatta-jwt-signing",
        32,
      ),
    );
    this.oauthKey = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        secret,
        "yatta-auth-salt",
        "yatta-oauth-state",
        32,
      ),
    );
    this.recoveryKey = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        secret,
        "yatta-auth-salt",
        "yatta-recovery-codes",
        32,
      ),
    );
  }

  timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  hmac(value: string, key: Buffer): string {
    return crypto.createHmac("sha256", key).update(value).digest("hex");
  }

  randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString("hex");
  }

  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
  }

  decrypt(cipherPayload: string): string {
    const parts = cipherPayload.split(":");
    if (parts.length !== 3)
      throw new AuthError("Invalid encrypted payload envelope", 400);
    const [ivHex, tagHex, contentHex] = parts as [string, string, string];
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.encKey,
        Buffer.from(ivHex, "hex"),
      );
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(contentHex, "hex")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      throw new AuthError(
        "Decryption failed: corrupted or tampered payload",
        400,
      );
    }
  }

  async hashPassword(password: string): Promise<string> {
    if (typeof Bun !== "undefined" && Bun.password?.hash) {
      return Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 65536,
        timeCost: 2,
      });
    }
    return new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(16).toString("hex");
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
      });
    });
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (typeof Bun !== "undefined" && Bun.password?.verify) {
      try {
        return await Bun.password.verify(password, hash);
      } catch {
        return false;
      }
    }
    if (hash.startsWith("scrypt:")) {
      const [, salt, key] = hash.split(":");
      return new Promise((resolve) => {
        crypto.scrypt(password, salt!, 64, (err, derivedKey) => {
          if (err) return resolve(false);
          const keyBuffer = Buffer.from(key!, "hex");
          if (keyBuffer.length !== derivedKey.length) return resolve(false);
          resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
        });
      });
    }
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Hardened JWT Subsystem
// ──────────────────────────────────────────────────────────────────────────

/**
 * What a sign-in returns when it stops at the second factor.
 *
 * A `ticket`, not a `userId`. With a bare id, whatever the app built as its second
 * step had no proof the first factor had passed — see {@link Auth.completeMfa}.
 */
export interface MfaChallenge {
  mfaRequired: true;
  /** Short-lived, single-use, signed. Pass it to `completeMfa`. */
  ticket: string;
  /** When the ticket stops working. For a countdown in the UI. */
  expiresInSec: number;
}

export interface JwtClaims {
  sub: string;
  /**
   * `mfa` is a short-lived, single-use ticket for the second half of a sign-in. It
   * carries no `sid`, because there is no session yet — it authorises the exchange
   * for one, and `completeMfa` is the only thing that performs it.
   */
  type: "access" | "refresh" | "mfa";
  sid?: string;
  jti: string;
  ver?: number;
  /** How the first factor was satisfied. Present on `mfa` tickets. */
  amr?: string;
  exp: number;
  iat: number;
}

export class AuthJwt {
  constructor(
    private readonly signingKey: Buffer,
    private readonly cryptoUtil: AuthCrypto,
  ) {}

  sign(
    payload: Omit<JwtClaims, "iat" | "exp" | "jti"> & {
      expInSec: number;
      jti?: string;
    },
  ): string {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + payload.expInSec;
    const jti = payload.jti ?? crypto.randomUUID();

    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const bodyClaims: JwtClaims = {
      sub: payload.sub,
      type: payload.type,
      sid: payload.sid,
      jti,
      ver: payload.ver,
      iat,
      exp,
    };

    const body = Buffer.from(JSON.stringify(bodyClaims)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", this.signingKey)
      .update(`${header}.${body}`)
      .digest("base64url");
    return `${header}.${body}.${signature}`;
  }

  verify(token: string): JwtClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, signature] = parts as [string, string, string];

    try {
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      if (header.alg !== "HS256" || header.typ !== "JWT") return null;
    } catch {
      return null;
    }

    const expectedSig = crypto
      .createHmac("sha256", this.signingKey)
      .update(`${headerB64}.${bodyB64}`)
      .digest("base64url");
    if (!this.cryptoUtil.timingSafeEqual(signature, expectedSig)) return null;

    try {
      const payload: JwtClaims = JSON.parse(
        Buffer.from(bodyB64, "base64url").toString(),
      );
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== "number" || typeof payload.iat !== "number")
        return null;
      if (payload.exp < now) return null;
      if (payload.iat > now + 60) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Pluggable Dual-Bucket Rate Limiter
// ──────────────────────────────────────────────────────────────────────────

export class GranularRateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly config: RateLimitConfig,
  ) {}

  private isEnabled(): boolean {
    return this.config.enabled ?? true;
  }

  async assertAllowed(
    bucket: keyof RateLimitConfig,
    ip: string,
    identifier?: string,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    const rule = this.config[bucket];
    if (!rule || typeof rule !== "object") return;

    const now = Date.now();
    const keys = [`rl:${bucket}:ip:${ip}`];
    if (identifier) keys.push(`rl:${bucket}:id:${identifier}`);

    for (const key of keys) {
      const record = await this.store.get(key);
      if (record?.lockoutUntil && record.lockoutUntil > now) {
        const secondsLeft = Math.ceil((record.lockoutUntil - now) / 1000);
        throw new RateLimitError(
          `Too many attempts. Locked out for ${secondsLeft}s.`,
        );
      }
    }
  }

  async recordFailure(
    bucket: keyof RateLimitConfig,
    ip: string,
    identifier?: string,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    const rule = this.config[bucket];
    if (!rule || typeof rule !== "object") return;

    const now = Date.now();
    const windowStart = now - rule.windowSec * 1000;
    const keys = [`rl:${bucket}:ip:${ip}`];
    if (identifier) keys.push(`rl:${bucket}:id:${identifier}`);

    for (const key of keys) {
      const record = (await this.store.get(key)) ?? { hits: [] };
      const validHits = record.hits.filter((t) => t > windowStart);
      validHits.push(now);

      let lockoutUntil = record.lockoutUntil;
      if (validHits.length >= rule.maxAttempts) {
        lockoutUntil = now + rule.lockoutSec * 1000;
      }

      const ttl =
        rule.lockoutSec > rule.windowSec ? rule.lockoutSec : rule.windowSec;
      await this.store.set(key, { hits: validHits, lockoutUntil }, ttl);
    }
  }

  async recordSuccess(
    bucket: keyof RateLimitConfig,
    ip: string,
    identifier?: string,
  ): Promise<void> {
    if (!this.isEnabled()) return;

    /*
     * Only the credential bucket is cleared, never the IP bucket.
     *
     * Deleting the IP counter meant an attacker could sign into an account they
     * own every few guesses and wipe the per-IP failure count, so the only
     * limiter actually holding against guessing from one address was reset by
     * the attack itself.
     */
    if (identifier) await this.store.delete(`rl:${bucket}:id:${identifier}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Permission Engine & RBAC
// ──────────────────────────────────────────────────────────────────────────

export class PermissionManager {
  private permissions = new Map<string, Set<string>>();

  constructor(roleDefs?: RoleDefinitions) {
    this.initialize(roleDefs);
  }

  private initialize(roleDefs?: RoleDefinitions) {
    const defs = roleDefs ?? {
      admin: { can: ["*:*"] },
      user: { can: ["read:own", "update:own"] },
    };

    for (const role of Object.keys(defs)) {
      this.permissions.set(
        role,
        this.resolvePermissionsForRole(role, defs, new Set()),
      );
    }
  }

  private resolvePermissionsForRole(
    role: string,
    defs: RoleDefinitions,
    /** Roles on the current path, not every role ever visited. */
    path: Set<string>,
  ): Set<string> {
    /*
     * A cycle is a configuration error and has to be loud.
     *
     * Returning an empty set silently dropped the permissions behind the cycle,
     * so an "admin" that inherited through a loop quietly stopped being an
     * admin — and nothing said so.
     *
     * `path` rather than a shared "seen" set: tracking the current path means a
     * diamond (A inherits B and C, both inherit D) is not mistaken for a cycle.
     */
    if (path.has(role)) {
      throw new AuthError(
        `Cyclic role inheritance detected: ${[...path, role].join(" -> ")}`,
        400,
      );
    }
    path.add(role);

    const conf = defs[role];
    if (!conf) return new Set();

    const allowed = new Set<string>();
    const directPerms = Array.isArray(conf) ? conf : conf.can;
    for (const p of directPerms) allowed.add(p);

    if (!Array.isArray(conf) && conf.inherits) {
      for (const parent of conf.inherits) {
        // A fresh set per branch: a role reachable by two paths is not a cycle.
        const parentPerms = this.resolvePermissionsForRole(
          parent,
          defs,
          new Set(path),
        );
        for (const p of parentPerms) allowed.add(p);
      }
    }

    return allowed;
  }

  check(
    userRoles: string[],
    action: string,
    resource: string,
    isOwner = false,
  ): boolean {
    for (const role of userRoles) {
      const perms = this.permissions.get(role);
      if (!perms) continue;

      if (
        perms.has("*:*") ||
        perms.has("manage:all") ||
        perms.has(`${resource}:*`) ||
        perms.has(`*:${action}`) ||
        perms.has(`${resource}:${action}`) ||
        perms.has(`${action}:${resource}`)
      ) {
        return true;
      }

      if (
        isOwner &&
        (perms.has(`${action}:own`) || perms.has(`${resource}:own`))
      ) {
        return true;
      }
    }
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Security Risk Engine
// ──────────────────────────────────────────────────────────────────────────

export interface RiskContext {
  user: AuthUser;
  ip?: string;
  userAgent?: string;
}

export class SecurityRiskEngine {
  constructor(private readonly store: AuthStore) {}

  async assessLoginRisk(
    ctx: RiskContext,
  ): Promise<{ risk: "low" | "medium" | "high"; reasons: string[] }> {
    const reasons: string[] = [];
    const sessions = await this.store.listSessionsByUserId(ctx.user.id);

    if (sessions.length > 0) {
      const seenIps = new Set(sessions.map((s) => s.ip).filter(Boolean));
      if (ctx.ip && !seenIps.has(ctx.ip)) {
        reasons.push("Unrecognized IP address");
      }

      const seenAgents = new Set(
        sessions.map((s) => s.userAgent).filter(Boolean),
      );
      if (ctx.userAgent && !seenAgents.has(ctx.userAgent)) {
        reasons.push("New device or browser detected");
      }
    }

    let risk: "low" | "medium" | "high" = "low";
    if (reasons.length >= 2) risk = "high";
    else if (reasons.length === 1) risk = "medium";

    return { risk, reasons };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 8. Core Auth Engine
// ──────────────────────────────────────────────────────────────────────────

export class Auth {
  readonly store: AuthStore;
  readonly challengeStore: AuthChallengeStore;
  readonly rateLimitStore: RateLimitStore;
  readonly auditStore: AuthAuditStore;
  readonly config: AuthConfig;
  readonly crypto: AuthCrypto;
  readonly jwt: AuthJwt;
  readonly permissions: PermissionManager;
  readonly rateLimiter: GranularRateLimiter;
  readonly risk: SecurityRiskEngine;

  readonly mfa: AuthMfa;
  readonly passkey: AuthPasskey;
  readonly oauth: AuthOAuth;
  readonly magicLink: AuthMagicLink;
  readonly apiKeys: AuthApiKeys;
  readonly password: AuthPasswordSubsystem;

  private readonly eventListeners = new Map<
    string,
    Array<(payload: any) => void | Promise<void>>
  >();

  constructor(config: AuthConfig) {
    if (!config.secret || config.secret.length < 32) {
      throw new AuthError(
        "AuthConfig.secret must be at least 32 characters long for security.",
      );
    }

    if (process.env.NODE_ENV === "production") {
      const url = config.email?.appUrl;
      if (!url || url.includes("localhost") || url.includes("127.0.0.1")) {
        throw new AuthError(
          "AuthConfig.email.appUrl must be set to a valid production domain.",
        );
      }
    }

    this.config = config;
    /*
     * A default store, but a loud one in production.
     *
     * `MemoryAuthStore` is O(n) per lookup — every authenticated request scans every
     * session and every user — and it enforces nothing. Two concurrent signups for
     * the same address both succeed, because the uniqueness check is a scan rather
     * than a constraint. That is fine for a script or a test and wrong for anything
     * serving traffic, so it is refused rather than defaulted silently.
     */
    this.store = config.store ?? new MemoryAuthStore();

    if (!config.store && process.env.NODE_ENV === "production") {
      throw new AuthError(
        "No auth store was supplied. MemoryAuthStore is an in-memory default: every " +
          "lookup is a linear scan and nothing enforces uniqueness, so two concurrent " +
          "signups for one address both succeed. Pass a persistent store, or set " +
          "NODE_ENV to something other than production.",
        500,
      );
    }
    this.challengeStore = config.challengeStore ?? new MemoryChallengeStore();
    this.rateLimitStore = config.rateLimitStore ?? new MemoryRateLimitStore();
    this.auditStore = config.auditStore ?? new MemoryAuditStore();

    this.crypto = new AuthCrypto(config.secret, config.security?.encryptionKey);
    this.jwt = new AuthJwt(this.crypto.jwtKey, this.crypto);
    this.permissions = new PermissionManager(config.roles);

    this.rateLimiter = new GranularRateLimiter(this.rateLimitStore, {
      enabled: config.rateLimits?.enabled ?? true,
      login: config.rateLimits?.login ?? {
        maxAttempts: 5,
        windowSec: 900,
        lockoutSec: 900,
      },
      signup: config.rateLimits?.signup ?? {
        maxAttempts: 10,
        windowSec: 3600,
        lockoutSec: 3600,
      },
      passwordReset: config.rateLimits?.passwordReset ?? {
        maxAttempts: 3,
        windowSec: 900,
        lockoutSec: 1800,
      },
      magicLink: config.rateLimits?.magicLink ?? {
        maxAttempts: 5,
        windowSec: 900,
        lockoutSec: 1800,
      },
      passkey: config.rateLimits?.passkey ?? {
        maxAttempts: 10,
        windowSec: 900,
        lockoutSec: 900,
      },
    });

    this.risk = new SecurityRiskEngine(this.store);

    this.mfa = new AuthMfa(this);
    this.passkey = new AuthPasskey(this);
    this.oauth = new AuthOAuth(this);
    this.magicLink = new AuthMagicLink(this);
    this.apiKeys = new AuthApiKeys(this);
    this.password = new AuthPasswordSubsystem(this);
  }

  get mailer(): YattaMailer {
    return this.config.email?.mailer ?? Mail;
  }

  on(event: string, listener: (payload: any) => void | Promise<void>) {
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener);
    this.eventListeners.set(event, list);
  }

  async emit(event: string, payload: Record<string, unknown>, req?: Request) {
    const client = this.extractClient(req);
    const auditEvent: AuthEvent = {
      id: crypto.randomUUID(),
      userId: payload.userId as string | undefined,
      type: event,
      ip: client.ip,
      userAgent: client.userAgent,
      metadata: payload,
      timestamp: new Date(),
    };

    this.auditStore.record(auditEvent).catch(console.error);

    const listeners = this.eventListeners.get(event) ?? [];
    Promise.allSettled(
      listeners.map(async (fn) => {
        try {
          await fn({ ...payload, event });
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err);
        }
      }),
    );
  }

  async signUp(input: {
    email: string;
    password?: string;
    metadata?: Record<string, unknown>;
    req?: Request;
  }): Promise<
    AuthResult | { user: PublicUser; emailVerificationRequired: true }
  > {
    const email = this.validateEmail(input.email);
    const client = this.extractClient(input.req);

    await this.rateLimiter.assertAllowed("signup", client.ip, email);

    if (input.password) {
      this.validatePasswordStrength(input.password);
    }

    const existing = await this.store.findUserByEmail(email);
    if (existing) {
      await this.rateLimiter.recordFailure("signup", client.ip, email);
      if (this.config.security?.preventAccountEnumeration ?? true) {
        return {
          user: {
            id: "pending",
            email,
            roles: ["user"],
            emailVerified: false,
            twoFactorEnabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          emailVerificationRequired: true,
        };
      }
      throw new AuthError("An account with this email already exists", 409);
    }

    /*
     * Only refusals count, and a success clears the count.
     *
     * This used to record a failure unconditionally, on every successful
     * registration. With the default rule (10 attempts, then an hour of lockout)
     * the eleventh signup from one IP locked that IP out for an hour — a
     * self-inflicted outage behind a NAT, on a CI runner, or anywhere many people
     * share an egress. `login` already did the right thing, which is what this
     * now matches.
     */
    await this.rateLimiter.recordSuccess("signup", client.ip);

    let passwordHash: string | undefined;
    if (input.password) {
      passwordHash = await this.crypto.hashPassword(input.password);
    }

    const user = await this.store.createUser({
      id: crypto.randomUUID(),
      email,
      passwordHash,
      roles: ["user"], // Roles are strictly server-side
      emailVerified: false,
      twoFactorEnabled: false,
      credentialVersion: 1,
      metadata: input.metadata,
    });

    await this.emit(
      "signup",
      { userId: user.id, email: user.email },
      input.req,
    );
    this.sendVerificationEmail(user.id).catch(console.error);

    const allowUnverified =
      this.config.security?.allowUnverifiedSession ?? false;
    if (!allowUnverified) {
      return { user: this.toPublicUser(user), emailVerificationRequired: true };
    }

    return this.createAuthResult(user, client);
  }

  async signIn(input: {
    email: string;
    password?: string;
    mfaCode?: string;
    recoveryCode?: string;
    req?: Request;
  }): Promise<AuthResult | MfaChallenge> {
    const email = this.validateEmail(input.email);
    const client = this.extractClient(input.req);

    await this.rateLimiter.assertAllowed("login", client.ip, email);

    const user = await this.store.findUserByEmail(email);

    // Constant-time dummy verification if user does not exist
    if (!user || !user.passwordHash) {
      await this.crypto.verifyPassword(
        input.password ?? "",
        "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$P9bZJgqGg4Wf",
      );
      await this.rateLimiter.recordFailure("login", client.ip, email);
      throw new UnauthorizedError("Invalid email or password");
    }

    const isValid = await this.crypto.verifyPassword(
      input.password ?? "",
      user.passwordHash,
    );
    if (!isValid) {
      await this.rateLimiter.recordFailure("login", client.ip, email);
      await this.emit(
        "login.failed",
        { userId: user.id, reason: "bad_password" },
        input.req,
      );
      throw new UnauthorizedError("Invalid email or password");
    }

    if (
      !user.emailVerified &&
      !(this.config.security?.allowUnverifiedSession ?? false)
    ) {
      throw new AuthError("Please verify your email before signing in.", 403);
    }

    if (user.twoFactorEnabled) {
      if (!input.mfaCode && !input.recoveryCode) {
        return this.issueMfaTicket(user);
      }

      if (input.mfaCode) {
        const secret = this.crypto.decrypt(user.encryptedTwoFactorSecret!);
        // `=== true`, not truthiness: "replayed" is a non-empty string, so a plain
        // `!` would read it as valid.
        if (this.mfa.verifyCode(secret, input.mfaCode, user) !== true) {
          await this.rateLimiter.recordFailure("login", client.ip, email);
          await this.emit(
            "login.failed",
            { userId: user.id, reason: "bad_mfa" },
            input.req,
          );
          throw new UnauthorizedError("Invalid two-factor authentication code");
        }
      } else if (input.recoveryCode) {
        const ok = await this.mfa.consumeRecoveryCode(
          user.id,
          input.recoveryCode,
        );
        if (!ok) {
          await this.rateLimiter.recordFailure("login", client.ip, email);
          await this.emit(
            "login.failed",
            { userId: user.id, reason: "bad_recovery_code" },
            input.req,
          );
          throw new UnauthorizedError("Invalid recovery code");
        }
      }
    }

    await this.rateLimiter.recordSuccess("login", client.ip, email);

    const assessment = await this.risk.assessLoginRisk({
      user,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    if (assessment.risk !== "low") {
      await this.emit(
        "security.suspicious_login",
        { userId: user.id, reasons: assessment.reasons },
        input.req,
      );
    }

    await this.emit("login.success", { userId: user.id }, input.req);
    return this.createAuthResult(user, client);
  }

  async signOut(
    reqOrToken: Request | { req: Request } | string,
  ): Promise<{ success: boolean; cookies: string[] }> {
    let sessionToken: string | null = null;

    if (typeof reqOrToken === "string") {
      sessionToken = reqOrToken;
    } else {
      const req = "req" in reqOrToken ? reqOrToken.req : reqOrToken;
      const cookies = this.parseCookies(req.headers.get("cookie") ?? "");
      sessionToken = cookies[this.cookieNames.session] ?? null;
      if (!sessionToken) {
        const authHeader = req.headers.get("authorization");
        if (authHeader?.toLowerCase().startsWith("bearer ")) {
          sessionToken = authHeader.slice(7).trim();
        }
      }
    }

    if (sessionToken) {
      const hash = this.crypto.hash(sessionToken);
      let session = await this.store.findSessionByTokenHash(hash);

      if (!session) {
        const jwtClaims = this.jwt.verify(sessionToken);
        if (jwtClaims?.sid) {
          session = await this.store.findSessionById(jwtClaims.sid);
        }
      }

      if (session) {
        await this.store.deleteSession(session.id);
        await this.emit("logout", {
          userId: session.userId,
          sessionId: session.id,
        });
      }
    }

    return {
      success: true,
      cookies: [
        this.makeCookie(this.cookieNames.session, "", { maxAge: 0 }),
        this.makeCookie(this.cookieNames.refresh, "", { maxAge: 0 }),
        this.makeCookie(this.cookieNames.csrf, "", { maxAge: 0 }),
      ],
    };
  }

  /**
   * Whether a session is still inside its lifetime.
   *
   * Checked here rather than left to the store. `MemoryAuthStore` filters expired
   * sessions out of its scan, so the default implementation made this look handled —
   * but `AuthStore` is a published interface, and a custom store that returns an
   * expired session makes every caller believe a dead session is live. "The default
   * happens to check" is not a security property.
   *
   * A session with no `expiresAt` is treated as live: some deployments use a
   * shorter access token and never set one, and refusing those would break them
   * loudly for a case that is not a leak.
   */
  private isSessionLive(session: AuthSession): boolean {
    if (!session.expiresAt) return true;
    return new Date(session.expiresAt).getTime() > Date.now();
  }

  /**
   * Finishes a sign-in that stopped at the second factor.
   *
   * Every flow that can stop — password, passkey, OAuth, magic link — returns
   * `{ mfaRequired: true, ticket }` when the account has 2FA on. Nothing consumed
   * that before, so a 2FA user could not sign in by any route but a password. This
   * is the half that was missing.
   *
   * A signed ticket rather than the bare `userId` the flows used to return.
   *
   * With a bare id, whatever the app built as its second step had no proof the first
   * factor had passed — so anything that accepted a user id and asked the store a
   * question was reachable by anyone who could produce or guess one. The ticket is
   * signed, short-lived, single-use, and only this function can interpret it.
   *
   * @param ticket The value from the `mfaRequired` response.
   * @param code A 6-digit TOTP code, or a recovery code.
   * @throws {AuthError} 401 if the ticket is missing, expired, already used, or for a
   *   user who no longer has 2FA on; 401 on a wrong code, after recording a failure.
   */
  async completeMfa(input: {
    ticket: string;
    code?: string;
    recoveryCode?: string;
    req?: Request;
  }): Promise<AuthResult> {
    if (!input.ticket) {
      throw new AuthError("An MFA ticket is required", 400);
    }

    if (!input.code && !input.recoveryCode) {
      throw new AuthError("Provide a code or a recovery code", 400);
    }

    const claims = this.jwt.verify(input.ticket);
    if (!claims || claims.type !== "mfa") {
      // Not a ticket, or a ticket whose signature does not check out. Both are the
      // same answer, so a caller cannot tell which it tried.
      throw new AuthError("This MFA ticket is invalid or has expired", 401);
    }

    const user = await this.store.findUserById(claims.sub);
    if (!user || !user.twoFactorEnabled || !user.encryptedTwoFactorSecret) {
      throw new AuthError("This MFA ticket is no longer valid", 401);
    }

    /*
     * Claim the ticket before spending a code attempt on it.
     *
     * Spent after the *signature* is verified and before the code is checked, so a
     * wrong code costs the user one ticket rather than leaving a credential an
     * attacker can keep guessing at for five minutes. And because the store takes it
     * atomically, a second caller presented with the same ticket finds nothing —
     * which is what "single use" has to mean when two requests race.
     */
    const claimed = await this.spendMfaTicket(input.ticket);
    if (!claimed) {
      throw new AuthError("This MFA ticket is invalid or has expired", 401);
    }

    const client = this.extractClient(input.req);

    let valid: boolean | "replayed" = false;

    if (input.code) {
      const secret = this.crypto.decrypt(user.encryptedTwoFactorSecret);
      valid = this.mfa.verifyCode(secret, input.code, user);
    }

    // A recovery code is not a TOTP code, so the replay verdict does not apply to it.
    if (valid !== true && input.recoveryCode) {
      valid = await this.mfa.consumeRecoveryCode(user.id, input.recoveryCode);
    }

    if (valid === "replayed") {
      // Not counted as a failure: the user did nothing wrong, so a lockout here would
      // punish them for the system's own timing.
      throw new AuthError(
        "That code was already used. Wait for the next code and try again.",
        401,
      );
    }

    if (!valid) {
      await this.rateLimiter.recordFailure("login", client.ip, user.email);
      await this.emit(
        "login.failed",
        { userId: user.id, reason: "mfa_invalid" },
        input.req,
      );
      throw new AuthError("That code is not valid", 401);
    }

    await this.rateLimiter.recordSuccess("login", client.ip, user.email);
    await this.emit("login.success", { userId: user.id, mfa: true }, input.req);

    return this.createAuthResult(user, client);
  }

  async getSession(
    reqOrToken: Request | { req: Request } | string,
    options?: { autoRefresh?: boolean },
  ): Promise<{
    user: PublicUser;
    session: PublicSession;
    newCookies?: string[];
  } | null> {
    let token: string | null = null;
    let rawCookies: Record<string, string> = {};
    let reqRef: Request | undefined;

    if (typeof reqOrToken === "string") {
      token = reqOrToken;
    } else {
      reqRef = "req" in reqOrToken ? reqOrToken.req : reqOrToken;
      const authHeader = reqRef.headers.get("authorization");
      if (authHeader?.toLowerCase().startsWith("bearer ")) {
        token = authHeader.slice(7).trim();
      } else {
        rawCookies = this.parseCookies(reqRef.headers.get("cookie") ?? "");
        token = rawCookies[this.cookieNames.session] ?? null;
      }
    }

    if (!token) return null;

    const sessionTokenHash = this.crypto.hash(token);
    let session = await this.store.findSessionByTokenHash(sessionTokenHash);

    if (session && this.isSessionLive(session)) {
      const user = await this.store.findUserById(session.userId);
      if (!user) return null;

      const throttleSec = this.config.session?.activityThrottleSec ?? 300;
      if (Date.now() - session.lastSeenAt.getTime() > throttleSec * 1000) {
        session = await this.store.updateSession(session.id, {
          lastSeenAt: new Date(),
        });
      }

      return {
        user: this.toPublicUser(user),
        session: this.toPublicSession(session),
      };
    }

    const jwt = this.jwt.verify(token);
    if (jwt && jwt.type === "access") {
      const user = await this.store.findUserById(jwt.sub);
      if (!user) return null;

      const dbSession = jwt.sid ? await this.store.findSessionById(jwt.sid) : null;
      // Expiry checked here too. A JWT's own `exp` says the token is still
      // parseable; it says nothing about whether the session behind it was revoked
      // or has run out.
      if (!dbSession || !this.isSessionLive(dbSession)) return null;

      return {
        user: this.toPublicUser(user),
        session: this.toPublicSession(dbSession),
      };
    }

    const refreshCookie = rawCookies[this.cookieNames.refresh];
    const shouldAutoRefresh =
      options?.autoRefresh ??
      this.config.session?.autoRefreshOnCookieAuth ??
      false;
    if (refreshCookie && shouldAutoRefresh) {
      try {
        const refreshed = await this.refresh(refreshCookie, reqRef);
        return {
          user: refreshed.user,
          session: refreshed.session,
          newCookies: refreshed.cookies,
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  async getUser(req: Request): Promise<PublicUser | null> {
    const s = await this.getSession(req);
    return s?.user ?? null;
  }

  async requireUser(req: Request): Promise<PublicUser> {
    const user = await this.getUser(req);
    if (!user) throw new UnauthorizedError();
    return user;
  }

  async requireRecentAuth(
    req: Request,
    maxAgeSec?: number,
  ): Promise<{ user: PublicUser; session: PublicSession }> {
    const authState = await this.getSession(req);
    if (!authState) throw new UnauthorizedError();

    const allowedWindow =
      (maxAgeSec ?? this.config.security?.recentAuthWindowSec ?? 600) * 1000;
    const elapsed =
      Date.now() - authState.session.lastAuthenticatedAt.getTime();

    if (elapsed > allowedWindow) {
      throw new SecurityReauthRequiredError();
    }

    return authState;
  }

  async reauthenticate(req: Request, password: string): Promise<void> {
    const user = await this.requireUser(req);
    const fullUser = await this.store.findUserById(user.id);
    if (!fullUser || !fullUser.passwordHash) {
      throw new UnauthorizedError("Re-authentication failed");
    }

    const valid = await this.crypto.verifyPassword(
      password,
      fullUser.passwordHash,
    );
    if (!valid) throw new UnauthorizedError("Incorrect password");

    const authState = await this.getSession(req);
    if (authState) {
      await this.store.updateSession(authState.session.id, {
        lastAuthenticatedAt: new Date(),
      });
    }
  }

  async refresh(refreshToken: string, req?: Request): Promise<AuthResult> {
    const claims = this.jwt.verify(refreshToken);
    if (!claims || claims.type !== "refresh") {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }

    // An access token without a session id cannot identify one.
    const session = claims.sid ? await this.store.findSessionById(claims.sid) : null;
    if (!session) {
      throw new UnauthorizedError("Session has been revoked");
    }

    const incomingHash = this.crypto.hash(refreshToken);

    // Replay detection with a 30s concurrent grace window
    if (
      session.refreshTokenHash &&
      !this.crypto.timingSafeEqual(session.refreshTokenHash, incomingHash)
    ) {
      const isWithinGraceWindow =
        session.previousRefreshTokenHash &&
        this.crypto.timingSafeEqual(
          session.previousRefreshTokenHash,
          incomingHash,
        ) &&
        session.rotatedAt &&
        Date.now() - session.rotatedAt.getTime() < 30000;

      if (!isWithinGraceWindow) {
        await this.store.deleteSession(session.id);
        await this.emit(
          "security.token_replay",
          { userId: session.userId, sessionId: session.id },
          req,
        );
        throw new UnauthorizedError(
          "Refresh token reuse detected. Session revoked for security.",
        );
      }
    }

    const user = await this.store.findUserById(session.userId);
    if (!user) throw new UnauthorizedError("User no longer exists");

    const client = this.extractClient(req);

    const nextVersion = session.refreshVersion + 1;
    const newRefreshJwt = this.jwt.sign({
      sub: user.id,
      sid: session.id,
      type: "refresh",
      ver: nextVersion,
      expInSec: this.config.session?.refreshTokenTtlSec ?? 30 * 24 * 3600,
    });

    const newSessionToken = this.crypto.randomToken(32);
    const newSessionHash = this.crypto.hash(newSessionToken);
    const newRefreshHash = this.crypto.hash(newRefreshJwt);

    const updatedSession = await this.store.updateSession(session.id, {
      sessionTokenHash: newSessionHash,
      previousRefreshTokenHash: session.refreshTokenHash,
      refreshTokenHash: newRefreshHash,
      rotatedAt: new Date(),
      refreshVersion: nextVersion,
      lastSeenAt: new Date(),
      ip: client.ip ?? session.ip,
      userAgent: client.userAgent ?? session.userAgent,
    });

    return this.buildAuthResult(
      user,
      updatedSession,
      newSessionToken,
      newRefreshJwt,
    );
  }

  async sendVerificationEmail(userId: string): Promise<void> {
    const user = await this.store.findUserById(userId);
    if (!user) throw new AuthError("User not found", 404);

    const rawToken = this.crypto.randomToken(32);
    const tokenHash = this.crypto.hash(rawToken);

    await this.store.deleteTokensByUserId(userId, "email_verification");
    await this.store.createToken({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      type: "email_verification",
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

    const link = `${this.config.email?.appUrl}/auth/verify-email?token=${rawToken}`;
    const templateFn =
      this.config.email?.templates?.verification ??
      ((d) => ({
        subject: "Verify your email address",
        html: `<p>Click here to verify your email: <a href="${d.link}">${d.link}</a></p>`,
        text: `Verify your email: ${d.link}`,
      }));

    const content = templateFn({ email: user.email, link, token: rawToken });
    await this.mailer
      .to(user.email)
      .subject(content.subject)
      .html(content.html)
      .text(content.text ?? content.html)
      .deliver();
  }

  async verifyEmail(rawToken: string): Promise<PublicUser> {
    const tokenHash = this.crypto.hash(rawToken);
    const record = await this.store.consumeToken(
      tokenHash,
      "email_verification",
    );
    if (!record)
      throw new AuthError("Invalid or expired verification token", 400);

    const updated = await this.store.updateUser(record.userId, {
      emailVerified: true,
    });
    await this.emit("email.verified", { userId: updated.id });

    return this.toPublicUser(updated);
  }

  can(userOrRoles: PublicUser | AuthUser | string[]) {
    const roles = Array.isArray(userOrRoles) ? userOrRoles : userOrRoles.roles;
    return {
      perform: (action: string) => ({
        on: (resource: string, options?: { isOwner?: boolean }) => {
          return this.permissions.check(
            roles,
            action,
            resource,
            options?.isOwner,
          );
        },
      }),
      do: (perm: string) => {
        const [resource, action] = (
          perm.includes(":") ? perm.split(":") : ["all", perm]
        ) as [string, string];
        return this.permissions.check(roles, action ?? "read", resource);
      },
    };
  }

  protect(requirements?: { role?: string; permission?: string }) {
    return async (
      ctx: any,
      next: () => Promise<Response>,
    ): Promise<Response> => {
      const req: Request = ctx.req ?? (ctx instanceof Request ? ctx : null);
      if (!req)
        throw new AuthError("Invalid request context for auth.protect()");

      // CSRF check on mutating methods authenticated via cookies
      const method = req.method.toUpperCase();
      const hasAuthHeader = req.headers
        .get("authorization")
        ?.toLowerCase()
        .startsWith("bearer ");
      if (
        !hasAuthHeader &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(method)
      ) {
        const cookies = this.parseCookies(req.headers.get("cookie") ?? "");
        const csrfCookie = cookies[this.cookieNames.csrf];
        const csrfHeader = req.headers.get("x-csrf-token");
        if (
          !csrfCookie ||
          !csrfHeader ||
          !this.crypto.timingSafeEqual(csrfCookie, csrfHeader)
        ) {
          return new Response(
            JSON.stringify({ error: "Forbidden: CSRF validation failed" }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      const authData = await this.getSession(req);
      if (!authData) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        requirements?.role &&
        !authData.user.roles.includes(requirements.role)
      ) {
        return new Response(
          JSON.stringify({ error: "Forbidden: Insufficient role" }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (
        requirements?.permission &&
        !this.can(authData.user).do(requirements.permission)
      ) {
        return new Response(
          JSON.stringify({ error: "Forbidden: Permission denied" }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      ctx.state = ctx.state ?? {};
      ctx.state.user = authData.user;
      ctx.state.session = authData.session;

      const res = await next();

      if (authData.newCookies && authData.newCookies.length > 0) {
        const headers = new Headers(res.headers);
        for (const c of authData.newCookies) headers.append("Set-Cookie", c);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }

      return res;
    };
  }

  private validateEmail(email: string): string {
    const trimmed = email.trim().toLowerCase();
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!regex.test(trimmed))
      throw new AuthError("A valid email address is required");
    return trimmed;
  }

  validatePasswordStrength(pass: string): void {
    const policy = this.config.passwordPolicy ?? {};
    const minLength = policy.minLength ?? 12;
    const maxLength = policy.maxLength ?? 128;

    if (pass.length < minLength)
      throw new AuthError(
        `Password must be at least ${minLength} characters long`,
      );
    if (pass.length > maxLength)
      throw new AuthError(`Password must be under ${maxLength} characters`);
    if (policy.requireUppercase && !/[A-Z]/.test(pass))
      throw new AuthError("Password must include an uppercase letter");
    if (policy.requireLowercase && !/[a-z]/.test(pass))
      throw new AuthError("Password must include a lowercase letter");
    if (policy.requireNumbers && !/\d/.test(pass))
      throw new AuthError("Password must include a number");
    if (
      policy.requireSymbols &&
      !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pass)
    ) {
      throw new AuthError("Password must include a special symbol");
    }
  }

  extractClient(req?: any): { ip: string; userAgent?: string } {
    if (!req) return { ip: "127.0.0.1" };

    let ip: string | undefined;

    if (typeof req === "object") {
      if (typeof req.ip === "string") ip = req.ip;
      else if (typeof req.socket?.remoteAddress === "string")
        ip = req.socket.remoteAddress;
    }

    /*
     * A Bun `Request` has neither `ip` nor `socket.remoteAddress`, so every
     * client resolved to 127.0.0.1 — which made every rate limit a *global*
     * one: five failed logins from anyone locked out everyone, and the risk
     * engine's IP comparison was meaningless.
     *
     * Bun exposes the peer address through `server.requestIP(req)`, which the
     * runtime only knows, so it cannot be read from here. Applications supply
     * it:
     *
     *   createAuth({
     *     security: { getClientIp: (req) => server.requestIP(req)?.address },
     *   })
     */
    if (ip === undefined && this.config.security?.getClientIp) {
      try {
        const resolved = this.config.security.getClientIp(req as Request);
        if (typeof resolved === "string" && resolved) ip = resolved.trim();
      } catch {
        // A broken resolver must not fail the request; fall through to the
        // headers, then to the loopback default.
      }
    }

    const headers =
      "headers" in req && req.headers instanceof Headers
        ? req.headers
        : req instanceof Request
          ? req.headers
          : new Headers(req.headers as Record<string, string>);

    if (this.config.security?.trustProxy) {
      const cf = headers.get("cf-connecting-ip");
      const real = headers.get("x-real-ip");
      const fwd = headers.get("x-forwarded-for");

      if (cf) ip = cf.trim();
      else if (real) ip = real.trim();
      else if (fwd) {
        const parts: string[] = fwd
          .split(",")
          .map((entry: string) => entry.trim())
          .filter(Boolean);
        /*
         * Walk from the right, skipping the trusted proxies.
         *
         * `x-forwarded-for` reads client, proxy1, proxy2… The **leftmost** entry is
         * the one the client wrote and can rewrite on every request; each proxy
         * appends to the right, so the entries nearest the end are the ones the
         * infrastructure vouched for.
         *
         * This previously took index 0, with a comment claiming the leftmost entry
         * "is the only one the client does not control". That is backwards, and it
         * turned every IP bucket into no protection: a client sent a fresh
         * `x-forwarded-for` per request and each one landed in a different bucket.
         * Taking a right-hand entry the client cannot reach restores the limit.
         *
         * How far from the right depends on how many proxies are actually trusted,
         * so it is configured rather than guessed.
         */
        const trusted = Math.max(0, this.config.security?.trustedProxyCount ?? 1);
        ip = parts[Math.max(0, parts.length - 1 - trusted)] ?? ip;
      }
    }

    const userAgent = headers.get("user-agent") || undefined;
    return { ip: ip || "127.0.0.1", userAgent };
  }

  toPublicUser(user: AuthUser): PublicUser {
    return {
      id: user.id,
      email: user.email,
      roles: user.roles,
      emailVerified: user.emailVerified,
      twoFactorEnabled: !!user.twoFactorEnabled,
      metadata: user.metadata,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  toPublicSession(session: AuthSession): PublicSession {
    return {
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      lastAuthenticatedAt: session.lastAuthenticatedAt,
      createdAt: session.createdAt,
      userAgent: session.userAgent,
      ip: session.ip,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
    };
  }

  get cookieNames() {
    return {
      session: this.config.cookies?.sessionCookieName ?? "yatta_session",
      refresh: this.config.cookies?.refreshCookieName ?? "yatta_refresh",
      csrf: this.config.cookies?.csrfCookieName ?? "yatta_csrf",
    };
  }

  /**
   * Mints the short-lived ticket handed back when 2FA stops a sign-in.
   *
   * Short-lived on purpose: it authorises nothing on its own, but it is the half of
   * a two-factor check, so a longer life is a wider window for a captured value.
   *
   * Public because every sign-in route needs it — password, passkey, OAuth and magic
   * link all stop here — and four private copies would be four chances to give one
   * of them a different lifetime.
   */
  /**
   * Takes an MFA ticket out of circulation, reporting whether it was still there.
   *
   * Uses the store's atomic `consume` where it offers one. Without it this is a read
   * followed by a delete, which two concurrent callers can both pass — and the second
   * session is exactly the one an attacker wants.
   */
  private async spendMfaTicket(ticket: string): Promise<boolean> {
    if (this.challengeStore.consume) {
      return (await this.challengeStore.consume(ticket)) !== null;
    }

    const existing = await this.challengeStore.get(ticket);
    if (!existing) return false;

    await this.challengeStore.delete(ticket);

    /*
     * A store with no atomic consume cannot promise single use. Said out loud,
     * because a race here is not visible in a test that runs one request at a time.
     */
    console.warn(
      "[auth] The challenge store has no consume(), so an MFA ticket is claimed with " +
        "a read followed by a delete. Two concurrent attempts with the same ticket can " +
        "both succeed. Implement consume() for single-use tickets.",
    );

    return true;
  }

  issueMfaTicket(user: AuthUser): MfaChallenge {
    const ttlSec = this.config.mfa?.challengeTtlSec ?? 300;

    const ticket = this.jwt.sign({
      sub: user.id,
      type: "mfa",
      // How the first factor was satisfied, inside the signature so it cannot be
      // edited to claim a stronger one.
      amr: "pwd",
      expInSec: ttlSec,
    });

    /*
     * Recorded so it can be spent.
     *
     * The ticket is signed and expiring, which is not the same as single-use: for its
     * whole five-minute life a captured value could be presented again. An earlier
     * version claimed single-use in a comment and called `challengeStore.delete` on
     * the ticket — deleting a key that was never stored, so the guarantee was not
     * there at all.
     *
     * A store entry is what makes "spent" a thing that can be observed. The TTL
     * matches the ticket's own, so the entry disappears exactly when the ticket stops
     * being valid anyway.
     */
    void this.challengeStore
      .set({
        id: crypto.randomUUID(),
        challenge: ticket,
        type: "authentication",
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlSec * 1000),
      })
      .catch((error: unknown) => {
        // A store that cannot record the ticket cannot enforce single use, so say so
        // rather than hand back a ticket that silently works twice.
        console.error(
          "[auth] Could not record the MFA ticket, so it cannot be single-use. " +
            "A captured ticket could be replayed until it expires.",
          error,
        );
      });

    return { mfaRequired: true, ticket, expiresInSec: ttlSec };
  }

  async createAuthResult(
    user: AuthUser,
    client: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const rawSessionToken = this.crypto.randomToken(32);
    const sessionTokenHash = this.crypto.hash(rawSessionToken);

    const sessionId = crypto.randomUUID();
    const sessionTtl = this.config.session?.sessionTtlSec ?? 30 * 24 * 3600;
    const refreshTtl =
      this.config.session?.refreshTokenTtlSec ?? 30 * 24 * 3600;

    const refreshJwt = this.jwt.sign({
      sub: user.id,
      sid: sessionId,
      type: "refresh",
      ver: 0,
      expInSec: refreshTtl,
    });
    const refreshTokenHash = this.crypto.hash(refreshJwt);

    const session = await this.store.createSession({
      id: sessionId,
      userId: user.id,
      sessionTokenHash,
      refreshTokenHash,
      expiresAt: new Date(Date.now() + sessionTtl * 1000),
      refreshVersion: 0,
      userAgent: client.userAgent,
      ip: client.ip,
      lastSeenAt: new Date(),
      lastAuthenticatedAt: new Date(),
      createdAt: new Date(),
    });

    return this.buildAuthResult(user, session, rawSessionToken, refreshJwt);
  }

  private buildAuthResult(
    user: AuthUser,
    session: AuthSession,
    rawSessionToken: string,
    refreshJwt: string,
  ): AuthResult {
    const accessTtl = this.config.session?.accessTokenTtlSec ?? 15 * 60;
    const refreshTtl =
      this.config.session?.refreshTokenTtlSec ?? 30 * 24 * 3600;
    const sessionTtl = this.config.session?.sessionTtlSec ?? 30 * 24 * 3600;

    const accessToken = this.jwt.sign({
      sub: user.id,
      sid: session.id,
      type: "access",
      expInSec: accessTtl,
    });

    const csrfToken = this.crypto.randomToken(24);

    const cookies = [
      this.makeCookie(this.cookieNames.session, rawSessionToken, {
        maxAge: sessionTtl,
      }),
      this.makeCookie(this.cookieNames.refresh, refreshJwt, {
        maxAge: refreshTtl,
      }),
      this.makeCookie(this.cookieNames.csrf, csrfToken, {
        maxAge: sessionTtl,
        httpOnly: false,
      }),
    ];

    const publicUser = this.toPublicUser(user);
    const publicSession = this.toPublicSession(session);

    return {
      user: publicUser,
      session: publicSession,
      tokens: { accessToken, refreshToken: refreshJwt, expiresIn: accessTtl },
      cookies,
      toResponse: (body = {}, status = 200) => {
        const headers = new Headers({ "Content-Type": "application/json" });
        for (const c of cookies) headers.append("Set-Cookie", c);
        const payload = {
          success: true,
          user: publicUser,
          session: publicSession,
          ...body,
        };
        return new Response(JSON.stringify(payload), { status, headers });
      },
    };
  }

  makeCookie(
    name: string,
    value: string,
    opts: { maxAge: number; httpOnly?: boolean },
  ): string {
    const secure =
      this.config.cookies?.secure ?? process.env.NODE_ENV === "production";
    const sameSite = this.config.cookies?.sameSite ?? "Lax";
    const path = this.config.cookies?.path ?? "/";

    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${opts.maxAge}; SameSite=${sameSite}`;
    if (opts.httpOnly ?? true) cookie += "; HttpOnly";
    if (secure) cookie += "; Secure";
    if (this.config.cookies?.domain)
      cookie += `; Domain=${this.config.cookies.domain}`;
    return cookie;
  }

  parseCookies(header: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of header.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      try {
        out[decodeURIComponent(trimmed.slice(0, eq))] = decodeURIComponent(
          trimmed.slice(eq + 1),
        );
      } catch {}
    }
    return out;
  }

  signup = this.signUp.bind(this);
  login = this.signIn.bind(this);
  logout = this.signOut.bind(this);
}

// ──────────────────────────────────────────────────────────────────────────
// 9. Subsystem: Password Management
// ──────────────────────────────────────────────────────────────────────────

export class AuthPasswordSubsystem {
  constructor(private auth: Auth) {}

  async requestReset(email: string, req?: Request): Promise<void> {
    const formatted = email.toLowerCase().trim();
    const client = this.auth.extractClient(req);

    await this.auth.rateLimiter.assertAllowed(
      "passwordReset",
      client.ip,
      formatted,
    );
    await this.auth.rateLimiter.recordFailure(
      "passwordReset",
      client.ip,
      formatted,
    );

    const user = await this.auth.store.findUserByEmail(formatted);
    if (!user) return;

    const rawToken = this.auth.crypto.randomToken(32);
    const tokenHash = this.auth.crypto.hash(rawToken);

    await this.auth.store.deleteTokensByUserId(user.id, "password_reset");
    await this.auth.store.createToken({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      type: "password_reset",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const link = `${this.auth.config.email?.appUrl}/auth/reset-password?token=${rawToken}`;
    const templateFn =
      this.auth.config.email?.templates?.passwordReset ??
      ((d) => ({
        subject: "Reset your password",
        html: `<p>Click here to reset your password: <a href="${d.link}">${d.link}</a></p>`,
        text: `Reset your password: ${d.link}`,
      }));

    const content = templateFn({ email: user.email, link, token: rawToken });
    await this.auth.mailer
      .to(user.email)
      .subject(content.subject)
      .html(content.html)
      .text(content.text ?? content.html)
      .deliver();
  }

  async reset(rawToken: string, newPassword: string): Promise<void> {
    this.auth.validatePasswordStrength(newPassword);

    const tokenHash = this.auth.crypto.hash(rawToken);
    const record = await this.auth.store.consumeToken(
      tokenHash,
      "password_reset",
    );
    if (!record)
      throw new AuthError("Invalid or expired password reset token", 400);

    const passwordHash = await this.auth.crypto.hashPassword(newPassword);
    const user = await this.auth.store.findUserById(record.userId);
    if (!user) throw new AuthError("User not found", 404);

    await this.auth.store.updateUser(user.id, {
      passwordHash,
      credentialVersion: user.credentialVersion + 1,
    });

    await this.auth.store.deleteSessionsByUserId(user.id);
    await this.auth.emit("password.reset", { userId: user.id });
  }

  async change(
    userId: string,
    currentPass: string,
    newPass: string,
    currentSessionId?: string,
  ): Promise<void> {
    this.auth.validatePasswordStrength(newPass);

    const user = await this.auth.store.findUserById(userId);
    if (!user || !user.passwordHash)
      throw new AuthError("No password set on this account");

    const valid = await this.auth.crypto.verifyPassword(
      currentPass,
      user.passwordHash,
    );
    if (!valid) throw new UnauthorizedError("Incorrect current password");

    const passwordHash = await this.auth.crypto.hashPassword(newPass);
    await this.auth.store.updateUser(userId, {
      passwordHash,
      credentialVersion: user.credentialVersion + 1,
    });

    // Invalidate other sessions while preserving current session if provided
    const sessions = await this.auth.store.listSessionsByUserId(userId);
    for (const sess of sessions) {
      if (sess.id !== currentSessionId) {
        await this.auth.store.deleteSession(sess.id);
      }
    }

    await this.auth.emit("password.changed", { userId });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 10. Subsystem: MFA & Recovery Codes
// ──────────────────────────────────────────────────────────────────────────

export class AuthMfa {
  constructor(private auth: Auth) {}

  async beginSetup(userId: string, appName = "Yatta App") {
    const user = await this.auth.store.findUserById(userId);
    if (!user) throw new AuthError("User not found", 404);

    const secret = authenticator.generateSecret();

    /*
     * Keyed by user, because confirmSetup only knows the user id — but the seed
     * goes in `data`, not in the key.
     *
     * The store indexes on `challenge`, so putting the encrypted seed there made
     * it unreadable: `get(userId)` never matched and every enrolment reported
     * "timed out", so 2FA could not be turned on at all.
     *
     * The seed is still held encrypted: the challenge store is often the least
     * protected of the stores, and an unencrypted TOTP seed there is a standing
     * 2FA bypass.
     */
    await this.auth.challengeStore.set({
      id: crypto.randomUUID(),
      challenge: mfaSetupKey(userId),
      data: this.auth.crypto.encrypt(secret),
      type: "registration",
      userId,
      expiresAt: new Date(Date.now() + 600 * 1000),
    });

    return {
      secret,
      uri: authenticator.keyuri(user.email, appName, secret),
    };
  }

  /**
   * Whether a TOTP code is valid for this user right now.
   *
   * @returns `true`, `false`, or `"replayed"`.
   *
   * `replayed` is distinguished because the situation is not the user's mistake. A
   * code that is genuinely correct but inside a time-step already used is rejected —
   * rightly — but reported as "that code is not valid" it reads as a typo, and the
   * user retypes a code that will never work. It happens on enrolment: the code used
   * to set 2FA up consumes the step, so signing in inside the same 30 seconds is
   * refused.
   */
  verifyCode(secret: string, code: string, user?: AuthUser): boolean | "replayed" {
    const step = Math.floor(Date.now() / 30000);
    if (user?.lastMfaStep && user.lastMfaStep >= step) {
      // Only a replay if the code itself is good for this step. A wrong code in a
      // spent step is just wrong, and saying "already used" would be misleading.
      return authenticator.check(code, secret) ? "replayed" : false;
    }
    const valid = authenticator.check(code, secret);
    if (valid && user) {
      this.auth.store
        .updateUser(user.id, { lastMfaStep: step })
        .catch(console.error);
    }
    return valid;
  }

  async confirmSetup(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.auth.store.findUserById(userId);
    if (!user) throw new AuthError("User not found", 404);

    let setupSecret: string | null = null;
    const pending = await this.auth.challengeStore.get(mfaSetupKey(userId));

    if (pending && pending.type === "registration" && pending.data) {
      setupSecret = this.auth.crypto.decrypt(pending.data);
    } else {
      throw new AuthError("MFA setup timed out. Please begin setup again.");
    }

    if (this.verifyCode(setupSecret, code, user) !== true) {
      throw new AuthError("Invalid TOTP verification code.");
    }

    // Same key it was written under, or the pending entry survives and the
    // enrolment can be replayed.
    await this.auth.challengeStore.delete(mfaSetupKey(userId));

    const encryptedSecret = this.auth.crypto.encrypt(setupSecret);

    const recoveryCodes: string[] = [];
    const hashedCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const codePart =
        `${this.auth.crypto.randomToken(3)}-${this.auth.crypto.randomToken(3)}-${this.auth.crypto.randomToken(3)}`.toUpperCase();
      recoveryCodes.push(codePart);
      hashedCodes.push(
        this.auth.crypto.hmac(codePart, this.auth.crypto.recoveryKey),
      );
    }

    await this.auth.store.updateUser(userId, {
      encryptedTwoFactorSecret: encryptedSecret,
      twoFactorRecoveryCodes: hashedCodes,
      twoFactorEnabled: true,
    });

    await this.auth.emit("mfa.enabled", { userId });
    return { recoveryCodes };
  }

  async disable(req: Request, code?: string): Promise<void> {
    const authState = await this.auth.requireRecentAuth(req);
    const user = await this.auth.store.findUserById(authState.user.id);
    if (!user || !user.twoFactorEnabled) return;

    /*
     * A code is mandatory. Skipping it meant any session younger than the
     * recent-auth window could turn 2FA off — and lastAuthenticatedAt is set at
     * login, so that is exactly the window right after signing in.
     */
    if (!code) {
      throw new AuthError(
        "A two-factor authentication code is required to disable MFA",
        400,
      );
    }

    if (!user.encryptedTwoFactorSecret) {
      throw new AuthError("Two-factor authentication is not configured", 400);
    }

    const secret = this.auth.crypto.decrypt(user.encryptedTwoFactorSecret);
    if (this.verifyCode(secret, code, user) !== true) {
      throw new UnauthorizedError("Invalid two-factor authentication code");
    }

    await this.auth.store.updateUser(user.id, {
      encryptedTwoFactorSecret: null,
      twoFactorRecoveryCodes: null,
      twoFactorEnabled: false,
    });

    await this.auth.emit("mfa.disabled", { userId: user.id }, req);
  }

  async consumeRecoveryCode(userId: string, rawCode: string): Promise<boolean> {
    const user = await this.auth.store.findUserById(userId);
    if (!user || !user.twoFactorRecoveryCodes) return false;

    const normalized = rawCode.toUpperCase().trim();
    const codeHash = this.auth.crypto.hmac(
      normalized,
      this.auth.crypto.recoveryKey,
    );
    const idx = user.twoFactorRecoveryCodes.findIndex((h) =>
      this.auth.crypto.timingSafeEqual(h, codeHash),
    );

    if (idx === -1) return false;

    const remaining = [...user.twoFactorRecoveryCodes];
    remaining.splice(idx, 1);
    await this.auth.store.updateUser(userId, {
      twoFactorRecoveryCodes: remaining,
    });
    await this.auth.emit("mfa.recovery_code_used", { userId });
    return true;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 11. Subsystem: Passkeys / WebAuthn
// ──────────────────────────────────────────────────────────────────────────

export class AuthPasskey {
  constructor(private auth: Auth) {}

  private get rpConfig() {
    if (!this.auth.config.passkeys) {
      throw new AuthError("Passkeys are not configured in AuthConfig.passkeys");
    }
    return this.auth.config.passkeys;
  }

  async generateRegistrationOptions(userId: string) {
    const user = await this.auth.store.findUserById(userId);
    if (!user) throw new AuthError("User not found", 404);

    const userPasskeys = await this.auth.store.listPasskeysByUserId(userId);

    const options = await generateRegistrationOptions({
      rpName: this.rpConfig.rpName,
      rpID: this.rpConfig.rpID,
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: userPasskeys.map((p) => ({
        id: p.id,
        transports: p.transports,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await this.auth.challengeStore.set({
      id: crypto.randomUUID(),
      challenge: options.challenge,
      type: "registration",
      userId: user.id,
      expiresAt: new Date(Date.now() + 300 * 1000),
    });

    return options;
  }

  async verifyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    expectedChallenge: string,
    name?: string,
  ) {
    const challengeData = await this.auth.challengeStore.get(expectedChallenge);
    if (
      !challengeData ||
      challengeData.type !== "registration" ||
      challengeData.userId !== userId
    ) {
      throw new AuthError("Passkey challenge expired or invalid", 400);
    }
    await this.auth.challengeStore.delete(expectedChallenge);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.rpConfig.origin,
      expectedRPID: this.rpConfig.rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new AuthError("Passkey registration verification failed", 400);
    }

    const { registrationInfo } = verification;
    const legacyInfo = registrationInfo as any;
    const cred = legacyInfo.credential ?? registrationInfo;

    await this.auth.store.savePasskey({
      id: cred.id ?? legacyInfo.credentialID,
      userId,
      name: name ?? "Passkey",
      publicKey: cred.publicKey ?? legacyInfo.credentialPublicKey,
      counter: cred.counter ?? legacyInfo.counter ?? 0,
      transports: response.response.transports as
        | AuthenticatorTransport[]
        | undefined,
      createdAt: new Date(),
    });

    await this.auth.emit("passkey.added", { userId, passkeyId: cred.id });
    return { verified: true };
  }

  async generateAuthenticationOptions(userEmail?: string, req?: Request) {
    const client = this.auth.extractClient(req);
    await this.auth.rateLimiter.assertAllowed("passkey", client.ip);

    let allowCredentials:
      | { id: string; transports?: AuthenticatorTransport[] }[]
      | undefined;

    if (userEmail) {
      const user = await this.auth.store.findUserByEmail(
        userEmail.toLowerCase().trim(),
      );
      if (user) {
        const userPasskeys = await this.auth.store.listPasskeysByUserId(
          user.id,
        );
        allowCredentials = userPasskeys.map((p) => ({
          id: p.id,
          transports: p.transports,
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpConfig.rpID,
      allowCredentials,
      userVerification: "preferred",
    });

    await this.auth.challengeStore.set({
      id: crypto.randomUUID(),
      challenge: options.challenge,
      type: "authentication",
      expiresAt: new Date(Date.now() + 300 * 1000),
    });

    return options;
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    req?: Request,
  ): Promise<AuthResult | MfaChallenge> {
    const client = this.auth.extractClient(req);
    await this.auth.rateLimiter.assertAllowed("passkey", client.ip);

    const challengeData = await this.auth.challengeStore.get(expectedChallenge);
    if (!challengeData || challengeData.type !== "authentication") {
      await this.auth.rateLimiter.recordFailure("passkey", client.ip);
      throw new AuthError(
        "Passkey authentication challenge expired or not found",
        400,
      );
    }
    await this.auth.challengeStore.delete(expectedChallenge);

    const passkey = await this.auth.store.findPasskeyById(response.id);
    if (!passkey) {
      await this.auth.rateLimiter.recordFailure("passkey", client.ip);
      throw new AuthError("Passkey credential not registered", 404);
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.rpConfig.origin,
      expectedRPID: this.rpConfig.rpID,
      credential: {
        id: passkey.id,
        publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>,
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });

    if (!verification.verified) {
      await this.auth.rateLimiter.recordFailure("passkey", client.ip);
      throw new UnauthorizedError("Passkey authentication failed");
    }

    await this.auth.store.updatePasskey(passkey.id, {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    });

    const user = await this.auth.store.findUserById(passkey.userId);
    if (!user) throw new AuthError("User not found", 404);

    if (user.twoFactorEnabled) {
      return this.auth.issueMfaTicket(user);
    }

    await this.auth.rateLimiter.recordSuccess("passkey", client.ip);
    await this.auth.emit(
      "passkey.used",
      { userId: user.id, passkeyId: passkey.id },
      req,
    );
    return this.auth.createAuthResult(user, client);
  }

  async list(userId: string) {
    return this.auth.store.listPasskeysByUserId(userId);
  }

  async rename(userId: string, id: string, name: string) {
    const cred = await this.auth.store.findPasskeyById(id);
    if (!cred || cred.userId !== userId)
      throw new ForbiddenError("Not authorized to rename this passkey");
    await this.auth.store.updatePasskey(id, { name });
  }

  async remove(userId: string, id: string) {
    const cred = await this.auth.store.findPasskeyById(id);
    if (!cred || cred.userId !== userId)
      throw new ForbiddenError("Not authorized to delete this passkey");
    await this.auth.store.deletePasskey(id);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 12. Subsystem: OAuth with PKCE & Verified Linking
// ──────────────────────────────────────────────────────────────────────────

export interface OAuthProvider {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  usePkce?: boolean;
  mapProfile: (data: Record<string, unknown>) => {
    id: string;
    email: string;
    emailVerified: boolean;
    name?: string;
  };
}

export class AuthOAuth {
  private providers = new Map<string, OAuthProvider>();

  constructor(private auth: Auth) {
    this.registerDefaults();
  }

  registerProvider(provider: OAuthProvider) {
    this.providers.set(provider.name, provider);
  }

  private registerDefaults() {
    this.registerProvider({
      name: "github",
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
      mapProfile: (data) => ({
        id: String(data.id),
        email: String(data.email ?? ""),
        // A public profile email is not proof of ownership, and GitHub only
        // publishes one if the user chose to. Treat it as unverified so an
        // unconfirmed address can never be used to claim an existing account;
        // fetching /user/emails is the way to verify properly.
        emailVerified: false,
        name: (data.name ?? data.login) as string,
      }),
    });

    this.registerProvider({
      name: "google",
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
      usePkce: true,
      mapProfile: (data) => ({
        id: String(data.sub),
        email: String(data.email ?? ""),
        emailVerified: Boolean(data.email_verified),
        name: data.name as string,
      }),
    });
  }

  async getAuthorizationUrl(
    providerName: string,
    redirectUri: string,
  ): Promise<{ url: string; state: string; codeVerifier?: string }> {
    const p = this.providers.get(providerName);
    if (!p)
      throw new AuthError(`OAuth provider "${providerName}" is not registered`);

    const rawState = this.auth.crypto.randomToken(24);
    const signature = crypto
      .createHmac("sha256", this.auth.crypto.oauthKey)
      .update(rawState)
      .digest("base64url");
    const state = `${rawState}.${signature}`;

    const params = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: p.scopes.join(" "),
      state,
    });

    let codeVerifier: string | undefined;
    if (p.usePkce) {
      codeVerifier = this.auth.crypto.randomToken(32);
      const codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      params.append("code_challenge", codeChallenge);
      params.append("code_challenge_method", "S256");
    }

    return {
      url: `${p.authorizeUrl}?${params.toString()}`,
      state,
      codeVerifier,
    };
  }

  /**
   * Completes an OAuth sign-in, or links a provider to the caller's own account.
   *
   * `linkToUserId` has been removed, and deliberately not replaced with
   * `linkToSessionToken`-style indirection of the same shape. Taking a user id from
   * the caller and checking only that it *exists* is account takeover: anyone who can
   * run their own Google sign-in and guess a victim's id passes their identity to
   * `linkIdentity`, and from then on Google signs them in as the victim.
   *
   * To link, pass `req` with the caller's own session cookie. The user is resolved
   * from that session inside this function, so the answer cannot be forged.
   */
  /**
   * The user id behind a request's own session, or `null`.
   *
   * Where an operation must act on the caller rather than on a value they supplied.
   * Returning `null` rather than throwing keeps the call sites readable: "no session"
   * and "a session" are two ordinary cases, and only the caller knows which it is.
   *
   * Goes through `getSession` rather than reading the cookie itself, so bearer tokens
   * and the JWT path resolve here too. Reading only the cookie would make linking work
   * in a browser and silently do nothing for a native client.
   *
   * `autoRefresh` is off: this decides who the request is, and a failed refresh should
   * leave that as no answer rather than minting a new session to find out.
   */
  private async sessionUserId(req: Request | undefined): Promise<string | null> {
    if (!req) return null;

    const resolved = await this.auth
      .getSession(req, { autoRefresh: false })
      .catch(() => null);

    return resolved?.user.id ?? null;
  }

  async handleCallback(input: {
    provider: string;
    code: string;
    state: string;
    expectedState: string;
    redirectUri: string;
    codeVerifier?: string;
    req?: Request;
  }): Promise<AuthResult | MfaChallenge> {
    const {
      provider,
      code,
      state,
      expectedState,
      redirectUri,
      codeVerifier,
      req,
    } = input;
    const p = this.providers.get(provider);
    if (!p) throw new AuthError(`Provider ${provider} not found`);

    // Verify State & HMAC
    if (!this.auth.crypto.timingSafeEqual(state, expectedState)) {
      throw new UnauthorizedError("Invalid or forged OAuth state");
    }

    const [rawState, sig] = state.split(".");
    if (!rawState || !sig) throw new UnauthorizedError("Malformed OAuth state");
    const expectedSig = crypto
      .createHmac("sha256", this.auth.crypto.oauthKey)
      .update(rawState)
      .digest("base64url");
    if (!this.auth.crypto.timingSafeEqual(sig, expectedSig)) {
      throw new UnauthorizedError("Tampered OAuth state signature");
    }

    const tokenParams = new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    if (codeVerifier) tokenParams.append("code_verifier", codeVerifier);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let tokenData: { access_token?: string };
    try {
      const tokenRes = await fetch(p.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: tokenParams,
        signal: controller.signal,
      });

      if (!tokenRes.ok) {
        throw new AuthError(
          "OAuth provider rejected authorization code token exchange",
          400,
        );
      }
      tokenData = (await tokenRes.json()) as { access_token?: string };
    } finally {
      clearTimeout(timeout);
    }

    if (!tokenData.access_token)
      throw new AuthError("OAuth provider returned no access token");

    const userController = new AbortController();
    const userTimeout = setTimeout(() => userController.abort(), 10000);

    let profile: ReturnType<typeof p.mapProfile>;
    try {
      const userRes = await fetch(p.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "User-Agent": "Yatta-Auth",
        },
        signal: userController.signal,
      });

      if (!userRes.ok)
        throw new AuthError("Failed to fetch user profile from OAuth provider");
      const rawProfile = (await userRes.json()) as Record<string, unknown>;
      profile = p.mapProfile(rawProfile);
    } finally {
      clearTimeout(userTimeout);
    }

    if (!profile.email) {
      throw new AuthError(
        "OAuth provider did not release an email address for this user",
        400,
      );
    }

    let identity = await this.auth.store.findIdentity(p.name, profile.id);
    let user: AuthUser | null = null;

    if (identity) {
      user = await this.auth.store.findUserById(identity.userId);
    } else {
      /*
       * Linking resolves the user from the caller's own session, never from a
       * parameter. See the note on `handleCallback`.
       */
      const sessionUserId = await this.sessionUserId(req);

      if (sessionUserId) {
        user = await this.auth.store.findUserById(sessionUserId);
        if (!user) {
          // The session points at a user that is gone. Not an error to work around
          // by creating an account — that would attach the provider to whoever
          // happens to hold that address.
          throw new AuthError(
            "Cannot link OAuth identity: your session refers to an account that no longer exists.",
            401,
          );
        }
      } else if (profile.emailVerified) {
        user = await this.auth.store.findUserByEmail(
          profile.email.toLowerCase().trim(),
        );
      }

      if (!user) {
        /*
         * An unverified provider email that already exists locally must NOT
         * create a second user: the unique constraint would turn that into a
         * 500, and where it did not, the attacker kept a usable account under
         * a victim's address.
         *
         * Fail loudly instead — the correct resolution is for the local account
         * owner to verify their address, then link.
         */
        const email = profile.email.toLowerCase().trim();
        const existing = await this.auth.store.findUserByEmail(email);

        if (existing) {
          if (!profile.emailVerified) {
            throw new AuthError(
              "An account already exists for this email. Verify it, then sign in to link this provider.",
              409,
            );
          }

          /*
           * Verified provider email matched a local account that was never
           * verified — the classic pre-hijacking shape: an attacker registers
           * the victim's address first, then signs in with a provider that
           * does verify it. Mark the address verified and revoke the password,
           * so the pre-registered credentials stop working.
           */
          user = await this.auth.store.updateUser(existing.id, {
            emailVerified: true,
            // Revokes the pre-registered credentials: `undefined` is how this
            // codebase represents "no password" (OAuth-only accounts).
            passwordHash: undefined,
          });
        } else {
          user = await this.auth.store.createUser({
            id: crypto.randomUUID(),
            email,
            roles: ["user"],
            emailVerified: profile.emailVerified,
            twoFactorEnabled: false,
            credentialVersion: 1,
            metadata: { name: profile.name },
          });
        }
      }

      await this.auth.store.createIdentity({
        id: crypto.randomUUID(),
        userId: user.id,
        provider: p.name,
        providerAccountId: profile.id,
        email: profile.email,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await this.auth.emit(
        "oauth.linked",
        { userId: user.id, provider: p.name },
        req,
      );
    }

    if (!user) throw new AuthError("Unable to resolve authenticating user");

    if (user.twoFactorEnabled) {
      return this.auth.issueMfaTicket(user);
    }

    const client = this.auth.extractClient(req);
    return this.auth.createAuthResult(user, client);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 13. Subsystem: Magic Links
// ──────────────────────────────────────────────────────────────────────────

export class AuthMagicLink {
  constructor(private auth: Auth) {}

  async request(email: string, req?: Request): Promise<void> {
    const formatted = email.toLowerCase().trim();
    const client = this.auth.extractClient(req);

    await this.auth.rateLimiter.assertAllowed(
      "magicLink",
      client.ip,
      formatted,
    );
    await this.auth.rateLimiter.recordFailure(
      "magicLink",
      client.ip,
      formatted,
    );

    let user = await this.auth.store.findUserByEmail(formatted);
    if (!user) {
      user = await this.auth.store.createUser({
        id: crypto.randomUUID(),
        email: formatted,
        roles: ["user"],
        emailVerified: false,
        twoFactorEnabled: false,
        credentialVersion: 1,
      });
    }

    const rawToken = this.auth.crypto.randomToken(32);
    const tokenHash = this.auth.crypto.hash(rawToken);

    await this.auth.store.deleteTokensByUserId(user.id, "magic_link");
    await this.auth.store.createToken({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      type: "magic_link",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const link = `${this.auth.config.email?.appUrl}/auth/magic?token=${rawToken}`;
    const templateFn =
      this.auth.config.email?.templates?.magicLink ??
      ((d) => ({
        subject: "Your Magic Sign-in Link",
        html: `<p>Click here to sign in: <a href="${d.link}">${d.link}</a></p>`,
        text: `Your sign-in link: ${d.link}`,
      }));

    const content = templateFn({ email: user.email, link, token: rawToken });
    await this.auth.mailer
      .to(user.email)
      .subject(content.subject)
      .html(content.html)
      .text(content.text ?? content.html)
      .deliver();

    await this.auth.emit("magic_link.requested", { userId: user.id }, req);
  }

  async verify(
    rawToken: string,
    req?: Request,
  ): Promise<AuthResult | MfaChallenge> {
    const tokenHash = this.auth.crypto.hash(rawToken);
    const record = await this.auth.store.consumeToken(tokenHash, "magic_link");
    if (!record) throw new AuthError("Invalid or expired magic link", 400);

    const user = await this.auth.store.findUserById(record.userId);
    if (!user) throw new AuthError("User not found", 404);

    if (!user.emailVerified) {
      await this.auth.store.updateUser(user.id, { emailVerified: true });
    }

    if (user.twoFactorEnabled) {
      return this.auth.issueMfaTicket(user);
    }

    const client = this.auth.extractClient(req);
    await this.auth.emit("magic_link.used", { userId: user.id }, req);
    return this.auth.createAuthResult(user, client);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 14. Subsystem: API Keys
// ──────────────────────────────────────────────────────────────────────────

export class AuthApiKeys {
  constructor(private auth: Auth) {}

  async create(
    userId: string,
    options: { name: string; scopes?: string[]; expiresAt?: Date },
  ): Promise<{ apiKey: string; record: AuthApiKey }> {
    const rawKey = `yk_live_${this.auth.crypto.randomToken(24)}`;
    const prefix = rawKey.slice(0, 12);
    const keyHash = this.auth.crypto.hash(rawKey);

    const record = await this.auth.store.createApiKey({
      id: crypto.randomUUID(),
      userId,
      name: options.name,
      prefix,
      keyHash,
      scopes: options.scopes ?? ["read"],
      expiresAt: options.expiresAt,
      createdAt: new Date(),
    });

    return { apiKey: rawKey, record };
  }

  async verify(
    rawKey: string,
  ): Promise<{ user: PublicUser; apiKey: AuthApiKey } | null> {
    if (!rawKey.startsWith("yk_live_")) return null;
    const keyHash = this.auth.crypto.hash(rawKey);
    const record = await this.auth.store.findApiKeyByHash(keyHash);

    if (!record) return null;
    if (record.expiresAt && record.expiresAt < new Date()) return null;

    const user = await this.auth.store.findUserById(record.userId);
    if (!user) return null;

    // Throttle lastUsedAt writes
    if (
      !record.lastUsedAt ||
      Date.now() - record.lastUsedAt.getTime() > 300000
    ) {
      await this.auth.store.updateApiKey(record.id, { lastUsedAt: new Date() });
    }

    return { user: this.auth.toPublicUser(user), apiKey: record };
  }

  async list(userId: string) {
    return this.auth.store.listApiKeysByUserId(userId);
  }

  async revoke(userId: string, id: string) {
    const keys = await this.auth.store.listApiKeysByUserId(userId);
    const key = keys.find((k) => k.id === id);
    if (!key) throw new ForbiddenError("Not authorized to revoke this API key");
    await this.auth.store.deleteApiKey(id);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 15. Factory & Singleton
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_AUTH_KEY = Symbol.for("yatta.auth.default");
const g = globalThis as unknown as { [GLOBAL_AUTH_KEY]?: Auth };

export function createAuth(config: AuthConfig): Auth {
  const instance = new Auth(config);
  g[GLOBAL_AUTH_KEY] = instance;
  return instance;
}

export function getDefaultAuth(): Auth {
  if (!g[GLOBAL_AUTH_KEY]) {
    throw new AuthError(
      "Auth has not been initialized. Call createAuth({ secret, ... }) first.",
    );
  }
  return g[GLOBAL_AUTH_KEY]!;
}

export const auth: Auth = new Proxy(function () {} as unknown as Auth, {
  get(_target, prop, receiver) {
    if (
      prop === "name" ||
      prop === "length" ||
      prop === "prototype" ||
      prop === Symbol.toPrimitive
    ) {
      return Reflect.get(_target, prop, receiver);
    }
    const instance = getDefaultAuth();
    const val = (instance as any)[prop];
    return typeof val === "function" ? val.bind(instance) : val;
  },
});
