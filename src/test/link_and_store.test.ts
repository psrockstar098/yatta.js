import { describe, it, expect, afterAll } from "bun:test";
import { serve } from "bun";

import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
  type AuthResult,
  type OAuthProvider,
} from "../types/auth";

/*
 * Two guards from this round, both closing a path where a caller-supplied value
 * decided who you were.
 *
 * The OAuth tests run against a real local server rather than a stubbed method. The
 * callback path makes two `fetch` calls of its own — token exchange, then profile —
 * and stubbing them would replace the code under test. A server answers the same
 * way a provider does.
 */

const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

/** Answers the two calls a provider makes, so no network is involved. */
const oauthProvider = serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/token") {
      return Response.json({ access_token: "provider-token" });
    }

    if (path === "/me") {
      return Response.json({
        id: "provider-1",
        email: "oauth-user@t.dev",
        emailVerified: true,
        name: "OAuth User",
      });
    }

    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  oauthProvider.stop(true);
});

const base = () => `http://localhost:${oauthProvider.port}`;

function build() {
  const auth = createAuth({
    secret: SECRET,
    store: new MemoryAuthStore(),
    challengeStore: new MemoryChallengeStore(),
    rateLimitStore: new MemoryRateLimitStore(),
    security: { allowUnverifiedSession: true },
  });

  // Registered through the same path a real provider uses.
  (auth.oauth as unknown as { providers: Map<string, OAuthProvider> }).providers.set("test", {
    name: "test",
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: `${base()}/authorize`,
    tokenUrl: `${base()}/token`,
    userInfoUrl: `${base()}/me`,
    scopes: ["email"],
    mapProfile: (data) => ({
      id: String(data.id),
      email: String(data.email),
      emailVerified: Boolean(data.emailVerified),
      name: data.name as string,
    }),
  });

  const callback = async (state: string, expected = state, req?: Request) =>
    auth.oauth.handleCallback({
      provider: "test",
      code: "the-code",
      state,
      expectedState: expected,
      redirectUri: "https://app.test/cb",
      req,
    });

  return { auth, callback };
}

/** A state the router will accept, since it is signed by the framework's own key. */
async function realState(auth: ReturnType<typeof createAuth>): Promise<string> {
  const { state } = await auth.oauth.getAuthorizationUrl("test", "https://app.test/cb");
  return state;
}

/**
 * The session cookie an `AuthResult` sets, as a `Cookie:` header.
 *
 * Taken from the cookies rather than `tokens.accessToken` because that is not what the
 * cookie holds: the session token is a random string that only ever appears inside the
 * `Set-Cookie`, and the store keeps just its hash. A test that used the access token
 * would be testing a path no browser takes.
 */
function sessionCookie(result: { cookies: string[] }): string {
  const setCookie = result.cookies.find((c) => c.startsWith("yatta_session="));
  if (!setCookie) throw new Error("No session cookie in the result");

  return setCookie.split(";")[0]!.replace("yatta_session=", "");
}

/** The account a provider identity was attached to. */
function identityUserId(auth: ReturnType<typeof createAuth>): string | undefined {
  const identities = (
    auth.store as unknown as { identities: Map<string, { userId: string }> }
  ).identities;
  return [...identities.values()][0]?.userId;
}

describe("OAuth linking cannot be aimed at another account", () => {
  it("takes no parameter naming the account to link", () => {
    const { auth } = build();

    /*
     * There was a `linkToUserId` here, checked only for existence. Anyone who ran
     * their own Google sign-in and guessed a victim's user id passed their identity
     * straight to `linkIdentity` — and from then on Google signed them in as the
     * victim. Existence is not proof of identity, so the parameter is gone rather
     * than re-shaped into another spelling of the same hole.
     */
    const declared = auth.oauth.handleCallback.toString();
    expect(declared).not.toContain("linkToUserId");
  });

  it("refuses a state it cannot parse", async () => {
    const { callback } = build();

    // A state is `token.signature`, both produced by `getAuthorizationUrl`. One
    // without a dot was never issued here.
    await expect(callback("made-up-state")).rejects.toThrow(/Malformed OAuth state/);
  });

  it("refuses a state whose signature does not check out", async () => {
    const { auth, callback } = build();

    const state = await realState(auth);
    const [token] = state.split(".");

    // The right shape, the wrong signature — a state replayed from another app using
    // this same secret, or one edited in flight.
    await expect(callback(`${token}.forged`, `${token}.forged`)).rejects.toThrow(
      /Tampered OAuth state signature/,
    );
  });

  it("refuses a state that does not match what it expected", async () => {
    const { auth, callback } = build();

    const state = await realState(auth);

    // A genuine state, but not the one this callback round started. This is the guard
    // that makes the rest of the flow safe to act on.
    await expect(callback(state, "something-else", undefined)).rejects.toThrow(
      /Invalid or forged OAuth state/,
    );
  });

  it("treats a request with no session as an ordinary first sign-in", async () => {
    const { auth, callback } = build();
    const state = await realState(auth);

    const result = await callback(state);

    expect(result).toBeDefined();
    expect(identityUserId(auth)).toBeDefined();
  });

  it("does not link to an account named by the caller", async () => {
    const { auth, callback } = build();

    const victim = (await auth.signUp({
      email: "victim@t.dev",
      password: "Password123!",
    })) as AuthResult;
    const victimId = victim.user.id;

    const state = await realState(auth);

    /*
     * A cookie that does not resolve. There is nobody to link *to*, so this is a
     * first sign-in for the provider identity — which is the correct reading, and the
     * opposite of what a supplied user id would produce.
     */
    const forged = new Request("https://app.test/cb", {
      headers: { cookie: "yatta_session=not-a-real-token" },
    });

    await callback(state, state, forged);

    expect(identityUserId(auth)).not.toBe(victimId);
  });

  it("links to the account behind a real session", async () => {
    const { auth, callback } = build();

    const mine = (await auth.signUp({
      email: "me@t.dev",
      password: "Password123!",
    })) as AuthResult;
    const myId = mine.user.id;

    const state = await realState(auth);

    const signedIn = new Request("https://app.test/cb", {
      headers: { cookie: `yatta_session=${sessionCookie(mine)}` },
    });

    await callback(state, state, signedIn);

    // The point of the change: with a session, the identity joins *my* account rather
    // than creating a second one. So a later Google sign-in lands here.
    expect(identityUserId(auth)).toBe(myId);
  });
});

describe("MemoryAuthStore is not a silent production default", () => {
  function inProduction<T>(run: () => T): T {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      return run();
    } finally {
      process.env.NODE_ENV = original;
    }
  }

  /**
   * Production has several fail-fast guards and the email one fires first, so a test
   * about the store check has to satisfy it to isolate what it means.
   */
  const email = { appUrl: "https://app.test" };

  it("refuses to start in production without a store", () => {
    inProduction(() => {
      expect(() =>
        createAuth({
          secret: SECRET,
          challengeStore: new MemoryChallengeStore(),
          rateLimitStore: new MemoryRateLimitStore(),
          email,
        } as never),
      ).toThrow(/No auth store was supplied/);
    });
  });

  it("allows any store when one is supplied", () => {
    inProduction(() => {
      // The refusal is about the *absence* of a store, not about which one it is. An
      // app that has wired up its own is fine.
      expect(() =>
        createAuth({
          secret: SECRET,
          store: new MemoryAuthStore(),
          challengeStore: new MemoryChallengeStore(),
          rateLimitStore: new MemoryRateLimitStore(),
          email,
        } as never),
      ).not.toThrow();
    });
  });

  it("stays quiet outside production", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      // A script or a test must not have to supply a store to get started.
      expect(() =>
        createAuth({
          secret: SECRET,
          challengeStore: new MemoryChallengeStore(),
          rateLimitStore: new MemoryRateLimitStore(),
        } as never),
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

