// yatta/backend/auth.ts
//
// Signup, signin, signout and "who am I".
//
// Auth is mounted in routes.ts, so these are live on a fresh project:
//
//   POST /api/auth/signup    { email, password }
//   POST /api/auth/signin    { email, password }
//   POST /api/auth/signout
//   GET  /api/auth/me
//
// Add password reset, passkeys, MFA or API keys here as you need them — they
// are methods on the same `auth` handle.

import { createAPI, HttpError } from "yatta.js/api";
import { auth } from "../func/auth";

const api = createAPI();

/**
 * signUp and signIn return a union: either a complete session, or a demand to
 * verify the address first. Both branches have to be handled, or a user is
 * silently left unable to sign in.
 */
function isVerificationRequired(
  result: unknown,
): result is { user: unknown; emailVerificationRequired: true } {
  return typeof result === "object" && result !== null && "emailVerificationRequired" in result;
}

/** Apply a token pair to a response. */
function sessionResponse(result: { tokens: unknown; cookies: string[] }, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);

  return new Response(
    JSON.stringify({ tokens: result.tokens }),
    { status, headers },
  );
}

/**
 * Whether a sign-in stopped at the second factor.
 *
 * Every sign-in route returns this instead of a session when the account has 2FA on,
 * and the returned value is a ticket, not a user id: a bare id gives an app's own
 * second step nothing to verify.
 */
function isMfaChallenge(
  result: unknown,
): result is { mfaRequired: true; ticket: string; expiresInSec: number } {
  return typeof result === "object" && result !== null && "mfaRequired" in result;
}

/** POST /api/auth/signup */
api.post("/signup", async (ctx) => {
  const { email, password } = (await ctx.req.json()) as {
    email: string;
    password: string;
  };

  const result = await auth.signUp({ email, password, req: ctx.req });

  if (isVerificationRequired(result)) {
    return Response.json(
      { user: result.user, emailVerificationRequired: true },
      { status: 202 },
    );
  }

  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ user: result.user }), { status: 201, headers });
});

/** POST /api/auth/signin */
api.post("/signin", async (ctx) => {
  const { email, password } = (await ctx.req.json()) as {
    email: string;
    password: string;
  };

  const result = await auth.signIn({ email, password, req: ctx.req });

  if (isVerificationRequired(result)) {
    return Response.json({ emailVerificationRequired: true }, { status: 202 });
  }

  // With 2FA on there is no session yet. Answering sessionResponse() here would read
  // cookies off an object that has none, so a 2FA user got a 500 from a fresh project.
  if (isMfaChallenge(result)) {
    return Response.json(result, { status: 202 });
  }

  return sessionResponse(result);
});

/** POST /api/auth/mfa — the second half of a sign-in that stopped at 2FA. */
api.post("/mfa", async (ctx) => {
  const { ticket, code, recoveryCode } = (await ctx.req.json()) as {
    ticket: string;
    code?: string;
    recoveryCode?: string;
  };

  // The ticket is single use, so a retry needs a new signIn.
  const result = await auth.completeMfa({ ticket, code, recoveryCode, req: ctx.req });

  return sessionResponse(result);
});

/** POST /api/auth/signout */
api.post("/signout", async (ctx) => {
  const result = await auth.signOut(ctx.req);
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(result), { status: 200, headers });
});

/** GET /api/auth/me — null when signed out. */
api.get("/me", async (ctx) => {
  const user = await auth.getUser(ctx.req);
  if (!user) throw new HttpError(401, "Not authenticated");
  return Response.json({ user });
});

/**
 * GET /api/auth/require-me — throws when signed out.
 *
 * requireUser raises the auth subsystem's own UnauthorizedError, which carries
 * status 401. routes.ts reads that status structurally, so the response is a
 * 401 rather than a 500.
 */
api.get("/require-me", async (ctx) => {
  const user = await auth.requireUser(ctx.req);
  return Response.json({ user });
});

export default api;
