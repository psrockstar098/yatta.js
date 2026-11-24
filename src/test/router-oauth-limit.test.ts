import { describe, it, expect } from "bun:test";

import routers from "../func/routerHelper";

/*
 * The default router wiring for the OAuth token endpoint: the limiter
 * exists in ratelimit.ts, but until it was wired here /oauth/token
 * accepted unlimited token guesses. Proved live through the real
 * router, not the middleware in isolation: the first five requests
 * reach the handler (401, unknown client), the sixth is refused.
 */

const fakeServer = {} as never;

function tokenRequest() {
  return new Request("http://localhost/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=nope&client_secret=nope",
  });
}

describe("default router OAuth wiring", () => {
  it("limits /oauth/token to 5 requests per minute per client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await routers(tokenRequest(), fakeServer)).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
