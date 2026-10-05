import { describe, it, expect } from "bun:test";

import { createObserver, type Observer } from "../types/observe";

/*
 * The dashboard's guard, tested at the HTTP boundary.
 *
 * `SafeActions` enforces confirmation and idempotency, and `performAction` records an
 * audit entry either way. Three endpoints did neither: they ran the real work inline
 * and logged afterwards. The comment beside `/api/analysis/action/` claimed that a
 * direct call could not bypass the guard, while these three URLs were exactly such a
 * bypass — reachable, unconfirmed, unkeyed, and double-clickable.
 *
 * These tests call the URLs, because calling the URL is the thing being fixed.
 */

/**
 * An observer with one fake subsystem attached.
 *
 * `name` is the subsystem key the router looks up; the value is whatever that
 * subsystem needs. Counters are the point: "the work happened" has to be observable,
 * not inferred from a 200.
 */
function withSubsystem(service: string, key: string, value: unknown) {
  const observer = createObserver({ service, environment: "test", dashboard: true });
  observer.attach(key, value as never);
  return observer;
}

const dlqWith = (over: Record<string, unknown>) => withSubsystem("g", "jobs", { dlq: over });
const cacheWith = (over: Record<string, unknown>) => withSubsystem("g", "cache", over);

const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`https://app.test/_yatta${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Every call made to the stubbed subsystems. */
function work(): string[] {
  const observer = createObserver({ service: "x", environment: "test", dashboard: true });
  void observer;
  return [];
}

describe("Destructive dashboard endpoints go through the guard", () => {
  it("refuses a purge with no idempotency key", async () => {
    const dlq = { purged: false, async purge() { dlq.purged = true; } };
    const observer = dlqWith(dlq);

    const response = await observer.router.handle(
      post("/api/jobs/purge-dead", { confirmed: true }),
    );

    // Confirmation alone was never enough: without a key a retried request re-runs the
    // action, so a double-clicked purge becomes two purges.
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error?: string };
    expect(body.error).toMatch(/idempotency key/i);
  });

  it("refuses a purge that was not confirmed", async () => {
    const dlq = { purged: false, async purge() { dlq.purged = true; } };
    const observer = dlqWith(dlq);

    const response = await observer.router.handle(
      post("/api/jobs/purge-dead", { idempotencyKey: "k-1" }),
    );

    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error?: string };
    expect(body.error).toMatch(/confirmation required/i);
  });

  it("does no work when it refuses", async () => {
    const dlq = { purged: false, async purge() { dlq.purged = true; } };
    const observer = dlqWith(dlq);

    await observer.router.handle(post("/api/jobs/purge-dead", { idempotencyKey: "k-2" }));

    // The property that matters: the guard is not just an audit note attached after
    // the fact. Refusing has to mean the work did not happen.
    expect(dlq.purged).toBe(false);
  });

  it("runs a purge that is confirmed and keyed", async () => {
    const dlq = { purged: false, async purge() { dlq.purged = true; } };
    const observer = dlqWith(dlq);

    const response = await observer.router.handle(
      post("/api/jobs/purge-dead", { idempotencyKey: "k-3", confirmed: true }),
    );

    expect(response?.status).toBe(200);
    expect(dlq.purged).toBe(true);
  });

  it("treats a repeated key as one action", async () => {
    const dlq = { purges: 0, async purge() { dlq.purges += 1; } };
    const observer = dlqWith(dlq);

    const body = { idempotencyKey: "k-4", confirmed: true };
    await observer.router.handle(post("/api/jobs/purge-dead", body));
    await observer.router.handle(post("/api/jobs/purge-dead", body));

    // The second response is the first one's, marked as deduplicated. Two purges would
    // be the failure mode a user hits by double-clicking.
    expect(dlq.purges).toBe(1);
  });

  it("guards replay, and passes the job id through", async () => {
    const dlq = {
      retried: [] as string[],
      async retry(id: string) { this.retried.push(id); },
    };
    const observer = dlqWith(dlq);

    const refused = await observer.router.handle(
      post("/api/jobs/replay-dead?id=job-7", { idempotencyKey: "k-5" }),
    );
    expect(refused?.status).toBe(400);
    expect(dlq.retried).toEqual([]);

    const allowed = await observer.router.handle(
      post("/api/jobs/replay-dead?id=job-7", { idempotencyKey: "k-6", confirmed: true }),
    );

    expect(allowed?.status).toBe(200);
    // Before the change this endpoint read the id itself; the guarded route takes it
    // from the payload, so an id that arrived as a query parameter still has to be
    // carried through.
    expect(dlq.retried).toEqual(["job-7"]);
  });

  it("guards the cache clear", async () => {
    const cache = { cleared: 0, async clear() { this.cleared += 1; return 5; } };
    const observer = cacheWith(cache);

    const refused = await observer.router.handle(post("/api/cache/clear", { idempotencyKey: "k-7" }));
    expect(refused?.status).toBe(400);
    expect(cache.cleared).toBe(0);

    const allowed = await observer.router.handle(
      post("/api/cache/clear", { idempotencyKey: "k-8", confirmed: true }),
    );
    expect(allowed?.status).toBe(200);
    expect(cache.cleared).toBe(1);
  });

  it("actually clears the cache on the guarded path", async () => {
    /*
     * The executor read `observer.cache`, which does not exist — so the guarded route
     * reported success while doing nothing, and the unguarded endpoint did the real
     * work. A guard that is the no-op and a bypass that is not is worse than neither.
     */
    const cache = { cleared: 0, async clear() { this.cleared += 1; return 2; } };
    const observer = cacheWith(cache);

    const response = await observer.router.handle(
      post("/api/cache/clear", { idempotencyKey: "k-9", confirmed: true }),
    );
    const body = (await response?.json()) as { result?: { cleared?: number } };

    expect(cache.cleared).toBe(1);
    expect(body.result?.cleared).toBe(2);
  });

  it("accepts a key from the query string when there is no body", async () => {
    const cache = { cleared: 0, async clear() { this.cleared += 1; return 1; } };
    const observer = cacheWith(cache);

    // So a `curl` is keyed rather than unguarded. Without a key at all it is refused,
    // which is the correct answer, but the parameter means a script need not send a
    // body to be safe.
    const response = await observer.router.handle(
      post("/api/cache/clear?key=k-10&confirmed=true"),
    );

    expect(response?.status).toBe(200);
    expect(cache.cleared).toBe(1);
  });
});

describe("Audit entries name a caller, or say plainly that they cannot", () => {
  it("records the actor the request declared", async () => {
    const observer = cacheWith({ async clear() { return 0; } });

    await observer.router.handle(
      post("/api/cache/clear", { idempotencyKey: "k-a", confirmed: true }, { "x-observe-actor": "ci/deploy" }),
    );

    const entries = observer.auditLogs.all();
    const last = entries[entries.length - 1]!;

    expect(last.actor).toBe("ci/deploy");
  });

  it("says unknown rather than inventing a person", async () => {
    const observer = cacheWith({ async clear() { return 0; } });

    await observer.router.handle(
      post("/api/cache/clear", { idempotencyKey: "k-b", confirmed: true }),
    );

    const entries = observer.auditLogs.all();

    // Every entry used to say `dashboard_operator`. The dashboard sits behind one
    // shared token, so the server cannot tell two holders apart, and a log where
    // everything says the same name cannot answer "who flushed the cache".
    expect(entries.every((entry) => entry.actor === "unknown (shared token)")).toBe(true);
  });

  it("reduces a declared actor to a short, printable label", async () => {
    const observer = cacheWith({ async clear() { return 0; } });

    // `\n` and NUL cannot be tested here: the Headers implementation refuses to build
    // a request with them, so they cannot reach this code over HTTP. A tab can, and
    // it is not in the allow-list.
    await observer.router.handle(
      post(
        "/api/cache/clear",
        { idempotencyKey: "k-c", confirmed: true },
        { "x-observe-actor": `ops\towner |${"x".repeat(200)}` },
      ),
    );

    const last = observer.auditLogs.all().at(-1)!;

    /*
     * The header is a self-declared label, not an identity, so it is reduced rather
     * than trusted: an allow-list keeps punctuation out of a record that other tools
     * read, and the bound keeps one call from writing a wall of text into the log.
     */
    // The tab and the pipe are gone; the rest is the allow-listed characters, cut at
    // the bound.
    expect(last.actor).toBe(`opsowner ${"x".repeat(64 - "opsowner ".length)}`);
    expect(last.actor.length).toBe(64);
  });
});

void work;