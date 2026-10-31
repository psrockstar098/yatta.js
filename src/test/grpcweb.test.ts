import { describe, it, expect } from "bun:test";
import {
  encodeVarint,
  decodeVarint,
  encodeStringField,
  encodeVarintField,
  decodeMessage,
  fieldString,
  encodeFrame,
  decodeFrames,
  createGrpcWebHandler,
  grpcWebCall,
  concat,
} from "../func/grpcweb";

describe("gRPC-Web codec", () => {
  it("varints round-trip, including multi-byte values", () => {
    for (const n of [0n, 1n, 127n, 128n, 300n, 123456789n]) {
      const encoded = encodeVarint(n);
      expect(decodeVarint(encoded, 0).value).toBe(n);
    }
  });

  it("string and number fields round-trip", () => {
    const msg = concat(
      encodeStringField(1, "hello"),
      encodeVarintField(2, 42),
    );
    const fields = decodeMessage(msg);
    expect(fieldString(fields, 1)).toBe("hello");
    expect(fields.find((f) => f.field === 2)?.varint).toBe(42n);
  });

  it("frames round-trip with trailer frames", () => {
    const packed = concat(
      encodeFrame(new Uint8Array([1, 2, 3])),
      encodeFrame(new TextEncoder().encode("grpc-status: 0\r\n"), true),
    );
    const frames = decodeFrames(packed);
    expect(frames.length).toBe(2);
    expect(frames[0]!.trailer).toBe(false);
    expect([...frames[0]!.data]).toEqual([1, 2, 3]);
    expect(frames[1]!.trailer).toBe(true);
  });

  it("bad frames throw", () => {
    expect(() => decodeFrames(new Uint8Array([0, 0, 0]))).toThrow();
  });
});

describe("gRPC-Web handler", () => {
  const handle = createGrpcWebHandler();

  it("Echo returns the same message", async () => {
    const res = await handle(
      new Request("http://x/grpc-web/yatta.Echo/Echo", {
        method: "POST",
        headers: { "Content-Type": "application/grpc-web" },
        body: encodeFrame(encodeStringField(1, "ping")) as BodyInit,
      }),
    );
    expect(res.status).toBe(200);
    const frames = decodeFrames(new Uint8Array(await res.arrayBuffer()));
    const msg = frames.find((f) => !f.trailer)!;
    expect(fieldString(decodeMessage(msg.data), 1)).toBe("ping");
  });

  it("Health answers SERVING", async () => {
    const res = await handle(
      new Request("http://x/grpc-web/yatta.Health/Check", {
        method: "POST",
        body: encodeFrame(new Uint8Array()) as BodyInit,
      }),
    );
    const frames = decodeFrames(new Uint8Array(await res.arrayBuffer()));
    const msg = frames.find((f) => !f.trailer)!;
    expect(fieldString(decodeMessage(msg.data), 1)).toBe("SERVING");
  });

  it("unknown service answers status 12", async () => {
    const res = await handle(
      new Request("http://x/grpc-web/nope/Nope", {
        method: "POST",
        body: encodeFrame(new Uint8Array()) as BodyInit,
      }),
    );
    expect(res.headers.get("grpc-status")).toBe("12");
  });

  it("a custom service can be added", async () => {
    const custom = createGrpcWebHandler({
      "demo.Math/Double": (request) => {
        const n = decodeMessage(request).find((f) => f.field === 1)?.varint ?? 0n;
        return encodeVarintField(1, n * 2n);
      },
    });
    const res = await custom(
      new Request("http://x/grpc-web/demo.Math/Double", {
        method: "POST",
        body: encodeFrame(encodeVarintField(1, 21)) as BodyInit,
      }),
    );
    const frames = decodeFrames(new Uint8Array(await res.arrayBuffer()));
    const msg = frames.find((f) => !f.trailer)!;
    expect(decodeMessage(msg.data).find((f) => f.field === 1)?.varint).toBe(42n);
  });

  it("grpcWebCall works against the handler through fetch", async () => {
    // Serve the handler on a real local port so the client uses fetch.
    const server = Bun.serve({
      port: 0,
      fetch: (req) => handle(req),
    });
    try {
      const reply = await grpcWebCall(
        `http://127.0.0.1:${server.port}/grpc-web`,
        "yatta.Echo",
        "Echo",
        encodeStringField(1, "over http"),
      );
      expect(fieldString(decodeMessage(reply), 1)).toBe("over http");
    } finally {
      server.stop();
    }
  });
});
