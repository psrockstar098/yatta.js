// OpenID Connect — identity on top of the OAuth 2.0 server.
//
// What it adds, in plain terms:
//   - A discovery document: clients find every endpoint in one place.
//   - ID tokens: a signed proof of who the user is, handed out with
//     the access token when the scope includes "openid".
//   - A JWKS endpoint: the public key clients use to check ID tokens.
//   - A userinfo endpoint: name and email for a valid access token.
//
// Signing uses RS256 (an RSA keypair made when the server first
// needs it). The public half is published on the JWKS endpoint;
// the private half never leaves the server. Keys do not survive a
// restart — old ID tokens stop verifying after one, which is fine
// for short-lived tokens. HS256 is deliberately not used: with a
// shared secret, publishing the check key would also publish the
// signing key, and anyone could forge tokens.

import crypto from "node:crypto";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface OidcUser {
  id: string;
  email?: string;
  name?: string;
}

export interface OidcOptions {
  // Public base URL of this server, like "http://localhost:4000".
  issuer: string;
  // The OAuth server, used to check access tokens at userinfo.
  oauth: {
    getAccessToken(token: string): {
      userId: string | null;
      clientId: string;
      scope: string[];
    } | null;
  };
  // Looks a user up by id. Return null when the user is gone.
  findUser: (id: string) => Promise<OidcUser | null>;
}

export function createOIDC(options: OidcOptions) {
  const { issuer } = options;
  let keypair: { publicKey: string; privateKey: string } | null = null;

  // Made once, on first use, then kept for the life of the server.
  function keys() {
    if (!keypair) {
      keypair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    }
    return keypair;
  }

  function publicJwk() {
    const key = crypto.createPublicKey(keys().publicKey);
    const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
    return {
      kty: "RSA",
      use: "sig",
      kid: "yatta-1",
      alg: "RS256",
      n: jwk.n,
      e: jwk.e,
    };
  }

  function signJwt(payload: Record<string, unknown>): string {
    const header = base64urlJson({ alg: "RS256", kid: "yatta-1", typ: "JWT" });
    const body = base64urlJson(payload);
    const signature = crypto
      .sign("RSA-SHA256", Buffer.from(`${header}.${body}`), keys().privateKey)
      .toString("base64url");
    return `${header}.${body}.${signature}`;
  }

  // Builds an ID token for a user. Returns null when the user is gone.
  async function issueIdToken(args: {
    clientId: string;
    userId: string;
    scope: string[];
    nonce?: string;
  }): Promise<string | null> {
    const user = await options.findUser(args.userId);
    if (!user) return null;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: user.id,
      aud: args.clientId,
      exp: now + 3600,
      iat: now,
    };
    if (args.nonce) claims.nonce = args.nonce;
    if (args.scope.includes("email") && user.email) claims.email = user.email;
    if (args.scope.includes("profile") && user.name) claims.name = user.name;
    return signJwt(claims);
  }

  function handleDiscovery(): Response {
    return Response.json({
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
        "name",
      ],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ],
      code_challenge_methods_supported: ["S256", "plain"],
    });
  }

  function handleJWKS(): Response {
    return Response.json({ keys: [publicJwk()] });
  }

  async function handleUserinfo(req: Request): Promise<Response> {
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1]) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    const info = options.oauth.getAccessToken(match[1]);
    if (!info || !info.userId) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    // userinfo is an OpenID Connect endpoint: a token without the
    // openid scope is not an identity token, even if it is valid for
    // other parts of the app. Without this check, any app token (for
    // example one made for plain API access) could read the user's
    // profile here.
    if (!info.scope.includes("openid")) {
      return Response.json({ error: "insufficient_scope" }, { status: 403 });
    }
    const user = await options.findUser(info.userId);
    if (!user) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    const body: Record<string, unknown> = { sub: user.id };
    if (info.scope.includes("email") && user.email) body.email = user.email;
    if (info.scope.includes("profile") && user.name) body.name = user.name;
    return Response.json(body);
  }

  return { issueIdToken, handleDiscovery, handleJWKS, handleUserinfo };
}

export type OIDC = ReturnType<typeof createOIDC>;
