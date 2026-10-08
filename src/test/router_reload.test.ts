import { describe, it, expect } from "bun:test";

import { throttledReload } from "../types/api";

/*
 * Dev-mode route reloading.
 *
 * The scaffold and `routeRequest` used to call `router.reload()` on every request so a
 * newly added route file would be picked up without a restart. Reloading mutates the
 * route table while `match()` reads it, and under concurrency the interleaving threw:
 * measured on a fresh `yatta new`, 40 of 100 concurrent requests to a file-routed path
 * returned 500, while the same handler reached through `/api` was 75/75 clean.
 *
 * It also cost a directory scan per request. The throttle keeps the feature and drops
 * both problems.
 */

/** A stand-in for Bun.FileSystemRouter that counts reloads. */
function fakeRouter() {
  let reloads = 0;
  return {
    router: {
      reload: () => {
        reloads++;
      },
    },
    count: () => reloads,
  };
}

describe("throttledReload", () => {
  it("reloads the first time it is called", () => {
    const { router, count } = fakeRouter();

    throttledReload(router, 500);

    expect(count()).toBe(1);
  });

  it("does not reload again inside the interval", () => {
    const { router, count } = fakeRouter();

    for (let i = 0; i < 50; i++) throttledReload(router, 500);

    // Before the fix each of these was a directory scan, and each raced the next.
    expect(count()).toBe(1);
  });

  it("reloads again once the interval has passed", async () => {
    const { router, count } = fakeRouter();

    throttledReload(router, 30);
    expect(count()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 45));

    throttledReload(router, 30);
    expect(count()).toBe(2);
  });

  it("keeps a burst of concurrent calls down to one reload", async () => {
    const { router, count } = fakeRouter();

    // All of these land in the same millisecond, which is exactly the interleaving
    // that produced the 500s.
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        throttledReload(router, 500);
      }),
    );

    expect(count()).toBe(1);
  });

  it("tracks each router separately, so one router does not throttle another", () => {
    const a = fakeRouter();
    const b = fakeRouter();

    throttledReload(a.router, 500);
    throttledReload(b.router, 500);

    expect(a.count()).toBe(1);
    expect(b.count()).toBe(1);
  });

  it("does not throw on something that is not a router", () => {
    expect(() => throttledReload({}, 500)).not.toThrow();
    expect(() => throttledReload({ reload: "not a function" }, 500)).not.toThrow();
    expect(() => throttledReload(null as never, 500)).not.toThrow();
  });

  it("reloads again after a throwing reload rather than latching", async () => {
    let calls = 0;
    const router = {
      reload: () => {
        calls++;
        if (calls === 1) throw new Error("scan failed");
      },
    };

    // The `running` flag is cleared in a finally, so one failure must not stop every
    // later reload — which would leave a dev server permanently blind to new files.
    expect(() => throttledReload(router, 0)).toThrow("scan failed");

    throttledReload(router, 0);

    expect(calls).toBe(2);
  });
});