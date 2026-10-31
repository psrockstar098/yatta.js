// OpenID Connect — identity on top of the OAuth 2.0 server.
//
// What it adds, in plain terms:
//   - A discovery document: clients find every endpoint in one place.
//   - ID tokens: a signed proof of who the user is, handed out with
//     the access token when the scope includes "openid".
//   - A JWKS endpoint: the public key clients use to check ID tokens.
//   - A userinfo endpoint: name and email for a valid access token.
//
// Signing uses RS256 (an RSA keypair). The public half is published on
// the JWKS endpoint; the private half never leaves the server.
//
// Keys: by default a keypair is made when the server first needs it
// and does not survive a restart — old ID tokens stop verifying after
// one, which is fine for short-lived tokens. If you run more than one
// server instance, or want tokens to survive restarts, pass
// `privateKeyPem` so every instance signs with the same key. The key
// id (`kid`) is derived from the public key, so a new key always gets
// a new kid and clients know to refetch the JWKS.
//
// HS256 is deliberately not used: with a shared secret, publishing the
// check key would also publish the signing key, and anyone could forge
// tokens.

import crypto from "node:crypto";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The parts of a user an ID token can carry. */
export interface OidcUser {
  id: string;
  email?: string;
  // Only send true when your app has actually verified the address.
  emailVerified?: boolean;
  name?: string;
}

interface AccessTokenInfo {
  userId: string | null;
  clientId: string;
  scope: string[];
}

/**
 * What the OIDC layer needs from the app.
 *
 * It adds three endpoints on top of the OAuth server — discovery, JWKS and
 * userinfo — and one method, `issueIdToken`, that the OAuth server calls
 * when a code is exchanged. Both objects share the same reading of who the
 * user is; neither keeps its own copy.
 */
export interface OidcOptions {
  // Public base URL of this server, like "http://localhost:4000".
  // A trailing slash is ignored.
  issuer: string;
  // The OAuth server, used to check access tokens at userinfo.
  oauth: {
    getAccessToken(
      token: string,
    ): AccessTokenInfo | null | Promise<AccessTokenInfo | null>;
  };
  // Looks a user up by id. Return null when the user is gone.
  findUser: (id: string) => Promise<OidcUser | null>;
  // Optional RSA private key (PKCS#8 or PKCS#1 PEM, 2048 bits or more)
  // so signing keys are stable across restarts and instances.
  privateKeyPem?: string;
  // How long an ID token lives, in seconds. Default 3600.
  idTokenTtlSeconds?: number;
  // What the discovery document says the OAuth server supports. These
  // only describe the server; they do not change what it accepts.
  // Defaults: the three grants below, and S256 only. "plain" PKCE is
  // not advertised because it gives no protection if the request is
  // seen; list it here only if your OAuth server needs it.
  grantTypes?: string[];
  codeChallengeMethods?: string[];
}

function normalizeIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OIDC issuer is not a valid URL: ${value}`);
  }
  if (url.search || url.hash) {
    throw new Error("OIDC issuer must not have a query string or fragment");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    console.warn(
      `[oidc] issuer "${value}" is not https. Most OIDC clients require https outside localhost.`,
    );
  }
  // Without this, "http://x/" produced "http://x//oauth/authorize".
  return url.toString().replace(/\/+$/, "");
}

function noStore(extra: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "no-store", Pragma: "no-cache", ...extra };
}

/**
 * Build the OpenID Connect endpoints over an existing OAuth server.
 *
 * Mount `handleDiscovery` on `/.well-known/openid-configuration`,
 * `handleJWKS` on `/oauth/jwks` and `handleUserinfo` on `/oauth/userinfo`,
 * then hand `issueIdToken` to the OAuth server with `setIdTokenIssuer`, so
 * a token reply carries an ID token.
 *
 * @example
 * const oidc = createOIDC({
 *   issuer: "https://api.example.com",
 *   oauth,
 *   findUser: (id) => db.users.findFirst({ where: { id } }),
 * });
 * oauth.setIdTokenIssuer(oidc.issueIdToken);
 *
 * @returns `issueIdToken`, plus the three HTTP handlers.
 * @throws when `issuer` is not a URL — at startup, not on the first login.
 */
export function createOIDC(options: OidcOptions) {
  const issuer = normalizeIssuer(options.issuer);
  const ttl = Math.max(
    60,
    Math.floor(options.idTokenTtlSeconds ?? 3600) || 3600,
  );
  const grantTypes = options.grantTypes ?? [
    "authorization_code",
    "client_credentials",
    "refresh_token",
  ];
  const challengeMethods = options.codeChallengeMethods ?? ["S256"];

  let cached: {
    privateKey: crypto.KeyObject;
    jwk: Record<string, unknown>;
    kid: string;
  } | null = null;

  // Made once, on first use, then kept for the life of the server.
  function keys() {
    if (cached) return cached;
    let privateKey: crypto.KeyObject;
    let publicKey: crypto.KeyObject;
    if (options.privateKeyPem) {
      privateKey = crypto.createPrivateKey(options.privateKeyPem);
      const details = privateKey.asymmetricKeyDetails;
      if (
        privateKey.asymmetricKeyType !== "rsa" ||
        (details?.modulusLength ?? 0) < 2048
      ) {
        throw new Error(
          "OIDC privateKeyPem must be an RSA key of 2048 bits or more",
        );
      }
      publicKey = crypto.createPublicKey(privateKey);
    } else {
      ({ privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      }));
    }
    const raw = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    // RFC 7638 thumbprint: SHA-256 over the required members in
    // alphabetical order. Same key, same kid; new key, new kid.
    const kid = crypto
      .createHash("sha256")
      .update(JSON.stringify({ e: raw.e, kty: "RSA", n: raw.n }))
      .digest("base64url");
    cached = {
      privateKey,
      kid,
      jwk: { kty: "RSA", use: "sig", kid, alg: "RS256", n: raw.n, e: raw.e },
    };
    return cached;
  }

  function signJwt(payload: Record<string, unknown>): string {
    const { privateKey, kid } = keys();
    const header = base64urlJson({ alg: "RS256", kid, typ: "JWT" });
    const body = base64urlJson(payload);
    const signature = crypto
      .sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey)
      .toString("base64url");
    return `${header}.${body}.${signature}`;
  }

  // Builds an ID token for a user. Returns null when the user is gone
  // or the scope does not include "openid" (no scope, no identity).
  async function issueIdToken(args: {
    clientId: string;
    userId: string;
    scope: string[];
    nonce?: string;
  }): Promise<string | null> {
    if (!args.scope.includes("openid")) return null;
    const user = await options.findUser(args.userId);
    if (!user) return null;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: user.id,
      aud: args.clientId,
      exp: now + ttl,
      iat: now,
    };
    if (args.nonce) claims.nonce = args.nonce;
    if (args.scope.includes("email") && user.email) {
      claims.email = user.email;
      if (user.emailVerified !== undefined) {
        claims.email_verified = user.emailVerified;
      }
    }
    if (args.scope.includes("profile") && user.name) claims.name = user.name;
    return signJwt(claims);
  }

  function handleDiscovery(): Response {
    return Response.json(
      {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        userinfo_endpoint: `${issuer}/oauth/userinfo`,
        jwks_uri: `${issuer}/oauth/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email"],
        claims_supported: [
          "sub",
          "iss",
          "aud",
          "exp",
          "iat",
          "nonce",
          "email",
          "email_verified",
          "name",
        ],
        grant_types_supported: grantTypes,
        code_challenge_methods_supported: challengeMethods,
      },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  }

  function handleJWKS(): Response {
    // Short cache: after a restart without privateKeyPem the key
    // changes, and clients should pick up the new one soon.
    return Response.json(
      { keys: [keys().jwk] },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  }

  function userinfoError(
    status: number,
    error: string,
    challenge: string,
  ): Response {
    return Response.json(
      { error },
      { status, headers: noStore({ "WWW-Authenticate": challenge }) },
    );
  }

  async function handleUserinfo(req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("Use GET or POST", {
        status: 405,
        headers: noStore({ Allow: "GET, POST" }),
      });
    }
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (!token) {
      return userinfoError(401, "invalid_token", "Bearer");
    }
    try {
      const info = await options.oauth.getAccessToken(token);
      if (!info || !info.userId) {
        return userinfoError(
          401,
          "invalid_token",
          'Bearer error="invalid_token"',
        );
      }
      // userinfo is an OpenID Connect endpoint: a token without the
      // openid scope is not an identity token, even if it is valid for
      // other parts of the app. Without this check, any app token (for
      // example one made for plain API access) could read the user's
      // profile here.
      if (!info.scope.includes("openid")) {
        return userinfoError(
          403,
          "insufficient_scope",
          'Bearer error="insufficient_scope", scope="openid"',
        );
      }
      const user = await options.findUser(info.userId);
      if (!user) {
        return userinfoError(
          401,
          "invalid_token",
          'Bearer error="invalid_token"',
        );
      }
      const body: Record<string, unknown> = { sub: user.id };
      if (info.scope.includes("email") && user.email) {
        body.email = user.email;
        if (user.emailVerified !== undefined) {
          body.email_verified = user.emailVerified;
        }
      }
      if (info.scope.includes("profile") && user.name) body.name = user.name;
      // Personal data: never let a proxy or browser keep a copy.
      return Response.json(body, { headers: noStore() });
    } catch (err) {
      console.error("[oidc] userinfo failed:", err);
      return Response.json(
        { error: "server_error" },
        { status: 500, headers: noStore() },
      );
    }
  }

  return { issueIdToken, handleDiscovery, handleJWKS, handleUserinfo };
}

/** The object `createOIDC` returns. */
export type OIDC = ReturnType<typeof createOIDC>;
