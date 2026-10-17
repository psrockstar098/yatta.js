// yatta/func/peer.ts
//
// The client's real address, captured at the edge.
//
// Bun does not put the peer address on Request — it lives on the server, as
// server.requestIP(req). Anything downstream that needs it (auth's per-IP rate
// limits, most obviously) has only the Request, and a Request does not carry it.
//
// So the address is recorded here on the way in, keyed by the Request itself. A
// WeakMap, so an entry disappears with the request rather than accumulating for
// the life of the process, and no header is injected and no Request is cloned —
// either of those would cost something on every single request to solve a
// problem only auth has.

const addresses = new WeakMap<Request, string>();

/**
 * Records the peer address for one request. Called from fetch(), which is the
 * only place the server is available.
 */
export function rememberPeerAddress(req: Request, address: string | undefined): void {
  if (address) addresses.set(req, address);
}

/**
 * The peer address of a request, or undefined when it was not recorded.
 *
 * Undefined is a real possibility and not a bug: a request that never passed
 * through fetch() — a test calling a handler directly, or a route invoked in
 * process — has no peer. Callers must treat it as "unknown", never as "local".
 */
export function peerAddress(req: Request): string | undefined {
  return addresses.get(req);
}
