// The client's real address, captured at the edge.
//
// Bun does not put the peer address on Request — it lives on the server, as
// server.requestIP(req). Anything downstream that needs it has only the Request,
// and a Request does not carry it.
//
// Auth is the case that matters: without the address, every request is seen as
// 127.0.0.1 and the per-IP rate limits collapse into one global limit, so one
// attacker guessing passwords locks out every legitimate user at once. Auth warns
// at boot when `getClientIp` is missing, and that warning was firing on this
// project's own production boot.
//
// So the address is recorded here on the way in, keyed by the Request itself. A
// WeakMap, so an entry disappears with the request rather than accumulating for
// the life of the process. No header is injected and no Request is cloned —
// either would cost something on every request to solve a problem only auth has.

const addresses = new WeakMap<Request, string>();

/**
 * Records the peer address for one request.
 *
 * Called from `fetch()`, which is the only place the server is available.
 */
export function rememberPeerAddress(req: Request, address: string | undefined): void {
  if (address) addresses.set(req, address);
}

/**
 * The peer address of a request, or `undefined` when it was not recorded.
 *
 * `undefined` is a real possibility and not a bug: a request that never passed
 * through `fetch()` — a test calling a handler directly, or a route invoked in
 * process — has no peer. Callers must treat it as "unknown", never as "local",
 * or every such call lands in one bucket.
 */
export function peerAddress(req: Request): string | undefined {
  return addresses.get(req);
}