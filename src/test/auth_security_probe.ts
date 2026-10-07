/**
 * An attack probe, not a test.
 *
 * `auth_security_probe.ts` tries the attacks your own strategy review lists — session
 * attacks, refresh replay, CSRF, RBAC bypass — and prints which ones got through. Run it
 * to find out what the current state is; the ones that succeed become tests.
 *
 *   bun run src/test/auth_security_probe.ts
 */
import {
  type AuthResult,
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  type AuthStore,
} from "../types/auth";
import { createMailer } from "../types/mail";

const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

interface Finding {
  attack: string;
  result: "BLOCKED" | "SUCCEEDED" | "N/A";
  detail: string;
}

const findings: Finding[] = [];

function record(attack: string, result: Finding["result"], detail: string): void {
  findings.push({ attack, result, detail });
}

function fresh(config: Record<string, unknown> = {}) {
  return createAuth({
    secret: SECRET,
    store: new MemoryAuthStore(),
    challengeStore: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    security: { allowUnverifiedSession: true },
    ...config,
  } as never);
}

/** A request carrying a session cookie, like a browser would. */
function cookieReq(url: string, cookies: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { cookie: cookies, ...((init.headers as Record<string, string>) ?? {}) },
  });
}

/**
 * Drives the middleware `protect()` returns, the way the router does.
 *
 * The middleware reads the request off the context and answers with a Response, so
 * `next` here stands in for "the rest of the chain", which is what a real route would
 * be. Returning a 204 from it means the request got past the guard.
 */
async function throughProtect(
  middleware: (ctx: unknown, next: () => Promise<Response>) => Promise<Response> | Response,
  req: Request,
): Promise<Response> {
  return middleware({ req, params: {}, state: {} }, async () => new Response(null, { status: 204 }));
}


// ── 1. Refresh token replay ────────────────────────────────────────────────
{
  const auth = fresh();
  const email = `replay-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });
  const session = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;

  const refresh = session.tokens.refreshToken;

  // First use: legitimate. This rotates, so the token just used becomes the previous one.
  const first = await auth.refresh(refresh).then((r) => r).catch(() => null);

  // A second use of the superseded token from the *same* client is the concurrent-retry
  // case the grace window exists for, so it is allowed by design.
  const sameClientReplay = await auth
    .refresh(refresh, new Request("https://app.test/refresh"))
    .then(() => true)
    .catch(() => false);

  // The attack: a stolen token replayed from somewhere else.
  const stolenToken = refresh;
  await auth.refresh(stolenToken).catch(() => null);

  const stolenReplay = await auth
    .refresh(stolenToken, new Request("https://attacker.test/refresh", { headers: { "x-forwarded-for": "203.0.113.66", "user-agent": "curl/8" } }))
    .then(() => true)
    .catch(() => false);

  record(
    "refresh: replay from a different client",
    first && !stolenReplay ? ("BLOCKED" as const) : ("SUCCEEDED" as const),
    `same-client retry ${sameClientReplay ? "allowed (by design)" : "refused"}, ` +
      `stolen replay ${stolenReplay ? "ACCEPTED" : "refused"}`,
  );
}

// ── 2. Refresh after sign-out ──────────────────────────────────────────────
{
  const auth = fresh();
  const email = `after-signout-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });
  const session = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;

  await auth.signOut(session.tokens.accessToken);

  // A signed-out session must not be revivable with the refresh token it left behind.
  const revived = await auth.refresh(session.tokens.refreshToken).then(() => true).catch(() => false);

  record(
    "refresh after sign-out",
    revived ? "SUCCEEDED" : "BLOCKED",
    revived ? "a signed-out session was refreshed back to life" : "refused",
  );
}

// ── 3. Access token after sign-out ─────────────────────────────────────────
{
  const auth = fresh();
  const email = `access-out-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });
  const session = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;

  await auth.signOut(session.tokens.accessToken);

  const resolved = await auth.getSession(session.tokens.accessToken).catch(() => null);

  record(
    "access token after sign-out",
    resolved === null ? "BLOCKED" : "SUCCEEDED",
    resolved ? "the session still resolved" : "refused",
  );
}

// ── 4. CSRF on a cookie-authenticated mutating request ─────────────────────
{
  const auth = fresh();
  const email = `csrf-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });
  const session = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;

  const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");

  // No CSRF header, and no CSRF cookie in the request. This is what a cross-site form
  // post looks like: the browser attaches the session cookie and nothing else.
  const bare = cookieReq("https://app.test/api/me", cookies, { method: "POST" });
  const bareRes = await throughProtect(auth.protect(), bare);

  // With a matching cookie/header pair.
  const csrfCookie = session.cookies
    .find((c) => c.startsWith("yatta_csrf="))!
    .split(";")[0]!
    .split("=")[1]!;
  const good = cookieReq("https://app.test/api/me", cookies, {
    method: "POST",
    headers: { "x-csrf-token": decodeURIComponent(csrfCookie) },
  });
  const goodRes = await throughProtect(auth.protect(), good);

  record(
    "CSRF: mutating request with no token",
    bareRes.status === 403 ? "BLOCKED" : "SUCCEEDED",
    `no token → ${bareRes.status}, with token → ${goodRes.status}`,
  );
}

// ── 5. CSRF bypass via a forged Authorization header ───────────────────────
{
  const auth = fresh();
  const email = `csrf-hdr-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });
  const session = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;
  const cookies = session.cookies.map((c) => c.split(";")[0]!).join("; ");

  // The CSRF check is skipped when an Authorization header is present, on the reasoning
  // that a bearer token cannot be attached cross-site. But the *session cookie is still
  // sent* by the browser, and the code path prefers the header for the session — so the
  // question is whether a header the attacker cannot set actually changes who is
  // authenticated.
  const forged = cookieReq("https://app.test/api/me", cookies, {
    method: "POST",
    headers: { authorization: "Bearer not-a-real-token" },
  });
  const res = await throughProtect(auth.protect(), forged);

  record(
    "CSRF: forged Authorization header skips the check",
    res.status >= 400 ? "BLOCKED" : "SUCCEEDED",
    `garbage bearer + session cookie → ${res.status}`,
  );
}

// ── 6. RBAC: privilege escalation via role assignment ──────────────────────
{
  const auth = fresh({
    rbac: {
      enabled: true,
      defaultRole: "user",
      roles: {
        user: { permissions: ["read:own"] },
        admin: { permissions: ["read:own", "read:any", "write:any"] },
      },
    },
  });

  const email = `rbac-${Date.now()}@t.dev`;
  const created = await auth.signUp({ email, password: "Password123!", metadata: { roles: ["admin"] } });
  const user = "user" in created ? created.user : null;

  record(
    "RBAC: roles supplied at signup",
    user?.roles?.includes("admin") ? "SUCCEEDED" : "BLOCKED",
    `asked for admin, got ${JSON.stringify(user?.roles)}`,
  );
}

// ── 7. Rate limit: per-account vs per-IP, and lockout ──────────────────────
{
  const rateLimitStore = new MemoryRateLimitStore();
  const auth = fresh({
    rateLimitStore,
    rateLimits: {
      enabled: true,
      login: { maxAttempts: 3, windowSec: 3600, lockoutSec: 3600 },
    },
  });

  const email = `rl-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });

  let locked = false;
  for (let i = 0; i < 8; i++) {
    try {
      await auth.signIn({ email, password: `wrong-${i}` });
    } catch (err) {
      if ((err as { name?: string }).name === "RateLimitError" || (err as { status?: number }).status === 429) {
        locked = true;
        break;
      }
    }
  }

  // And the lockout must actually block the correct password too, or it is only
  // slowing down an attacker rather than stopping them.
  let correctAfterLockout = false;
  try {
    await auth.signIn({ email, password: "Password123!" });
    correctAfterLockout = true;
  } catch {
    /* refused, which is what we want */
  }

  record(
    "rate limit: wrong password",
    locked ? "BLOCKED" : "SUCCEEDED",
    locked ? "throttled after repeated failures" : "never throttled",
  );

  record(
    "rate limit: lockout also blocks the real password",
    correctAfterLockout ? "SUCCEEDED" : "BLOCKED",
    correctAfterLockout ? "the correct password still worked while locked out" : "the correct password was refused too",
  );
}

// ── 8. Rate limit: forged X-Forwarded-For ──────────────────────────────────
{
  const rateLimitStore = new MemoryRateLimitStore();
  const auth = fresh({
    rateLimitStore,
    security: { allowUnverifiedSession: true },
    rateLimits: {
      enabled: true,
      login: { maxAttempts: 3, windowSec: 3600, lockoutSec: 3600 },
    },
  });

  const email = `xff-${Date.now()}@t.dev`;
  await auth.signUp({ email, password: "Password123!" });

  // A fresh spoofed IP per attempt. If the limiter keys on this header, it is trivially
  // bypassed and the lockout is decorative.
  let attempts = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await auth.signIn({
        email,
        password: `wrong-${i}`,
        req: new Request("https://app.test/login", {
          headers: { "x-forwarded-for": `203.0.113.${i}` },
        }),
      });
      attempts++;
    } catch {
      break;
    }
  }

  record(
    "rate limit: forged X-Forwarded-For",
    attempts >= 10 ? "SUCCEEDED" : "BLOCKED",
    `${attempts} attempts allowed while spoofing a new IP each time`,
  );
}

// ── 9. Password reset token: replay and user binding ────────────────────────
{
  const auth = fresh();
  const victim = `reset-${Date.now()}@t.dev`;
  const other = `other-${Date.now()}@t.dev`;

  await auth.signUp({ email: victim, password: "Password123!" });
  await auth.signUp({ email: other, password: "Password123!" });

  /*
   * The raw token goes out in the email and `reset()` hashes whatever it is given.
   *
   * The first version of this probe read the stored hash and passed that in, which is
   * refused every time — so it reported "token replay: ACCEPTED" and "old password STILL
   * WORKS" for a surface that is actually correct. A probe that cries wolf is worse than
   * no probe: it sends you hunting a bug that is not there.
   */
  const mailer = createMailer({ mode: "memory" });

  const withMailer = createAuth({
    secret: SECRET,
    store: new MemoryAuthStore(),
    challengeStore: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    security: { allowUnverifiedSession: true },
    email: { mailer, appUrl: "https://app.test" },
  } as never);

  await withMailer.password.requestReset(victim);
  const rawToken = /token=([A-Za-z0-9._~-]+)/.exec(
    JSON.stringify(mailer.lastSent()?.options ?? {}),
  )?.[1];

  if (!rawToken) {
    record("password reset: single use", "N/A", "no reset token reached the message");
  } else {
    const first = await withMailer.password.reset(rawToken, "NewPassword123!").then(() => true).catch(() => false);
    const second = await withMailer.password.reset(rawToken, "OtherPassword123!").then(() => true).catch(() => false);

    record(
      "password reset: token replay",
      first && !second ? ("BLOCKED" as const) : ("SUCCEEDED" as const),
      `first use ${first ? "ok" : "refused"}, replay ${second ? "ACCEPTED" : "refused"}`,
    );

    const oldWorks = await withMailer.signIn({ email: victim, password: "Password123!" }).then(() => true).catch(() => false);
    const newWorks = await withMailer.signIn({ email: victim, password: "NewPassword123!" }).then(() => true).catch(() => false);

    record(
      "password reset: changes the password",
      !oldWorks && newWorks ? ("BLOCKED" as const) : ("SUCCEEDED" as const),
      `old password ${oldWorks ? "STILL WORKS" : "refused"}, new ${newWorks ? "works" : "refused"}`,
    );
  }
}

// ── 10. API keys: scope enforcement and revocation ─────────────────────────
{
  const auth = fresh();
  const email = `keys-${Date.now()}@t.dev`;
  const created = await auth.signUp({ email, password: "Password123!" });
  const userId = "user" in created ? created.user.id : "";

  const { apiKey } = await auth.apiKeys.create(userId, { name: "ci", scopes: ["read:data"] });

  const principal = await auth.apiKeys.verify(apiKey).catch(() => null);

  let scopeError: string | null = null;
  try {
    principal?.requireScope("write:data");
  } catch (err) {
    scopeError = (err as Error).message;
  }

  // And the read scope it does hold.
  const readOk = principal?.hasScope("read:data") ?? false;

  // A key minted with a scope must not verify for a different one.
  const gatedOut = (await auth.apiKeys.verify(apiKey, { requireScope: "write:data" })) === null;

  const keyId = principal?.apiKey?.id ?? "";
  await auth.apiKeys.revoke(userId, keyId);

  const afterRevoke = await auth.apiKeys.verify(apiKey).then((r) => r !== null).catch(() => false);

  record(
    "API key: scope enforcement",
    principal && scopeError && readOk && gatedOut ? ("BLOCKED" as const) : ("SUCCEEDED" as const),
    `held scope readable: ${readOk}, missing scope threw: ${Boolean(scopeError)}, ` +
      `gated verify returned null: ${gatedOut}`,
  );

  record(
    "API key: revoked key still authenticates",
    afterRevoke ? "SUCCEEDED" : "BLOCKED",
    afterRevoke ? "a revoked key still worked" : "refused",
  );
}

// ── Report ────────────────────────────────────────────────────────────────

console.log("\n=======================================================");
console.log("   AUTH SECURITY PROBE");
console.log("=======================================================\n");

const succeeded = findings.filter((f) => f.result === "SUCCEEDED");

for (const f of findings) {
  const mark = f.result === "BLOCKED" ? "  ok " : f.result === "SUCCEEDED" ? "FAIL " : "  -- ";
  console.log(`${mark} ${f.attack}\n         ${f.detail}`);
}

console.log(`\n${findings.length - succeeded.length} blocked, ${succeeded.length} got through.\n`);