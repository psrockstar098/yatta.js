import { createRealtime } from "../types/realtime";

// The auth engine is imported lazily, inside `authenticate`, not at module
// scope: importing it here pulled the whole auth chain (~260ms of import
// time, measured) into every process that touches realtime — including
// server startup, which imports this module before it serves anything.
// A realtime connection pays one cached dynamic import (~2µs); a server
// that never takes a realtime connection never pays the 260ms.
async function getAuth() {
  return (await import("./auth")).auth;
}

export const realtime = createRealtime<{ userId: string }>({
  /*
   * The default export used to configure no `authenticate` at all, so anyone
   * who could reach `/realtime` got a socket — WebSocket upgrade or SSE —
   * with no proof of who they were, and the echo handler below would talk
   * back to them. The engine only warns about a missing hook; it does not
   * refuse the connection. A Yatta session is the proof: `getSession`
   * accepts the session cookie or a bearer token, and returns null for an
   * unknown, expired or revoked one, which refuses the upgrade (SSE gets
   * 401). `autoRefresh` stays off — this decides who the request is, and a
   * failed refresh must not turn into a second chance at a session. A store
   * error fails closed the same way: no session, no socket.
   */
  authenticate: async (req) => {
    try {
      const auth = await getAuth();
      const session = await auth.getSession(req, { autoRefresh: false });
      return session ? { userId: session.user.id } : null;
    } catch {
      return null;
    }
  },

  handlers: {
    open(client) {
      console.log(`[realtime] Client connected: ${client.id}`);
    },

    message(client, event, data) {
      client.send(event, data);
    },

    close(client) {
      console.log(`[realtime] Client disconnected: ${client.id}`);
    },
  },
});
