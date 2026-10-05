// Path templates, parsed once.
//
// Every layer needs to agree on what "/users/:id?" means: the client has to build
// one, the router has to match one, and the handler has to read one. Written
// separately, they drift — and the symptom is a route that matches but gets no
// parameter, or a client that sends a segment the router drops.
//
// So there is one parser and one matcher here, and the client, the transport and
// the type helpers all use them.
//
// Supported forms, deliberately small:
//   /users            static
//   /users/:id        one required parameter
//   /users/:id?       one optional parameter
//   /files/*path      a wildcard, last segment only, may span slashes
//
// Anything else — two wildcards, a wildcard that is not last, an empty `:name` —
// is refused by `parseTemplate` rather than given a meaning nobody can predict.

/** One segment of a parsed template. */
export type Segment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string; readonly optional: boolean }
  | { readonly kind: "wildcard"; readonly name: string };

/** A template, parsed. */
export interface ParsedPath {
  readonly template: string;
  readonly segments: readonly Segment[];
  /** True when the last segment is a wildcard, which may contain slashes. */
  readonly wildcard: boolean;
  /** Required segment count, for matching a path with no wildcard. */
  readonly arity: number;
}

export class PathTemplateError extends Error {}

/** Splits a path, dropping empty segments so a trailing slash is the same path. */
function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Parses a path template.
 *
 * @throws {PathTemplateError} on a wildcard that is not last, a parameter with no
 *   name, or a repeated parameter name.
 */
export function parseTemplate(template: string): ParsedPath {
  const raw = split(template);
  const segments: Segment[] = [];
  const seen = new Set<string>();

  raw.forEach((part, index) => {
    if (part === "*" || part.startsWith("*")) {
      const name = part.slice(1);
      if (name === "") throw new PathTemplateError(`Wildcard in "${template}" has no name`);
      // Only last, because a wildcard in the middle makes the path after it
      // unmatchable — you cannot tell where the parameter ended.
      if (index !== raw.length - 1) {
        throw new PathTemplateError(
          `Wildcard "*${name}" in "${template}" must be the last segment`,
        );
      }
      segments.push({ kind: "wildcard", name });
      return;
    }

    if (part.startsWith(":")) {
      const optional = part.endsWith("?");
      const name = optional ? part.slice(1, -1) : part.slice(1);

      if (name === "") throw new PathTemplateError(`Parameter in "${template}" has no name`);
      // A repeated name is ambiguous: the second would overwrite the first, and
      // which one the handler reads would depend on iteration order.
      if (seen.has(name)) {
        throw new PathTemplateError(`Parameter ":${name}" appears twice in "${template}"`);
      }
      seen.add(name);

      /*
       * An optional parameter must be last, or the path is ambiguous.
       *
       * "/posts/:id?/comments" and "/posts/comments" cannot be told apart: the
       * `id` could be "comments" with `/comments` missing, or absent with
       * `/comments` present. A router has to pick, and whichever it picks is wrong
       * for someone. Refused at startup, where the message can explain, rather than
       * guessed at on every request.
       */
      if (optional && index !== raw.length - 1) {
        throw new PathTemplateError(
          `Optional parameter ":${name}?" in "${template}" must be the last segment. ` +
            `An optional segment in the middle is ambiguous, so which value belongs ` +
            `to it cannot be decided. Move it to the end, or give it a default.`,
        );
      }

      segments.push({ kind: "param", name, optional });
      return;
    }

    segments.push({ kind: "static", value: part });
  });

  const wildcard = segments[segments.length - 1]?.kind === "wildcard";

  return {
    template,
    segments,
    wildcard,
    arity: segments.filter((s) => s.kind !== "param" || !s.optional).length,
  };
}

/** Splits a request path. A wildcard tail keeps its slashes, so it is not split. */
function splitRequest(path: string, wildcard: boolean): string[] {
  if (!wildcard) return split(path);
  // Split off the wildcard tail as one piece.
  const segments = split(path);
  return segments;
}

/**
 * Matches a request path against a parsed template.
 *
 * An optional parameter may be absent, and a wildcard absorbs whatever is left.
 */
export function matchesPath(parsed: ParsedPath, path: string): boolean {
  const parts = splitRequest(path, parsed.wildcard);

  let segmentIndex = 0;
  let partIndex = 0;

  while (segmentIndex < parsed.segments.length) {
    const segment = parsed.segments[segmentIndex]!;

    if (segment.kind === "wildcard") {
      // Takes everything remaining, including slashes. An absent value is
      // reported as undefined rather than "" so a schema can tell them apart.
      return true;
    }

    const part = parts[partIndex];

    if (part === undefined) {
      // Nothing left. Fine only if everything remaining is optional.
      if (segment.kind === "param" && segment.optional) {
        segmentIndex++;
        continue;
      }
      return false;
    }

    if (segment.kind === "static") {
      if (segment.value !== part) return false;
    }

    segmentIndex++;
    partIndex++;
  }

  return partIndex === parts.length;
}

/** Reads the parameters out of a request path. */
export function extractParams(parsed: ParsedPath, path: string): Record<string, string> {
  const parts = split(path);
  const params: Record<string, string> = {};

  let partIndex = 0;

  for (const segment of parsed.segments) {
    if (segment.kind === "wildcard") {
      // The remainder, joined back: a wildcard is meant to carry a path.
      const rest = parts.slice(partIndex).join("/");
      if (rest !== "") params[segment.name] = safeDecode(rest);
      return params;
    }

    const part = parts[partIndex];

    if (part === undefined) {
      // Absent and optional means absent, not empty — a schema can then
      // distinguish "not given" from "given as empty". Absent and required means
      // the path did not match this template in the first place.
      if (segment.kind === "param" && !segment.optional) return params;
      continue;
    }

    if (segment.kind === "param") {
      params[segment.name] = safeDecode(part);
    }

    partIndex++;
  }

  return params;
}

/**
 * Builds a URL path from a template and its parameters.
 *
 * A parameter with no value is omitted when it is optional; a required one is an
 * error, because sending the string "undefined" produces a request that reaches
 * a handler as a real segment.
 */
export function buildPathFrom(
  parsed: ParsedPath,
  params?: Record<string, unknown>,
): string {
  const parts: string[] = [];

  for (const segment of parsed.segments) {
    if (segment.kind === "static") {
      parts.push(segment.value);
      continue;
    }

    const value = params?.[segment.name];
    const absent = value === undefined || value === null || value === "";

    if (absent) {
      // Checked in this order because the wildcard arm is not a property of the
      // param shape, so reading `optional` off it is not a type error to repeat.
      if (segment.kind === "wildcard") continue;
      if (segment.optional) continue;
      throw new Error(`Missing path parameter "${segment.name}" for "${parsed.template}"`);
    }

    /*
     * A wildcard carries a path, so its slashes are kept and only each piece is
     * encoded. Encoding the whole value turned "a/b/c.txt" into "a%2Fb%2Fc.txt",
     * which is one segment and defeats the point of having a wildcard at all.
     *
     * A parameter does the opposite: encoding it whole is what stops a value
     * containing a slash from adding a path segment.
     */
    if (segment.kind === "wildcard") {
      parts.push(
        String(value)
          .split("/")
          .map((piece) => encodeURIComponent(piece))
          .join("/"),
      );
      continue;
    }

    parts.push(encodeURIComponent(String(value)));
  }

  return `/${parts.join("/")}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray % is not worth a 500; the raw text is more useful than an error.
    return value;
  }
}

/**
 * Orders templates so the most specific one is tried first.
 *
 * `/users/new` must be matched before `/users/:id`, or a create endpoint silently
 * becomes a fetch of a user whose id is the literal string "new". A static segment
 * beats a parameter at the same position; a wildcard loses to both.
 *
 * Stable for templates that are equally specific, so declaration order decides
 * between two routes that cannot both match.
 */
export function bySpecificity(a: ParsedPath, b: ParsedPath): number {
  const length = Math.max(a.segments.length, b.segments.length);

  for (let i = 0; i < length; i++) {
    const rank = (path: ParsedPath) => {
      const segment = path.segments[i];
      if (!segment) return 0;
      if (segment.kind === "static") return 3;
      if (segment.kind === "param") return segment.optional ? 1 : 2;
      return 0;
    };

    const difference = rank(b) - rank(a);
    if (difference !== 0) return difference;
  }

  // A wildcard tail sorts after a fully specified path of the same length.
  return Number(a.wildcard) - Number(b.wildcard);
}

/** Splits a query string into scalars, or arrays where a key really did repeat. */
export function readQuery(url: string): Record<string, unknown> {
  const index = url.indexOf("?");
  if (index === -1) return {};

  // Null-prototype, so `?constructor=1` reads as a parameter rather than the
  // inherited constructor function. The same query reaching two parsers must not
  // give them two different answers.
  const out: Record<string, unknown> = Object.create(null);
  const params = new URLSearchParams(url.slice(index + 1));

  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    // Decided by how many arrived, not by the shape, so `?limit=10` reaches a
    // `{ limit: number }` schema as a string and `?tag=a&tag=b` reaches a
    // `{ tag: string[] }` schema as an array.
    out[key] = all.length === 1 ? all[0] : all;
  }

  return out;
}

/** Strips a mount point from a path, when the platform does not include it. */
export function stripBase(path: string, basePath: string | undefined): string {
  if (!basePath || basePath === "/") return path;
  const normalised = basePath.replace(/\/$/, "");
  if (!path.startsWith(normalised)) return path;
  return path.slice(normalised.length) || "/";
}