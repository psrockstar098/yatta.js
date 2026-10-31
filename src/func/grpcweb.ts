// gRPC-Web — Browser & Node/Bun clients calling services over HTTP.
//
// Unary calls only (no streaming, no compression).
// Messages use protobuf wire format; HTTP body uses gRPC-Web framing.
// Zero third-party dependencies.
//
// The one thing that surprises people coming from REST: a call can fail
// and still be `HTTP 200`. The outcome is the `grpc-status` trailer, not
// the HTTP status line, which only says whether the transport worked.

// ── Status codes and errors ──────────────────────────────────────────────

/**
 * gRPC status codes.
 *
 * They travel in the `grpc-status` trailer (and header), not in the HTTP
 * status line, so a failed call is still HTTP 200.
 */
export const GrpcStatus = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

/** Any of the numeric values in {@link GrpcStatus}. */
export type GrpcStatusCode = (typeof GrpcStatus)[keyof typeof GrpcStatus];

/**
 * An error carrying a gRPC status code.
 *
 * Throw one from a service to choose what the client sees. Anything else
 * is logged and answered as `INTERNAL`, so an unexpected failure does not
 * put its message on the wire.
 */
export class GrpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "GrpcError";
    this.code = code;
  }
  get grpcStatus(): number {
    return this.code;
  }
}

// ── Protobuf wire codec ──────────────────────────────────────────────────

/**
 * One decoded protobuf field.
 *
 * `varint` is set for wire type 0, `bytes` for 1 (fixed64), 2
 * (length-delimited) and 5 (fixed32). Values are `bigint`, not `number`,
 * so a real 64-bit id survives the round trip.
 */
export interface ProtoField {
  field: number;
  wireType: 0 | 1 | 2 | 5;
  varint?: bigint;
  bytes?: Uint8Array;
}

const MAX_FIELD_NUMBER = 536870911; // 2^29 - 1
const MAX_UINT64 = 0xffffffffffffffffn;
const MIN_INT64 = -0x8000000000000000n;

function malformed(message: string): GrpcError {
  return new GrpcError(GrpcStatus.INVALID_ARGUMENT, message);
}

/**
 * ZigZag-encode a signed value for a `sint32`/`sint64` field.
 *
 * Without it a small negative number is ten bytes of sign extension;
 * with it, -1 is one byte.
 */
export function encodeZigZag(n: bigint | number): bigint {
  const b = BigInt(n);
  return (b << 1n) ^ (b >> 63n);
}

/** Undo {@link encodeZigZag}. */
export function decodeZigZag(n: bigint): bigint {
  return (n >> 1n) ^ -(n & 1n);
}

/**
 * Encode an integer as a base-128 varint.
 *
 * A negative value becomes its 64-bit two's complement, which is how
 * protobuf writes `int64` — ten bytes every time. Use
 * {@link encodeZigZag} for `sint*` fields to avoid that.
 *
 * @throws RangeError when the value does not fit in 64 bits.
 */
export function encodeVarint(value: bigint | number): Uint8Array {
  let v = BigInt(value);
  if (v < MIN_INT64 || v > MAX_UINT64) {
    throw new RangeError(`Varint does not fit in 64 bits: ${value}`);
  }
  if (v < 0n) v = BigInt.asUintN(64, v);

  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return new Uint8Array(out);
}

/**
 * Read one varint that starts at `offset`.
 *
 * @returns `value`, and `next` — the offset just past the varint, so a
 * caller can keep walking a message.
 * @throws GrpcError (INVALID_ARGUMENT) on a truncated or over-long varint;
 * malformed input from a client is not a server fault.
 */
export function decodeVarint(
  data: Uint8Array,
  offset: number,
): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;

  for (let n = 0; n < 10; n++) {
    if (i >= data.length) throw malformed("Truncated varint");
    const b = data[i]!;
    i++;
    // The 10th byte can only carry 1 bit before overflowing 64-bit unsigned int
    if (n === 9 && (b & 0xfe) !== 0)
      throw malformed("Varint overflow (exceeds 64 bits)");
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: BigInt.asUintN(64, result), next: i };
    }
    shift += 7n;
  }
  throw malformed("Varint too long (> 10 bytes)");
}

function checkField(field: number): void {
  if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER) {
    throw new RangeError(`Invalid protobuf field number: ${field}`);
  }
}

function encodeTag(field: number, wireType: number): Uint8Array {
  checkField(field);
  return encodeVarint((BigInt(field) << 3n) | BigInt(wireType));
}

/** Join byte arrays in order. The result is a copy, so it is safe to keep. */
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

// ── Encoding Helpers ─────────────────────────────────────────────────────

/** Wire type 2: tag, length, then the bytes untouched. */
export function encodeBytesField(field: number, body: Uint8Array): Uint8Array {
  return concat(encodeTag(field, 2), encodeVarint(body.length), body);
}

/** Wire type 2, with the string encoded as UTF-8. */
export function encodeStringField(field: number, value: string): Uint8Array {
  return encodeBytesField(field, new TextEncoder().encode(value));
}

/** Wire type 0: tag then varint. */
export function encodeVarintField(
  field: number,
  value: number | bigint,
): Uint8Array {
  return concat(encodeTag(field, 0), encodeVarint(value));
}

/** Wire type 0 with 1 or 0. Protobuf has no boolean on the wire. */
export function encodeBooleanField(field: number, value: boolean): Uint8Array {
  return encodeVarintField(field, value ? 1n : 0n);
}

/** Wire type 2 with a message the caller has already encoded. */
export function encodeMessageField(
  field: number,
  messageBytes: Uint8Array,
): Uint8Array {
  return encodeBytesField(field, messageBytes);
}

/** Wire type 5: four bytes, little-endian, as protobuf requires. */
export function encodeFloatField(field: number, value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, value, true); // Little-endian
  return concat(encodeTag(field, 5), buf);
}

/** Wire type 1: eight bytes, little-endian. */
export function encodeDoubleField(field: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true); // Little-endian
  return concat(encodeTag(field, 1), buf);
}

// ── Message Decoding ─────────────────────────────────────────────────────

/**
 * Split one encoded message into its fields, in wire order.
 *
 * Every length is checked against the bytes actually present before it is
 * used, so a truncated message is an error rather than a short read.
 *
 * @throws GrpcError (INVALID_ARGUMENT) when the bytes are not a valid message.
 */
export function decodeMessage(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < data.length) {
    const tag = decodeVarint(data, i);
    i = tag.next;
    const fieldBig = tag.value >> 3n;
    if (fieldBig < 1n || fieldBig > BigInt(MAX_FIELD_NUMBER)) {
      throw malformed("Invalid protobuf field number");
    }
    const field = Number(fieldBig);
    const wireType = Number(tag.value & 0x7n);

    if (wireType === 0) {
      const v = decodeVarint(data, i);
      i = v.next;
      fields.push({ field, wireType: 0, varint: v.value });
    } else if (wireType === 2) {
      const len = decodeVarint(data, i);
      i = len.next;
      if (len.value > BigInt(data.length - i))
        throw malformed("Truncated field");
      const size = Number(len.value);
      fields.push({ field, wireType: 2, bytes: data.subarray(i, i + size) });
      i += size;
    } else if (wireType === 1 || wireType === 5) {
      const size = wireType === 1 ? 8 : 4;
      if (i + size > data.length) throw malformed("Truncated fixed field");
      fields.push({ field, wireType, bytes: data.subarray(i, i + size) });
      i += size;
    } else {
      throw malformed(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
  return fields;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function lastField(
  fields: ProtoField[],
  field: number,
  wireType: number,
): ProtoField | undefined {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.field === field && f.wireType === wireType) return f;
  }
  return undefined;
}

/**
 * The last length-delimited field with this number, read as text.
 *
 * @returns null when the field is absent — an absent field and an empty
 * string are different answers, and callers rely on that.
 * @throws GrpcError when the bytes are not valid UTF-8, rather than
 * substituting replacement characters and handing back mangled text.
 */
export function fieldString(
  fields: ProtoField[],
  field: number,
): string | null {
  const found = lastField(fields, field, 2);
  if (!found?.bytes) return null;
  try {
    return utf8Decoder.decode(found.bytes);
  } catch {
    throw malformed(`Field ${field} is not valid UTF-8`);
  }
}

/**
 * The last length-delimited field with this number, as raw bytes.
 *
 * @returns null when the field is absent. The bytes are a view into the
 * decoded message, so copy them before keeping them.
 */
export function fieldBytes(
  fields: ProtoField[],
  field: number,
): Uint8Array | null {
  return lastField(fields, field, 2)?.bytes ?? null;
}

/**
 * The last varint field with this number.
 *
 * @returns null when absent, so a legitimate 0 is not mistaken for "no field".
 */
export function fieldVarint(
  fields: ProtoField[],
  field: number,
): bigint | null {
  return lastField(fields, field, 0)?.varint ?? null;
}

/**
 * {@link fieldVarint} as a JavaScript number.
 *
 * Loses precision past 2^53, so read ids and timestamps with
 * {@link fieldVarint} instead.
 */
export function fieldNumber(
  fields: ProtoField[],
  field: number,
): number | null {
  const v = fieldVarint(fields, field);
  return v === null ? null : Number(v);
}

/** A varint field read as a boolean: anything other than 0 is true. */
export function fieldBoolean(
  fields: ProtoField[],
  field: number,
): boolean | null {
  const v = fieldVarint(fields, field);
  return v === null ? null : v !== 0n;
}

/** A 32-bit float field (wire type 5). Null when absent or the wrong width. */
export function fieldFloat(fields: ProtoField[], field: number): number | null {
  const f = lastField(fields, field, 5);
  if (!f?.bytes || f.bytes.length !== 4) return null;
  return new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getFloat32(
    0,
    true,
  );
}

/** A 64-bit float field (wire type 1). Null when absent or the wrong width. */
export function fieldDouble(
  fields: ProtoField[],
  field: number,
): number | null {
  const f = lastField(fields, field, 1);
  if (!f?.bytes || f.bytes.length !== 8) return null;
  return new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(
    0,
    true,
  );
}

/** A nested message, already decoded. Null when the field is absent. */
export function fieldMessage(
  fields: ProtoField[],
  field: number,
): ProtoField[] | null {
  const raw = fieldBytes(fields, field);
  return raw ? decodeMessage(raw) : null;
}

/**
 * Every value of a repeated varint field, in order.
 *
 * Proto3 packs them into one length-delimited field (wire type 2) and
 * proto2 repeats the tag (wire type 0). Both appear in real traffic, so
 * both are read rather than assuming the sender's proto version.
 */
export function fieldRepeatedVarint(
  fields: ProtoField[],
  field: number,
): bigint[] {
  const res: bigint[] = [];
  for (const f of fields) {
    if (f.field !== field) continue;
    if (f.wireType === 0 && f.varint !== undefined) {
      res.push(f.varint);
    } else if (f.wireType === 2 && f.bytes) {
      let offset = 0;
      while (offset < f.bytes.length) {
        const dec = decodeVarint(f.bytes, offset);
        res.push(dec.value);
        offset = dec.next;
      }
    }
  }
  return res;
}

/** Every value of a repeated string field, in order. */
export function fieldRepeatedString(
  fields: ProtoField[],
  field: number,
): string[] {
  const res: string[] = [];
  for (const f of fields) {
    if (f.field === field && f.wireType === 2 && f.bytes) {
      try {
        res.push(utf8Decoder.decode(f.bytes));
      } catch {
        throw malformed(`Field ${field} contains invalid UTF-8`);
      }
    }
  }
  return res;
}

/** Every value of a repeated bytes field, in order. */
export function fieldRepeatedBytes(
  fields: ProtoField[],
  field: number,
): Uint8Array[] {
  return fields
    .filter((f) => f.field === field && f.wireType === 2 && f.bytes)
    .map((f) => f.bytes!);
}

/** Every value of a repeated message field, decoded. */
export function fieldRepeatedMessage(
  fields: ProtoField[],
  field: number,
): ProtoField[][] {
  return fieldRepeatedBytes(fields, field).map((bytes) => decodeMessage(bytes));
}

// ── gRPC-Web framing ─────────────────────────────────────────────────────

/**
 * One frame of a gRPC-Web body.
 *
 * `trailer` marks the final frame, which carries `grpc-status` as text
 * instead of a message. `compressed` is the flag this server never sets:
 * it negotiates no compression, and refusing the flag is clearer than
 * silently handing back bytes nobody decompressed.
 */
export interface GrpcFrame {
  trailer: boolean;
  compressed: boolean;
  data: Uint8Array;
}

/** Frame a payload: one flag byte, a 4-byte big-endian length, then the bytes. */
export function encodeFrame(data: Uint8Array, trailer = false): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = trailer ? 0x80 : 0x00;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(
    1,
    data.length,
    false,
  );
  out.set(data, 5);
  return out;
}

/**
 * Split a gRPC-Web body into its frames.
 *
 * @param maxFrameBytes Refuse a frame above this size before reading it.
 * The length comes from the caller, so a 5-byte header can otherwise
 * announce four gigabytes and have the server try to find them.
 */
export function decodeFrames(
  data: Uint8Array,
  maxFrameBytes = Infinity,
): GrpcFrame[] {
  const frames: GrpcFrame[] = [];
  let i = 0;
  while (i < data.length) {
    if (i + 5 > data.length) throw malformed("Truncated gRPC-Web frame header");
    const flag = data[i]!;
    const length = new DataView(
      data.buffer,
      data.byteOffset + i + 1,
      4,
    ).getUint32(0, false);
    i += 5;
    if (length > maxFrameBytes) {
      throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "Message too large");
    }
    if (i + length > data.length)
      throw malformed("Truncated gRPC-Web frame body");
    frames.push({
      trailer: (flag & 0x80) !== 0,
      compressed: (flag & 0x01) !== 0,
      data: data.subarray(i, i + length),
    });
    i += length;
  }
  return frames;
}

function encodeGrpcMessage(message: string): string {
  try {
    return encodeURIComponent(message.slice(0, 500));
  } catch {
    return "";
  }
}

function decodeGrpcMessage(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function trailerFrame(status: number, message = ""): Uint8Array {
  const encoded = message ? encodeGrpcMessage(message) : "";
  const text = new TextEncoder().encode(
    `grpc-status: ${status}\r\n${encoded ? `grpc-message: ${encoded}\r\n` : ""}`,
  );
  return encodeFrame(text, true);
}

function parseTrailers(frames: GrpcFrame[]): {
  status: number | null;
  message: string;
} {
  for (const f of frames) {
    if (!f.trailer) continue;
    const text = new TextDecoder().decode(f.data);
    let status: number | null = null;
    let message = "";
    for (const line of text.split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      if (name === "grpc-status" && status === null) {
        const n = Number(value);
        if (Number.isInteger(n)) status = n;
      } else if (name === "grpc-message" && !message) {
        message = decodeGrpcMessage(value);
      }
    }
    return { status, message };
  }
  return { status: null, message: "" };
}

// ── Base64 (Safe across Node, Bun, and Browsers) ─────────────────────────

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "base64",
    );
  }
  let binary = "";
  const chunk = 0x2000; // 8192 items avoids stack call bounds
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(clean, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    throw malformed("Invalid base64 payload");
  }
}

// ── Service handler ──────────────────────────────────────────────────────

/** What a service gets besides the request message. */
export interface GrpcContext {
  /** The original HTTP request: headers, cookies, and the caller's identity. */
  req: Request;
  signal?: AbortSignal;
}

/**
 * One unary method: request message in, reply message out.
 *
 * Return bytes, not a `Response` — framing, trailers and status codes are
 * the handler's job. Throw {@link GrpcError} to pick the status code.
 */
export type GrpcServiceFn = (
  request: Uint8Array,
  ctx: GrpcContext,
) => Promise<Uint8Array> | Uint8Array;

/**
 * Methods keyed `"package.Service/Method"`, the same string the client
 * puts in the URL.
 */
export type GrpcServices = Record<string, GrpcServiceFn>;

/**
 * Two services that need no setup, so the endpoint answers before an app
 * has anything to say: `yatta.Health/Check` and `yatta.Echo/Echo`.
 */
export const defaultGrpcServices: GrpcServices = {
  "yatta.Health/Check": () => encodeStringField(1, "SERVING"),
  "yatta.Echo/Echo": (request) => {
    const msg = fieldString(decodeMessage(request), 1) ?? "";
    return encodeStringField(1, msg);
  },
};

export interface GrpcWebOptions {
  /** Where the handler is mounted. Default `/grpc-web`; a trailing slash is ignored. */
  basePath?: string;
  /**
   * Largest message accepted, in bytes. Default 4 MB. A reply is not
   * capped by this — only what a client can push in.
   */
  maxMessageBytes?: number;
  /**
   * Browser origins allowed to call this endpoint, like
   * `["https://app.example.com"]`, or `["*"]` for any.
   *
   * Unset means no CORS headers, so a browser on another origin is
   * refused by the browser itself. An `OPTIONS` from an origin not on
   * the list gets a 403 rather than a permissive preflight.
   */
  corsOrigins?: string[];
}

async function readLimited(
  req: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const declared = Number(cl);
    if (!Number.isNaN(declared) && declared > limit) return null;
  }
  if (!req.body) return new Uint8Array(0);

  // Fallback for non-streaming Request implementations
  if (typeof req.body.getReader !== "function") {
    const buf = await req.arrayBuffer();
    return buf.byteLength > limit ? null : new Uint8Array(buf);
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

function parseContentType(
  header: string | null,
): { text: boolean; responseType: string } | null {
  const base = (header ?? "").split(";")[0]!.trim().toLowerCase();
  switch (base) {
    case "application/grpc-web":
    case "application/grpc-web+proto":
      return { text: false, responseType: base };
    case "application/grpc-web-text":
    case "application/grpc-web-text+proto":
      return { text: true, responseType: base };
    default:
      return null;
  }
}

/**
 * Build the HTTP handler for gRPC-Web unary calls.
 *
 * Mount it on `options.basePath` and give it a service map. Anything that
 * is not a `POST` to `<basePath>/<Service>/<Method>` is answered before a
 * service is consulted.
 *
 * @param services The methods to expose. Defaults to the health check and
 * an echo, which are useful for a smoke test and harmless otherwise.
 * @returns A `(req) => Promise<Response>` to hand to a router or `Bun.serve`.
 *
 * @example
 * const grpc = createGrpcWebHandler({
 *   "shop.Catalog/Get": async (request) => {
 *     const id = fieldString(decodeMessage(request), 1);
 *     if (!id) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "id is required");
 *     return encodeStringField(1, await loadItem(id));
 *   },
 * });
 */
export function createGrpcWebHandler(
  services: GrpcServices = defaultGrpcServices,
  options: GrpcWebOptions = {},
): (req: Request) => Promise<Response> {
  const rawBase = (options.basePath ?? "/grpc-web").trim();
  const basePath = (rawBase.startsWith("/") ? rawBase : "/" + rawBase).replace(
    /\/+$/,
    "",
  );
  const maxMessage = options.maxMessageBytes ?? 4 * 1024 * 1024;
  const maxBody = maxMessage + 5;
  const maxTextBody = Math.ceil(maxBody / 3) * 4 + 8;
  const hint = `Use POST ${basePath}/<Service>/<Method>`;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath + "/")) {
      return new Response(hint, { status: 404 });
    }

    const origin = req.headers.get("origin");
    const allowAll = options.corsOrigins?.includes("*");
    const corsAllowed =
      !!origin && (allowAll || options.corsOrigins?.includes(origin));

    const corsHeaders: Record<string, string> = corsAllowed
      ? {
          "Access-Control-Allow-Origin": origin!,
          "Access-Control-Expose-Headers":
            "grpc-status, grpc-message, grpc-status-details-bin, x-grpc-web",
          Vary: "Origin",
        }
      : {};

    if (req.method === "OPTIONS") {
      if (origin && !corsAllowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            req.headers.get("access-control-request-headers") ??
            "content-type, x-grpc-web, x-user-agent, grpc-timeout, authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (req.method !== "POST") {
      return new Response(hint, {
        status: 405,
        headers: { Allow: "POST, OPTIONS", ...corsHeaders },
      });
    }

    const mode = parseContentType(req.headers.get("content-type"));
    if (!mode) {
      return new Response("Content-Type must be application/grpc-web", {
        status: 415,
        headers: corsHeaders,
      });
    }

    const respond = (
      payload: Uint8Array,
      status: number,
      message = "",
    ): Response => {
      const headers: Record<string, string> = {
        "Content-Type": mode.responseType,
        "grpc-status": String(status),
        "Cache-Control": "no-store",
        ...corsHeaders,
      };
      if (message) headers["grpc-message"] = encodeGrpcMessage(message);
      return new Response(
        (mode.text ? toBase64(payload) : payload) as BodyInit,
        { status: 200, headers },
      );
    };

    const fail = (status: number, message: string) =>
      respond(trailerFrame(status, message), status, message);

    const target = url.pathname
      .slice(basePath.length + 1)
      .replace(/^\/+|\/+$/g, "");
    const fn = Object.prototype.hasOwnProperty.call(services, target)
      ? services[target]
      : undefined;

    if (!fn) {
      return fail(GrpcStatus.UNIMPLEMENTED, `Unknown method ${target}`);
    }

    let frames: GrpcFrame[];
    try {
      const raw = await readLimited(req, mode.text ? maxTextBody : maxBody);
      if (!raw) return fail(GrpcStatus.RESOURCE_EXHAUSTED, "Request too large");
      const bytes = mode.text ? fromBase64(new TextDecoder().decode(raw)) : raw;
      frames = decodeFrames(bytes, maxMessage);
    } catch (err) {
      if (err instanceof GrpcError) return fail(err.code, err.message);
      return fail(GrpcStatus.INVALID_ARGUMENT, "Bad gRPC-Web request");
    }

    const messages = frames.filter((f) => !f.trailer);
    if (messages.length === 0)
      return fail(GrpcStatus.INVALID_ARGUMENT, "No message frame");
    if (messages.length > 1) {
      return fail(GrpcStatus.UNIMPLEMENTED, "Only unary calls are supported");
    }

    const messageFrame = messages[0]!;
    if (messageFrame.compressed) {
      return fail(GrpcStatus.UNIMPLEMENTED, "Compression is not supported");
    }

    let reply: Uint8Array;
    try {
      reply = await fn(messageFrame.data, { req, signal: req.signal });
      if (!(reply instanceof Uint8Array))
        throw new Error("Service did not return bytes");
    } catch (err) {
      if (err instanceof GrpcError) return fail(err.code, err.message);
      console.error(`[grpc-web] ${target} failed:`, err);
      return fail(GrpcStatus.INTERNAL, "Internal error");
    }

    return respond(concat(encodeFrame(reply), trailerFrame(0)), 0);
  };
}

// ── Client ───────────────────────────────────────────────────────────────

export interface GrpcWebCallOptions {
  /** Extra headers, for example `{ authorization: "Bearer …" }`. */
  headers?: Record<string, string>;
  /** Abort the call from the caller's side. */
  signal?: AbortSignal;
  /**
   * `"text"` sends base64 over `application/grpc-web-text`, which is what
   * browsers without binary support used; `"binary"` (the default) is
   * smaller and now universally supported.
   */
  format?: "binary" | "text";
  /** Sent as a `grpc-timeout` header. The server is free to ignore it. */
  timeoutMs?: number;
}

function httpToGrpc(status: number): number {
  switch (status) {
    case 400:
      return GrpcStatus.INTERNAL;
    case 401:
      return GrpcStatus.UNAUTHENTICATED;
    case 403:
      return GrpcStatus.PERMISSION_DENIED;
    case 404:
      return GrpcStatus.UNIMPLEMENTED;
    case 429:
    case 502:
    case 503:
    case 504:
      return GrpcStatus.UNAVAILABLE;
    default:
      return GrpcStatus.UNKNOWN;
  }
}

/**
 * Call a unary gRPC-Web method and return the raw reply message.
 *
 * Works in a browser and in Bun/Node, because it goes through `fetch`.
 * The reply is unwrapped for you: trailers are parsed and the message
 * bytes are returned.
 *
 * @param endpoint Base URL, like `"https://api.example.com/grpc-web"`.
 * @throws {GrpcError} when the call fails, with the status code in `code`.
 * A transport failure (a 404, a 503) is mapped to the nearest gRPC code.
 */
export async function grpcWebCall(
  endpoint: string,
  service: string,
  method: string,
  message: Uint8Array,
  options: GrpcWebCallOptions = {},
): Promise<Uint8Array> {
  const isText = options.format === "text";
  const contentType = isText
    ? "application/grpc-web-text"
    : "application/grpc-web";

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Accept: isText ? "application/grpc-web-text" : "application/grpc-web",
    "X-Grpc-Web": "1",
    "X-User-Agent": "grpc-web-ts/1.0",
    ...options.headers,
  };

  if (options.timeoutMs && options.timeoutMs > 0) {
    headers["grpc-timeout"] = `${options.timeoutMs}m`;
  }

  const s = service.replace(/^\/+|\/+$/g, "");
  const m = method.replace(/^\/+|\/+$/g, "");
  const url = `${endpoint.replace(/\/+$/, "")}/${s}/${m}`;

  const framed = encodeFrame(message);
  const body = (isText ? toBase64(framed) : framed) as BodyInit;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });

  if (!res.ok) {
    throw new GrpcError(
      httpToGrpc(res.status),
      `HTTP ${res.status}: ${res.statusText}`,
    );
  }

  const resType = res.headers.get("content-type") ?? "";
  const isResText = resType.includes("application/grpc-web-text");

  let rawBytes: Uint8Array;
  if (isResText) {
    rawBytes = fromBase64(await res.text());
  } else {
    rawBytes = new Uint8Array(await res.arrayBuffer());
  }

  let frames: GrpcFrame[];
  try {
    frames = decodeFrames(rawBytes);
  } catch {
    throw new GrpcError(
      GrpcStatus.INTERNAL,
      "Malformed gRPC-Web reply framing",
    );
  }

  const trailers = parseTrailers(frames);
  let status = trailers.status;
  let errorMsg = trailers.message;

  // Fallback to headers if response was trailers-only
  if (status === null && res.headers.has("grpc-status")) {
    const n = Number(res.headers.get("grpc-status"));
    if (Number.isInteger(n)) status = n;
  }
  if (!errorMsg && res.headers.has("grpc-message")) {
    errorMsg = decodeGrpcMessage(res.headers.get("grpc-message")!);
  }

  if (status === null) {
    throw new GrpcError(
      GrpcStatus.UNKNOWN,
      "gRPC reply did not contain a grpc-status",
    );
  }

  if (status !== 0) {
    throw new GrpcError(
      status,
      errorMsg || `gRPC call failed with status ${status}`,
    );
  }

  const messageFrame = frames.find((f) => !f.trailer);
  if (!messageFrame) {
    throw new GrpcError(
      GrpcStatus.INTERNAL,
      "gRPC reply missing message frame",
    );
  }

  return messageFrame.data;
}
