import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import { createOAuthServer } from "../func/oauth";

function sha256b64url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function form(body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request("http://x/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

describe("OAuth 2.0 server", () => {
  const server = createOAuthServer({
    issuer: "http://x",
    resolveUser: async () => "user-1",
  });
  server.registerClient({
    id: "web-app",
    secret: "s3cret",
    redirectUris: ["http://localhost:3000/callback"],
    name: "Web app",
  });
  server.registerClient({
    id: "mobile-app",
    redirectUris: ["myapp://callback"],
    name: "Mobile app (public)",
  });

  async function authorize(
    clientId: string,
    extra: Record<string, string> = {},
  ): Promise<string> {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri:
        clientId === "mobile-app" ? "myapp://callback" : "http://localhost:3000/callback",
      scope: "openid profile",
      state: "xyz",
      ...extra,
    });
    const res = await server.handleAuthorize(
      new Request(`http://x/oauth/authorize?${params.toString()}`),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.searchParams.get("state")).toBe("xyz");
    return location.searchParams.get("code")!;
  }

  it("code flow with PKCE (S256) issues access + refresh tokens", async () => {
    const verifier = "a-random-verifier-string-long-enough";
    const code = await authorize("mobile-app", {
      code_challenge: sha256b64url(verifier),
      code_challenge_method: "S256",
    });
    const res = await server.handleToken(
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: "myapp://callback",
        client_id: "mobile-app",
        code_verifier: verifier,
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.token_type).toBe("Bearer");
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    expect(json.expires_in).toBe(3600);
  });

  it("wrong PKCE verifier fails", async () => {
    const code = await authorize("mobile-app", {
      code_challenge: sha256b64url("correct-verifier"),
      code_challenge_method: "S256",
    });
    const res = await server.handleToken(
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: "myapp://callback",
        client_id: "mobile-app",
        code_verifier: "wrong-verifier",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("a code works only once", async () => {
    const code = await authorize("web-app");
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:3000/callback",
      client_id: "web-app",
      client_secret: "s3cret",
    };
    expect((await server.handleToken(form(body))).status).toBe(200);
    const again = await server.handleToken(form(body));
    expect(again.status).toBe(400);
  });

  it("wrong client secret fails", async () => {
    const code = await authorize("web-app");
    const res = await server.handleToken(
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/callback",
        client_id: "web-app",
        client_secret: "not-the-secret",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("public clients must use PKCE", async () => {
    const res = await server.handleAuthorize(
      new Request(
        "http://x/oauth/authorize?response_type=code&client_id=mobile-app&redirect_uri=myapp://callback",
      ),
    );
    expect(res.status).toBe(400);
  });

  it("client credentials flow issues an access token, no refresh", async () => {
    const res = await server.handleToken(
      form({
        grant_type: "client_credentials",
        client_id: "web-app",
        client_secret: "s3cret",
        scope: "read",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.access_token).toBe("string");
    expect(json.refresh_token).toBeUndefined();
  });

  it("refresh tokens rotate: the old one dies on use", async () => {
    const verifier = "another-verifier-string-long-enough";
    const code = await authorize("mobile-app", {
      code_challenge: sha256b64url(verifier),
      code_challenge_method: "S256",
    });
    const first = (await (
      await server.handleToken(
        form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "myapp://callback",
          client_id: "mobile-app",
          code_verifier: verifier,
        }),
      )
    ).json()) as { refresh_token: string };
    const rotated = await server.handleToken(
      form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "mobile-app",
      }),
    );
    expect(rotated.status).toBe(200);
    const reused = await server.handleToken(
      form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "mobile-app",
      }),
    );
    expect(reused.status).toBe(400);
  });

  it("reusing a rotated refresh token revokes the whole family", async () => {
    const verifier = "family-verifier-string-long-enough";
    const code = await authorize("mobile-app", {
      code_challenge: sha256b64url(verifier),
      code_challenge_method: "S256",
    });
    const first = (await (
      await server.handleToken(
        form({
          grant_type: "authorization_code",
          code,
          redirect_uri: "myapp://callback",
          client_id: "mobile-app",
          code_verifier: verifier,
        }),
      )
    ).json()) as { access_token: string; refresh_token: string };
    const rotated = (await (
      await server.handleToken(
        form({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: "mobile-app",
        }),
      )
    ).json()) as { access_token: string; refresh_token: string };
    expect(server.getAccessToken(rotated.access_token)).not.toBeNull();
    // Showing the old refresh token again means it may have been
    // stolen: the replacement tokens must die too.
    const reuse = await server.handleToken(
      form({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: "mobile-app",
      }),
    );
    expect(reuse.status).toBe(400);
    expect(server.getAccessToken(rotated.access_token)).toBeNull();
    const newRefresh = await server.handleToken(
      form({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: "mobile-app",
      }),
    );
    expect(newRefresh.status).toBe(400);
  });

  it("revoke kills a token", async () => {
    const res = await server.handleToken(
      form({
        grant_type: "client_credentials",
        client_id: "web-app",
        client_secret: "s3cret",
      }),
    );
    const { access_token } = (await res.json()) as { access_token: string };
    expect(server.getAccessToken(access_token)).not.toBeNull();
    const revoked = await server.handleRevoke(
      form({ token: access_token, client_id: "web-app", client_secret: "s3cret" }),
    );
    expect(revoked.status).toBe(200);
    expect(server.getAccessToken(access_token)).toBeNull();
  });
});
