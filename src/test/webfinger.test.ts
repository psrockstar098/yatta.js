import { describe, it, expect } from "bun:test";
import { createWebFingerHandler } from "../func/webfinger";

const lookup = async (resource: string) => {
  if (resource !== "acct:ada@example.com") return null;
  return {
    subject: "acct:ada@example.com",
    links: [
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: "https://example.com/users/ada",
      },
      {
        rel: "self",
        type: "application/jrd+json",
        href: "https://example.com/.well-known/webfinger?resource=acct:ada@example.com",
      },
    ],
  };
};

describe("WebFinger", () => {
  const handle = createWebFingerHandler(lookup);

  it("known acct: returns a JRD document", async () => {
    const res = await handle(
      new Request("http://x/.well-known/webfinger?resource=acct:ada@example.com"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/jrd+json");
    const json = (await res.json()) as {
      subject: string;
      links: Array<{ rel: string }>;
    };
    expect(json.subject).toBe("acct:ada@example.com");
    expect(json.links.length).toBe(2);
  });

  it("?rel= filters links", async () => {
    const res = await handle(
      new Request(
        "http://x/.well-known/webfinger?resource=acct:ada@example.com&rel=self",
      ),
    );
    const json = (await res.json()) as { links: Array<{ rel: string }> };
    expect(json.links.length).toBe(1);
    expect(json.links[0]!.rel).toBe("self");
  });

  it("missing ?resource= is 400, unknown user is 404", async () => {
    expect(
      (await handle(new Request("http://x/.well-known/webfinger"))).status,
    ).toBe(400);
    expect(
      (
        await handle(
          new Request("http://x/.well-known/webfinger?resource=acct:nobody@example.com"),
        )
      ).status,
    ).toBe(404);
  });
});
