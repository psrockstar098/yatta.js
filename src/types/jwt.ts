/**
 * ============================================================================
 *  YATTA JWT — Fast, stateless HS256 verification for Bun
 * ============================================================================
 *
 *  OVERVIEW:
 *  A minimal, opt-in HS256 JWT verifier for hot request paths. It verifies
 *  exactly the token shape the entry-style `verifyAuth` accepts — a
 *  `Bearer` token whose header declares `alg: "HS256"` and whose payload
 *  carries a numeric-string `sub`, a string `username`, and a future `exp`
 *  — and returns `{ userId, username }` on success. Nothing is cached:
 *  every call re-verifies the signature from scratch, so a revoked or
 *  rotated secret takes effect on the very next request.
 *
 *  SPEED:
 *  HMAC-SHA256 goes through `Bun.CryptoHasher` (constructor key form),
 *  which measured ~2x faster than `node:crypto` `createHmac` on this VM
 *  (729 ns/op vs 1,423 ns/op, 20,000 iters, Bun 1.4.4 — see the probe in
 *  the perf-3 notes). The signature is decoded with
 *  `Buffer.from(sig, "base64url")`: there is no `Bun.base64URLDecode` in
 *  Bun 1.4.4 (checked against bun.sh/docs/api/hashing and at runtime —
 *  `typeof Bun.base64URLDecode === "undefined"`), and the lenient
 *  `Buffer.from` decode is also what the reference verifier uses, so
 *  non-canonical base64url spellings behave identically here.
 *
 *  ORDER (deliberately different from the reference, provably equivalent):
 *  the reference parses the payload JSON before checking the signature;
 *  this verifier checks the signature first and parses the payload only
 *  after the signature is known good. The two orders produce identical
 *  outcomes because every failure before the payload-shape check reports
 *  the same string — "invalid or expired token" — and the only other
 *  failure string, "invalid token payload", is reachable only after the
 *  signature has passed and the payload has parsed as an object, which
 *  is the same gate in both orders. A token that fails two checks at once
 *  therefore yields the same string either way; the test file
 *  (`src/test/jwt-fast.test.ts`) proves this with a differential test
 *  that runs the same corpus through both implementations.
 *
 *  One equivalence subtlety is load-bearing: the signature comparison is
 *  over DECODED BYTES (`timingSafeEqual` on the 32-byte digests), never
 *  over the base64url strings. Two base64url spellings can decode to the
 *  same bytes (non-canonical trailing bits, padding variants); the
 *  reference accepts those, so a string comparison here would wrongly
 *  reject them.
 *
 *  KEY EXPORTS:
 *  - `createJwtVerifier(secret)`: Factory returning a `{ verifyToken,
 *    verifyAuthorizationHeader, verifyRequest }` verifier bound to one
 *    HS256 secret. Stateless per call; safe to share across requests.
 *  - `verifyToken` / `verifyAuthorizationHeader` / `verifyRequest`:
 *    Verify a raw token, an `Authorization` header value, or a whole
 *    `Request`. All return `JwtVerifyResult`.
 *  - `JwtVerifyResult`: `{ ok: true; userId: number; username: string }`
 *    on success, `{ ok: false; error: string }` on failure. Error
 *    strings match the reference verifier exactly: "missing bearer
 *    token", "invalid or expired token", "invalid token payload".
 *
 *  SCOPE — what this is NOT:
 *  This is not the auth subsystem (`src/types/auth.ts`): it issues no
 *  tokens, manages no sessions, and knows nothing about users, roles,
 *  or refresh flows. It verifies one token shape, fast. It accepts only
 *  HS256; `alg: "none"`, HS384/HS512, RS256, and every other algorithm
 *  fail with "invalid or expired token".
 *
 *  QUICKSTART / USAGE:
 *  ```ts
 *  import { createJwtVerifier } from "yatta.js/jwt";
 *
 *  const jwt = createJwtVerifier(process.env.JWT_SECRET!);
 *
 *  api.post("/posts/:id/like", (ctx) => {
 *    const auth = jwt.verifyRequest(ctx.req);
 *    if (!auth.ok) return API.json({ error: auth.error }, { status: 401 });
 *    // auth.userId, auth.username
 *  });
 *  ```
 */

import { timingSafeEqual } from "node:crypto";

// Hoisted: the reference builds this literal per call; the pattern never
// changes, so one shared instance is both faster and identical.
const SUB_RE = /^[1-9][0-9]*$/;

/** Success: the token verified; `userId` is `Number(payload.sub)`. */
export type JwtVerifySuccess = {
  ok: true;
  userId: number;
  username: string;
};

/** Failure: `error` is one of the reference verifier's exact strings. */
export type JwtVerifyFailure = {
  ok: false;
  error: string;
};

export type JwtVerifyResult = JwtVerifySuccess | JwtVerifyFailure;

/**
 * A stateless HS256 verifier bound to one secret. Create once, share
 * across requests — no per-request state is kept, and no verification
 * result is ever cached.
 */
export interface JwtVerifier {
  /** Verify a raw `header.payload.signature` token (no `Bearer ` prefix). */
  verifyToken(token: string): JwtVerifyResult;
  /**
   * Verify an `Authorization` header value. Missing / non-`Bearer`
   * values fail with "missing bearer token", exactly like the reference.
   */
  verifyAuthorizationHeader(
    header: string | null | undefined,
  ): JwtVerifyResult;
  /** Verify the `Authorization` header of a `Request`. */
  verifyRequest(req: Request): JwtVerifyResult;
}

const MISSING_BEARER = "missing bearer token";
const INVALID_OR_EXPIRED = "invalid or expired token";
const INVALID_PAYLOAD = "invalid token payload";

/**
 * Create a fast HS256 verifier for `secret`.
 *
 * @throws `TypeError` if `secret` is not a non-empty string. This is
 *   construction-time only; verification itself never throws — every
 *   malformed input is a `{ ok: false, error }` result.
 */
export function createJwtVerifier(secret: string): JwtVerifier {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError(
      "createJwtVerifier requires a non-empty string secret",
    );
  }

  function verifyToken(token: string): JwtVerifyResult {
    // Exactly two dots, exactly three segments (reference semantics).
    const i1 = token.indexOf(".");
    const i2 = i1 < 0 ? -1 : token.indexOf(".", i1 + 1);
    if (i1 < 0 || i2 < 0 || token.indexOf(".", i2 + 1) >= 0) {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }
    const headerB64 = token.slice(0, i1);
    const payloadB64 = token.slice(i1 + 1, i2);
    const signatureB64 = token.slice(i2 + 1);

    // Header first: the algorithm gate must hold before any HMAC work,
    // and a malformed header fails here with the same string the
    // reference reports when its joint header+payload parse throws.
    let headerObj: unknown;
    try {
      headerObj = JSON.parse(
        Buffer.from(headerB64, "base64url").toString("utf8"),
      );
    } catch {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }
    if (
      typeof headerObj !== "object" ||
      headerObj === null ||
      (headerObj as { alg?: unknown }).alg !== "HS256"
    ) {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }

    // Signature before payload: a forged token never pays for a
    // JSON.parse of its payload. The digest is compared over decoded
    // bytes (see the header comment) with a length check first, so
    // `timingSafeEqual` only ever sees equal-length buffers.
    const digest = new Bun.CryptoHasher("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const givenSig = Buffer.from(signatureB64, "base64url");
    if (
      digest.length !== givenSig.length ||
      !timingSafeEqual(digest, givenSig)
    ) {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }

    let payloadObj: unknown;
    try {
      payloadObj = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      );
    } catch {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }
    if (typeof payloadObj !== "object" || payloadObj === null) {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }
    const payload = payloadObj as {
      sub?: unknown;
      username?: unknown;
      exp?: unknown;
    };
    if (
      typeof payload.sub !== "string" ||
      !SUB_RE.test(payload.sub) ||
      typeof payload.username !== "string"
    ) {
      return { ok: false, error: INVALID_PAYLOAD };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
      return { ok: false, error: INVALID_OR_EXPIRED };
    }
    return {
      ok: true,
      userId: Number(payload.sub),
      username: payload.username,
    };
  }

  function verifyAuthorizationHeader(
    header: string | null | undefined,
  ): JwtVerifyResult {
    if (!header || !header.startsWith("Bearer ")) {
      return { ok: false, error: MISSING_BEARER };
    }
    return verifyToken(header.slice("Bearer ".length));
  }

  function verifyRequest(req: Request): JwtVerifyResult {
    return verifyAuthorizationHeader(req.headers.get("authorization"));
  }

  return { verifyToken, verifyAuthorizationHeader, verifyRequest };
}
