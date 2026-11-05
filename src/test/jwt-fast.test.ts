/**
 * jwt-fast tests — fast stateless HS256 verifier (`src/types/jwt.ts`).
 *
 * Every case asserts the EXACT error string, because the verifier's
 * contract is byte-for-byte equivalence with the entry's `verifyAuth`
 * (see `~/workspace/yatta-features/perf3/feed-app.ts`, lines ~56-130).
 * A differential test at the bottom runs the same corpus through both
 * implementations and asserts identical outcomes, including tokens that
 * fail two checks at once.
 *
 * The reference implementation is copied into this file (labelled
 * `referenceVerifyAuth`) so the differential test does not depend on the
 * perf-3 scratch area. It is test-only scaffolding, not shipped code.
 */
import { describe, it, expect } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createJwtVerifier } from "../types/jwt";

const SECRET = "twelve-dollar-challenge";
const jwt = createJwtVerifier(SECRET);

// ─── Token minting (test-only; mirrors feed-profile.ts) ────────────────────

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function sign(hB64: string, pB64: string, secret = SECRET): string {
  return createHmac("sha256", secret)
    .update(`${hB64}.${pB64}`)
    .digest("base64url");
}

/** Mint from raw JSON strings (lets tests smuggle duplicate keys, etc.). */
function mintRaw(headerJson: string, payloadJson: string): string {
  const h = b64(headerJson);
  const p = b64(payloadJson);
  return `${h}.${p}.${sign(h, p)}`;
}

const NOW = () => Math.floor(Date.now() / 1000);

function validPayload(over: Record<string, unknown> = {}) {
  return {
    sub: "1",
    username: "user1",
    iat: NOW(),
    exp: NOW() + 3600,
    ...over,
  };
}

function mint(
  payload: Record<string, unknown> = validPayload(),
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  return mintRaw(JSON.stringify(header), JSON.stringify(payload));
}

const req = (authorization: string | null) =>
  new Request("http://127.0.0.1/posts/1/like", {
    method: "POST",
    ...(authorization === null
      ? {}
      : { headers: { authorization } }),
  });

// ─── Reference implementation (local copy of the entry's verifyAuth) ───────

type AuthOk = { ok: true; userId: number; username: string };
type AuthFail = { ok: false; error: string };

function referenceVerifyAuth(request: Request): AuthOk | AuthFail {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return { ok: false, error: "missing bearer token" };
  }
  const token = header.slice("Bearer ".length);
  const i1 = token.indexOf(".");
  const i2 = i1 < 0 ? -1 : token.indexOf(".", i1 + 1);
  if (i1 < 0 || i2 < 0 || token.indexOf(".", i2 + 1) >= 0) {
    return { ok: false, error: "invalid or expired token" };
  }
  const headerB64 = token.slice(0, i1);
  const payloadB64 = token.slice(i1 + 1, i2);
  const signatureB64 = token.slice(i2 + 1);
  let headerObj: unknown;
  let payloadObj: unknown;
  try {
    headerObj = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8"),
    );
    payloadObj = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
  } catch {
    return { ok: false, error: "invalid or expired token" };
  }
  if (
    typeof headerObj !== "object" ||
    headerObj === null ||
    (headerObj as { alg?: unknown }).alg !== "HS256"
  ) {
    return { ok: false, error: "invalid or expired token" };
  }
  const digest = createHmac("sha256", SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let givenSig: Buffer;
  try {
    givenSig = Buffer.from(signatureB64, "base64url");
  } catch {
    return { ok: false, error: "invalid or expired token" };
  }
  if (digest.length !== givenSig.length || !timingSafeEqual(digest, givenSig)) {
    return { ok: false, error: "invalid or expired token" };
  }
  if (typeof payloadObj !== "object" || payloadObj === null) {
    return { ok: false, error: "invalid or expired token" };
  }
  const payload = payloadObj as {
    sub?: unknown;
    username?: unknown;
    exp?: unknown;
  };
  if (
    typeof payload.sub !== "string" ||
    !/^[1-9][0-9]*$/.test(payload.sub) ||
    typeof payload.username !== "string"
  ) {
    return { ok: false, error: "invalid token payload" };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return { ok: false, error: "invalid or expired token" };
  }
  return {
    ok: true,
    userId: Number(payload.sub),
    username: payload.username,
  };
}

// ─── Success path ──────────────────────────────────────────────────────────

describe("jwt-fast: valid tokens", () => {
  it("accepts a valid token and returns userId + username", () => {
    const r = jwt.verifyRequest(req(`Bearer ${mint()}`));
    expect(r).toEqual({ ok: true, userId: 1, username: "user1" });
  });

  it("accepts multi-digit sub and empty username (reference does too)", () => {
    const r = jwt.verifyToken(mint({ ...validPayload(), sub: "123456789", username: "" }));
    expect(r).toEqual({ ok: true, userId: 123456789, username: "" });
  });

  it("accepts extra payload claims and extra header fields", () => {
    const r = jwt.verifyToken(
      mint(
        { ...validPayload(), role: "admin", scope: ["a", "b"] },
        { alg: "HS256", typ: "JWT", kid: "k1" },
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a far-future exp", () => {
    const r = jwt.verifyToken(mint({ ...validPayload(), exp: NOW() + 10_000_000 }));
    expect(r.ok).toBe(true);
  });

  it("verifyAuthorizationHeader and verifyToken agree with verifyRequest", () => {
    const token = mint();
    expect(jwt.verifyAuthorizationHeader(`Bearer ${token}`)).toEqual(
      jwt.verifyRequest(req(`Bearer ${token}`)),
    );
    expect(jwt.verifyToken(token)).toEqual(
      jwt.verifyRequest(req(`Bearer ${token}`)),
    );
  });
});

// ─── Failure matrix (exact error strings) ──────────────────────────────────

describe("jwt-fast: failure matrix", () => {
  it("missing header → missing bearer token", () => {
    expect(jwt.verifyRequest(req(null))).toEqual({
      ok: false,
      error: "missing bearer token",
    });
  });

  it("non-Bearer schemes → missing bearer token", () => {
    for (const h of ["Basic abc", "bearer abc", "Bearer", "Token abc", ""]) {
      expect(jwt.verifyAuthorizationHeader(h)).toEqual({
        ok: false,
        error: "missing bearer token",
      });
    }
  });

  it("wrong segment counts → invalid or expired token", () => {
    for (const t of ["abc", "a.b", "a.b.c.d", "a.b.c.", ".b.c", "a..c", "..", ".", ""]) {
      expect(jwt.verifyToken(t)).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("malformed header JSON → invalid or expired token", () => {
    const p = b64(JSON.stringify(validPayload()));
    const bad = `${b64("{not json")}.${p}.${sign(b64("{not json"), p)}`;
    expect(jwt.verifyToken(bad)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("malformed payload JSON → invalid or expired token", () => {
    const bad = mintRaw(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "{not json",
    );
    expect(jwt.verifyToken(bad)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("non-object header → invalid or expired token", () => {
    for (const h of ['"HS256"', "123", "true", "null", "[\"HS256\"]"]) {
      expect(jwt.verifyToken(mintRaw(h, JSON.stringify(validPayload())))).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("non-object payload → invalid or expired token", () => {
    for (const p of ['"just a string"', "123", "true", "null"]) {
      expect(jwt.verifyToken(mintRaw(JSON.stringify({ alg: "HS256" }), p))).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("payload array → invalid token payload (arrays pass the object check, sub is missing)", () => {
    expect(
      jwt.verifyToken(mintRaw(JSON.stringify({ alg: "HS256" }), '["1","user1"]')),
    ).toEqual({ ok: false, error: "invalid token payload" });
  });

  it("bad sub → invalid token payload", () => {
    for (const sub of ["0", "01", "", "1.5", "-1", " 1", "1 ", "abc", "1e3"]) {
      expect(jwt.verifyToken(mint({ ...validPayload(), sub }))).toEqual({
        ok: false,
        error: "invalid token payload",
      });
    }
    for (const sub of [123, null, undefined, true, ["1"], { v: "1" }]) {
      const payload = { ...validPayload(), sub };
      if (sub === undefined) delete (payload as Record<string, unknown>).sub;
      expect(jwt.verifyToken(mint(payload))).toEqual({
        ok: false,
        error: "invalid token payload",
      });
    }
  });

  it("bad username → invalid token payload", () => {
    for (const username of [123, null, true, ["u"], { u: 1 }]) {
      expect(
        jwt.verifyToken(mint({ ...validPayload(), username })),
      ).toEqual({ ok: false, error: "invalid token payload" });
    }
    const { username: _u, ...noUser } = validPayload();
    expect(jwt.verifyToken(mint(noUser))).toEqual({
      ok: false,
      error: "invalid token payload",
    });
  });

  it("missing / non-numeric / past exp → invalid or expired token", () => {
    const { exp: _e, ...noExp } = validPayload();
    expect(jwt.verifyToken(mint(noExp))).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
    for (const exp of ["9999999999", null, true, 0, NOW() - 1, NOW() - 3600]) {
      expect(jwt.verifyToken(mint({ ...validPayload(), exp }))).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("exp exactly now fails (no leeway)", () => {
    expect(jwt.verifyToken(mint({ ...validPayload(), exp: NOW() }))).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("wrong secret → invalid or expired token", () => {
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64(JSON.stringify(validPayload()));
    const token = `${h}.${p}.${sign(h, p, "wrong-secret")}`;
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });
});

// ─── Tokens failing two checks at once ─────────────────────────────────────

describe("jwt-fast: double failures", () => {
  it("bad alg AND bad payload shape → invalid or expired token", () => {
    // Reference hits the alg gate first; helper also gates on alg before
    // payload shape — both must say "invalid or expired token", never
    // "invalid token payload".
    const token = mint({ sub: "0", username: 42 }, { alg: "HS384" });
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("bad signature AND bad payload shape → invalid or expired token", () => {
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64(JSON.stringify({ sub: "0", username: 42, exp: 1 }));
    const token = `${h}.${p}.${sign(h, p, "wrong-secret")}`;
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("bad signature AND malformed payload JSON → invalid or expired token", () => {
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64("{not json");
    const token = `${h}.${p}.${sign(h, p, "wrong-secret")}`;
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("malformed header AND bad signature → invalid or expired token", () => {
    const h = b64("{not json");
    const p = b64(JSON.stringify(validPayload()));
    const token = `${h}.${p}.${sign(h, p, "wrong-secret")}`;
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("valid signature but bad sub AND expired exp → invalid token payload (payload shape is checked before exp)", () => {
    const token = mint({ sub: "0", username: "u", exp: NOW() - 100 });
    expect(jwt.verifyToken(token)).toEqual({
      ok: false,
      error: "invalid token payload",
    });
  });

  it("Bearer header with garbage token → invalid or expired token", () => {
    expect(jwt.verifyAuthorizationHeader("Bearer ...")).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
    expect(jwt.verifyAuthorizationHeader("Bearer a.b")).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });
});

// ─── Adversarial: algorithm confusion ──────────────────────────────────────

describe("jwt-fast: algorithm confusion", () => {
  it("alg none with empty signature fails", () => {
    const h = b64(JSON.stringify({ alg: "none", typ: "JWT" }));
    const p = b64(JSON.stringify(validPayload()));
    expect(jwt.verifyToken(`${h}.${p}.`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
    // none + a *valid HS256* signature over the same segments still fails:
    // the alg gate, not the signature, decides.
    expect(jwt.verifyToken(`${h}.${p}.${sign(h, p)}`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("alg HS384 / HS512 / RS256 fail even with a valid HS256 signature", () => {
    for (const alg of ["HS384", "HS512", "RS256", "hs256", "Hs256"]) {
      const token = mint(validPayload(), { alg, typ: "JWT" });
      expect(jwt.verifyToken(token)).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("missing alg fails", () => {
    expect(jwt.verifyToken(mint(validPayload(), { typ: "JWT" }))).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("alg as non-string fails", () => {
    expect(jwt.verifyToken(mint(validPayload(), { alg: 256 }))).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });
});

// ─── Adversarial: signature malleability ───────────────────────────────────

describe("jwt-fast: signature malleability", () => {
  it("truncated signature fails", () => {
    const token = mint();
    const truncated = token.slice(0, token.length - 5);
    expect(jwt.verifyToken(truncated)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
    const parts = token.split(".");
    expect(jwt.verifyToken(`${parts[0]}.${parts[1]}.${parts[2]!.slice(0, 10)}`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("padded signature (extra base64url chars) fails", () => {
    const token = mint();
    expect(jwt.verifyToken(`${token}AAAA`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("signature differing in the last byte fails; differing in the first byte fails", () => {
    const token = mint();
    const parts = token.split(".");
    const sig = parts[2]!;
    const flipFirst = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const flipLast = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(jwt.verifyToken(`${parts[0]}.${parts[1]}.${flipFirst}`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
    expect(jwt.verifyToken(`${parts[0]}.${parts[1]}.${flipLast}`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("wrong-length signatures never throw (length check precedes timingSafeEqual)", () => {
    const token = mint();
    const parts = token.split(".");
    for (const sig of ["", "A", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "A".repeat(100)]) {
      expect(() =>
        jwt.verifyToken(`${parts[0]}.${parts[1]}.${sig}`),
      ).not.toThrow();
      expect(jwt.verifyToken(`${parts[0]}.${parts[1]}.${sig}`)).toEqual({
        ok: false,
        error: "invalid or expired token",
      });
    }
  });

  it("non-canonical base64url spellings behave exactly like the reference (byte comparison, not string comparison)", () => {
    const token = mint();
    const parts = token.split(".");
    const sig = parts[2]!;
    // 32 bytes = 43 base64url chars; the last char's low 2 bits are
    // unused, so swapping the last char within the same top-2-bits
    // decodes to identical bytes. A string comparison would reject
    // this; the reference (byte comparison) accepts it — so must we.
    // 'A'=0 (000000), 'B'=1 (000001), 'C'=2 (000010), 'D'=3 (000011):
    // all share top bits 00 with any last char whose value is 0..3.
    const lastVal = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(sig.at(-1)!);
    const sameTop = ["A", "B", "C", "D"][lastVal & 3]!;
    const altLast = sameTop === sig.at(-1) ? "B" : sameTop;
    const respelled = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${altLast}`;
    expect(referenceVerifyAuth(req(`Bearer ${respelled}`))).toEqual(
      jwt.verifyToken(respelled),
    );
    // And the helper accepts it iff the reference does.
    expect(jwt.verifyToken(respelled).ok).toBe(
      referenceVerifyAuth(req(`Bearer ${respelled}`)).ok,
    );
  });

  it("base64url edge cases (padding, invalid chars) match the reference", () => {
    const token = mint();
    const parts = token.split(".");
    const variants = [
      `${parts[0]}.${parts[1]}.${parts[2]}=`, // trailing padding
      `${parts[0]}.${parts[1]}.${parts[2]}===`,
      `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, 10)}!${parts[2]!.slice(10)}`, // stray '!'
      `${parts[0]}.${parts[1]}.${parts[2]!.replace(/-/g, "+").replace(/_/g, "/")}`, // std-base64 alphabet
    ];
    for (const v of variants) {
      expect(jwt.verifyToken(v)).toEqual(
        referenceVerifyAuth(req(`Bearer ${v}`)),
      );
    }
  });

  it("never throws on garbage input", () => {
    const garbage = [
      "....", "a.b.c.d.e", "\0.\0.\0", "é.é.é",
      "A".repeat(10000), "a.".repeat(5000),
      "Bearer Bearer Bearer", "null", "undefined",
    ];
    for (const g of garbage) {
      expect(() => jwt.verifyToken(g)).not.toThrow();
      expect(jwt.verifyToken(g).ok).toBe(false);
    }
  });
});

// ─── Adversarial: JSON smuggling ───────────────────────────────────────────

describe("jwt-fast: JSON smuggling", () => {
  it("duplicate keys: last wins, exactly like JSON.parse in the reference", () => {
    // sub "1" then "2": JSON.parse keeps "2" → userId 2.
    const token = mintRaw(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      `{"sub":"1","sub":"2","username":"user1","iat":${NOW()},"exp":${NOW() + 3600}}`,
    );
    expect(jwt.verifyToken(token)).toEqual({ ok: true, userId: 2, username: "user1" });
    expect(jwt.verifyToken(token)).toEqual(
      referenceVerifyAuth(req(`Bearer ${token}`)),
    );
    // Duplicate exp: last wins — expired last value must fail.
    const token2 = mintRaw(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      `{"sub":"1","username":"u","exp":${NOW() + 3600},"exp":1}`,
    );
    expect(jwt.verifyToken(token2)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("huge payload verifies (no size gate in either implementation)", () => {
    const big = "x".repeat(100_000);
    const token = mint({ ...validPayload(), note: big });
    expect(jwt.verifyToken(token)).toEqual({
      ok: true,
      userId: 1,
      username: "user1",
    });
    // Huge payload + bad signature fails fast with the same string.
    const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const p = b64(JSON.stringify({ ...validPayload(), note: big }));
    expect(jwt.verifyToken(`${h}.${p}.${sign(h, p, "wrong")}`)).toEqual({
      ok: false,
      error: "invalid or expired token",
    });
  });

  it("payload with __proto__ / constructor keys is inert (plain JSON.parse)", () => {
    const token = mintRaw(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      `{"sub":"1","username":"u","exp":${NOW() + 3600},"__proto__":{"admin":true}}`,
    );
    expect(jwt.verifyToken(token)).toEqual({
      ok: true,
      userId: 1,
      username: "u",
    });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("unicode / escaped payloads verify identically", () => {
    const token = mint({ ...validPayload(), username: "usér✓\n\t\"x\"" });
    expect(jwt.verifyToken(token)).toEqual({
      ok: true,
      userId: 1,
      username: "usér✓\n\t\"x\"",
    });
  });
});

// ─── Factory ───────────────────────────────────────────────────────────────

describe("jwt-fast: factory", () => {
  it("rejects empty / non-string secrets at construction time", () => {
    expect(() => createJwtVerifier("")).toThrow(TypeError);
    expect(() => createJwtVerifier(undefined as unknown as string)).toThrow(TypeError);
    expect(() => createJwtVerifier(123 as unknown as string)).toThrow(TypeError);
  });

  it("two verifiers with different secrets disagree (no shared state)", () => {
    const other = createJwtVerifier("another-secret");
    const token = mint();
    expect(jwt.verifyToken(token).ok).toBe(true);
    expect(other.verifyToken(token).ok).toBe(false);
  });
});

// ─── Differential: helper vs reference over the whole corpus ───────────────

describe("jwt-fast: differential vs reference verifyAuth", () => {
  const corpus: { name: string; header: string | null }[] = [];
  const add = (name: string, header: string | null) => {
    corpus.push({ name, header });
  };

  add("valid", `Bearer ${mint()}`);
  add("valid multi-digit sub", `Bearer ${mint({ ...validPayload(), sub: "9876543210" })}`);
  add("missing header", null);
  add("empty header", "");
  add("basic scheme", "Basic abc");
  add("lowercase bearer", "bearer abc");
  add("bearer no token", "Bearer ");
  add("one segment", "Bearer abc");
  add("two segments", "Bearer a.b");
  add("four segments", "Bearer a.b.c.d");
  add("empty segments", "Bearer ..");
  add("trailing dot", `Bearer ${mint()}.`);
  add("double space after Bearer", `Bearer  ${mint()}`);
  add("alg none empty sig", `Bearer ${(() => { const h = b64(JSON.stringify({ alg: "none" })); const p = b64(JSON.stringify(validPayload())); return `${h}.${p}.`; })()}`);
  add("alg none valid HS256 sig", `Bearer ${mint(validPayload(), { alg: "none" })}`);
  for (const alg of ["HS384", "HS512", "RS256", "hs256"]) {
    add(`alg ${alg}`, `Bearer ${mint(validPayload(), { alg })}`);
  }
  add("header array", `Bearer ${mintRaw('["HS256"]', JSON.stringify(validPayload()))}`);
  add("header string", `Bearer ${mintRaw('"HS256"', JSON.stringify(validPayload()))}`);
  add("header malformed", `Bearer ${mintRaw("{oops", JSON.stringify(validPayload()))}`);
  add("payload malformed", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), "{oops")}`);
  add("payload string", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), '"x"')}`);
  add("payload number", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), "42")}`);
  add("payload null", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), "null")}`);
  add("payload array", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), '["1","u"]')}`);
  for (const sub of ["0", "01", "", "-1", "1.5", "abc"]) {
    add(`sub ${JSON.stringify(sub)}`, `Bearer ${mint({ ...validPayload(), sub })}`);
  }
  add("sub number", `Bearer ${mint({ ...validPayload(), sub: 7 })}`);
  add("username number", `Bearer ${mint({ ...validPayload(), username: 7 })}`);
  add("exp missing", `Bearer ${mint((() => { const { exp: _e, ...rest } = validPayload(); return rest; })())}`);
  add("exp string", `Bearer ${mint({ ...validPayload(), exp: "9999999999" })}`);
  add("exp zero", `Bearer ${mint({ ...validPayload(), exp: 0 })}`);
  add("exp past", `Bearer ${mint({ ...validPayload(), exp: NOW() - 5 })}`);
  add("exp now", `Bearer ${mint({ ...validPayload(), exp: NOW() })}`);
  add("exp now+1", `Bearer ${mint({ ...validPayload(), exp: NOW() + 1 })}`);
  add("wrong secret", `Bearer ${(() => { const h = b64(JSON.stringify({ alg: "HS256" })); const p = b64(JSON.stringify(validPayload())); return `${h}.${p}.${sign(h, p, "nope")}`; })()}`);
  add("bad sub + expired", `Bearer ${mint({ sub: "0", username: "u", exp: NOW() - 100 })}`);
  add("bad alg + bad sub", `Bearer ${mint({ sub: "0", username: 1 }, { alg: "HS512" })}`);
  add("duplicate sub keys", `Bearer ${mintRaw(JSON.stringify({ alg: "HS256" }), `{"sub":"1","sub":"9","username":"u","exp":${NOW() + 3600}}`)}`);
  add("huge payload valid", `Bearer ${mint({ ...validPayload(), note: "y".repeat(50_000) })}`);
  add("huge payload bad sig", `Bearer ${(() => { const h = b64(JSON.stringify({ alg: "HS256" })); const p = b64(JSON.stringify({ ...validPayload(), note: "y".repeat(50_000) })); return `${h}.${p}.${sign(h, p, "nope")}`; })()}`);
  {
    // Non-canonical last-char signature respelling.
    const t = mint();
    const parts = t.split(".");
    const sig = parts[2]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastVal = alphabet.indexOf(sig.at(-1)!);
    const alt = ["A", "B", "C", "D"][lastVal & 3]!;
    const respelled = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${alt === sig.at(-1) ? "B" : alt}`;
    add("non-canonical sig spelling", `Bearer ${respelled}`);
  }
  add("sig with padding", `Bearer ${mint()}=`);

  it("identical outcomes on every corpus entry", () => {
    expect(corpus.length).toBeGreaterThan(30);
    for (const { name, header } of corpus) {
      const request = req(header);
      const got = jwt.verifyRequest(request);
      const want = referenceVerifyAuth(request);
      expect(got, `corpus case: ${name}`).toEqual(want);
    }
  });
});
