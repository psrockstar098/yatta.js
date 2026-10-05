import { describe, it, expect } from "bun:test";

import {
  parseTemplate,
  matchesPath,
  extractParams,
  buildPathFrom,
  bySpecificity,
  readQuery,
  stripBase,
  PathTemplateError,
} from "../types/path";

/*
 * One parser, three consumers — the client, the router and the handler.
 *
 * These are the cases where the three used to disagree: an optional segment was
 * matched by none of them consistently, and `:id?` was read as the parameter name
 * "id?" while the router treated the segment as required.
 */

describe("Path templates", () => {
  it("parses static, required, optional and wildcard segments", () => {
    expect(parseTemplate("/users").segments).toEqual([
      { kind: "static", value: "users" },
    ]);

    expect(parseTemplate("/users/:id").segments).toEqual([
      { kind: "static", value: "users" },
      { kind: "param", name: "id", optional: false },
    ]);

    expect(parseTemplate("/users/posts/:id?").segments).toEqual([
      { kind: "static", value: "users" },
      { kind: "static", value: "posts" },
      { kind: "param", name: "id", optional: true },
    ]);

    expect(parseTemplate("/files/*path").segments).toEqual([
      { kind: "static", value: "files" },
      { kind: "wildcard", name: "path" },
    ]);
  });

  it("treats a trailing slash as the same path", () => {
    expect(matchesPath(parseTemplate("/users"), "/users/")).toBe(true);
    expect(matchesPath(parseTemplate("/"), "/")).toBe(true);
    // "/" is not "/users" — an empty path matches only an empty template.
    expect(matchesPath(parseTemplate("/users"), "/")).toBe(false);
  });

  it("refuses a template it cannot interpret", () => {
    // A wildcard in the middle makes everything after it unmatchable — you cannot
    // tell where the parameter ended. Better to refuse at startup than to invent
    // an answer at request time.
    expect(() => parseTemplate("/files/*path/edit")).toThrow(/must be the last segment/);
    expect(() => parseTemplate("/files/*")).toThrow(/has no name/);
    expect(() => parseTemplate("/users/:")).toThrow(/has no name/);
    // A repeated name would silently overwrite the first.
    expect(() => parseTemplate("/:id/posts/:id")).toThrow(/appears twice/);
  });
});

describe("Optional path parameters", () => {
  it("matches with the segment present", () => {
    expect(matchesPath(parseTemplate("/users/:id?"), "/users/42")).toBe(true);
    expect(extractParams(parseTemplate("/users/:id?"), "/users/42")).toEqual({ id: "42" });
  });

  it("matches with the segment absent", () => {
    // The bug: an optional segment that is omitted made the segment count differ
    // from the template's, so every optional route 404'd when used as documented.
    expect(matchesPath(parseTemplate("/users/:id?"), "/users")).toBe(true);
    expect(extractParams(parseTemplate("/users/:id?"), "/users")).toEqual({});
  });

  it("strips the question mark from the parameter name", () => {
    // `segment.slice(1)` on ":id?" yields "id?", so the handler was handed a
    // parameter named "id?" while the schema declared "id".
    const params = extractParams(parseTemplate("/users/:id?"), "/users/7");
    expect(params).toEqual({ id: "7" });
    expect(Object.keys(params)).toEqual(["id"]);
  });

  it("reports an absent optional parameter as absent, not empty", () => {
    // A schema can then tell "not given" from "given as an empty string".
    expect(extractParams(parseTemplate("/users/:id?"), "/users")).toEqual({});
    expect(extractParams(parseTemplate("/users/:id?"), "/users/")).toEqual({});
  });

  it("still refuses a missing required parameter", () => {
    expect(matchesPath(parseTemplate("/users/:id"), "/users")).toBe(false);
    expect(matchesPath(parseTemplate("/users/:id"), "/users/a/b")).toBe(false);
  });

  it("builds a path both with and without an optional segment", () => {
    const template = parseTemplate("/users/posts/:id?");

    expect(buildPathFrom(template, { id: "42" })).toBe("/users/posts/42");
    expect(buildPathFrom(template, {})).toBe("/users/posts");
  });
});

describe("Wildcards", () => {
  it("matches a wildcard carrying a slash", () => {
    const template = parseTemplate("/files/*path");

    expect(matchesPath(template, "/files/a")).toBe(true);
    // The point of a wildcard: it spans slashes, which is what a path parameter
    // cannot do.
    expect(matchesPath(template, "/files/a/b/c.txt")).toBe(true);
    expect(matchesPath(template, "/files")).toBe(true);
  });

  it("reads the whole remainder as one value", () => {
    expect(extractParams(parseTemplate("/files/*path"), "/files/a/b/c.txt")).toEqual({
      path: "a/b/c.txt",
    });
  });

  it("builds a wildcard path, encoding each segment separately", () => {
    expect(buildPathFrom(parseTemplate("/files/*path"), { path: "a/b/c.txt" })).toBe(
      "/files/a/b/c.txt",
    );
  });

  it("refuses to build a path missing a required parameter", () => {
    // Sending the string "undefined" reaches the handler as a real segment, which
    // is worse than an error naming what is missing.
    expect(() => buildPathFrom(parseTemplate("/users/:id"), {})).toThrow(
      /Missing path parameter "id"/,
    );
  });

  it("still encodes per segment, so a value cannot add a segment", () => {
    expect(buildPathFrom(parseTemplate("/users/:id"), { id: "a/b" })).toBe("/users/a%2Fb");
    expect(buildPathFrom(parseTemplate("/q/:term"), { term: "x?y#z" })).toBe("/q/x%3Fy%23z");
  });
});

describe("Route specificity", () => {
  const ordered = (templates: string[]) =>
    templates
      .map(parseTemplate)
      .sort(bySpecificity)
      .map((t) => t.template);

  it("tries a static segment before a parameter", () => {
    // Without this, "/users/new" is matched by "/users/:id" and a create endpoint
    // silently becomes a fetch of the user whose id is the string "new".
    expect(ordered(["/users/:id", "/users/new"])).toEqual(["/users/new", "/users/:id"]);
  });

  it("tries a required parameter before an optional one", () => {
    expect(ordered(["/users/:id?", "/users/:id"])).toEqual(["/users/:id", "/users/:id?"]);
  });

  it("tries everything specific before a wildcard", () => {
    expect(ordered(["/files/*path", "/files/:name"])).toEqual(["/files/:name", "/files/*path"]);
  });

  it("is stable between templates that cannot both match", () => {
    // Neither order is wrong; declaration order deciding is predictable, which
    // random ordering would not be.
    expect(ordered(["/a/b", "/a/c"])).toEqual(["/a/b", "/a/c"]);
    expect(ordered(["/a/c", "/a/b"])).toEqual(["/a/c", "/a/b"]);
  });

  it("sorts the whole way to the most specific", () => {
    expect(ordered(["/c/:x?", "/a/b/d", "/c/:x"]).map((t) => t)).toEqual([
      "/a/b/d",
      "/c/:x",
      "/c/:x?",
    ]);
  });
});

describe("Query parsing", () => {
  it("gives a single value as a scalar and a repeated key as an array", () => {
    // Decided by how many arrived rather than by the shape, so a schema does not
    // have to special-case `{limit: ["10"]}`.
    expect(readQuery("http://x/?limit=10")).toEqual({ limit: "10" });
    expect(readQuery("http://x/?tag=a&tag=b")).toEqual({ tag: ["a", "b"] });
    expect(readQuery("http://x/no-query")).toEqual({});
  });

  it("decodes percent-encoded values", () => {
    expect(readQuery("http://x/?q=a%20b")).toEqual({ q: "a b" });
  });
});

describe("Base path", () => {
  it("strips a mount point when the platform omits it", () => {
    expect(stripBase("/api/users", "/api")).toBe("/users");
    expect(stripBase("/api/users", "/api/")).toBe("/users");
    expect(stripBase("/users", "/api")).toBe("/users");
    expect(stripBase("/users", undefined)).toBe("/users");
    expect(stripBase("/users", "/")).toBe("/users");
  });

  it("returns the root when the mount point is the whole path", () => {
    expect(stripBase("/api", "/api")).toBe("/");
  });
});