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
    expect(decoded.answers[0].address).toBe("93.184.215.14");
    const v6 = encodeResponse({ id: 8, name: "example.com", type: 28 }, 0, [
      { name: "example.com", type: "AAAA", ttl: 60, address: "2606:2800:220:1:248:1893:25c8:1946" },
    ]);
    expect(decodeResponse(v6).answers[0].address).toBe("2606:2800:220:1:248:1893:25c8:1946");
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
    expect(decoded.answers[0].address).toBe("93.184.215.14");
  });

  it("GET ?name= answers JSON", async () => {
    const handle = createDoHHandler(stubResolver);
    const res = await handle(new Request("http://x/dns-query?name=example.com&type=A"));
    const json = (await res.json()) as {
      Status: number;
      Answer: Array<{ data: string }>;
    };
    expect(json.Status).toBe(0);
    expect(json.Answer[0].data).toBe("93.184.215.14");
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
    expect(decoded.answers[0].address).toBe("2606:2800:220:1:248:1893:25c8:1946");
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

  it("resolveDoH works against the handler over HTTP", async () => {
    const handle = createDoHHandler(stubResolver);
    const server = Bun.serve({ port: 0, fetch: (req) => handle(req) });
    try {
      const answers = await resolveDoH(
        `http://127.0.0.1:${server.port}/dns-query`,
        "example.com",
        "A",
      );
      expect(answers[0].address).toBe("93.184.215.14");
    } finally {
      server.stop();
    }
  });
});
