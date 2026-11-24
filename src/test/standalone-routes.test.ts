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

describe("standalone router grouping", () => {
  it("exact routes win over param routes, fewest params wins, then longest", () => {
    const table = [
      { pattern: "/users/new", file: "backend/users/new.ts", module: {} },
      { pattern: "/users/[id]", file: "backend/users/[id].ts", module: {} },
      { pattern: "/users/[id]/posts/[postId]", file: "backend/users/[id]/posts/[postId].ts", module: {} },
      { pattern: "/about", file: "backend/about.ts", module: {} },
    ];
    (globalThis as any).__yattaStandaloneRoutes = table;
    const r = createFileRouter("/nonexistent");

    // Exact beats a param route that would also match.
    expect(r.match("/users/new")!.kind).toBe("exact");
    expect(r.match("/users/new")!.filePath).toBe("backend/users/new.ts");
    // One param, deeper than the catch-all-free table allows otherwise.
    const one = r.match("/users/42")!;
    expect(one.kind).toBe("dynamic");
    expect(one.params).toEqual({ id: "42" });
    const two = r.match("/users/42/posts/7")!;
    expect(two.params).toEqual({ id: "42", postId: "7" });
    expect(r.match("/nothing/here")).toBeNull();
  });

  it("a catch-all takes the rest when nothing more specific fits", () => {
    const table = [
      { pattern: "/users/[id]", file: "backend/users/[id].ts", module: {} },
      { pattern: "/users/[...rest]", file: "backend/users/[...rest].ts", module: {} },
    ];
    (globalThis as any).__yattaStandaloneRoutes = table;
    const r = createFileRouter("/nonexistent");
    expect(r.match("/users/42")!.params).toEqual({ id: "42" });
    expect(r.match("/users/42/posts/7/comments")!.params).toEqual({
      rest: "42/posts/7/comments",
    });
  });

  it("grouping scales: a static hit does not walk a large table", () => {
    // 200 static routes + 80 param routes: the old scan tried every
    // pattern's segments on each request. Correctness here, numbers in
    // /tmp/perf-probe/probe-c.ts (static 1.88µs -> 0.60µs, miss
    // 46µs -> 5.3µs at 281 routes).
    const table: Array<{ pattern: string; file: string; module: unknown }> = [
      { pattern: "/", file: "backend/index.ts", module: {} },
    ];
    for (let i = 0; i < 200; i++) {
      table.push({ pattern: `/page${i}`, file: `backend/page${i}.ts`, module: {} });
    }
    for (let i = 0; i < 40; i++) {
      table.push({ pattern: `/users/${i}/posts/[id]`, file: `backend/u${i}.ts`, module: {} });
      table.push({ pattern: `/items/[id]`, file: "backend/items.ts", module: {} });
    }
    (globalThis as any).__yattaStandaloneRoutes = table;
    const r = createFileRouter("/nonexistent");
    expect(r.match("/page199")!.kind).toBe("exact");
    expect(r.match("/items/42")!.params).toEqual({ id: "42" });
    expect(r.match("/users/3/posts/9")!.params).toEqual({ id: "9" });
    expect(r.match("/nope/deep/path")).toBeNull();
  });
});
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
