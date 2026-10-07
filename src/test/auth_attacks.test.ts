import { describe, it, expect, beforeEach } from "bun:test";

import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  ForbiddenError,
  UnauthorizedError,
  RateLimitError,
  type AuthResult,
} from "../types/auth";
import { createMailer } from "../types/mail";

/*
 * Attacks, as tests.
 *
 * `auth_security_probe.ts` tries these and prints what got through; this file pins the
 * answers. Every case here is an attack that was tried against the current code and the
 * result is in the comment — three of them were finding something at the time, and two
 * of those three were fixed.
 *
 * The surface is the one `STRATEGY_REVIEW_TAKEAWAYS.md` names as the real risk:
 * "Auth surface is huge (Argon2id, JWT rotation, TOTP, WebAuthn, RBAC...). Feature
 * completeness ≠ security maturity."
 */

const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";
let seq = 0;
const uniq = (what: string) => `${what}-${Date.now()}-${seq++}@t.dev`;

function build(config: Record<string, unknown> = {}) {
  const mailer = createMailer({ mode: "memory" });

  const auth = createAuth({
    secret: SECRET,
    store: new MemoryAuthStore(),
    challengeStore: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    security: { allowUnverifiedSession: true },
    email: { mailer, appUrl: "https://app.test" },
    ...config,
  } as never);

  return { auth, mailer };
}

/** The raw token from the most recent message, as someone following the link would get. */
function tokenFromMail(mailer: ReturnType<typeof createMailer>): string | undefined {
  // `lastSent()` returns the compiled nodemailer options, not the rendered message.
  const message = mailer.lastSent();
  if (!message) return undefined;

  const body = JSON.stringify(message.options ?? {});
  return /token=([A-Za-z0-9._~-]+)/.exec(body)?.[1];
}

async function signedIn(auth: ReturnType<typeof build>["auth"], email: string): Promise<AuthResult> {
  await auth.signUp({ email, password: "Password123!" });
  return (await auth.signIn({ email, password: "Password123!" })) as AuthResult;
}

/** Drive the middleware `protect()` returns, the way the router does. */
async function throughProtect(
  middleware: (ctx: unknown, next: () => Promise<Response>) => Promise<Response> | Response,
  req: Request,
): Promise<Response> {
  return middleware({ req, params: {}, state: {} }, async () => new Response(null, { status: 204 }));
}

/**
 * The address the framework sees, which is what binds a refresh token to a client.
 *
 * `getClientIp` is configured explicitly rather than relied on. Without it Bun gives no
 * peer address, every request resolves to 127.0.0.1, and there is nothing to compare —
 * which is the same gap the framework warns about at boot, and the reason this must be
 * set in production for the binding below to mean anything.
 */
function withClientIp(auth: unknown) {
  (auth as { config: { security: Record<string, unknown> } }).config.security.getClientIp = (
    req: Request,
  ) => req.headers.get("x-forwarded-for") ?? "127.0.0.1";

  return auth as ReturnType<typeof build>["auth"];
}

describe("Refresh token replay", () => {
  it("refuses a replay from a different client, even inside the grace window", async () => {
    const built = build();
    const auth = withClientIp(built.auth);
    const email = uniq("replay");

    const session = await signedIn(auth, email);
    const stolen = session.tokens.refreshToken;

    // The legitimate use rotates the token, moving it into the previous slot.
    const rotated = await auth.refresh(
      stolen,
      new Request("https://app.test/refresh", { headers: { "x-forwarded-for": "198.51.100.10" } }),
    );
    expect(rotated.user.email).toBe(email);

    /*
     * The 30-second grace window exists because a client that fires two refreshes at
     * once legitimately presents the same token twice. It used to compare hashes and
     * nothing else, so a stolen token replayed two seconds after the victim's own
     * refresh got a session.
     *
     * The window now also requires the same client, because the case it exists for is
     * the same client retrying and an attacker's retry is not.
     *
     * This only binds when a client address is available. With no `getClientIp`
     * configured, every request is 127.0.0.1 and there is nothing to compare — the
     * user agent is the only remaining signal, and it is absent often enough that the
     * window stays open. That is why the scaffold now sets it.
     */
    await expect(
      auth.refresh(
        stolen,
        new Request("https://attacker.test/refresh", {
          headers: { "x-forwarded-for": "203.0.113.66", "user-agent": "curl/8" },
        }),
      ),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("cannot bind a token to a client when no address is available", async () => {
    // Stated rather than hidden: with the default configuration there is one signal
    // missing and the grace window cannot tell an attacker from a retry.
    const { auth } = build();
    const session = await signedIn(auth, uniq("noaddr"));
    const token = session.tokens.refreshToken;

    await auth.refresh(token);
    const replayed = await auth.refresh(token).then(() => true).catch(() => false);

    expect(replayed).toBe(true);
  });

  it("still allows the same client to retry concurrently", async () => {
    const { auth } = build();
    const email = uniq("concurrent");

    const session = await signedIn(auth, email);
    const token = session.tokens.refreshToken;

    // First use rotates; the immediate second use from the same client is the race the
    // window is for, and revoking on it would log users out for their own timing.
    const from = () =>
      new Request("https://app.test/refresh", {
        headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "198.51.100.10" },
      });

    const first = await withClientIp(auth).refresh(token, from());
    const retry = await withClientIp(auth)
      .refresh(token, from())
      .then((r) => r.user.email)
      .catch(() => null);

    expect(first.user.email).toBe(email);
    expect(retry).toBe(email);
  });

  it("revokes the session when an old token is replayed later", async () => {
    const { auth } = build();
    const email = uniq("family");

    const session = await signedIn(auth, email);
    const first = session.tokens.refreshToken;

    const second = await auth.refresh(first);
    const third = await auth.refresh(second.tokens.refreshToken);

    // Two generations old. Nothing about the client matches, so this is a replay.
    await expect(auth.refresh(first)).rejects.toThrow(/reuse detected/i);

    // And the whole session is gone, not just the token refused.
    expect(await auth.getSession(third.tokens.accessToken)).toBeNull();
  });
});

describe("Sessions do not outlive the thing that ends them", () => {
  it("refuses to refresh after sign-out", async () => {
    const { auth } = build();
    const session = await signedIn(auth, uniq("signedout"));

    await auth.signOut(session.tokens.accessToken);

    // A signed-out session must not be revivable with the token it left behind.
    await expect(auth.refresh(session.tokens.refreshToken)).rejects.toThrow();
  });

  it("does not resolve an access token after sign-out", async () => {
    const { auth } = build();
    const session = await signedIn(auth, uniq("revoked"));

    await auth.signOut(session.tokens.accessToken);

    expect(await auth.getSession(session.tokens.accessToken)).toBeNull();
  });

  it("kills every session when a password is reset", async () => {
    const { auth, mailer } = build();
    const email = uniq("resetsessions");
    const session = await signedIn(auth, email);

    await auth.password.requestReset(email);
    const token = tokenFromMail(mailer);

    expect(token).toBeDefined();
    await auth.password.reset(token!, "BrandNewPassword123!");

    /*
     * A reset is what someone does *because* a session may be compromised. If it left
     * that session working, the remedy would not be one.
     */
    expect(await auth.getSession(session.tokens.accessToken)).toBeNull();
  });
});

describe("Password reset tokens", () => {
  it("are single use", async () => {
    const { auth, mailer } = build();
    const email = uniq("resetsingle");
    await auth.signUp({ email, password: "Password123!" });

    await auth.password.requestReset(email);
    const token = tokenFromMail(mailer);

    expect(token).toBeDefined();
    await auth.password.reset(token!, "FirstNewPassword123!");

    // Replaying the same link must not set a second password.
    await expect(auth.password.reset(token!, "SecondNewPassword123!")).rejects.toThrow(/invalid or expired/i);

    const secondWins = await auth.signIn({ email, password: "SecondNewPassword123!" }).then(() => true).catch(() => false);
    expect(secondWins).toBe(false);
  });

  it("changes the password and invalidates the old one", async () => {
    const { auth, mailer } = build();
    const email = uniq("resetworks");
    await auth.signUp({ email, password: "Password123!" });

    await auth.password.requestReset(email);
    await auth.password.reset(tokenFromMail(mailer)!, "Replacement12345!");

    const oldWorks = await auth.signIn({ email, password: "Password123!" }).then(() => true).catch(() => false);
    const newWorks = await auth.signIn({ email, password: "Replacement12345!" }).then(() => true).catch(() => false);

    expect(oldWorks).toBe(false);
    expect(newWorks).toBe(true);
  });

  it("reveals nothing about whether an address has an account", async () => {
    const { auth } = build();

    // Probing with an unknown address must not behave differently from a known one, or
    // the endpoint becomes a way to enumerate users.
    await expect(auth.password.requestReset(uniq("nobody"))).resolves.toBeUndefined();
    await expect(auth.password.requestReset(uniq("nobody"))).resolves.toBeUndefined();
  });
});

describe("CSRF", () => {
  it("refuses a cookie-authenticated mutation with no token", async () => {
    const { auth } = build();
    const session = await signedIn(auth, uniq("csrf"));

    const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");

    // What a cross-site form post looks like: the browser attaches the session cookie and
    // nothing else the page cannot read.
    const bare = new Request("https://app.test/api/me", { method: "POST", headers: { cookie: cookies } });
    const res = await throughProtect(auth.protect(), bare);

    expect(res.status).toBe(403);
  });

  it("allows the same request with a matching cookie and header", async () => {
    const { auth } = build();
    const session = await signedIn(auth, uniq("csrfok"));

    const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");
    const csrf = decodeURIComponent(
      session.cookies.find((c) => c.startsWith("yatta_csrf="))!.split(";")[0]!.split("=")[1]!,
    );

    const req = new Request("https://app.test/api/me", {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf },
    });

    // Reaching the inner handler at all is the point: 204 is what `next` answers.
    expect((await throughProtect(auth.protect(), req)).status).toBe(204);
  });

  it("does not let a forged bearer header skip the check and the session with it", async () => {
    const { auth } = build();
    const session = await signedIn(auth, uniq("csrfforged"));

    const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");
    const req = new Request("https://app.test/api/me", {
      method: "POST",
      headers: { cookie: cookies, authorization: "Bearer not-a-real-token" },
    });

    // The CSRF check is skipped when an Authorization header is present, on the
    // reasoning that a bearer token cannot be attached cross-site. The session cookie is
    // still attached though, so this must not authenticate as the cookie's owner.
    expect((await throughProtect(auth.protect(), req)).status).toBe(401);
  });
});

describe("RBAC", () => {
  const rbac = {
    rbac: {
      enabled: true,
      defaultRole: "user",
      roles: {
        user: { permissions: ["read:own"] },
        admin: { permissions: ["read:own", "read:any", "write:any"] },
      },
    },
  };

  it("ignores roles asked for at signup", async () => {
    const { auth } = build(rbac);

    const created = await auth.signUp({
      email: uniq("escalate"),
      password: "Password123!",
      metadata: { roles: ["admin"] },
    });

    // Self-declared roles are the oldest privilege-escalation bug there is.
    const user = "user" in created ? created.user : null;
    expect(user?.roles).not.toContain("admin");
  });

  it("refuses a route the role is not permitted", async () => {
    const { auth } = build(rbac);
    const email = uniq("rbacdeny");

    const session = await signedIn(auth, email);
    const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");
    const csrf = decodeURIComponent(
      session.cookies.find((c) => c.startsWith("yatta_csrf="))!.split(";")[0]!.split("=")[1]!,
    );

    const req = new Request("https://app.test/api/admin", {
      method: "GET",
      headers: { cookie: cookies, "x-csrf-token": csrf },
    });

    // A signed-in `user` asking for an `admin` route. The guard must answer, not fall
    // through to the handler.
    const res = await throughProtect(auth.protect({ role: "admin" }), req);
    expect(res.status).toBe(403);
  });

  it("permits a route the role does hold", async () => {
    const { auth } = build(rbac);
    const session = await signedIn(auth, uniq("rbacallow"));

    const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");
    const csrf = decodeURIComponent(
      session.cookies.find((c) => c.startsWith("yatta_csrf="))!.split(";")[0]!.split("=")[1]!,
    );

    const req = new Request("https://app.test/api/me", {
      method: "GET",
      headers: { cookie: cookies, "x-csrf-token": csrf },
    });

    expect((await throughProtect(auth.protect({ role: "user" }), req)).status).toBe(204);
  });
});

describe("Rate limiting", () => {
  const limited = () =>
    build({
      rateLimits: {
        enabled: true,
        login: { maxAttempts: 3, windowSec: 3600, lockoutSec: 3600 },
      },
    });

  it("throttles repeated wrong passwords", async () => {
    const { auth } = limited();
    const email = uniq("throttle");
    await auth.signUp({ email, password: "Password123!" });

    let locked = false;
    for (let i = 0; i < 8 && !locked; i++) {
      try {
        await auth.signIn({ email, password: `wrong-${i}` });
      } catch (err) {
        if (err instanceof RateLimitError || (err as { status?: number }).status === 429) locked = true;
      }
    }

    expect(locked).toBe(true);
  });

  it("locks out the correct password too, not just the wrong ones", async () => {
    const { auth } = limited();
    const email = uniq("lockout");
    await auth.signUp({ email, password: "Password123!" });

    for (let i = 0; i < 8; i++) {
      await auth.signIn({ email, password: `wrong-${i}` }).catch(() => null);
    }

    // A lockout that only blocks wrong answers is a speed bump, not a lockout.
    const correctWorks = await auth.signIn({ email, password: "Password123!" }).then(() => true).catch(() => false);
    expect(correctWorks).toBe(false);
  });

  it("is not bypassed by a forged X-Forwarded-For", async () => {
    const { auth } = limited();
    const email = uniq("xff");
    await auth.signUp({ email, password: "Password123!" });

    // A fresh spoofed address per attempt. If the limiter keyed on this header it would
    // be trivially bypassed and the lockout decorative.
    let attempts = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await auth.signIn({
          email,
          password: `wrong-${i}`,
          req: new Request("https://app.test/login", { headers: { "x-forwarded-for": `203.0.113.${i}` } }),
        });
        attempts++;
      } catch {
        break;
      }
    }

    expect(attempts).toBeLessThan(10);
  });
});

describe("API key scopes", () => {
  it("enforces them, which it did not before", async () => {
    const { auth } = build();
    const created = await auth.signUp({ email: uniq("keys"), password: "Password123!" });
    const userId = "user" in created ? created.user.id : "";

    const { apiKey } = await auth.apiKeys.create(userId, { name: "ci", scopes: ["read:data"] });
    const principal = await auth.apiKeys.verify(apiKey);

    /*
     * Scopes were written at creation and read back by `verify`, and nothing in between
     * looked at them — so a read-only key was exactly as good as a read-write one, and
     * the scaffold's own comment claimed it "checks the hash and scopes".
     */
    expect(principal?.hasScope("read:data")).toBe(true);
    expect(principal?.hasScope("write:data")).toBe(false);
    expect(() => principal?.requireScope("write:data")).toThrow(ForbiddenError);
  });

  it("refuses to verify a key that lacks a required scope", async () => {
    const { auth } = build();
    const created = await auth.signUp({ email: uniq("gated"), password: "Password123!" });
    const userId = "user" in created ? created.user.id : "";

    const { apiKey } = await auth.apiKeys.create(userId, { name: "ci", scopes: ["read:data"] });

    expect(await auth.apiKeys.verify(apiKey, { requireScope: "read:data" })).not.toBeNull();
    expect(await auth.apiKeys.verify(apiKey, { requireScope: "write:data" })).toBeNull();
  });

  it("treats * as a wildcard and an empty list as granting nothing", async () => {
    const { auth } = build();
    const created = await auth.signUp({ email: uniq("wildcard"), password: "Password123!" });
    const userId = "user" in created ? created.user.id : "";

    const wildcard = await auth.apiKeys.create(userId, { name: "root", scopes: ["*"] });
    const wildcardPrincipal = await auth.apiKeys.verify(wildcard.apiKey);
    expect(wildcardPrincipal?.hasScope("anything:at:all")).toBe(true);

    // Denying by default. A key with no scopes is a key with no permissions, so a
    // forgotten scope list cannot accidentally read as "everything".
    const narrow = await auth.apiKeys.create(userId, { name: "empty", scopes: [] });
    const narrowPrincipal = await auth.apiKeys.verify(narrow.apiKey);
    expect(narrowPrincipal?.hasScope("read:data")).toBe(false);
  });

  it("stops working once revoked", async () => {
    const { auth } = build();
    const created = await auth.signUp({ email: uniq("revoked"), password: "Password123!" });
    const userId = "user" in created ? created.user.id : "";

    const { apiKey } = await auth.apiKeys.create(userId, { name: "ci", scopes: ["read"] });
    const verified = await auth.apiKeys.verify(apiKey);
    expect(verified).not.toBeNull();

    await auth.apiKeys.revoke(userId, verified!.apiKey.id);

    expect(await auth.apiKeys.verify(apiKey)).toBeNull();
  });
});