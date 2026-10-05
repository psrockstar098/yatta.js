// Environment detection.
//
// Small file, but the answer decides whether a server render opens a WebSocket,
// so a plausible-looking check is worse than none: the failure is a hung render
// or a hydration mismatch, and neither points here.

/**
 * Whether this code is running outside a browser.
 *
 * Defaults to `true` when it cannot tell. That direction is deliberate:
 * believing you are on the server when you are not costs a skipped effect that
 * recovers on the next render, while believing you are in a browser when you are
 * not costs a WebSocket that outlives the request it was opened in.
 *
 * `document` is the test rather than `window`, because a worker has `self` and
 * often a `window`-alike shim but no `document`, and a worker should get the
 * interactive behaviour — a worker can hold a connection perfectly well.
 */
export function isServer(): boolean {
  return typeof document === "undefined";
}

/** The inverse of {@link isServer}, for the cases where that reads better. */
export function isBrowser(): boolean {
  return !isServer();
}

/**
 * Whether React's server rendering is in progress.
 *
 * Distinct from {@link isServer}: a component can render on the server in an
 * environment that does have a `document`, and a library that guesses wrong opens
 * a connection during render.
 *
 * Read from React when it is present, so this module needs no dependency on it.
 * Anything that renders React server-side sets `useSyncExternalStore`.
 */
export function isServerRender(): boolean {
  const store = (globalThis as { __yattaServerRender?: boolean }).__yattaServerRender;
  return store === true;
}