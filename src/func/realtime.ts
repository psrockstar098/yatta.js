import { createRealtime } from "../types/realtime";

export const realtime = createRealtime({
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
