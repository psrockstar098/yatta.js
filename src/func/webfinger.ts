// WebFinger (RFC 7033) — find things about an account.
//
// A client asks "who is acct:someone@example.com?" and gets a small
// JSON document (JRD) back: the subject, plus links about it.
// Yatta serves it on /.well-known/webfinger.
//
// Simple to use: give the handler a lookup function. It takes the
// resource string (like "acct:ada@example.com") and returns what is
// known about it, or null when nothing is known.
//
// Browsers: the RFC requires `Access-Control-Allow-Origin: *` so web
// pages can ask too. It is sent on every answer, errors included
// (a browser cannot even read a 404 without it).

/** One link in a JRD document, keyed by `rel`. */
export interface WebFingerLink {
  rel: string;
  type?: string;
  href?: string;
  template?: string;
}

/** What a lookup knows about a resource: its canonical name and its links. */
export interface WebFingerSubject {
  subject: string;
  aliases?: string[];
  links: WebFingerLink[];
}

/**
 * Returns what is known about a resource, or null.
 *
 * @param resource The URI the client asked about, like
 * `"acct:ada@example.com"`. It arrives decoded; validate it as you see fit.
 */
export type WebFingerLookup = (
  resource: string,
) => Promise<WebFingerSubject | null>;

// A resource is a URI. Nothing real is this long, and it ends up in
// lookups and logs, so a huge one is refused up front.
const MAX_RESOURCE_LENGTH = 2048;

const CORS = { "Access-Control-Allow-Origin": "*" };

function plain(
  body: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}

/**
 * Build the WebFinger handler.
 *
 * @param lookup Your discovery logic. Returning null is a plain 404 — say
 * nothing rather than guess.
 * @returns A `(req) => Promise<Response>` for a router or `Bun.serve`.
 *
 * @example
 * const webfinger = createWebFingerHandler((resource) =>
 *   resource === "acct:ada@example.com" ? { subject: resource, links: [] } : null,
 * );
 */
export function createWebFingerHandler(
  lookup: WebFingerLookup,
  options: { path?: string } = {},
): (req: Request) => Promise<Response> {
  const path = options.path ?? "/.well-known/webfinger";
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return new Response("Not Found", { status: 404 });
    }
    // Before, any method got an answer, POST and DELETE included.
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return plain("Use GET", 405, { Allow: "GET, HEAD, OPTIONS" });
    }
    const resource = url.searchParams.get("resource");
    if (!resource) {
      return plain("Missing ?resource=...", 400);
    }
    if (resource.length > MAX_RESOURCE_LENGTH) {
      return plain("resource is too long", 400);
    }
    let found: WebFingerSubject | null;
    try {
      found = await lookup(resource);
    } catch (err) {
      // A failing lookup used to escape as an unhandled error.
      console.error("[webfinger] lookup failed:", err);
      return plain("Internal Server Error", 500);
    }
    if (!found) {
      return plain("Not Found", 404);
    }
    // ?rel=... keeps only the links with that relation.
    const rels = url.searchParams.getAll("rel");
    const links =
      rels.length === 0
        ? found.links
        : found.links.filter((l) => rels.includes(l.rel));
    const body: Record<string, unknown> = { subject: found.subject };
    if (found.aliases?.length) body.aliases = found.aliases;
    body.links = links;
    return Response.json(body, {
      headers: { ...CORS, "Content-Type": "application/jrd+json" },
    });
  };
}

// ── Production lookup: Yatta users ───────────────────────────────────────
// "acct:email@host" is looked up in the auth store. When the user
// exists, the reply points at the app itself as their profile page.

/**
 * A lookup that answers from the auth store.
 *
 * Best-effort pre-filled: `profile-page` points at the app URL and `self`
 * at this same endpoint. Add a real `acct:` discovery result if clients
 * should be able to resolve the address from another server.
 *
 * @example
 * createWebFingerHandler(
 *   createUserWebFingerLookup({
 *     findUserByEmail: (email) => db.users.findFirst({ where: { email } }),
 *     appUrl: "https://example.com",
 *     hosts: ["example.com"], // do not answer for other domains
 *   }),
 * );
 */
export function createUserWebFingerLookup(deps: {
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>;
  appUrl: string;
  // Only answer for addresses at these hosts, like ["example.com"].
  // Strongly recommended: without it, anyone can use this endpoint to
  // test whether ANY email address, at any domain, has an account here.
  hosts?: string[];
}): WebFingerLookup {
  // "https://app.example.com/" must not become "https://app.example.com//...".
  const appUrl = deps.appUrl.replace(/\/+$/, "");
  const hosts = deps.hosts?.map((h) => h.toLowerCase());
  return async (resource) => {
    // The scheme is case-insensitive: "ACCT:ada@example.com" is valid.
    if (!/^acct:/i.test(resource)) return null;
    // The whole address is the lookup key ("ada@example.com"), not
    // just the part before "@". Looking up only the local part never
    // matched a real stored email, so every real user answered 404.
    // Note what this means: anyone can ask about an address and learn
    // whether it exists here (200 = yes, 404 = no). That is how
    // WebFinger works — it is a discovery protocol — so only run it
    // on an app where account existence is not a secret, and set
    // `hosts` to limit it to your own domain.
    const address = resource.slice("acct:".length);
    // Exactly one "@", with something on both sides, and no spaces.
    const match = address.match(/^([^@\s]+)@([^@\s]+)$/);
    if (!match) return null;
    // The host part of an address is case-insensitive; the local part
    // is left as typed, because the user store decides about that.
    const host = match[2]!.toLowerCase();
    if (hosts && !hosts.includes(host)) return null;
    const email = `${match[1]!}@${host}`;
    const user = await deps.findUserByEmail(email);
    if (!user) return null;
    return {
      subject: `acct:${user.email}`,
      links: [
        {
          rel: "http://webfinger.net/rel/profile-page",
          type: "text/html",
          href: appUrl,
        },
        {
          rel: "self",
          type: "application/jrd+json",
          // Encoded: a "+" in an address (ada+news@example.com) is a
          // space in a query string, so the raw link looked up the
          // wrong address and answered 404.
          href: `${appUrl}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${user.email}`)}`,
        },
      ],
    };
  };
}
