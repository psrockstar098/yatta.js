import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import { createOAuthServer } from "../func/oauth";
import { createOIDC } from "../func/oidc";

const users: Record<string, { id: string; email: string; name: string }> = {
  "user-1": { id: "user-1", email: "ada@example.com", name: "Ada" },
};

describe("OpenID Connect", () => {
  const oauth = createOAuthServer({
    issuer: "http://x",
    resolveUser: async () => "user-1",
  });
  oauth.registerClient({
    id: "web-app",
    secret: "s3cret",
    redirectUris: ["http://localhost:3000/callback"],
  });
  const oidc = createOIDC({
    issuer: "http://x",
    oauth,
    findUser: async (id) => users[id] ?? null,
  });
  oauth.setIdTokenIssuer(oidc.issueIdToken);

  async function fullLogin(): Promise<{
    access: string;
    idToken: string;
  }> {
    const authRes = await oauth.handleAuthorize(
      new Request(
        "http://x/oauth/authorize?response_type=code&client_id=web-app" +
          "&redirect_uri=http://localhost:3000/callback&scope=openid%20profile%20email" +
          "&nonce=test-nonce-123",
      ),
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes = await oauth.handleToken(
      new Request("http://x/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          client_id: "web-app",
          client_secret: "s3cret",
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const json = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
    };
    expect(typeof json.id_token).toBe("string");
    return { access: json.access_token, idToken: json.id_token! };
  }

  it("token reply carries a verifiable RS256 ID token", async () => {
    const { idToken } = await fullLogin();
    const [headerB64, payloadB64, signatureB64] = idToken.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new Error("ID token is missing a part");
    }
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("yatta-1");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    expect(payload.iss).toBe("http://x");
    expect(payload.sub).toBe("user-1");
    expect(payload.aud).toBe("web-app");
    expect(payload.nonce).toBe("test-nonce-123");
    expect(payload.email).toBe("ada@example.com");
    expect(payload.name).toBe("Ada");
    // Check the signature against the published JWKS key.
    const jwks = (await oidc.handleJWKS().json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(jwks.keys[0]!.kty).toBe("RSA");
    const publicKey = crypto.createPublicKey({ key: jwks.keys[0]!, format: "jwk" });
    const ok = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      publicKey,
      Buffer.from(signatureB64, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("userinfo returns claims for a valid access token", async () => {
    const { access } = await fullLogin();
    const res = await oidc.handleUserinfo(
      new Request("http://x/oauth/userinfo", {
        headers: { Authorization: `Bearer ${access}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.sub).toBe("user-1");
    expect(json.email).toBe("ada@example.com");
    expect(json.name).toBe("Ada");
  });

  it("userinfo refuses a bad token", async () => {
    const res = await oidc.handleUserinfo(
      new Request("http://x/oauth/userinfo", {
        headers: { Authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("userinfo refuses a token without openid scope", async () => {
    const authRes = await oauth.handleAuthorize(
      new Request(
        "http://x/oauth/authorize?response_type=code&client_id=web-app" +
          "&redirect_uri=http://localhost:3000/callback&scope=profile",
      ),
    );
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes = await oauth.handleToken(
      new Request("http://x/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:3000/callback",
          client_id: "web-app",
          client_secret: "s3cret",
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const json = (await tokenRes.json()) as { access_token: string };
    const res = await oidc.handleUserinfo(
      new Request("http://x/oauth/userinfo", {
        headers: { Authorization: `Bearer ${json.access_token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("discovery lists every endpoint", async () => {
    const doc = (await oidc.handleDiscovery().json()) as Record<string, unknown>;
    expect(doc.issuer).toBe("http://x");
    expect(doc.authorization_endpoint).toBe("http://x/oauth/authorize");
    expect(doc.token_endpoint).toBe("http://x/oauth/token");
    expect(doc.userinfo_endpoint).toBe("http://x/oauth/userinfo");
    expect(doc.jwks_uri).toBe("http://x/oauth/jwks");
    expect(
      (doc.id_token_signing_alg_values_supported as string[]).includes("RS256"),
    ).toBe(true);
  });
});
