import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  type AuthResult,
  type MfaChallenge,
} from "../types/auth";
import { createMailer } from "../types/mail";
import { authenticator } from "otplib";

/*
 * TOTP replay: one code, one use — even when two requests race.
 *
 * `verifyCode` used to guard reuse only with `lastMfaStep` on the user object
 * the caller fetched, and the store write was fire-and-forget. Two
 * `completeMfa` calls racing with two tickets and one captured code both read
 * a snapshot from before either spent the step, so both passed. The fix claims
 * the step synchronously in the process, so the second caller sees the claim
 * even though its own snapshot still reads as unspent.
 *
 * otplib checks with window 0 here (verified: a code from the previous or
 * next step fails `check`), so the race inside one step is the whole hole —
 * there is no cross-step reuse to close as well.
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
    mfa: { challengeTtlSec: 300 },
  });
  return { auth, store };
}

async function userWithTwoFactor(auth: ReturnType<typeof createAuth>) {
  const email = `replay-${Date.now()}-${Math.random()}@t.dev`;
  const result = await auth.signUp({ email, password: "Password123!" });
  const userId = "user" in result ? result.user.id : "";

  const { secret } = await auth.mfa.beginSetup(userId);
  await auth.mfa.confirmSetup(userId, authenticator.generate(secret));

  /*
   * Simulate "some time later" by advancing the mocked clock past the step
   * enrolment consumed. A sign-in inside the same 30 seconds is refused by
   * design — the code that set 2FA up is spent — so the sign-in code has to
   * come from the next step. Winding the store marker back used to stand in
   * for this, but the marker is only one of the two replay guards now, and
   * the clock is the one both guards agree on.
   */
  setSystemTime(new Date(Date.now() + 31_000));

  return { userId, email, secret };
}

describe("TOTP replay race", () => {
  let auth: ReturnType<typeof createAuth>;

  beforeEach(() => {
    auth = build().auth;
  });

  afterEach(() => {
    setSystemTime();
  });

  it("lets only one of two racing sign-ins spend the same code", async () => {
    const { email, secret } = await userWithTwoFactor(auth);

    // Two tickets, so the ticket's own single-use guard cannot be what
    // refuses the second call — only the TOTP replay guard can.
    const first = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const second = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const code = authenticator.generate(secret);

    const outcomes = await Promise.allSettled([
      auth.completeMfa({ ticket: first.ticket, code }),
      auth.completeMfa({ ticket: second.ticket, code }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as Error).message,
    ).toMatch(/already used/i);

    // The winner really signed in.
    expect((fulfilled[0] as PromiseFulfilledResult<AuthResult>).value.user.email).toBe(email);
  });

  it("refuses the same code twice in sequence, with the replay message", async () => {
    const { email, secret } = await userWithTwoFactor(auth);

    const first = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const code = authenticator.generate(secret);
    await auth.completeMfa({ ticket: first.ticket, code });

    const second = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    await expect(
      auth.completeMfa({ ticket: second.ticket, code }),
    ).rejects.toThrow(/already used/i);
  });

  it("does not burn the step on a wrong code", async () => {
    const { email, secret } = await userWithTwoFactor(auth);

    const pending = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    await expect(
      auth.completeMfa({ ticket: pending.ticket, code: "000000" }),
    ).rejects.toThrow(/not valid/i);

    // A fresh ticket and the right code still work: the wrong guess must not
    // have consumed the step.
    const retry = (await auth.signIn({ email, password: "Password123!" })) as MfaChallenge;
    const result = await auth.completeMfa({
      ticket: retry.ticket,
      code: authenticator.generate(secret),
    });
    expect(result.user.email).toBe(email);
  });

  it("reports a wrong code in a spent step as wrong, not replayed", async () => {
    const { userId, secret } = await userWithTwoFactor(auth);

    const user = await auth.store.findUserById(userId);
    expect(auth.mfa.verifyCode(secret, authenticator.generate(secret), user!)).toBe(true);
    // Same step, wrong code: the replay verdict would be misleading here.
    expect(auth.mfa.verifyCode(secret, "000000", user!)).toBe(false);
  });
});
