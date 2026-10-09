// yatta/func/realtime.ts
//
// WebSocket + SSE.
//
// The WebSocket upgrade handler is wired in main.ts. SSE is not: it is an HTTP
// response, so main.ts needs a route that returns it — `sseResponse()` below
// provides one and main.ts calls it for GET /realtime/sse.
import { createRealtime, sse } from "yatta.js/realtime";

export const realtime = createRealtime({
  handlers: {
    open(client) {
      console.log(`[realtime] connected: ${client.id}`);
    },
    message(client, event, data) {
      // Echo straight back for now.
      client.send(event, data);
    },
    close(client) {
      console.log(`[realtime] disconnected: ${client.id}`);
    },
  },
});

/**
 * GET /realtime/sse — a Server-Sent Events stream.
 *
 * Returns a live event source. Publish to a topic from anywhere and connected
 * browsers receive it:
 *
 *   realtime.publish("task.created", { taskId });
 *
 * The abort signal fires when the client disconnects, so anything started per
 * connection must be torn down there.
 */
export function sseResponse(req: Request): Response {
  return sse(req, (client) => {
    client.send("connected", { clientId: client.id });

    client.signal.addEventListener("abort", () => {
      console.log(`[realtime] sse disconnected: ${client.id}`);
    });
  });
}
