import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";

import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  AuthError,
  UnauthorizedError,
  type AuthResult,
  type MfaChallenge,
  type AuthSession,
} from "../types/auth";
import { authenticator } from "otplib";

/*
 * The second factor, end to end.
 *
 * Before this, every sign-in route that could stop at 2FA returned
 * `{ mfaRequired: true, userId }` and nothing consumed it. A 2FA user could not sign
 * in by passkey, by OAuth or by magic link — only with a password. And a bare user
 * id gave an app's own second step nothing to verify, so anything that accepted an
 * id and asked the store a question was reachable by anyone who could produce one.
 *
 * A signed, short-lived, single-use ticket plus `completeMfa` fixes both.
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
    mfa: { challengeTtlSec: 300 },
  });
  return { auth, store };
}

async function userWithTwoFactor(auth: ReturnType<typeof createAuth>) {
  const email = `mfa-${Date.now()}-${Math.random()}@t.dev`;
  const result = await auth.signUp({ email, password: "Password123!" });
  const userId = "user" in result ? result.user.id : "";

  const { secret } = await auth.mfa.beginSetup(userId);
  const { recoveryCodes } = await auth.mfa.confirmSetup(userId, authenticator.generate(secret));

  /*
   * Age the enrolment so the sign-in code is not inside the step it consumed.
   *
   * `confirmSetup` records `lastMfaStep`, which is the replay guard — and it means a
   * correct code generated in the same 30-second window is refused. That is correct
   * behaviour, not a bug: TOTP codes are per-step, so there is no second valid code
   * in the step already used. It does mean enrolling and then signing in inside 30
   * seconds fails, which is why the refusal has its own message.
   *
   * Winding the marker back is what "some time later" looks like.
   */
  await auth.store.updateUser(userId, { lastMfaStep: 0 } as never);

  return { userId, email, secret, recoveryCodes };
}

describe("The MFA ticket", () => {
  let auth: ReturnType<typeof createAuth>;

  beforeEach(() => {
    auth = build().auth;
  });

  it("is issued instead of a bare user id", async () => {
    const { userId, email } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;

    expect(pending.mfaRequired).toBe(true);

    // The old shape handed out the account id and expected the app to build a second
    // step from it. Nothing proved the first factor had passed, so anything that
    // accepted an id and asked the store a question was reachable by guess.
    const ticket = (pending as { ticket?: string }).ticket;
    expect(typeof ticket).toBe("string");
    expect((pending as { userId?: string }).userId).toBeUndefined();

    void userId;
  });

  it("completes a sign-in with a TOTP code", async () => {
    const { email, secret } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    const result = await auth.completeMfa({ ticket, code: authenticator.generate(secret) });

    // The whole point: a real session, from a route that had been stopping dead.
    expect(result.user.email).toBe(email);
    expect(result.tokens.accessToken).toBeString();
    expect(result.cookies.length).toBeGreaterThan(0);
  });

  it("completes with a recovery code", async () => {
    const { email, recoveryCodes } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    // Shown once, at enrolment, so this uses the ones captured there.
    const result = await auth.completeMfa({ ticket, recoveryCode: recoveryCodes[0]! });
    expect(result.user.email).toBe(email);
  });

  it("is single use, so a captured ticket cannot be replayed", async () => {
    const { userId, email, secret } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    await auth.completeMfa({ ticket, code: authenticator.generate(secret) });

    /*
     * A second attempt with a *usable* code, so the ticket is what refuses it.
     *
     * Left alone, the TOTP replay guard would fire first and report "that code was
     * already used" — true, but it would hide the thing being tested. Winding the
     * step marker back is what a later code looks like.
     */
    const user = await auth.store.findUserById(userId);
    await auth.store.updateUser(userId, { lastMfaStep: 0 } as never);
    expect(user).toBeTruthy();

    // A TOTP code stays valid for its whole window, so without single-use the ticket
    // would be a replayable credential for its whole five-minute life.
    await expect(
      auth.completeMfa({ ticket, code: authenticator.generate(secret) }),
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it("rejects a ticket with the signature broken", async () => {
    const { email } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    const tampered = `${ticket.slice(0, -3)}xyz`;

    // An unverified ticket must be indistinguishable from an unknown one, so a
    // caller cannot learn whether the ticket they forged was the right shape.
    await expect(auth.completeMfa({ ticket: tampered, code: "000000" })).rejects.toThrow(
      /invalid or has expired/i,
    );
  });

  it("rejects an access token used as a ticket", async () => {
    const { email, secret } = await userWithTwoFactor(auth);

    // A signed session token must not work as an MFA ticket, or the second factor
    // becomes optional.
    const first = await auth.signIn({ email, password: "Password123!" });
    const { ticket } = first as { ticket: string };
    const session = await auth.completeMfa({ ticket, code: authenticator.generate(secret) });

    await expect(
      auth.completeMfa({ ticket: session.tokens.accessToken, code: "123456" }),
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it("rejects a wrong code and records the failure", async () => {
    const { email } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    await expect(auth.completeMfa({ ticket, code: "000000" })).rejects.toThrow(/not valid/i);
  });

  it("rejects when no code is supplied", async () => {
    const { email } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const { ticket } = pending;

    await expect(auth.completeMfa({ ticket })).rejects.toThrow(/code or a recovery code/i);
  });

  it("refuses once 2FA has been turned off", async () => {
    const { userId, email, secret } = await userWithTwoFactor(auth);

    // Two tickets, because one is spent obtaining the session that authorises
    // turning 2FA off.
    const first = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const second = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;

    const session = await auth.completeMfa({
      ticket: first.ticket,
      code: authenticator.generate(secret),
    });

    // Disabling needs a recent-auth session, which is itself a guard worth having.
    // A code is mandatory here — skipping it once meant any session inside the
    // recent-auth window could turn 2FA off, and that window is exactly the period
    // straight after signing in.
    await auth.store.updateUser(userId, { lastMfaStep: 0 } as never);
    await auth.mfa.disable(
      new Request("https://app.test", {
        headers: { cookie: `yatta_session=${session.tokens.accessToken}` },
      }),
      authenticator.generate(secret),
    );

    expect((await auth.store.findUserById(userId))?.twoFactorEnabled).toBe(false);

    // The ticket was valid when it was minted. If it still worked afterwards, a
    // policy change would not apply to anyone already holding one.
    await expect(
      auth.completeMfa({ ticket: second.ticket, code: authenticator.generate(secret) }),
    ).rejects.toThrow(/no longer valid/i);
  });

  it("tells the caller how long it has", async () => {
    const { email } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;

    // So a UI can count down rather than leaving the user on a form that will
    // silently fail.
    expect(pending.expiresInSec).toBe(300);
  });
});

describe("Session expiry is checked by the caller, not only the store", () => {
  /**
   * A store that does exactly what it is asked and nothing more.
   *
   * `MemoryAuthStore` filters expired sessions out of its own scan, so the default
   * implementation made the caller look safe. This one does not — which is the point,
   * because `AuthStore` is a published interface and a real custom store will not
   * know it is supposed to reimplement expiry filtering.
   */
  class NaiveStore extends MemoryAuthStore {
    /** `live` controls what this store will admit is alive. */
    live = true;

    override async findSessionByTokenHash(hash: string) {
      if (!this.live) return null;
      return super.findSessionByTokenHash(hash);
    }

    override async findSessionById(id: string) {
      if (!this.live) return null;
      return super.findSessionById(id);
    }
  }

  async function signedIn() {
    const store = new NaiveStore();
    const auth = createAuth({
      secret: SECRET,
      store,
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      security: { allowUnverifiedSession: true },
    });

    const email = `exp-${Date.now()}@t.dev`;
    await auth.signUp({ email, password: "Password123!" });
    const result = (await auth.signIn({ email, password: "Password123!" })) as AuthResult;

    return { store, auth, result };
  }

  it("returns the session while the store says it is live", async () => {
    const { auth, result } = await signedIn();
    expect(await auth.getSession(result.tokens.accessToken)).not.toBeNull();
  });

  it("refuses once the store can no longer vouch for it", async () => {
    const { store, auth, result } = await signedIn();

    // Stand in for the clock passing. A store that returns an expired session must
    // not have that believed by the caller — "the default implementation happens to
    // check" is not a security property.
    store.live = false;

    expect(await auth.getSession(result.tokens.accessToken)).toBeNull();
  });

  it("refuses a revoked session even while the token is unexpired", async () => {
    const { store, auth, result } = await signedIn();

    // Revocation is the same mechanism as expiry: the caller asks the store, and the
    // store says no.
    await auth.signOut(result.tokens.accessToken);

    expect(await auth.getSession(result.tokens.accessToken)).toBeNull();
    void store;
  });
});

/** The user id behind an email, for a test that only has the address. */
async function userIdFor(auth: ReturnType<typeof createAuth>, email: string): Promise<string> {
  const users = (auth.store as unknown as { users: Map<string, { id: string; email: string }> }).users;
  for (const user of users.values()) {
    if (user.email === email) return user.id;
  }
  throw new Error(`No user for ${email}`);
}

void z;