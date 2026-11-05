// General rate-limit middleware for the onion pipeline (`api.use()`).
//
// This is the general limiter, not the auth limiter. Auth keeps its own
// attempt limits (login, signup, magic link, passkey) with lockouts, and
// this middleware does not touch them. Use this one for ordinary routes
// and for endpoints the codebase flags as unprotected, like /oauth/token.
//
// How a request is judged, in plain terms:
//   - One bucket per route, per client. The route is part of every key, so
//     exhausting one route never affects another.
//   - By default the client is its IP address. When an authenticated user
//     is known (see `userId`, below) that user gets a second, separate
//     bucket, checked as well. A request must pass every bucket that
//     applies to it; a blocked request consumes none of the buckets that
//     passed, so one dimension's limit cannot drain another's.
//   - Limits are fixed windows: a bucket allows `limit` requests, then
//     refuses until its window ends. There is no sliding window and no
//     lockout that a stranger can trigger against a victim's account.
//
// Escalating penalties, stated plainly:
//   - A "violation" is one window in which a key went over its limit.
//     Further over-limit requests in that same window do not add more
//     violations, so a single burst cannot jump a key to the harshest
//     treatment in one go.
//   - 0-2 violations: the normal limit and window.
//   - 3-5 violations: the limit is halved (never below 1) and the window
//     is doubled.
//   - 6 or more violations: the limit is 1 per window and the window is
//     four times the base window.
//   - A full window with no violation removes one violation, so good
//     behaviour restores normal treatment. Nothing here ever sets a limit
//     of zero: a degraded key is slowed, never silenced outright, and no
//     account is ever locked out by this middleware.
//
// Cluster-wide limiting: counters live behind `RateLimitStore`, the same
// get/set/delete shape with a TTL that the auth attempt store uses. The
// default is in-memory and single-process. For more than one process,
// supply a store backed by storage every process can see (the same
// pattern as a custom auth or OAuth store); the middleware itself does
// not need to change. Note the honest limit of that setup: check-then-
// increment through get/set is not atomic, so under heavy concurrent
// load a shared store can admit a few requests past the limit. A store
// with an atomic increment avoids that; the in-memory default is exact
// for one process because requests run one at a time per bucket here.
//
// Trusted proxies: by default forwarded headers are ignored completely.
// A client that can set `x-forwarded-for` on a direct connection would
// otherwise mint a fresh bucket per request and walk past any per-IP
// limit. Only when `trustProxy` is set does the middleware read those
// headers, and then it counts back from the right-hand end of
// `x-forwarded-for` past `trustedProxyCount` entries, exactly as auth
// does — the leftmost entry is the one the client wrote, so it is never
// trusted. The peer address (from `getClientIp`, or from the peer
// address recorded at the edge) is the base address in both cases.

import type { Context, Middleware } from "../types/api";
import { peerAddress } from "./peer";

// One bucket's counter. `violations` and `violationWindow` carry the
// escalation state; `count` and `resetAt` carry the current window.
export interface RateLimitCounter {
  count: number;
  resetAt: number;
  violations: number;
  // The `resetAt` of the window in which a violation was already counted,
  // so later over-limit requests in that window do not count again.
  violationWindow?: number;
}

// Pluggable counter store, modelled on the auth attempt store: get, set
// with a TTL in seconds, delete. `size` is optional and only the
// in-memory store provides it; it backs the key cap (see below).
export interface RateLimitStore {
  get(key: string): Promise<RateLimitCounter | null>;
  set(key: string, data: RateLimitCounter, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
  size?(): number | Promise<number>;
}

// In-memory default. Entries expire lazily on read, and expired entries
// are swept on write at most once a minute, so no timer has to be
// cleaned up and no work happens after shutdown.
export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { data: RateLimitCounter; expires: number }>();
  private lastSweep = 0;

  async get(key: string): Promise<RateLimitCounter | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.data;
  }

  async set(key: string, data: RateLimitCounter, ttlSec: number): Promise<void> {
    const now = Date.now();
    this.store.set(key, { data, expires: now + ttlSec * 1000 });
    if (now - this.lastSweep >= 60_000) {
      this.lastSweep = now;
      for (const [k, item] of this.store.entries()) {
        if (item.expires < now) this.store.delete(k);
      }
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }
}

// One route's limit and window. `windowSec` is seconds; the existing
// `api.rateLimit` uses milliseconds, so do not copy numbers across.
export interface RateLimitRule {
  limit: number;
  windowSec: number;
}

export interface RateLimitOptions {
  // Defaults: 100 requests per 60 seconds, per IP, per route.
  limit?: number;
  windowSec?: number;
  // Per-route overrides, keyed by path ("/oauth/token"). Keys are
  // normalised the same way request paths are, so a trailing slash or
  // different casing in the override still matches the route it names.
  // An override replaces the default rule for that route only.
  routes?: Record<string, RateLimitRule>;
  store?: RateLimitStore;
  // Cap on distinct keys that may hold their own bucket. Past it, new
  // keys share one fallback bucket per route and dimension instead of
  // growing the store without bound — the same guard the existing
  // `api.rateLimit` has, for the same forged-header reason. Defaults
  // to 100,000. Only enforced by stores that report a size; a custom
  // store without one owns its own eviction through the TTL.
  maxKeys?: number;
  // Proxy trust. Off by default: forwarded headers are ignored.
  trustProxy?: boolean;
  // How many proxies in front of this process are trusted to append to
  // `x-forwarded-for`. Defaults to 1. See the header comment above.
  trustedProxyCount?: number;
  // Resolves the peer address, e.g. `(req) => server.requestIP(req)?.address`
  // under Bun. Falls back to the peer address recorded at the edge.
  getClientIp?: (req: Request) => string | undefined;
  // Which dimensions get their own bucket, in addition to the route
  // that is always part of the key. Defaults: IP only. Add "user" to
  // also limit per authenticated user, across IPs.
  dimensions?: Array<"ip" | "user">;
  // Resolves the user id for the per-user bucket. Default: the auth
  // middleware's `ctx.state.user` (a string id, or an object with an
  // `id`), else `ctx.state.userId`. A request with no user simply has
  // no per-user bucket; it is not put in a shared "anonymous" bucket,
  // because that would let one anonymous client spend everyone's quota.
  userId?: (ctx: Context) => string | undefined;
  // Escalation tuning. `violationsPerLevel` is how many violations move
  // a key one penalty level stricter; `maxLevel` caps it. Defaults 3
  // and 2, giving the policy stated in the header comment.
  escalation?: { violationsPerLevel?: number; maxLevel?: number };
  // Called when a request is refused, for logging or metrics. It must
  // never throw into the request path; errors are swallowed.
  onBlocked?: (info: {
    route: string;
    ip: string;
    user?: string;
    retryAfterSec: number;
  }) => void;
}

// The per-IP, per-route defaults for the OAuth token endpoint, which
// the OAuth module itself flags as having no rate limiting. Wire it in
// front of the token handler with `api.use()`; it changes nothing about
// OAuth itself, it only refuses the 6th token request per minute from
// one IP. Pass options to tighten or loosen it for a deployment.
export function oauthTokenRateLimit(
  options: Omit<RateLimitOptions, "routes"> = {},
): Middleware {
  return createRateLimit({ limit: 5, windowSec: 60, ...options });
}

// Normalise a path for bucket keys and override lookup: one trailing
// slash removed (except the root), lowercased. Two spellings of one
// route must share one bucket, or an attacker alternates spellings and
// doubles the budget. Lowercasing can only merge buckets, never split
// them, so it fails closed; routes that genuinely differ only by case
// share a budget, which is the safe direction.
export function normalizeRoutePath(pathname: string): string {
  let path = pathname.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

// An IPv4 client seen over an IPv6 socket arrives as "::ffff:1.2.3.4"
// (that is what `server.requestIP` returns for a loopback client, and
// for any IPv4 peer on a dual-stack socket). Without normalising, the
// same client holds two buckets — one per address spelling — and gets
// twice the budget. Only the mapped form is folded; a genuine IPv6
// address is left exactly as it arrived.
function normalizeIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1]! : ip;
}

// Resolve the client IP. Mirrors auth's resolution order: peer address
// first, then — only when proxies are trusted — the forwarded headers,
// counting back from the right past the trusted proxies. Returns
// "unknown" when nothing is known, never a loopback address: labelling
// every unidentified client as 127.0.0.1 would put them all in one
// bucket, which is exactly the collapse this middleware must avoid.
export function resolveClientIp(
  req: Request,
  options: Pick<RateLimitOptions, "trustProxy" | "trustedProxyCount" | "getClientIp">,
): string {
  let ip: string | undefined;
  try {
    ip = options.getClientIp?.(req);
  } catch {
    ip = undefined;
  }
  if (!ip) ip = peerAddress(req);

  if (options.trustProxy) {
    const headers = req.headers;
    const cf = headers.get("cf-connecting-ip")?.trim();
    const real = headers.get("x-real-ip")?.trim();
    const fwd = headers.get("x-forwarded-for");
    if (cf) ip = cf;
    else if (real) ip = real;
    else if (fwd) {
      const parts = fwd
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        const trusted = Math.max(0, options.trustedProxyCount ?? 1);
        ip = parts[Math.max(0, parts.length - 1 - trusted)] ?? ip;
      }
    }
  }

  return ip ? normalizeIp(ip) : "unknown";
}

function validateRule(rule: RateLimitRule, where: string): void {
  if (!Number.isFinite(rule.limit) || rule.limit < 1 || !Number.isInteger(rule.limit)) {
    throw new TypeError(
      `rateLimit: ${where} limit must be a finite integer of at least 1, got ${rule.limit}. ` +
        "A non-finite limit disables the limiter instead of failing it.",
    );
  }
  if (!Number.isFinite(rule.windowSec) || rule.windowSec < 1) {
    throw new TypeError(
      `rateLimit: ${where} windowSec must be a finite number of at least 1, got ${rule.windowSec}. ` +
        "A zero window resets the bucket on every request, so the limit never accumulates.",
    );
  }
}

function resolveUserId(ctx: Context, custom?: RateLimitOptions["userId"]): string | undefined {
  if (custom) {
    try {
      const id = custom(ctx);
      return typeof id === "string" && id ? id : undefined;
    } catch {
      return undefined;
    }
  }
  const state = ctx.state as Record<string, unknown>;
  const user = state.user;
  if (typeof user === "string" && user) return user;
  if (user && typeof user === "object") {
    const id = (user as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  const userId = state.userId;
  return typeof userId === "string" && userId ? userId : undefined;
}

// Penalty level from a violation count, and what it does to a rule.
// Level 0 is the rule as written; each level halves the limit (floor,
// never below 1) and doubles the window.
function penaltyFor(
  violations: number,
  violationsPerLevel: number,
  maxLevel: number,
  rule: RateLimitRule,
): { level: number; limit: number; windowSec: number } {
  const level = Math.min(maxLevel, Math.floor(violations / violationsPerLevel));
  return {
    level,
    limit: Math.max(1, Math.floor(rule.limit / 2 ** level)),
    windowSec: rule.windowSec * 2 ** level,
  };
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const next = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) next.set(name, value);
  const nullBody = response.status === 204 || response.status === 304 || response.status === 205;
  return new Response(nullBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  });
}

export function createRateLimit(options: RateLimitOptions = {}): Middleware {
  const defaultRule: RateLimitRule = {
    limit: options.limit ?? 100,
    windowSec: options.windowSec ?? 60,
  };
  validateRule(defaultRule, "default");
  const overrides = new Map<string, RateLimitRule>();
  for (const [path, rule] of Object.entries(options.routes ?? {})) {
    validateRule(rule, `route "${path}"`);
    overrides.set(normalizeRoutePath(path), rule);
  }
  const maxKeys = options.maxKeys ?? 100_000;
  if (!Number.isFinite(maxKeys) || maxKeys < 1) {
    throw new TypeError(
      `rateLimit: maxKeys must be a finite number of at least 1, got ${String(options.maxKeys)}.`,
    );
  }
  const store = options.store ?? new MemoryRateLimitStore();
  const dimensions = options.dimensions ?? ["ip"];
  for (const dimension of dimensions) {
    if (dimension !== "ip" && dimension !== "user") {
      throw new TypeError(
        `rateLimit: unknown dimension "${dimension}". Only "ip" and "user" exist; ` +
          "an unknown dimension would silently limit nothing.",
      );
    }
  }
  const violationsPerLevel = options.escalation?.violationsPerLevel ?? 3;
  const maxLevel = options.escalation?.maxLevel ?? 2;
  if (!Number.isFinite(violationsPerLevel) || violationsPerLevel < 1) {
    throw new TypeError("rateLimit: escalation.violationsPerLevel must be at least 1.");
  }
  if (!Number.isFinite(maxLevel) || maxLevel < 0) {
    throw new TypeError("rateLimit: escalation.maxLevel must be at least 0.");
  }
  // Fallback bucket for keys past the cap. One per route and dimension,
  // so a flood of forged keys degrades to sharing a route's budget
  // rather than sharing every route's budget at once.
  const SHARED = "__shared__";

  return (async (ctx, next) => {
    const route = normalizeRoutePath(ctx.url.pathname);
    const rule = overrides.get(route) ?? defaultRule;
    const ip = resolveClientIp(ctx.req, options);
    const user = dimensions.includes("user") ? resolveUserId(ctx, options.userId) : undefined;

    // One bucket per dimension, each keyed by route so routes never
    // share a budget. The key parts are encoded, so a user id or IP
    // containing a separator cannot collide with a different key: two
    // different (route, dimension, value) triples always encode to two
    // different keys.
    const buckets: Array<{ key: string; dimension: string; value: string }> = [];
    if (dimensions.includes("ip")) {
      buckets.push({ key: `rl:${encodeURIComponent(route)}:ip:${encodeURIComponent(ip)}`, dimension: "ip", value: ip });
    }
    if (user !== undefined) {
      buckets.push({ key: `rl:${encodeURIComponent(route)}:user:${encodeURIComponent(user)}`, dimension: "user", value: user });
    }
    // No dimension at all (an empty `dimensions` list) still limits
    // per route, so the middleware can never be configured into a
    // no-op by accident.
    if (buckets.length === 0) {
      buckets.push({ key: `rl:${encodeURIComponent(route)}:route:all`, dimension: "route", value: "all" });
    }

    const now = Date.now();
    const canCap = typeof store.size === "function";

    type BucketState = {
      key: string;
      record: RateLimitCounter;
      effective: { level: number; limit: number; windowSec: number };
    };
    const states: BucketState[] = [];
    for (const bucket of buckets) {
      let key = bucket.key;
      let record = await store.get(key);
      if (!record && canCap) {
        // New key, store full: it shares the fallback bucket instead of
        // minting another one. An existing key keeps its own bucket.
        const size = await store.size!();
        if (size >= maxKeys) {
          key = `rl:${encodeURIComponent(route)}:${bucket.dimension}:${SHARED}`;
          record = await store.get(key);
        }
      }
      if (!record || now > record.resetAt) {
        // A window just ended. If it ended clean — no violation was
        // counted in it — one violation decays, so a key that behaved
        // works its way back to normal treatment.
        const violations = record
          ? record.violationWindow === record.resetAt
            ? record.violations
            : Math.max(0, record.violations - 1)
          : 0;
        const effective = penaltyFor(violations, violationsPerLevel, maxLevel, rule);
        record = {
          count: 0,
          resetAt: now + effective.windowSec * 1000,
          violations,
        };
        states.push({ key, record, effective });
      } else {
        const effective = penaltyFor(record.violations, violationsPerLevel, maxLevel, rule);
        states.push({ key, record, effective });
      }
    }

    // Judge every bucket before changing any of them: a request refused
    // by one bucket must not consume the buckets that passed.
    const blocked = states.filter((s) => s.record.count + 1 > s.effective.limit);
    if (blocked.length > 0) {
      const retryAfterSec = Math.max(
        1,
        ...blocked.map((s) => Math.ceil((s.record.resetAt - now) / 1000)),
      );
      for (const state of blocked) {
        // At most one violation per window: a burst that is already over
        // the limit does not keep escalating the key while it is refused.
        if (state.record.violationWindow !== state.record.resetAt) {
          state.record.violations += 1;
          state.record.violationWindow = state.record.resetAt;
        }
        const ttlSec = Math.max(
          1,
          Math.ceil((state.record.resetAt - now) / 1000) +
            // Keep the record past its window so the next window can see
            // whether it ended clean and decay a violation.
            rule.windowSec * 2 ** maxLevel + 1,
        );
        await store.set(state.key, state.record, ttlSec);
      }
      try {
        options.onBlocked?.({ route, ip, user, retryAfterSec });
      } catch {
        // A logging hook must never fail the request it reports on.
      }
      // The body is deliberately generic: it names no IP, user, route
      // budget or penalty level, so a refused client learns nothing
      // about whose bucket it hit or how close it is to the next level.
      return new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(retryAfterSec),
        },
      });
    }

    for (const state of states) {
      state.record.count += 1;
      const ttlSec = Math.max(
        1,
        Math.ceil((state.record.resetAt - now) / 1000) +
          rule.windowSec * 2 ** maxLevel + 1,
      );
      await store.set(state.key, state.record, ttlSec);
    }

    // The strictest bucket decides what the client sees, and the
    // handler can read the same numbers from ctx.state.rateLimit.
    const limit = Math.min(...states.map((s) => s.effective.limit));
    const remaining = Math.min(...states.map((s) => s.effective.limit - s.record.count));
    const resetAt = Math.max(...states.map((s) => s.record.resetAt));
    (ctx.state as Record<string, unknown>).rateLimit = {
      limit,
      remaining,
      resetAt,
      route,
    };

    const response = await next();
    return withHeaders(response, {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(Math.ceil(resetAt / 1000)),
    });
  }) as Middleware;
}
