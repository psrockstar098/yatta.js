// gRPC-Web — browser clients calling services over HTTP.
//
// Small, honest scope: unary calls only, no streaming. Messages use real
// protobuf wire format (varint + length-delimited fields), and the HTTP
// body uses real gRPC-Web framing (1 flag byte + 4 length bytes).
// No extra dependency: the codec below is the protobuf wire format
// for the two field kinds a simple API needs (numbers and strings).
//
// Mounted on /grpc-web/<Service>/<Method>. Two built-in services ship
// with it: yatta.Health/Check and yatta.Echo/Echo. Add your own by
// passing a service map to createGrpcWebHandler().

// ── Protobuf wire codec (subset) ─────────────────────────────────────────

// One decoded field. varint holds numbers, bytes holds strings/bytes.
export interface ProtoField {
  field: number;
  wireType: 0 | 2;
  varint?: bigint;
  bytes?: Uint8Array;
}

export function encodeVarint(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return new Uint8Array(out);
}

export function decodeVarint(
  data: Uint8Array,
  offset: number,
): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= data.length) throw new Error("Truncated varint");
    const b = data[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("Varint too long");
  }
  return { value: result, next: i };
}

function encodeTag(field: number, wireType: number): Uint8Array {
  return encodeVarint(BigInt((field << 3) | wireType));
}

// A string field: tag + length + UTF-8 bytes.
export function encodeStringField(field: number, value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  const out = new Uint8Array(
    encodeTag(field, 2).length + encodeVarint(BigInt(body.length)).length + body.length,
  );
  let at = 0;
  for (const part of [encodeTag(field, 2), encodeVarint(BigInt(body.length)), body]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A number field: tag + varint.
export function encodeVarintField(field: number, value: number | bigint): Uint8Array {
  const tag = encodeTag(field, 0);
  const body = encodeVarint(BigInt(value));
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function decodeMessage(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < data.length) {
    const tag = decodeVarint(data, i);
    i = tag.next;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    if (wireType === 0) {
      const v = decodeVarint(data, i);
      i = v.next;
      fields.push({ field, wireType: 0, varint: v.value });
    } else if (wireType === 2) {
      const len = decodeVarint(data, i);
      i = len.next;
      const size = Number(len.value);
      if (i + size > data.length) throw new Error("Truncated field");
      fields.push({ field, wireType: 2, bytes: data.slice(i, i + size) });
      i += size;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

export function fieldString(fields: ProtoField[], field: number): string | null {
  const found = fields.find((f) => f.field === field && f.bytes);
  return found?.bytes ? new TextDecoder().decode(found.bytes) : null;
}

// ── gRPC-Web framing ─────────────────────────────────────────────────────

export interface GrpcFrame {
  // true for a trailer frame (headers), false for a message frame.
  trailer: boolean;
  data: Uint8Array;
}

// One frame: flag byte, then a 4-byte big-endian length, then the bytes.
export function encodeFrame(data: Uint8Array, trailer = false): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = trailer ? 0x80 : 0x00;
  new DataView(out.buffer).setUint32(1, data.length, false);
  out.set(data, 5);
  return out;
}

export function decodeFrames(data: Uint8Array): GrpcFrame[] {
  const frames: GrpcFrame[] = [];
  let i = 0;
  while (i < data.length) {
    if (i + 5 > data.length) throw new Error("Truncated gRPC-Web frame");
    const trailer = (data[i] & 0x80) !== 0;
    const length = new DataView(data.buffer, data.byteOffset + i + 1, 4).getUint32(0, false);
    i += 5;
    if (i + length > data.length) throw new Error("Truncated gRPC-Web frame");
    frames.push({ trailer, data: data.slice(i, i + length) });
    i += length;
  }
  return frames;
}

function trailerFrame(status: number, message = ""): Uint8Array {
  const text = new TextEncoder().encode(
    `grpc-status: ${status}\r\n${message ? `grpc-message: ${message}\r\n` : ""}`,
  );
  return encodeFrame(text, true);
}

function trailerStatus(frames: GrpcFrame[]): number {
  for (const f of frames) {
    if (!f.trailer) continue;
    const text = new TextDecoder().decode(f.data);
    const m = text.match(/grpc-status:\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

// ── Service handler ──────────────────────────────────────────────────────

export type GrpcServiceFn = (request: Uint8Array) => Promise<Uint8Array> | Uint8Array;
export type GrpcServices = Record<string, GrpcServiceFn>;

// Two small built-in services, so the endpoint works with no setup.
export const defaultGrpcServices: GrpcServices = {
  // Request: field 1 = service name (optional). Reply: field 1 = "SERVING".
  "yatta.Health/Check": (request) => {
    void request;
    return encodeStringField(1, "SERVING");
  },
  // Request: field 1 = message. Reply: field 1 = the same message.
  "yatta.Echo/Echo": (request) => {
    const message = fieldString(decodeMessage(request), 1) ?? "";
    return encodeStringField(1, message);
  },
};

export function createGrpcWebHandler(
  services: GrpcServices = defaultGrpcServices,
  options: { basePath?: string } = {},
): (req: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/grpc-web";
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.startsWith(basePath + "/")) {
      return new Response("Use POST /grpc-web/<Service>/<Method>", { status: 404 });
    }
    const name = url.pathname.slice(basePath.length + 1);
    const fn = services[name];
    const fail = (status: number, message: string) =>
      new Response(concat(trailerFrame(status, message)), {
        status: 200,
        headers: {
          "Content-Type": "application/grpc-web",
          "grpc-status": String(status),
        },
      });
    if (!fn) return fail(12, `Unknown service ${name}`);
    let frames: GrpcFrame[];
    try {
      frames = decodeFrames(new Uint8Array(await req.arrayBuffer()));
    } catch {
      return fail(3, "Bad gRPC-Web frame");
    }
    const messageFrame = frames.find((f) => !f.trailer);
    if (!messageFrame) return fail(3, "No message frame");
    let reply: Uint8Array;
    try {
      reply = await fn(messageFrame.data);
    } catch (err) {
      return fail(13, err instanceof Error ? err.message : "Service failed");
    }
    return new Response(concat(encodeFrame(reply), trailerFrame(0)), {
      status: 200,
      headers: { "Content-Type": "application/grpc-web", "grpc-status": "0" },
    });
  };
}

// ── Browser / Bun client ─────────────────────────────────────────────────

// Calls a unary gRPC-Web method and returns the raw reply message bytes.
// Throws an Error with the gRPC status code when the call fails.
export async function grpcWebCall(
  endpoint: string,
  service: string,
  method: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const res = await fetch(`${endpoint}/${service}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/grpc-web" },
    body: encodeFrame(message) as BodyInit,
  });
  const frames = decodeFrames(new Uint8Array(await res.arrayBuffer()));
  const status = trailerStatus(frames);
  if (status !== 0) {
    const err = new Error(`gRPC call failed with status ${status}`);
    (err as { grpcStatus?: number }).grpcStatus = status;
    throw err;
  }
  const messageFrame = frames.find((f) => !f.trailer);
  if (!messageFrame) throw new Error("gRPC reply had no message frame");
  return messageFrame.data;
}
