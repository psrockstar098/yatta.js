import { describe, it, expect, beforeEach } from "bun:test";
import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  type AuthResult,
  type AuthVerificationToken,
} from "../types/auth";
import { createMailer } from "../types/mail";

/*
 * The nightly `cleanup-stale-tokens` job used to only log that it was
 * cleaning up. Nothing was ever deleted: there was no store method that
 * removed an expired row, so expired verification tokens accumulated in the
 * store forever. `Auth.cleanupExpired()` is the method the job should have
 * been calling, and these tests pin what it removes — and what it leaves.
 */

const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

function build() {
  const store = new MemoryAuthStore();
  const auth = createAuth({
    secret: SECRET,
    store,
    challengeStore: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    security: { allowUnverifiedSession: true },
    email: { mailer: createMailer({ mode: "memory" }), appUrl: "https://app.test" },
  });
  return { auth, store };
}

async function signedIn(auth: ReturnType<typeof createAuth>, email: string) {
  await auth.signUp({ email, password: "Password123!" });
  const result = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;
  const session = await auth.getSession(result.tokens.accessToken);
  return { result, sessionId: session!.session.id };
}

function token(
  userId: string,
  id: string,
  expiresAt: Date,
): AuthVerificationToken {
  return {
    id,
    userId,
    tokenHash: `hash-${id}`,
    type: "email_verification",
    expiresAt,
  };
}

describe("cleanupExpired", () => {
  let auth: ReturnType<typeof createAuth>;
  let store: MemoryAuthStore;

  beforeEach(() => {
    ({ auth, store } = build());
  });

  it("deletes expired verification tokens and leaves live ones", async () => {
    const { result } = await signedIn(auth, `clean-${Date.now()}@t.dev`);
    const userId = result.user.id;
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await store.createToken(token(userId, "tok-expired", past));
    await store.createToken(token(userId, "tok-live", future));

    const removed = await auth.cleanupExpired();

    expect(removed.tokens).toBe(1);
    expect(await store.findTokenByHash("hash-tok-expired", "email_verification")).toBeNull();
    expect(await store.findTokenByHash("hash-tok-live", "email_verification")).not.toBeNull();
  });

  it("deletes expired sessions and leaves live ones", async () => {
    const { result, sessionId } = await signedIn(auth, `clean-${Date.now()}@t.dev`);

    // A second, still-live session for the same user.
    const second = (await auth.signIn({
      email: result.user.email,
      password: "Password123!",
    })) as AuthResult;
    const secondSession = await auth.getSession(second.tokens.accessToken);

    // Age the first session past expiry.
    await store.updateSession(sessionId, { expiresAt: new Date(Date.now() - 60_000) });

    const removed = await auth.cleanupExpired();

    expect(removed.sessions).toBe(1);
    expect(await store.findSessionById(sessionId)).toBeNull();
    expect(await store.findSessionById(secondSession!.session.id)).not.toBeNull();
    // The dead session no longer authenticates either.
    expect(await auth.getSession(result.tokens.accessToken)).toBeNull();
  });

  it("reports zero and removes nothing when nothing is expired", async () => {
    await signedIn(auth, `clean-${Date.now()}@t.dev`);
    expect(await auth.cleanupExpired()).toEqual({ tokens: 0, sessions: 0 });
  });

  it("treats a token expiring exactly now as expired", async () => {
    const { result } = await signedIn(auth, `clean-${Date.now()}@t.dev`);
    const now = new Date();
    await store.createToken(token(result.user.id, "tok-now", now));

    const removed = await auth.cleanupExpired(now);

    expect(removed.tokens).toBe(1);
  });

  it("reports zero for a store without the deleteExpired methods", async () => {
    // A pre-existing custom store has neither method: cleanup must report
    // the honest zero, not throw and not claim a sweep happened.
    const bare = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "deleteExpiredTokens" || prop === "deleteExpiredSessions") {
          return undefined;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bareAuth = createAuth({
      secret: SECRET,
      store: bare as MemoryAuthStore,
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      security: { allowUnverifiedSession: true },
      email: { mailer: createMailer({ mode: "memory" }), appUrl: "https://app.test" },
    });

    expect(await bareAuth.cleanupExpired()).toEqual({ tokens: 0, sessions: 0 });
  });
});
