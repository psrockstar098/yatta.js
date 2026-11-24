import { describe, it, expect } from "bun:test";
import {
  encodeQuery,
  decodeQuery,
  encodeResponse,
  decodeResponse,
  createDoHHandler,
  resolveDoH,
  type DnsResolver,
} from "../func/doh";

const stubResolver: DnsResolver = async (name, type) => {
  if (name === "missing.test") throw new Error("NXDOMAIN");
  if (type === "A") return [{ name, type, ttl: 60, address: "93.184.215.14" }];
  return [{ name, type, ttl: 60, address: "2606:2800:220:1:248:1893:25c8:1946" }];
};

describe("DNS over HTTPS", () => {
  it("query messages round-trip", () => {
    const bytes = encodeQuery(1234, "example.com", 1);
    const query = decodeQuery(bytes);
    expect(query.id).toBe(1234);
    expect(query.name).toBe("example.com");
    expect(query.type).toBe(1);
  });

  it("response messages round-trip, A and AAAA", () => {
    const query = { id: 7, name: "example.com", type: 1 };
    const bytes = encodeResponse(query, 0, [
      { name: "example.com", type: "A", ttl: 60, address: "93.184.215.14" },
    ]);
    const decoded = decodeResponse(bytes);
    expect(decoded.rcode).toBe(0);
    expect(decoded.answers[0]!.address).toBe("93.184.215.14");
    const v6 = encodeResponse({ id: 8, name: "example.com", type: 28 }, 0, [
      { name: "example.com", type: "AAAA", ttl: 60, address: "2606:2800:220:1:248:1893:25c8:1946" },
    ]);
    expect(decodeResponse(v6).answers[0]!.address).toBe("2606:2800:220:1:248:1893:25c8:1946");
  });

  it("POST wire query answers with the stub address", async () => {
    const handle = createDoHHandler(stubResolver);
    const res = await handle(
      new Request("http://x/dns-query", {
        method: "POST",
        headers: { "Content-Type": "application/dns-message" },
        body: encodeQuery(99, "example.com", 1) as BodyInit,
      }),
    );
    expect(res.headers.get("Content-Type")).toBe("application/dns-message");
    const decoded = decodeResponse(new Uint8Array(await res.arrayBuffer()));
    expect(decoded.rcode).toBe(0);
    expect(decoded.answers[0]!.address).toBe("93.184.215.14");
  });

  it("GET ?name= answers JSON", async () => {
    const handle = createDoHHandler(stubResolver);
    const res = await handle(new Request("http://x/dns-query?name=example.com&type=A"));
    const json = (await res.json()) as {
      Status: number;
      Answer: Array<{ data: string }>;
    };
    expect(json.Status).toBe(0);
    expect(json.Answer[0]!.data).toBe("93.184.215.14");
  });

  it("GET ?dns= base64url wire query works", async () => {
    const handle = createDoHHandler(stubResolver);
    const wire = Buffer.from(encodeQuery(55, "example.com", 28))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await handle(new Request(`http://x/dns-query?dns=${wire}`));
    const decoded = decodeResponse(new Uint8Array(await res.arrayBuffer()));
    expect(decoded.answers[0]!.address).toBe("2606:2800:220:1:248:1893:25c8:1946");
  });

  it("unknown type answers rcode 4, missing name rcode 3", async () => {
    const handle = createDoHHandler(stubResolver);
    const bad = await handle(
      new Request("http://x/dns-query", {
        method: "POST",
        body: encodeQuery(1, "example.com", 99) as BodyInit,
      }),
    );
    expect(decodeResponse(new Uint8Array(await bad.arrayBuffer())).rcode).toBe(4);
    const missing = await handle(
      new Request("http://x/dns-query", {
        method: "POST",
        body: encodeQuery(2, "missing.test", 1) as BodyInit,
      }),
    );
    expect(decodeResponse(new Uint8Array(await missing.arrayBuffer())).rcode).toBe(3);
  });

  it("an unknown named type is not silently answered as A", async () => {
    const handle = createDoHHandler(stubResolver);
    const res = await handle(
      new Request("http://x/dns-query?name=example.com&type=MX", {
        headers: { Accept: "application/dns-json" },
      }),
    );
    const json = (await res.json()) as { Status: number };
    expect(json.Status).toBe(2);
  });

  it("a bad address from the resolver becomes SERVFAIL, not a throw", async () => {
    const badResolver = async (name: string, type: "A" | "AAAA") => [
      { name, type, ttl: 60, address: "1:2:3:4:5:6:7:8:9" },
    ];
    const handle = createDoHHandler(badResolver);
    const res = await handle(
      new Request("http://x/dns-query", {
        method: "POST",
        body: encodeQuery(7, "bad.example", 28) as BodyInit,
      }),
    );
    expect(res.status).toBe(200);
    expect(decodeResponse(new Uint8Array(await res.arrayBuffer())).rcode).toBe(2);
  });

  it("resolveDoH works against the handler over HTTP", async () => {
    const handle = createDoHHandler(stubResolver);
    const server = Bun.serve({ port: 0, fetch: (req) => handle(req) });
    try {
      const answers = await resolveDoH(
        `http://127.0.0.1:${server.port}/dns-query`,
        "example.com",
        "A",
      );
      expect(answers[0]!.address).toBe("93.184.215.14");
    } finally {
      server.stop();
    }
  });

  it("decodes compressed answer names (0xc0 pointers), as real DoH servers send", () => {
    // A Cloudflare-style reply: the question is example.com, and the
    // answer name is a pointer (0xc00c) back to the question — the shape
    // every real DoH server sends, which decodeResponse used to reject
    // with "Compressed DNS names are not supported".
    const bytes: number[] = [];
    const u16 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff);
    u16(42); // id
    u16(0x8180); // QR + RD + RA, rcode 0
    u16(1); // QDCOUNT
    u16(1); // ANCOUNT
    u16(0);
    u16(0);
    // Question: example.com, A, IN
    for (const label of ["example", "com"]) {
      bytes.push(label.length, ...new TextEncoder().encode(label));
    }
    bytes.push(0);
    u16(1);
    u16(1);
    // Answer: name = pointer to offset 12, A, IN, TTL 60, 93.184.215.14
    bytes.push(0xc0, 0x0c);
    u16(1);
    u16(1);
    bytes.push(0, 0, 0, 60);
    u16(4);
    bytes.push(93, 184, 215, 14);
    const decoded = decodeResponse(new Uint8Array(bytes));
    expect(decoded.id).toBe(42);
    expect(decoded.rcode).toBe(0);
    expect(decoded.answers).toEqual([
      { name: "example.com", type: "A", ttl: 60, address: "93.184.215.14" },
    ]);
  });

  it("rejects a compression pointer loop instead of spinning", () => {
    const bytes: number[] = [];
    const u16 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff);
    u16(1);
    u16(0x8180);
    u16(1);
    u16(1);
    u16(0);
    u16(0);
    for (const label of ["example", "com"]) {
      bytes.push(label.length, ...new TextEncoder().encode(label));
    }
    bytes.push(0);
    u16(1);
    u16(1);
    // Answer name points at itself (the pointer's own offset).
    const answerAt = bytes.length;
    bytes.push(0xc0, answerAt);
    u16(1);
    u16(1);
    bytes.push(0, 0, 0, 60);
    u16(4);
    bytes.push(1, 2, 3, 4);
    expect(() => decodeResponse(new Uint8Array(bytes))).toThrow(/pointer loop/);
  });

  it("emits canonical compressed IPv6 (longest zero run as ::)", () => {
    const query = { id: 9, name: "example.com", type: 28 as const };
    const v6 = encodeResponse(query, 0, [
      { name: "example.com", type: "AAAA", ttl: 60, address: "2001:db8:0:0:0:0:0:1" },
    ]);
    expect(decodeResponse(v6).answers[0]!.address).toBe("2001:db8::1");
    const loopback = encodeResponse(query, 0, [
      { name: "example.com", type: "AAAA", ttl: 60, address: "0:0:0:0:0:0:0:1" },
    ]);
    expect(decodeResponse(loopback).answers[0]!.address).toBe("::1");
  });
});
