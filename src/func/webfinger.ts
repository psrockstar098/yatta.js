// WebFinger (RFC 7033) — find things about an account.
//
// A client asks "who is acct:someone@example.com?" and gets a small
// JSON document (JRD) back: the subject, plus links about it.
// Yatta serves it on /.well-known/webfinger.
//
// Simple to use: give the handler a lookup function. It takes the
// resource string (like "acct:ada@example.com") and returns what is
// known about it, or null when nothing is known.

export interface WebFingerLink {
  rel: string;
  type?: string;
  href?: string;
  template?: string;
}

export interface WebFingerSubject {
  subject: string;
  aliases?: string[];
  links: WebFingerLink[];
}

// Returns what is known about a resource, or null.
export type WebFingerLookup = (
  resource: string,
) => Promise<WebFingerSubject | null>;

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
    const resource = url.searchParams.get("resource");
    if (!resource) {
      return new Response("Missing ?resource=...", { status: 400 });
    }
    const found = await lookup(resource);
    if (!found) {
      return new Response("Not Found", { status: 404 });
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
      headers: { "Content-Type": "application/jrd+json" },
    });
  };
}

// ── Production lookup: Yatta users ───────────────────────────────────────
// "acct:email@host" is looked up in the auth store. When the user
// exists, the reply points at the app itself as their profile page.

export function createUserWebFingerLookup(deps: {
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>;
  appUrl: string;
}): WebFingerLookup {
  return async (resource) => {
    if (!resource.startsWith("acct:")) return null;
    // The whole address is the lookup key ("ada@example.com"), not
    // just the part before "@". Looking up only the local part never
    // matched a real stored email, so every real user answered 404.
    // Note what this means: anyone can ask about an address and learn
    // whether it exists here (200 = yes, 404 = no). That is how
    // WebFinger works — it is a discovery protocol — so only run it
    // on an app where account existence is not a secret.
    const email = resource.slice("acct:".length);
    if (!email || !email.includes("@")) return null;
    const user = await deps.findUserByEmail(email);
    if (!user) return null;
    return {
      subject: `acct:${user.email}`,
      links: [
        {
          rel: "http://webfinger.net/rel/profile-page",
          type: "text/html",
          href: deps.appUrl,
        },
        {
          rel: "self",
          type: "application/jrd+json",
          href: `${deps.appUrl}/.well-known/webfinger?resource=acct:${user.email}`,
        },
      ],
    };
  };
}
