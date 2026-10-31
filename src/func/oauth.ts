// OAuth 2.0 server — authorization code with PKCE, client
// credentials, and refresh tokens.
//
// Simple to use: create a server, register a client, mount three
// routes. No database is needed: codes and tokens live in memory
// (they do not survive a restart, and one server holds them — for
// multi-node setups, give each node its own clients or add a shared
// store later). Secrets are never stored raw: only SHA-256 hashes.
//
// Endpoints (mounted by the router):
//   GET  /oauth/authorize  — starts the code flow (user must be signed in)
//   POST /oauth/token      — code, client_credentials, refresh_token
//   POST /oauth/revoke     — revokes one token
//
// When the scope includes "openid" and an ID-token issuer is set
// (see setIdTokenIssuer, used by the OIDC module), the token reply
// also carries an id_token.

import crypto from "node:crypto";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function base64urlSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export interface OAuthClient {
  id: string;
  // SHA-256 hash of the secret. Empty for public clients (apps that
  // cannot keep a secret, like a mobile app or a browser app).
  secretHash: string;
  redirectUris: string[];
  name?: string;
}

export interface OAuthClientInput {
  id: string;
  secret?: string;
  redirectUris: string[];
  name?: string;
}

interface AuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge?: string;
  codeChallengeMethod?: string;
  nonce?: string;
  expiresAt: number;
  used: boolean;
}

interface OAuthTokenRecord {
  tokenHash: string;
  type: "access" | "refresh";
  clientId: string;
  userId: string | null;
  scope: string[];
  expiresAt: number;
  revoked: boolean;
}

export interface OAuthStore {
  saveClient(client: OAuthClient): void;
  getClient(id: string): OAuthClient | undefined;
  saveCode(code: AuthCode): void;
  getCode(codeHash: string): AuthCode | undefined;
  saveToken(token: OAuthTokenRecord): void;
  getToken(tokenHash: string): OAuthTokenRecord | undefined;
}

// Plain in-memory store. Good for one server and for tests.
export class MemoryOAuthStore implements OAuthStore {
  clients = new Map<string, OAuthClient>();
  codes = new Map<string, AuthCode>();
  tokens = new Map<string, OAuthTokenRecord>();

  saveClient(client: OAuthClient): void {
    this.clients.set(client.id, client);
  }
  getClient(id: string): OAuthClient | undefined {
    return this.clients.get(id);
  }
  saveCode(code: AuthCode): void {
    this.codes.set(code.codeHash, code);
  }
  getCode(codeHash: string): AuthCode | undefined {
    return this.codes.get(codeHash);
  }
  saveToken(token: OAuthTokenRecord): void {
    this.tokens.set(token.tokenHash, token);
  }
  getToken(tokenHash: string): OAuthTokenRecord | undefined {
    return this.tokens.get(tokenHash);
  }
}

export interface IdTokenIssuer {
  (args: {
    clientId: string;
    userId: string;
    scope: string[];
    nonce?: string;
  }): Promise<string | null> | string | null;
}

export interface OAuthServerOptions {
  // Public base URL of this server, like "http://localhost:4000".
  issuer: string;
  store?: OAuthStore;
  // Clients known at startup (more can be added with registerClient).
  clients?: OAuthClientInput[];
  // Finds the signed-in user for the authorize step. Return null
  // when nobody is signed in.
  resolveUser?: (req: Request) => Promise<string | null>;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  codeTtlSec?: number;
  issueIdToken?: IdTokenIssuer;
}

export interface OAuthTokenInfo {
  userId: string | null;
  clientId: string;
  scope: string[];
}

function oauthError(error: string, status = 400, description?: string): Response {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status },
  );
}

export function createOAuthServer(options: OAuthServerOptions) {
  const store = options.store ?? new MemoryOAuthStore();
  const accessTtl = options.accessTokenTtlSec ?? 3600;
  const refreshTtl = options.refreshTokenTtlSec ?? 30 * 24 * 3600;
  const codeTtl = options.codeTtlSec ?? 600;
  let issueIdToken = options.issueIdToken ?? null;
  const resolveUser = options.resolveUser ?? (async () => null);

  function registerClient(input: OAuthClientInput): OAuthClient {
    if (!input.id) throw new Error("Client id is required");
    if (!input.redirectUris || input.redirectUris.length === 0) {
      throw new Error("At least one redirect URI is required");
    }
    for (const uri of input.redirectUris) {
      try {
        new URL(uri);
      } catch {
        throw new Error(`Bad redirect URI: ${uri}`);
      }
    }
    const client: OAuthClient = {
      id: input.id,
      secretHash: input.secret ? sha256Hex(input.secret) : "",
      redirectUris: input.redirectUris,
      name: input.name,
    };
    store.saveClient(client);
    return client;
  }

  for (const input of options.clients ?? []) registerClient(input);

  // Reads client_id + client_secret from a Basic header or the body.
  function readClientAuth(
    req: Request,
    params: URLSearchParams,
  ): { id: string; secret: string } | null {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
        const colon = decoded.indexOf(":");
        if (colon !== -1) {
          return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
        }
      } catch {
        // Fall through to body params.
      }
    }
    const id = params.get("client_id");
    if (!id) return null;
    return { id, secret: params.get("client_secret") ?? "" };
  }

  // Checks a client and, for secret-holding clients, its secret.
  // Public clients (no secret) pass with any or no secret.
  function authenticateClient(
    auth: { id: string; secret: string } | null,
  ): OAuthClient | null {
    if (!auth) return null;
    const client = store.getClient(auth.id);
    if (!client) return null;
    if (client.secretHash !== "" && sha256Hex(auth.secret) !== client.secretHash) {
      return null;
    }
    return client;
  }

  // Token families, kept next to the store (not in it, so custom
  // stores need no change). One family = one login grant: the first
  // access + refresh pair, plus every pair rotated from it. When a
  // rotated-out refresh token is presented again, someone may have
  // stolen it — so the whole family dies, not just that one token.
  // (After a restart with a persistent custom store, families are
  // forgotten and reuse falls back to a plain rejection.)
  const tokenFamily = new Map<string, string>();
  const families = new Map<string, Set<string>>();

  function revokeFamily(familyId: string): void {
    const hashes = families.get(familyId);
    if (!hashes) return;
    for (const hash of hashes) {
      const record = store.getToken(hash);
      if (record && !record.revoked) {
        record.revoked = true;
        store.saveToken(record);
      }
    }
  }

  function trackFamily(familyId: string, ...hashes: string[]): void {
    let set = families.get(familyId);
    if (!set) {
      set = new Set();
      families.set(familyId, set);
    }
    for (const hash of hashes) {
      set.add(hash);
      tokenFamily.set(hash, familyId);
    }
  }

  function issueTokens(
    client: OAuthClient,
    userId: string | null,
    scope: string[],
    familyId: string = randomToken(),
  ): { access: OAuthTokenRecord; refresh: OAuthTokenRecord | null; accessRaw: string; refreshRaw: string | null } {
    const now = Date.now();
    const accessRaw = randomToken();
    const access: OAuthTokenRecord = {
      tokenHash: sha256Hex(accessRaw),
      type: "access",
      clientId: client.id,
      userId,
      scope,
      expiresAt: now + accessTtl * 1000,
      revoked: false,
    };
    store.saveToken(access);
    let refresh: OAuthTokenRecord | null = null;
    let refreshRaw: string | null = null;
    if (userId !== null) {
      refreshRaw = randomToken();
      refresh = {
        tokenHash: sha256Hex(refreshRaw),
        type: "refresh",
        clientId: client.id,
        userId,
        scope,
        expiresAt: now + refreshTtl * 1000,
        revoked: false,
      };
      store.saveToken(refresh);
    }
    trackFamily(
      familyId,
      access.tokenHash,
      ...(refresh ? [refresh.tokenHash] : []),
    );
    return { access, refresh, accessRaw, refreshRaw };
  }

  async function tokenReply(
    client: OAuthClient,
    userId: string | null,
    scope: string[],
    nonce?: string,
    familyId?: string,
  ): Promise<Response> {
    const { accessRaw, refreshRaw } = issueTokens(client, userId, scope, familyId);
    const body: Record<string, unknown> = {
      access_token: accessRaw,
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: scope.join(" "),
    };
    if (refreshRaw) body.refresh_token = refreshRaw;
    if (userId !== null && scope.includes("openid") && issueIdToken) {
      const idToken = await issueIdToken({ clientId: client.id, userId, scope, nonce });
      if (idToken) body.id_token = idToken;
    }
    return Response.json(body);
  }

  // GET /oauth/authorize — the user must already be signed in to Yatta.
  async function handleAuthorize(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const scope = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
    const state = url.searchParams.get("state") ?? undefined;
    const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "plain";
    const nonce = url.searchParams.get("nonce") ?? undefined;

    const client = store.getClient(clientId);
    if (!client) return oauthError("invalid_client", 400, "Unknown client");
    if (!client.redirectUris.includes(redirectUri)) {
      return oauthError("invalid_request", 400, "Redirect URI does not match");
    }
    if (responseType !== "code") {
      return oauthError("unsupported_response_type", 400, "Only code is supported");
    }
    const isPublic = client.secretHash === "";
    if (isPublic && !codeChallenge) {
      return oauthError(
        "invalid_request",
        400,
        "Public clients must use PKCE (code_challenge)",
      );
    }
    if (codeChallengeMethod !== "S256" && codeChallengeMethod !== "plain") {
      return oauthError("invalid_request", 400, "Unknown code_challenge_method");
    }
    const userId = await resolveUser(req);
    if (!userId) {
      return oauthError("login_required", 401, "Sign in to Yatta first");
    }
    const codeRaw = randomToken();
    store.saveCode({
      codeHash: sha256Hex(codeRaw),
      clientId: client.id,
      userId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      nonce,
      expiresAt: Date.now() + codeTtl * 1000,
      used: false,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", codeRaw);
    if (state) target.searchParams.set("state", state);
    return Response.redirect(target.toString(), 302);
  }

  // POST /oauth/token — form-encoded.
  async function handleToken(req: Request): Promise<Response> {
    const params = new URLSearchParams(await req.text());
    const grantType = params.get("grant_type") ?? "";
    const auth = readClientAuth(req, params);

    if (grantType === "authorization_code") {
      const client = authenticateClient(auth);
      if (!client) return oauthError("invalid_client", 401);
      const codeRaw = params.get("code") ?? "";
      const code = store.getCode(sha256Hex(codeRaw));
      if (!code || code.used || code.expiresAt <= Date.now()) {
        return oauthError("invalid_grant", 400, "Code is unknown, used, or expired");
      }
      if (code.clientId !== client.id) {
        return oauthError("invalid_grant", 400, "Code belongs to another client");
      }
      if (code.redirectUri !== (params.get("redirect_uri") ?? "")) {
        return oauthError("invalid_grant", 400, "Redirect URI does not match");
      }
      const verifier = params.get("code_verifier") ?? undefined;
      if (code.codeChallenge) {
        if (!verifier) return oauthError("invalid_request", 400, "Missing code_verifier");
        const ok =
          code.codeChallengeMethod === "S256"
            ? base64urlSha256(verifier) === code.codeChallenge
            : verifier === code.codeChallenge;
        if (!ok) return oauthError("invalid_grant", 400, "PKCE check failed");
      }
      code.used = true;
      store.saveCode(code);
      return tokenReply(client, code.userId, code.scope, code.nonce);
    }

    if (grantType === "client_credentials") {
      const client = authenticateClient(auth);
      if (!client || client.secretHash === "") {
        return oauthError("invalid_client", 401, "A secret-holding client is required");
      }
      const scope = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
      return tokenReply(client, null, scope);
    }

    if (grantType === "refresh_token") {
      const client = authenticateClient(auth);
      if (!client) return oauthError("invalid_client", 401);
      const refreshRaw = params.get("refresh_token") ?? "";
      const record = store.getToken(sha256Hex(refreshRaw));
      if (!record || record.type !== "refresh") {
        return oauthError("invalid_grant", 400, "Refresh token is unknown");
      }
      if (record.revoked) {
        // A rotated-out refresh token shown again means the token may
        // have been stolen: kill the whole family, so the replacement
        // tokens the thief does not have stop working too.
        const familyId = tokenFamily.get(record.tokenHash);
        if (familyId) revokeFamily(familyId);
        return oauthError("invalid_grant", 400, "Refresh token was already used");
      }
      if (record.expiresAt <= Date.now()) {
        return oauthError("invalid_grant", 400, "Refresh token is expired");
      }
      if (record.clientId !== client.id) {
        return oauthError("invalid_grant", 400, "Token belongs to another client");
      }
      // Rotation: the old refresh token dies the moment it is used.
      record.revoked = true;
      store.saveToken(record);
      return tokenReply(
        client,
        record.userId,
        record.scope,
        undefined,
        tokenFamily.get(record.tokenHash),
      );
    }

    return oauthError("unsupported_grant_type", 400, `Unknown grant type ${grantType}`);
  }

  // POST /oauth/revoke — always answers 200, even for unknown tokens.
  async function handleRevoke(req: Request): Promise<Response> {
    const params = new URLSearchParams(await req.text());
    const auth = readClientAuth(req, params);
    if (!authenticateClient(auth)) return oauthError("invalid_client", 401);
    const tokenRaw = params.get("token") ?? "";
    const record = store.getToken(sha256Hex(tokenRaw));
    if (record) {
      record.revoked = true;
      store.saveToken(record);
      // Revoking one token of a grant must kill the whole grant. Before
      // this, revoking a refresh token left its access token live for
      // up to an hour — exactly the window a stolen-token revocation
      // is supposed to close.
      const familyId = tokenFamily.get(record.tokenHash);
      if (familyId) revokeFamily(familyId);
    }
    return new Response(null, { status: 200 });
  }

  // Looks up a live access token. Used by the OIDC userinfo endpoint.
  function getAccessToken(tokenRaw: string): OAuthTokenInfo | null {
    const record = store.getToken(sha256Hex(tokenRaw));
    if (!record || record.type !== "access" || record.revoked) return null;
    if (record.expiresAt <= Date.now()) return null;
    return { userId: record.userId, clientId: record.clientId, scope: record.scope };
  }

  return {
    store,
    issuer: options.issuer,
    registerClient,
    handleAuthorize,
    handleToken,
    handleRevoke,
    getAccessToken,
    setIdTokenIssuer(fn: IdTokenIssuer) {
      issueIdToken = fn;
    },
  };
}

export type OAuthServer = ReturnType<typeof createOAuthServer>;

// Reads OAUTH_CLIENTS (a JSON list) into client inputs.
// Bad entries are skipped with a warning, never a crash.
export function clientsFromEnv(env: Record<string, string | undefined>): OAuthClientInput[] {
  const raw = env.OAUTH_CLIENTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: OAuthClientInput[] = [];
    for (const entry of parsed) {
      const e = entry as Record<string, unknown>;
      if (
        typeof e.id === "string" &&
        Array.isArray(e.redirectUris) &&
        e.redirectUris.every((u) => typeof u === "string")
      ) {
        out.push({
          id: e.id,
          secret: typeof e.secret === "string" ? e.secret : undefined,
          redirectUris: e.redirectUris as string[],
          name: typeof e.name === "string" ? e.name : undefined,
        });
      }
    }
    return out;
  } catch {
    console.warn("[oauth] OAUTH_CLIENTS is not valid JSON — ignoring it.");
    return [];
  }
}
