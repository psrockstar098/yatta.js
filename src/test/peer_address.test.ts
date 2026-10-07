import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { peerAddress, rememberPeerAddress } from "../func/peer";
import {
  createAuth,
  MemoryAuthStore,
  MemoryChallengeStore,
  MemoryRateLimitStore,
} from "../types/auth";

/*
 * The client address, and why auth is the reason it exists.
 *
 * Without `security.getClientIp` every request is seen as 127.0.0.1, so the per-IP
 * rate limits collapse into one global limit and a single attacker guessing passwords
 * locks out every legitimate user. The warning about it was firing on this project's own
 * production boot, which is how it was found — running the CI's env vars locally and
 * reading the log.
 *
 * Bun keeps the peer address on the server, not on the Request, so it has to be captured
 * at the edge. These tests cover the holder and the two call sites, since a holder
 * nothing writes to is the same as no holder.
 */

describe("The peer address holder", () => {
  it("returns what was recorded for a request", () => {
    const req = new Request("https://app.test/x");

    rememberPeerAddress(req, "203.0.113.7");

    expect(peerAddress(req)).toBe("203.0.113.7");
  });

  it("returns nothing for a request it never saw", () => {
    // A route called in process, or a test invoking a handler directly, has no peer.
    // Reporting "local" here would put every such call in one rate-limit bucket.
    expect(peerAddress(new Request("https://app.test/unknown"))).toBeUndefined();
  });

  it("records nothing when the address is undefined", () => {
    const req = new Request("https://app.test/x");

    // requestIP can return undefined for a connection with no resolved address. Storing
    // it would turn "unknown" into a falsy string that reads as a real value later.
    rememberPeerAddress(req, undefined);

    expect(peerAddress(req)).toBeUndefined();
  });

  it("keeps addresses per request, not per last-seen value", () => {
    const a = new Request("https://app.test/a");
    const b = new Request("https://app.test/b");

    rememberPeerAddress(a, "198.51.100.1");
    rememberPeerAddress(b, "198.51.100.2");

    // Two concurrent requests must not overwrite each other's address, which is what a
    // single mutable variable would do — and the one it would do it in is a rate limit.
    expect(peerAddress(a)).toBe("198.51.100.1");
    expect(peerAddress(b)).toBe("198.51.100.2");
  });

  it("does not accumulate entries for the life of the process", () => {
    const source = readFileSync(join(import.meta.dir, "..", "func", "peer.ts"), "utf8");

    /*
     * A Map would leak one entry per request for the life of the process. A WeakMap's
     * entry dies with its key, which is the only reason this is safe to do on every
     * request without a bound.
     */
    expect(source).toContain("new WeakMap<Request, string>()");
    expect(source).not.toMatch(/new Map<Request/);
  });
});

describe("The cookie parser does not inherit from Object.prototype", () => {
  /*
   * `api.ts` was hardened after `?constructor=1` turned out to be a 500 on every
   * route: a plain `{}` returns the inherited value for a key nobody sent. The auth
   * parser is a separate implementation and had the same shape.
   *
   * Not reachable with the default cookie names, which are namespaced. Reachable when
   * an app configures one to an Object.prototype member — `csrfCookieName:
   * "constructor"` hands back a function where a token belongs, and that value is then
   * compared against a header, which is a check that quietly stops checking.
   */
  const SECRET = "super-secret-cryptographic-signing-key-32-chars-minimum";

  function authWith(cookieName: string) {
    return createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
      cookies: { csrfCookieName: cookieName },
    });
  }

  it("returns nothing for a cookie nobody sent", () => {
    const auth = authWith("constructor");

    // Bracket access deliberately: the declared type is `Record<string, string>`, so
    // `parsed.constructor` type-checks as a function and never reaches the index
    // signature. The index access is what the parser actually does.
    const parsed = auth.parseCookies("a=1");

    expect(parsed["constructor"]).toBeUndefined();
    expect(parsed["hasOwnProperty"]).toBeUndefined();
    expect(parsed["toString"]).toBeUndefined();
    expect(parsed["__proto__"]).toBeUndefined();
  });

  it("still reads a cookie whose name shadows an Object.prototype member", () => {
    const auth = authWith("constructor");

    // Sent for real, it must win over the inherited one — that is the whole point of
    // the null prototype.
    expect(auth.parseCookies("constructor=real")["constructor"]).toBe("real");
  });

  it("keeps reading the default names unchanged", () => {
    const auth = createAuth({
      secret: SECRET,
      store: new MemoryAuthStore(),
      challengeStore: new MemoryChallengeStore(),
      rateLimitStore: new MemoryRateLimitStore(),
    });

    const parsed = auth.parseCookies("yatta_session=abc; yatta_csrf=xyz");

    expect(parsed.yatta_session).toBe("abc");
    expect(parsed.yatta_csrf).toBe("xyz");
    expect(Object.keys(parsed).sort()).toEqual(["yatta_csrf", "yatta_session"]);
  });
});

describe("The framework's own server captures the address", () => {
  const main = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8");
  const auth = readFileSync(join(import.meta.dir, "..", "func", "auth.ts"), "utf8");

  it("records it at the edge, where the server exists", () => {
    expect(main).toContain("rememberPeerAddress(req, server.requestIP(req)?.address)");
  });

  it("reads it in the auth config, so rate limits are per client", () => {
    // The warning this silences was firing three times on a production boot.
    expect(auth).toContain("getClientIp: (req) => peerAddress(req)");
  });
});