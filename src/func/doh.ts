// DNS over HTTPS (RFC 8484) — serve and resolve DNS over HTTPS.
//
// Simple to use: the server answers on /dns-query, and resolveDoH()
// asks any DoH server. Only A and AAAA records are supported, which
// covers the normal "what IP is this name?" question.
//
// Two shapes are accepted, both from the RFC:
//   - Wire shape: a DNS message, POSTed as application/dns-message,
//     or passed base64url-encoded as GET ?dns=...
//   - JSON shape: GET ?name=example.com&type=A returns
//     application/dns-json, the shape browsers and tools expect.

export type DnsRecordType = "A" | "AAAA";

export const DNS_TYPE_CODES: Record<DnsRecordType, number> = { A: 1, AAAA: 28 };
const CODE_TO_TYPE: Record<number, DnsRecordType> = { 1: "A", 28: "AAAA" };

export interface DnsAnswer {
  name: string;
  type: DnsRecordType;
  ttl: number;
  // Dotted IPv4 for A, coloned IPv6 for AAAA.
  address: string;
}

// A function that answers "what IP does this name have?" The default
// uses the machine's own resolver; tests pass a small stub.
export type DnsResolver = (
  name: string,
  type: DnsRecordType,
) => Promise<DnsAnswer[]>;

// ── DNS wire format (small, no compression) ──────────────────────────────

function encodeName(name: string): Uint8Array {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts: number[] = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

function decodeName(data: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let i = offset;
  for (;;) {
    if (i >= data.length) throw new Error("Truncated DNS name");
    const len = data[i++];
    if (len === 0) break;
    // Compressed names (top bits set) never appear in queries we build,
    // and we refuse them rather than guess.
    if ((len & 0xc0) !== 0) throw new Error("Compressed DNS names are not supported");
    if (i + len > data.length) throw new Error("Truncated DNS name");
    labels.push(new TextDecoder().decode(data.slice(i, i + len)));
    i += len;
  }
  return { name: labels.join("."), next: i };
}

function u16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

function putU16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function putU32(out: number[], value: number): void {
  out.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export interface DnsQuery {
  id: number;
  name: string;
  type: number;
}

// Builds a normal DNS query message for one name and type.
export function encodeQuery(id: number, name: string, type: number): Uint8Array {
  const out: number[] = [];
  putU16(out, id);
  putU16(out, 0x0100); // RD set: "please recurse for me".
  putU16(out, 1); // QDCOUNT
  putU16(out, 0); // ANCOUNT
  putU16(out, 0); // NSCOUNT
  putU16(out, 0); // ARCOUNT
  out.push(...encodeName(name));
  putU16(out, type);
  putU16(out, 1); // QCLASS IN
  return new Uint8Array(out);
}

export function decodeQuery(data: Uint8Array): DnsQuery {
  if (data.length < 12) throw new Error("DNS message too short");
  const id = u16(data, 0);
  const qdCount = u16(data, 4);
  if (qdCount !== 1) throw new Error("Only one DNS question is supported");
  const { name, next } = decodeName(data, 12);
  if (next + 4 > data.length) throw new Error("Truncated DNS question");
  return { id, name, type: u16(data, next) };
}

function ipToBytes(address: string): Uint8Array {
  if (address.includes(":")) {
    // IPv6: expand "::" then parse the 8 groups.
    const [head, tail] = address.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    const groups = [...headParts, ...Array(missing).fill("0"), ...tailParts];
    const out = new Uint8Array(16);
    groups.forEach((g, i) => {
      const v = parseInt(g, 16);
      out[i * 2] = (v >> 8) & 0xff;
      out[i * 2 + 1] = v & 0xff;
    });
    return out;
  }
  return new Uint8Array(address.split(".").map((n) => Number(n)));
}

function bytesToIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  }
  return groups.join(":");
}

// Builds a DNS reply for one question. rcode: 0 ok, 2 server fail,
// 3 name does not exist, 4 not supported.
export function encodeResponse(
  query: DnsQuery,
  rcode: number,
  answers: DnsAnswer[],
): Uint8Array {
  const out: number[] = [];
  putU16(out, query.id);
  // QR=1 (reply), RD copied, RA=1, plus the rcode in the low bits.
  putU16(out, 0x8000 | 0x0100 | 0x0080 | rcode);
  putU16(out, 1);
  putU16(out, answers.length);
  putU16(out, 0);
  putU16(out, 0);
  out.push(...encodeName(query.name));
  putU16(out, query.type);
  putU16(out, 1);
  for (const a of answers) {
    out.push(...encodeName(a.name));
    putU16(out, DNS_TYPE_CODES[a.type]);
    putU16(out, 1);
    putU32(out, a.ttl);
    const rdata = ipToBytes(a.address);
    putU16(out, rdata.length);
    out.push(...rdata);
  }
  return new Uint8Array(out);
}

export interface DecodedResponse {
  id: number;
  rcode: number;
  answers: DnsAnswer[];
}

export function decodeResponse(data: Uint8Array): DecodedResponse {
  if (data.length < 12) throw new Error("DNS message too short");
  const id = u16(data, 0);
  const rcode = u16(data, 2) & 0x000f;
  const anCount = u16(data, 6);
  const { next: afterQuestion } = (() => {
    const q = decodeName(data, 12);
    return { next: q.next + 4 };
  })();
  const answers: DnsAnswer[] = [];
  let i = afterQuestion;
  for (let n = 0; n < anCount; n++) {
    const { name, next } = decodeName(data, i);
    i = next;
    if (i + 10 > data.length) throw new Error("Truncated DNS answer");
    const type = u16(data, i);
    const ttl = (data[i + 4]! << 24) | (data[i + 5]! << 16) | (data[i + 6]! << 8) | data[i + 7]!;
    const rdLength = u16(data, i + 8);
    i += 10;
    if (i + rdLength > data.length) throw new Error("Truncated DNS answer");
    const rdata = data.slice(i, i + rdLength);
    i += rdLength;
    const answerType = CODE_TO_TYPE[type];
    if (answerType) {
      answers.push({ name, type: answerType, ttl, address: bytesToIp(rdata) });
    }
  }
  return { id, rcode, answers };
}

// ── Default resolver (the machine's own DNS) ─────────────────────────────

export const systemResolver: DnsResolver = async (name, type) => {
  const dns = await import("node:dns/promises");
  try {
    const addresses = await dns.lookup(name, {
      family: type === "A" ? 4 : 6,
      all: true,
    });
    return addresses.map((a) => ({
      name,
      type,
      ttl: 300,
      address: a.address,
    }));
  } catch (err) {
    // ENOTFOUND means the name does not exist; anything else is a
    // server-side failure. The handler turns these into rcodes.
    const code = (err as { code?: string }).code;
    const mapped = new Error(code === "ENOTFOUND" ? "NXDOMAIN" : "SERVFAIL");
    (mapped as { dnsCode?: string }).dnsCode = code;
    throw mapped;
  }
};

// ── HTTP handler ─────────────────────────────────────────────────────────

function jsonResponse(query: DnsQuery, rcode: number, answers: DnsAnswer[]): Response {
  const status = rcode === 0 ? 0 : rcode === 3 ? 3 : 2;
  return Response.json({
    Status: status,
    TC: false,
    RD: true,
    RA: true,
    Question: [{ name: query.name + ".", type: query.type }],
    Answer: answers.map((a) => ({
      name: a.name + ".",
      type: DNS_TYPE_CODES[a.type],
      TTL: a.ttl,
      data: a.address,
    })),
  });
}

export function createDoHHandler(
  resolver: DnsResolver = systemResolver,
  options: { path?: string } = {},
): (req: Request) => Promise<Response> {
  const path = options.path ?? "/dns-query";
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return new Response("Not Found", { status: 404 });
    }
    const wantsJson =
      (req.headers.get("accept") ?? "").includes("application/dns-json") ||
      url.searchParams.has("name");

    let query: DnsQuery;
    try {
      if (url.searchParams.has("name")) {
        const name = url.searchParams.get("name")!;
        const typeParam = (url.searchParams.get("type") ?? "A").toUpperCase();
        const typeCode =
          typeParam === "AAAA" ? 28 : /^\d+$/.test(typeParam) ? Number(typeParam) : 1;
        query = { id: 0, name, type: typeCode };
      } else if (req.method === "POST") {
        query = decodeQuery(new Uint8Array(await req.arrayBuffer()));
      } else {
        const encoded = url.searchParams.get("dns");
        if (!encoded) {
          return new Response("Give a DNS message (?dns=...) or a name (?name=...)", {
            status: 400,
          });
        }
        query = decodeQuery(
          new Uint8Array(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
        );
      }
    } catch {
      return new Response("Bad DNS query", { status: 400 });
    }

    const type = CODE_TO_TYPE[query.type];
    if (!type) {
      if (wantsJson) return jsonResponse(query, 4, []);
      return new Response(encodeResponse(query, 4, []) as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/dns-message" },
      });
    }
    let answers: DnsAnswer[];
    try {
      answers = await resolver(query.name, type);
    } catch (err) {
      const rcode = (err as Error).message === "NXDOMAIN" ? 3 : 2;
      if (wantsJson) return jsonResponse(query, rcode, []);
      return new Response(encodeResponse(query, rcode, []) as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/dns-message" },
      });
    }
    if (wantsJson) return jsonResponse(query, 0, answers);
    return new Response(encodeResponse(query, 0, answers) as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/dns-message" },
    });
  };
}

// ── Client ─────────────────────────────────────────────────────────────────

// Asks a DoH server for one name and returns the answers.
export async function resolveDoH(
  endpoint: string,
  name: string,
  type: DnsRecordType = "A",
): Promise<DnsAnswer[]> {
  const id = Math.floor(Math.random() * 0xffff);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/dns-message" },
    body: encodeQuery(id, name, DNS_TYPE_CODES[type]) as BodyInit,
  });
  if (!res.ok) throw new Error(`DoH server answered ${res.status}`);
  const decoded = decodeResponse(new Uint8Array(await res.arrayBuffer()));
  if (decoded.rcode === 3) throw new Error(`Name does not exist: ${name}`);
  if (decoded.rcode !== 0) throw new Error(`DoH lookup failed (rcode ${decoded.rcode})`);
  return decoded.answers;
}
