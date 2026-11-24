import { createRealtime } from "../types/realtime";
import { auth } from "./auth";

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
