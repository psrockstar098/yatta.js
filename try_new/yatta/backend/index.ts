// yatta/backend/index.ts — this file serves GET /
import { API, createAPI } from "yatta.js/api";

const api = createAPI();

api.get(async () => {
  return API.json({
    ok: true,
    message: "Edit yatta/backend/ to add your routes.",
  });
});

export default api;
