import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

/*
 * The default realtime export used to configure no `authenticate` at all, so
 * anyone who could reach `/realtime` got a socket — WebSocket upgrade or
 * SSE — with no proof of who they were. These tests pin the fix at the
 * exported object: a request without a live Yatta session is refused, and
 * one with a session upgrades carrying that user's id.
 *
 * The import is dynamic and the database path is a throwaway file, because
 * importing `../func/realtime` pulls in the app's SQLite-backed auth, and
 * pointing that at the real `Database/app.db` from a test would be data
 * corruption dressed as coverage.
 */

const DB_PATH = join(tmpdir(), `yatta-realtime-auth-${Date.now()}.db`);

// The throwaway values are only for the dynamic import below: importing
// `../func/realtime` pulls in the app's SQLite-backed auth, whose database
// is opened once at module load from DATABASE_URL. They are restored
// immediately after the import — leaving them set leaks into every other
// test file in the same `bun test` process (process.env is shared), and
// a stale DATABASE_URL pointing at a deleted temp file broke
// `yatta db:backup` / `db:restore` tests in full-suite runs.
const savedEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NODE_ENV: process.env.NODE_ENV,
};

let realtime: typeof import("../func/realtime").realtime;
let auth: typeof import("../func/auth").auth;

beforeAll(async () => {
  process.env.DATABASE_URL = DB_PATH;
  process.env.AUTH_SECRET = "test-only-realtime-auth-secret-32-chars-min";
  process.env.NODE_ENV = "test";
  ({ realtime } = await import("../func/realtime"));
  ({ auth } = await import("../func/auth"));
  // The singletons above captured the throwaway config at construction
  // (the database connection is opened at import); the environment goes
  // back now so no other test file ever sees it.
  if (savedEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  if (savedEnv.AUTH_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedEnv.AUTH_SECRET;
  if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv.NODE_ENV;
});

afterAll(() => {
  try {
    unlinkSync(DB_PATH);
  } catch {
    // Already gone, or never created.
  }
  try {
    unlinkSync(`${DB_PATH}-wal`);
  } catch {
    // No WAL file.
  }
  try {
    unlinkSync(`${DB_PATH}-shm`);
  } catch {
    // No SHM file.
  }
});

async function signedInCookie(): Promise<{ cookie: string; userId: string }> {
  const email = `rt-${Date.now()}-${Math.random()}@t.dev`;
  const signedUp = await auth.signUp({ email, password: "Password123!" });
  const userId = "user" in signedUp ? signedUp.user.id : "";
  // The app's auth refuses sign-in until the email is verified; the
  // verification email goes to the terminal mailer here, so mark it
  // verified directly instead of chasing the link.
  await auth.store.updateUser(userId, { emailVerified: true });
  const result = await auth.signIn({ email, password: "Password123!" });
  const accessToken = (result as { tokens: { accessToken: string } }).tokens.accessToken;
  return { cookie: `yatta_session=${accessToken}`, userId: "user" in result ? result.user.id : "" };
}

/** A stand-in for Bun.Server: records the upgrade instead of doing one. */
function stubServer() {
  const calls: Array<{ req: Request; data: unknown }> = [];
  return {
    calls,
    server: {
      upgrade(req: Request, opts: { data: unknown }) {
        calls.push({ req, data: opts.data });
        return true;
      },
    } as never,
  };
}

describe("default realtime export requires a session", () => {
  it("refuses a WebSocket upgrade with no session", async () => {
    const { server, calls } = stubServer();
    const ok = await realtime.upgrade(
      new Request("http://localhost/realtime", {
        headers: { upgrade: "websocket", connection: "upgrade" },
      }),
      server,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses a WebSocket upgrade with a bogus session cookie", async () => {
    const { server, calls } = stubServer();
    const ok = await realtime.upgrade(
      new Request("http://localhost/realtime", {
        headers: {
          upgrade: "websocket",
          connection: "upgrade",
          cookie: "yatta_session=not-a-real-token",
        },
      }),
      server,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("upgrades a signed-in caller and carries their user id", async () => {
    const { cookie, userId } = await signedInCookie();
    const { server, calls } = stubServer();
    const ok = await realtime.upgrade(
      new Request("http://localhost/realtime", {
        headers: { upgrade: "websocket", connection: "upgrade", cookie },
      }),
      server,
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.data as { userId: string }).userId).toBe(userId);
  });

  it("answers 401 to an unauthenticated SSE connect", async () => {
    const { server } = stubServer();
    const res = await realtime.connect(
      new Request("http://localhost/realtime", {
        headers: { accept: "text/event-stream" },
      }),
      server,
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it("opens an SSE stream for a signed-in caller", async () => {
    const { cookie } = await signedInCookie();
    const { server } = stubServer();
    const res = await realtime.connect(
      new Request("http://localhost/realtime", {
        headers: { accept: "text/event-stream", cookie },
      }),
      server,
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
    // Don't leave the stream open: it would hold the test process.
    await (res as Response).body?.cancel();
  });
});
