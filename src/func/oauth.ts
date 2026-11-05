// OAuth 2.0 server — authorization code with PKCE, client
// credentials, and refresh tokens.
//
// Simple to use: create a server, register a client, mount three
// routes. No database is needed: codes and tokens live in memory
// (they do not survive a restart, and one server holds them — for
// multi-node setups, give each node its own clients or add a shared
// store later). Secrets are never stored raw: only SHA-256 hashes.
// Expired codes and tokens are swept out of memory about once a minute.
//
// Endpoints (mounted by the router):
//   GET  /oauth/authorize  — starts the code flow (user must be signed in)
//   POST /oauth/token      — code, client_credentials, refresh_token
//   POST /oauth/revoke     — revokes one token
//
// When the scope includes "openid" and an ID-token issuer is set
// (see setIdTokenIssuer, used by the OIDC module), the token reply
// also carries an id_token.
//
// Safe defaults worth knowing about:
//   - PKCE must use S256. "plain" is refused unless allowPlainPkce is on.
//   - Public clients must always use PKCE. Set requirePkce to demand it
//     from every client (recommended).
//   - Scopes are NOT limited unless you set `scopes` (server-wide) or
//     `allowedScopes` (per client). Set one of them: without it a
//     client may ask for any scope string.
//   - There is no consent screen. Any signed-in user who opens an
//     authorize link for a registered client approves it. Pass
//     `approve` if third-party clients can exist.
//   - There is no rate limiting built in. Put one in front of /oauth/token:
//     `oauthTokenRateLimit()` from yatta.js/ratelimit is a ready-made
//     middleware for the API pipeline (5 token requests per minute per
//     IP by default). The server itself stays unchanged.

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

// Constant-time string compare, so response time does not leak how
// many leading characters matched.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const MAX_FORM_BYTES = 64 * 1024;
const SWEEP_EVERY_MS = 60_000;
// RFC 7636: a verifier is 43–128 characters from this set; an S256
// challenge is a 43-character base64url SHA-256.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const DANGEROUS_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A registered OAuth client.
 *
 * `secretHash` is empty for a public client — a mobile or browser app
 * that cannot keep a secret. Public clients must use PKCE, because
 * nothing else proves the code came back to whoever started the flow.
 */
export interface OAuthClient {
  id: string;
  // SHA-256 hash of the secret. Empty for public clients (apps that
  // cannot keep a secret, like a mobile app or a browser app).
  secretHash: string;
  redirectUris: string[];
  name?: string;
  // Scopes this client may ask for. Overrides the server-wide `scopes`.
  allowedScopes?: string[];
}

/**
 * What `registerClient` takes.
 *
 * The secret is handed over in the clear exactly once, here; only its
 * SHA-256 hash is kept. There is no way to read it back, which is why
 * registering a client is a startup job rather than an API.
 */
export interface OAuthClientInput {
  id: string;
  secret?: string;
  redirectUris: string[];
  name?: string;
  allowedScopes?: string[];
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
  // Set when the code is exchanged, so a second use of the same code
  // can revoke the tokens the first use produced.
  familyId?: string;
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

/**
 * Where clients, codes and tokens live.
 *
 * Every method is synchronous by design: a check and its matching write
 * must not be separated by an `await`, or two simultaneous requests can
 * both spend the same code. A persistent store should therefore keep its
 * state in memory and write through, not read from disk on each call.
 */
export interface OAuthStore {
  saveClient(client: OAuthClient): void;
  getClient(id: string): OAuthClient | undefined;
  saveCode(code: AuthCode): void;
  getCode(codeHash: string): AuthCode | undefined;
  saveToken(token: OAuthTokenRecord): void;
  getToken(tokenHash: string): OAuthTokenRecord | undefined;
  // Optional: drop codes and tokens that have expired. Called about
  // once a minute. A store without it just keeps everything.
  sweep?(now: number): void;
}

/**
 * In-memory store. Fine for one server, and for tests.
 *
 * Nothing survives a restart: issued tokens stop working and registered
 * clients have to be registered again. Pass your own `store` to change
 * that, and keep the write in that store out of the check-then-write
 * window.
 */
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
  // Without this, every code and token ever issued stayed in memory
  // until restart. Revoked tokens are kept until they expire on their
  // own, because reuse detection needs to recognize them.
  sweep(now: number): void {
    for (const [key, code] of this.codes) {
      if (code.expiresAt <= now) this.codes.delete(key);
    }
    for (const [key, token] of this.tokens) {
      if (token.expiresAt <= now) this.tokens.delete(key);
    }
  }
}

/**
 * Builds the OIDC ID token for a token reply.
 *
 * Return null when there is no identity to sign (the user is gone, or the
 * scope has no "openid"). `createOIDC` supplies one of these; a code
 * exchange fails if it throws, and a refresh leaves the token out rather
 * than stranding a grant whose old refresh token is already spent.
 */
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
  // Scopes the server hands out. A request for any other scope fails
  // with invalid_scope. A client's own `allowedScopes` wins over this.
  // Leave both unset and any scope string is accepted.
  scopes?: string[];
  // Demand PKCE from every client, not only public ones.
  requirePkce?: boolean;
  // Accept the weak "plain" PKCE method. Off by default.
  allowPlainPkce?: boolean;
  // Consent hook, run after sign-in and before a code is issued.
  // Return false to refuse (the client gets access_denied).
  approve?: (info: {
    userId: string;
    client: OAuthClient;
    scope: string[];
  }) => Promise<boolean> | boolean;
}

/** What `getAccessToken` returns for a live token. */
export interface OAuthTokenInfo {
  userId: string | null;
  clientId: string;
  scope: string[];
}

// Every token-endpoint answer must not be cached (RFC 6749 §5.1).
function oauthError(
  error: string,
  status = 400,
  description?: string,
): Response {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
  // Only for failed client login at the token endpoints. Sending this
  // on a browser page would pop up a password box.
  if (error === "invalid_client" && status === 401) {
    headers["WWW-Authenticate"] = 'Basic realm="oauth"';
  }
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers },
  );
}

function redirectTo(target: URL): Response {
  // Response.redirect() builds an immutable response, so headers
  // cannot be added to it. Build it by hand.
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

// Throws on a redirect URI that must never be registered.
function checkRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`Bad redirect URI: ${uri}`);
  }
  if (DANGEROUS_SCHEMES.has(url.protocol)) {
    throw new Error(`Redirect URI scheme is not allowed: ${uri}`);
  }
  if (url.hash) {
    throw new Error(`Redirect URI must not have a fragment: ${uri}`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    console.warn(
      `[oauth] redirect URI "${uri}" is plain http. Codes can be read on the network; use https outside localhost.`,
    );
  }
}

function parseScope(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(/\s+/).filter(Boolean))];
}

// Credentials in a Basic header are form-urlencoded before base64
// (RFC 6749 §2.3.1), so "+" means a space and "%XX" needs decoding.
function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

// Reads a request body as text, but gives up (null) past `limit`
// bytes, so a huge upload cannot fill memory.
async function readText(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Token and revoke requests: POST, form-encoded, small.
async function readForm(req: Request): Promise<URLSearchParams | Response> {
  if (req.method !== "POST") {
    return new Response("Use POST", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/x-www-form-urlencoded")) {
    return oauthError(
      "invalid_request",
      400,
      "Content-Type must be application/x-www-form-urlencoded",
    );
  }
  const text = await readText(req, MAX_FORM_BYTES);
  if (text === null)
    return oauthError("invalid_request", 413, "Request too large");
  return new URLSearchParams(text);
}

/**
 * Build an OAuth 2.0 authorization server.
 *
 * Mount the three handlers on `/oauth/authorize`, `/oauth/token` and
 * `/oauth/revoke`. The wire format is plain form-encoded HTTP, so the
 * handlers take and return `Request`/`Response` directly.
 *
 * @example
 * const oauth = createOAuthServer({
 *   issuer: "https://api.example.com",
 *   clients: [{ id: "web", secret: process.env.OAUTH_SECRET, redirectUris: ["https://app.example.com/callback"] }],
 *   resolveUser: async (req) => sessionUserId(req),
 *   scopes: ["openid", "profile", "email"],
 *   requirePkce: true,
 * });
 */
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
    for (const uri of input.redirectUris) checkRedirectUri(uri);
    const client: OAuthClient = {
      id: input.id,
      secretHash: input.secret ? sha256Hex(input.secret) : "",
      redirectUris: [...input.redirectUris],
      name: input.name,
      allowedScopes: input.allowedScopes ? [...input.allowedScopes] : undefined,
    };
    store.saveClient(client);
    return client;
  }

  for (const input of options.clients ?? []) registerClient(input);

  // Returns the first requested scope this client may not have, or
  // null when all are fine (or no limit is configured).
  function disallowedScope(
    client: OAuthClient,
    scope: string[],
  ): string | null {
    const allowed = client.allowedScopes ?? options.scopes;
    if (!allowed) return null;
    return scope.find((s) => !allowed.includes(s)) ?? null;
  }

  // Reads client_id + client_secret from a Basic header or the body.
  function readClientAuth(
    req: Request,
    params: URLSearchParams,
  ): { id: string; secret: string } | null {
    const header = req.headers.get("authorization") ?? "";
    // The scheme name is case-insensitive.
    const basic = header.match(/^Basic\s+(.+)$/i);
    if (basic) {
      try {
        const decoded = Buffer.from(basic[1]!.trim(), "base64").toString();
        const colon = decoded.indexOf(":");
        if (colon !== -1) {
          return {
            id: formDecode(decoded.slice(0, colon)),
            secret: formDecode(decoded.slice(colon + 1)),
          };
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
    if (
      client.secretHash !== "" &&
      !safeEqual(sha256Hex(auth.secret), client.secretHash)
    ) {
      return null;
    }
    return client;
  }

  // Token families, kept next to the store (not in it, so custom
  // stores need no change). One family = one login grant: the first
  // access + refresh pair, plus every pair rotated from it. When a
  // rotated-out refresh token is presented again, someone may have
  // stolen it — so the whole family dies, not just that one token.
  // The same goes for an authorization code used twice.
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

  // Frees codes and tokens that have expired, and forgets family
  // entries whose tokens are gone. Runs at most once a minute, on
  // request, so there is no timer to leak.
  let lastSweep = 0;
  function maybeSweep(): void {
    const now = Date.now();
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    store.sweep?.(now);
    for (const [familyId, hashes] of families) {
      for (const hash of hashes) {
        if (!store.getToken(hash)) {
          hashes.delete(hash);
          tokenFamily.delete(hash);
        }
      }
      if (hashes.size === 0) families.delete(familyId);
    }
  }

  function issueTokens(
    client: OAuthClient,
    userId: string | null,
    scope: string[],
    familyId: string = randomToken(),
  ): {
    access: OAuthTokenRecord;
    refresh: OAuthTokenRecord | null;
    accessRaw: string;
    refreshRaw: string | null;
  } {
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
    requireIdToken = false,
  ): Promise<Response> {
    // The ID token is made BEFORE any token is stored. Before, a
    // failing issuer left a stored access + refresh pair that the
    // client never received.
    let idToken: string | null = null;
    if (userId !== null && scope.includes("openid") && issueIdToken) {
      try {
        idToken = await issueIdToken({
          clientId: client.id,
          userId,
          scope,
          nonce,
        });
      } catch (err) {
        console.error("[oauth] ID token issuer failed:", err);
        // A code exchange must return the ID token. A refresh may
        // leave it out, and failing there would strand a grant whose
        // old refresh token is already spent.
        if (requireIdToken) {
          return oauthError("server_error", 500, "Could not issue an ID token");
        }
      }
    }
    const { accessRaw, refreshRaw } = issueTokens(
      client,
      userId,
      scope,
      familyId,
    );
    const body: Record<string, unknown> = {
      access_token: accessRaw,
      token_type: "Bearer",
      expires_in: accessTtl,
      scope: scope.join(" "),
    };
    if (refreshRaw) body.refresh_token = refreshRaw;
    if (idToken) body.id_token = idToken;
    return Response.json(body, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  }

  // Errors after the redirect URI is known to be good go back to the
  // client as query parameters (RFC 6749 §4.1.2.1), not as JSON.
  function redirectWithError(
    redirectUri: string,
    error: string,
    description: string,
    state: string | undefined,
  ): Response {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    target.searchParams.set("iss", options.issuer);
    return redirectTo(target);
  }

  // GET /oauth/authorize — the user must already be signed in to Yatta.
  async function handleAuthorize(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return new Response("Use GET", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }
    maybeSweep();
    const url = new URL(req.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const scope = parseScope(url.searchParams.get("scope"));
    const state = url.searchParams.get("state") ?? undefined;
    const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
    // RFC 7636: no method means "plain". That is refused below unless
    // allowPlainPkce is on, so clients must send S256.
    const codeChallengeMethod =
      url.searchParams.get("code_challenge_method") ?? "plain";
    const nonce = url.searchParams.get("nonce") ?? undefined;

    // These two must never redirect: the redirect URI is not trusted yet.
    const client = store.getClient(clientId);
    if (!client) return oauthError("invalid_client", 400, "Unknown client");
    if (!client.redirectUris.includes(redirectUri)) {
      return oauthError("invalid_request", 400, "Redirect URI does not match");
    }

    const fail = (error: string, description: string) =>
      redirectWithError(redirectUri, error, description, state);

    if (responseType !== "code") {
      return fail("unsupported_response_type", "Only code is supported");
    }
    const isPublic = client.secretHash === "";
    if ((isPublic || options.requirePkce) && !codeChallenge) {
      return fail("invalid_request", "PKCE (code_challenge) is required");
    }
    if (codeChallenge) {
      if (codeChallengeMethod === "S256") {
        if (!S256_CHALLENGE_RE.test(codeChallenge)) {
          return fail(
            "invalid_request",
            "code_challenge is not a valid S256 challenge",
          );
        }
      } else if (codeChallengeMethod === "plain" && options.allowPlainPkce) {
        if (!VERIFIER_RE.test(codeChallenge)) {
          return fail("invalid_request", "code_challenge is not valid");
        }
      } else {
        return fail("invalid_request", "code_challenge_method must be S256");
      }
    }
    const badScope = disallowedScope(client, scope);
    if (badScope)
      return fail("invalid_scope", `Scope not allowed: ${badScope}`);

    let userId: string | null;
    try {
      userId = await resolveUser(req);
    } catch (err) {
      console.error("[oauth] resolveUser failed:", err);
      return fail("server_error", "Could not check sign-in");
    }
    if (!userId) {
      return oauthError("login_required", 401, "Sign in to Yatta first");
    }
    if (options.approve) {
      let approved = false;
      try {
        approved = await options.approve({ userId, client, scope });
      } catch (err) {
        console.error("[oauth] approve failed:", err);
        return fail("server_error", "Could not check consent");
      }
      if (!approved) return fail("access_denied", "The user did not approve");
    }

    const codeRaw = randomToken();
    store.saveCode({
      codeHash: sha256Hex(codeRaw),
      clientId: client.id,
      userId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod: codeChallenge ? codeChallengeMethod : undefined,
      nonce,
      expiresAt: Date.now() + codeTtl * 1000,
      used: false,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", codeRaw);
    if (state) target.searchParams.set("state", state);
    // RFC 9207: tells the client which server answered.
    target.searchParams.set("iss", options.issuer);
    return redirectTo(target);
  }

  // POST /oauth/token — form-encoded.
  //
  // Note on races: between reading a code or refresh token and marking
  // it spent there is no `await`, so with the sync store interface two
  // simultaneous requests cannot both succeed. Keep it that way: do not
  // add an await between a check and its matching write.
  async function handleToken(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form instanceof Response) return form;
    const params = form;
    maybeSweep();
    const grantType = params.get("grant_type") ?? "";
    const auth = readClientAuth(req, params);

    if (grantType === "authorization_code") {
      const client = authenticateClient(auth);
      if (!client) return oauthError("invalid_client", 401);
      const codeRaw = params.get("code") ?? "";
      const code = store.getCode(sha256Hex(codeRaw));
      if (!code)
        return oauthError("invalid_grant", 400, "Code is unknown or expired");
      if (code.clientId !== client.id) {
        return oauthError(
          "invalid_grant",
          400,
          "Code belongs to another client",
        );
      }
      if (code.used) {
        // A code works once. A second try means it may have leaked, so
        // the tokens the first use produced are revoked too
        // (RFC 6749 §4.1.2).
        if (code.familyId) revokeFamily(code.familyId);
        return oauthError("invalid_grant", 400, "Code was already used");
      }
      if (code.expiresAt <= Date.now()) {
        return oauthError("invalid_grant", 400, "Code is unknown or expired");
      }
      if (code.redirectUri !== (params.get("redirect_uri") ?? "")) {
        return oauthError("invalid_grant", 400, "Redirect URI does not match");
      }
      if (code.codeChallenge) {
        const verifier = params.get("code_verifier");
        if (!verifier)
          return oauthError("invalid_request", 400, "Missing code_verifier");
        if (!VERIFIER_RE.test(verifier)) {
          return oauthError("invalid_request", 400, "Bad code_verifier");
        }
        const expected =
          code.codeChallengeMethod === "S256"
            ? base64urlSha256(verifier)
            : verifier;
        if (!safeEqual(expected, code.codeChallenge)) {
          return oauthError("invalid_grant", 400, "PKCE check failed");
        }
      }
      const familyId = randomToken();
      code.used = true;
      code.familyId = familyId;
      store.saveCode(code);
      return tokenReply(
        client,
        code.userId,
        [...code.scope],
        code.nonce,
        familyId,
        true,
      );
    }

    if (grantType === "client_credentials") {
      const client = authenticateClient(auth);
      if (!client || client.secretHash === "") {
        return oauthError(
          "invalid_client",
          401,
          "A secret-holding client is required",
        );
      }
      const scope = parseScope(params.get("scope"));
      // There is no user here, so there is no identity to describe.
      if (scope.includes("openid")) {
        return oauthError(
          "invalid_scope",
          400,
          "openid needs a signed-in user",
        );
      }
      const badScope = disallowedScope(client, scope);
      if (badScope)
        return oauthError(
          "invalid_scope",
          400,
          `Scope not allowed: ${badScope}`,
        );
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
      // Ownership first. Before, a different client showing a spent
      // token could trigger the family kill below.
      if (record.clientId !== client.id) {
        return oauthError(
          "invalid_grant",
          400,
          "Token belongs to another client",
        );
      }
      if (record.revoked) {
        // A rotated-out refresh token shown again means the token may
        // have been stolen: kill the whole family, so the replacement
        // tokens the thief does not have stop working too.
        const familyId = tokenFamily.get(record.tokenHash);
        if (familyId) revokeFamily(familyId);
        return oauthError(
          "invalid_grant",
          400,
          "Refresh token was already used",
        );
      }
      if (record.expiresAt <= Date.now()) {
        return oauthError("invalid_grant", 400, "Refresh token is expired");
      }
      // A refresh may ask for fewer scopes, never more.
      let scope = record.scope;
      const asked = params.get("scope");
      if (asked) {
        const narrower = parseScope(asked);
        if (narrower.some((s) => !record.scope.includes(s))) {
          return oauthError(
            "invalid_scope",
            400,
            "A refresh cannot widen the scope",
          );
        }
        scope = narrower;
      }
      // Rotation: the old refresh token dies the moment it is used.
      record.revoked = true;
      store.saveToken(record);
      return tokenReply(
        client,
        record.userId,
        [...scope],
        undefined,
        tokenFamily.get(record.tokenHash),
      );
    }

    return oauthError(
      "unsupported_grant_type",
      400,
      `Unknown grant type ${grantType}`,
    );
  }

  // POST /oauth/revoke — answers 200 for unknown tokens too, and for
  // tokens that belong to someone else.
  async function handleRevoke(req: Request): Promise<Response> {
    const form = await readForm(req);
    if (form instanceof Response) return form;
    const params = form;
    const auth = readClientAuth(req, params);
    const client = authenticateClient(auth);
    if (!client) return oauthError("invalid_client", 401);
    const tokenRaw = params.get("token") ?? "";
    const record = store.getToken(sha256Hex(tokenRaw));
    // RFC 7009 §2.1: only the client a token was issued to may revoke
    // it. Before, any client (a public one needs no secret at all)
    // could revoke every other client's tokens if it knew a value.
    if (record && record.clientId === client.id) {
      record.revoked = true;
      store.saveToken(record);
      // Revoking one token of a grant must kill the whole grant. Before
      // this, revoking a refresh token left its access token live for
      // up to an hour — exactly the window a stolen-token revocation
      // is supposed to close.
      const familyId = tokenFamily.get(record.tokenHash);
      if (familyId) revokeFamily(familyId);
    }
    return new Response(null, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Looks up a live access token. Used by the OIDC userinfo endpoint.
  function getAccessToken(tokenRaw: string): OAuthTokenInfo | null {
    const record = store.getToken(sha256Hex(tokenRaw));
    if (!record || record.type !== "access" || record.revoked) return null;
    if (record.expiresAt <= Date.now()) return null;
    // A copy, so a caller cannot change the stored scope.
    return {
      userId: record.userId,
      clientId: record.clientId,
      scope: [...record.scope],
    };
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

/** The object `createOAuthServer` returns. */
export type OAuthServer = ReturnType<typeof createOAuthServer>;

/**
 * Read `OAUTH_CLIENTS` — a JSON list — into client inputs.
 *
 * A bad entry is skipped with a warning instead of taking the process
 * down: one mistyped redirect URI used to discard the good clients next
 * to it, and the failure surfaced only as "invalid_client" at runtime.
 *
 * @param env Usually `process.env`.
 */
export function clientsFromEnv(
  env: Record<string, string | undefined>,
): OAuthClientInput[] {
  const raw = env.OAUTH_CLIENTS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[oauth] OAUTH_CLIENTS is not valid JSON — ignoring it.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[oauth] OAUTH_CLIENTS must be a JSON list — ignoring it.");
    return [];
  }
  const out: OAuthClientInput[] = [];
  parsed.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      console.warn(
        `[oauth] OAUTH_CLIENTS entry ${index} is not an object — skipped.`,
      );
      return;
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      !e.id ||
      !Array.isArray(e.redirectUris) ||
      e.redirectUris.length === 0 ||
      !e.redirectUris.every((u) => typeof u === "string")
    ) {
      console.warn(
        `[oauth] OAUTH_CLIENTS entry ${index} needs an id and redirectUris — skipped.`,
      );
      return;
    }
    // Same check registerClient makes, so a bad URI is skipped here
    // instead of crashing startup later.
    try {
      for (const uri of e.redirectUris as string[]) checkRedirectUri(uri);
    } catch (err) {
      console.warn(
        `[oauth] OAUTH_CLIENTS entry ${index}: ${err instanceof Error ? err.message : err} — skipped.`,
      );
      return;
    }
    out.push({
      id: e.id,
      secret: typeof e.secret === "string" ? e.secret : undefined,
      redirectUris: e.redirectUris as string[],
      name: typeof e.name === "string" ? e.name : undefined,
      allowedScopes:
        Array.isArray(e.allowedScopes) &&
        e.allowedScopes.every((s) => typeof s === "string")
          ? (e.allowedScopes as string[])
          : undefined,
    });
  });
  return out;
}
