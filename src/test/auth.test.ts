import { describe, it, expect, beforeEach } from "bun:test";
import {
  createAuth,
  AuthCrypto,
  AuthJwt,
  PermissionManager,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  type PublicUser,
  type AuthSession,
  type TokenPair,
} from "../types/auth";

describe("Yatta Auth — Enterprise Security & Authentication Engine", () => {
  const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";
  let auth: ReturnType<typeof createAuth>;
  let store: MemoryAuthStore;
  let cryptoUtil: AuthCrypto;

  beforeEach(() => {
    store = new MemoryAuthStore();
    cryptoUtil = new AuthCrypto(SECRET);

    auth = createAuth({
      secret: SECRET,
      store,
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      security: {
        allowUnverifiedSession: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireNumbers: true,
        requireUppercase: true,
      },
      rateLimits: {
        enabled: true,
        login: { maxAttempts: 3, windowSec: 60, lockoutSec: 120 },
      },
      roles: {
        admin: { can: ["*:*"] },
        editor: { can: ["posts:write", "posts:read"] },
        viewer: { can: ["posts:read"] },
      },
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Type-Level Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Type-Level Tests", () => {
    it("should guarantee PublicUser does not expose password hashes or MFA secrets", () => {
      const publicUser: PublicUser = {
        id: "usr_123",
        email: "user@example.com",
        roles: ["member"],
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Compile-time: passwordHash must not exist on PublicUser
      // @ts-expect-error passwordHash should not be accessible on PublicUser
      const _ = publicUser.passwordHash;

      expect(publicUser.id).toBe("usr_123");
      expect(publicUser.email).toBe("user@example.com");
    });

    it("should structure TokenPair with accessToken and refreshToken", () => {
      const tokens: TokenPair = {
        accessToken: "access.jwt.token",
        refreshToken: "refresh.jwt.token",
        expiresIn: 900,
      };

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.expiresIn).toBe(900);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Security & Negative Exploitation Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Security & Negative Exploitation Tests", () => {
    it("should trigger RateLimitError and lockout after exceeding maximum failed login attempts", async () => {
      const email = "victim@domain.com";
      await auth.signup({ email, password: "Password123!" });

      // Attempt 1: Fail
      await expect(auth.login({ email, password: "WrongPassword!" })).rejects.toThrow(UnauthorizedError);

      // Attempt 2: Fail
      await expect(auth.login({ email, password: "WrongPassword!" })).rejects.toThrow(UnauthorizedError);

      // Attempt 3: Fail
      await expect(auth.login({ email, password: "WrongPassword!" })).rejects.toThrow(UnauthorizedError);

      // Attempt 4: Must be locked out by rate limiter
      await expect(auth.login({ email, password: "WrongPassword!" })).rejects.toThrow(RateLimitError);
    });

    it("should reject weak passwords violating password policy", async () => {
      // Too short
      await expect(
        auth.signup({ email: "weak1@test.com", password: "123" }),
      ).rejects.toThrow(/at least 8 characters/);

      // Missing uppercase
      await expect(
        auth.signup({ email: "weak2@test.com", password: "password123" }),
      ).rejects.toThrow(/uppercase/);

      // Missing number
      await expect(
        auth.signup({ email: "weak3@test.com", password: "PasswordOnly" }),
      ).rejects.toThrow(/number/);
    });

    it("should detect and reject tampered JWT signatures", () => {
      const jwt = new AuthJwt(Buffer.from(SECRET), cryptoUtil);
      const token = jwt.sign({ sub: "user-1", type: "access", sid: "sess-1", expInSec: 3600 });

      // Tamper with signature
      const [h, b, s] = token.split(".");
      const tamperedSignature = s + "invalid";
      const tamperedToken = `${h}.${b}.${tamperedSignature}`;

      expect(jwt.verify(tamperedToken)).toBeNull();
    });

    it("should reject tampered AES-256-GCM cipher payloads", () => {
      const plain = "super_sensitive_api_secret_key";
      const encrypted = cryptoUtil.encrypt(plain);

      const parts = encrypted.split(":");
      // Tamper with ciphertext
      const tamperedContent = parts[2]!.slice(0, -4) + "ffff";
      const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedContent}`;

      expect(() => {
        cryptoUtil.decrypt(tamperedPayload);
      }).toThrow();
    });

    it("should detect cyclic role inheritance during initialization", () => {
      expect(() => {
        new PermissionManager({
          roleA: { can: ["read"], inherits: ["roleB"] },
          roleB: { can: ["write"], inherits: ["roleC"] },
          roleC: { can: ["admin"], inherits: ["roleA"] }, // Cycle: A -> B -> C -> A
        });
      }).toThrow(/Cyclic role inheritance detected/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Unit Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Unit Tests", () => {
    it("should hash and verify passwords using Bun native Argon2id", async () => {
      const password = "SecurePassword123!";
      const hash = await cryptoUtil.hashPassword(password);

      expect(hash).toContain("$argon2id$");

      const isValid = await cryptoUtil.verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await cryptoUtil.verifyPassword("IncorrectPassword", hash);
      expect(isInvalid).toBe(false);
    });

    it("should perform AES-256-GCM encryption and decryption round-trip", () => {
      const secretData = "otp-secret-BASE32ENCODED-12345678";
      const cipherText = cryptoUtil.encrypt(secretData);

      expect(cipherText).not.toBe(secretData);
      expect(cipherText.split(":").length).toBe(3); // iv:tag:content

      const decrypted = cryptoUtil.decrypt(cipherText);
      expect(decrypted).toBe(secretData);
    });

    it("should evaluate wildcard and hierarchical role permissions", () => {
      const pm = new PermissionManager({
        admin: { can: ["*:*"] },
        editor: { can: ["posts:write", "posts:read"], inherits: ["viewer"] },
        viewer: { can: ["comments:read"] },
      });

      // Admin has universal permission
      expect(pm.check(["admin"], "execute", "anything")).toBe(true);

      // Editor has explicit and inherited permissions
      expect(pm.check(["editor"], "write", "posts")).toBe(true);
      expect(pm.check(["editor"], "read", "comments")).toBe(true); // Inherited from viewer
      expect(pm.check(["editor"], "charge", "billing")).toBe(false);

      // Viewer only has comments:read
      expect(pm.check(["viewer"], "read", "comments")).toBe(true);
      expect(pm.check(["viewer"], "write", "posts")).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Integration & State Machine Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Integration & State Machine Tests", () => {
    it("should complete full user lifecycle: signup -> login -> session -> refresh -> logout", async () => {
      const email = "lifecycle@test.com";
      const password = "ValidPassword123!";

      // 1. SIGNUP
      const signupRes = (await auth.signup({ email, password, metadata: { source: "test" } })) as any;
      expect(signupRes.user.email).toBe(email);
      expect(signupRes.tokens.accessToken).toBeDefined();

      // 2. LOGIN
      const loginRes = (await auth.login({ email, password })) as any;
      expect(loginRes.user.id).toBe(signupRes.user.id);
      expect(loginRes.session).toBeDefined();

      // 3. AUTHENTICATE REQUEST VIA BEARER TOKEN
      const authReq = new Request("http://localhost/protected", {
        headers: { Authorization: `Bearer ${loginRes.tokens.accessToken}` },
      });
      const sessionContext = await auth.getSession(authReq);
      expect(sessionContext).not.toBeNull();
      expect(sessionContext?.user.email).toBe(email);

      // 4. REFRESH TOKEN ROTATION
      const refreshRes = await auth.refresh(loginRes.tokens.refreshToken);
      expect(refreshRes.tokens.accessToken).toBeDefined();
      expect(refreshRes.tokens.refreshToken).not.toBe(loginRes.tokens.refreshToken); // Token rotated

      // 5. LOGOUT
      const logoutReq = new Request("http://localhost/logout", {
        headers: { Cookie: refreshRes.cookies[0]! },
      });
      await auth.logout(logoutReq);
      const afterLogout = await auth.getSession(authReq);
      expect(afterLogout).toBeNull();
    });

    it("should manage developer API keys (create, authenticate, scope check, revoke)", async () => {
      const signup = (await auth.signup({ email: "dev@api.com", password: "Password123!" })) as any;
      const user = signup.user;

      // Create API Key
      const { apiKey: secretKey, record: apiKey } = await auth.apiKeys.create(user.id, {
        name: "Production CLI Key",
        scopes: ["read:data", "write:data"],
      });

      expect(secretKey.startsWith("yk_live_")).toBe(true);

      // Authenticate with API Key
      const verified = await auth.apiKeys.verify(secretKey);
      expect(verified).not.toBeNull();
      expect(verified?.user.id).toBe(user.id);

      // Revoke API Key. Takes the owning user id as well, so a caller cannot
      // revoke someone else's key just by knowing its id.
      await auth.apiKeys.revoke(user.id, apiKey.id);

      // Verification after revocation fails
      const afterRevoke = await auth.apiKeys.verify(secretKey);
      expect(afterRevoke).toBeNull();
    });

    it("should handle password changes and invalidate previous sessions", async () => {
      const email = "pwdchange@test.com";
      const oldPwd = "OldPassword123!";
      const newPwd = "NewPassword456!";

      const signup = (await auth.signup({ email, password: oldPwd })) as any;
      const user = signup.user;
      const login = (await auth.login({ email, password: oldPwd })) as any;

      // Change Password via auth.password.change (singular)
      await auth.password.change(user.id, oldPwd, newPwd);

      // Old password should fail
      await expect(auth.login({ email, password: oldPwd })).rejects.toThrow(UnauthorizedError);

      // New password should succeed
      const newLogin = (await auth.login({ email, password: newPwd })) as any;
      expect(newLogin.user.id).toBe(user.id);

      // Old JWT session token must be invalid due to credentialVersion bump
      const oldReq = new Request("http://localhost/api", {
        headers: { Authorization: `Bearer ${login.tokens.accessToken}` },
      });
      const oldSession = await auth.getSession(oldReq);
      expect(oldSession).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Protocol & Streaming Tests (Headers & Cookies)
  // ──────────────────────────────────────────────────────────────────────────
  describe("Protocol & Streaming Tests (Headers & Cookies)", () => {
    it("should authenticate sessions extracted from Cookie headers", async () => {
      const email = "cookie_auth@test.com";
      const password = "Password123!";

      await auth.signup({ email, password });
      const login = (await auth.login({ email, password })) as any;
      const cookieHeader = login.cookies.join("; ");

      const reqWithCookies = new Request("http://localhost/profile", {
        headers: { Cookie: cookieHeader },
      });

      const session = await auth.getSession(reqWithCookies);
      expect(session).not.toBeNull();
      expect(session?.user.email).toBe(email);
    });

    it("should format toResponse() with proper Set-Cookie headers and response body", async () => {
      const email = "response_builder@test.com";
      const login = (await auth.signup({ email, password: "Password123!" })) as any;

      const httpRes = login.toResponse({ message: "Welcome aboard" }, 201);

      expect(httpRes.status).toBe(201);
      const setCookies = httpRes.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThan(0);
      expect(setCookies.some((c: string) => c.includes("HttpOnly"))).toBe(true);

      const body = await httpRes.json();
      expect(body.message).toBe("Welcome aboard");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Performance & Concurrency Tests
  // ──────────────────────────────────────────────────────────────────────────
  describe("Performance & Concurrency Tests", () => {
    /*
     * 30 seconds, not Bun's 5s default.
     *
     * Ten concurrent logins means ten Argon2id hashes, and Argon2id is slow on
     * purpose — that is the property being paid for. Measured idle on a 2-core box,
     * those ten take 1,664ms, so the 5s default leaves a 3x margin, and a shared CI
     * runner running four jobs in parallel spends it. The failure is a timeout, with no
     * output pointing at anything: it reads as "the auth engine hung" rather than "the
     * machine was busy".
     *
     * The timeout is sized to the work, not to how fast the machine feels.
     */
    it("should handle parallel logins concurrently without race conditions", async () => {
      const totalUsers = 10;
      const users = await Promise.all(
        Array.from({ length: totalUsers }).map(async (_, i) => {
          const email = `concur_${i}@domain.com`;
          const password = `Password${i}123!`;
          await auth.signup({ email, password });
          return { email, password };
        }),
      );

      // Log in all 10 users simultaneously
      const loginPromises = users.map((u) => auth.login(u));
      const results = (await Promise.all(loginPromises)) as any[];

      expect(results.length).toBe(totalUsers);
      results.forEach((res, i) => {
        expect(res.user.email).toBe(users[i]!.email);
        expect(res.tokens.accessToken).toBeDefined();
      });
    }, 30_000);
  });
});

describe("Yatta Auth — MFA enrolment round trip", () => {
  const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

  /** A current TOTP code for a secret, using the same library auth uses. */
  function currentCode(secret: string): string {
    // Imported lazily so the dependency stays an implementation detail of
    // auth.ts rather than something this test hard-codes against.
    const { authenticator } = require("otplib") as {
      authenticator: { generate: (s: string) => string };
    };
    return authenticator.generate(secret);
  }

  async function enrolledAuth() {
    const auth = createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      security: { allowUnverifiedSession: true },
    });

    const user = await auth.signUp({
      email: `mfa-${Date.now()}@t.dev`,
      password: "Password123!",
    });

    const userId = "user" in user ? user.user.id : (user as any).userId;
    return { auth, userId };
  }

  it("completes enrolment, which it previously never could", async () => {
    const { auth, userId } = await enrolledAuth();

    const { secret, uri } = await auth.mfa.beginSetup(userId);

    expect(secret).toBeString();
    expect(uri).toContain("otpauth://totp/");

    /*
     * The bug this pins: beginSetup filed the encrypted seed under the store's
     * index while confirmSetup read it back by user id, so the two never met
     * and every enrolment ended in "MFA setup timed out". A test that only
     * checked beginSetup's return value would never have noticed.
     */
    const result = await auth.mfa.confirmSetup(userId, currentCode(secret));

    expect(result.recoveryCodes).toHaveLength(10);

    const user = await auth.store.findUserById(userId);
    expect(user!.twoFactorEnabled).toBe(true);
    // Encrypted at rest, never the raw seed.
    expect(user!.encryptedTwoFactorSecret).toBeTruthy();
    expect(user!.encryptedTwoFactorSecret).not.toBe(secret);
  });

  it("rejects a wrong code and leaves enrolment retryable", async () => {
    const { auth, userId } = await enrolledAuth();
    const { secret } = await auth.mfa.beginSetup(userId);

    await expect(auth.mfa.confirmSetup(userId, "000000")).rejects.toThrow();

    // The pending entry must survive a wrong code, or one typo forces the user
    // to re-enrol and re-scan.
    const { secret: again } = await auth.mfa.beginSetup(userId);
    expect(again).toBeString();
    expect(again).not.toBe(secret);
  });

  it("refuses when no enrolment is pending", async () => {
    const { auth, userId } = await enrolledAuth();
    await expect(auth.mfa.confirmSetup(userId, "123456")).rejects.toThrow(/timed out/i);
  });

  it("clears the pending entry once enrolment succeeds", async () => {
    const { auth, userId } = await enrolledAuth();
    const { secret } = await auth.mfa.beginSetup(userId);
    await auth.mfa.confirmSetup(userId, currentCode(secret));

    // A second confirm must not succeed: the entry has to be consumed.
    await expect(auth.mfa.confirmSetup(userId, currentCode(secret))).rejects.toThrow();
  });
});

describe("Yatta Auth — signup rate limiting", () => {
  const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

  it("does not count successful registrations against the limit", async () => {
    const rateLimitStore = new MemoryRateLimitStore();

    const auth = createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore,
      security: { allowUnverifiedSession: true },
      rateLimits: {
        enabled: true,
        // Deliberately small, so counting successes would exhaust it.
        signup: { maxAttempts: 5, windowSec: 3600, lockoutSec: 3600 },
      },
    });

    // Ten signups from one IP. Previously each success recorded a failure, so the
    // sixth locked this IP out for an hour.
    for (let i = 0; i < 10; i++) {
      await auth.signUp({ email: `many${i}-${Date.now()}@t.dev`, password: "Password123!" });
    }

    // Keyed as rl:signup:ip:<ip>. Ten successes must leave no hits at all.
    expect(await rateLimitStore.get("rl:signup:ip:127.0.0.1")).toBeNull();
  }, 30_000);

  it("still counts repeated attempts at an address that already exists", async () => {
    const rateLimitStore = new MemoryRateLimitStore();

    const auth = createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore,
      security: { allowUnverifiedSession: true, preventAccountEnumeration: true },
      rateLimits: {
        enabled: true,
        signup: { maxAttempts: 3, windowSec: 3600, lockoutSec: 3600 },
      },
    });

    const email = `dup-${Date.now()}@t.dev`;
    await auth.signUp({ email, password: "Password123!" });

    // Anti-enumeration probing has to keep counting, or the limiter can be used
    // to discover which addresses have accounts without tripping it.
    for (let i = 0; i < 5; i++) {
      await auth.signUp({ email, password: "Password123!" }).catch(() => undefined);
    }

    expect(await rateLimitStore.get(`rl:signup:id:${email}`)).not.toBeNull();
  });
});
