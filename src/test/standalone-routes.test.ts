import { describe, it, expect, afterEach } from "bun:test";

import { createFileRouter } from "../func/standalone_routes";

/*
 * The standalone (compiled-binary) file router decodes each path segment
 * exactly once. It used to decode the whole pathname and then decode
 * every param again, so `%252F` in a param became `/` — one segment
 * smuggling a path separator into a param.
 */

const routes = [
  { pattern: "/files/[name]", file: "backend/files/[name].ts", module: {} },
  { pattern: "/docs/[...slug]", file: "backend/docs/[...slug].ts", module: {} },
  { pattern: "/about", file: "backend/about.ts", module: {} },
];

afterEach(() => {
  delete (globalThis as any).__yattaStandaloneRoutes;
});

function router() {
  (globalThis as any).__yattaStandaloneRoutes = routes;
  return createFileRouter("/nonexistent");
}

describe("standalone router decoding", () => {
  it("decodes a param once: %252F stays %2F, it does not become /", () => {
    const match = router().match(new Request("http://x/files/a%252Fb"));
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ name: "a%2Fb" });
  });

  it("still decodes ordinary escapes once", () => {
    const match = router().match(new Request("http://x/files/hello%20world"));
    expect(match!.params).toEqual({ name: "hello world" });
  });

  it("does not double-decode catch-all segments either", () => {
    const match = router().match(new Request("http://x/docs/a%252Fb/c"));
    expect(match!.params).toEqual({ slug: "a%2Fb/c" });
  });

  it("exact routes still match, including the root", () => {
    expect(router().match(new Request("http://x/about"))!.kind).toBe("exact");
    const root = createFileRouter("/nonexistent");
    (globalThis as any).__yattaStandaloneRoutes = [{ pattern: "/", file: "backend/index.ts", module: {} }];
    expect(createFileRouter("/nonexistent").match(new Request("http://x/"))!.kind).toBe("exact");
    expect(root.match(new Request("http://x/nope"))).toBeNull();
  });
});
