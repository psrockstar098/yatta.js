import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { peerAddress, rememberPeerAddress } from "../func/peer";

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