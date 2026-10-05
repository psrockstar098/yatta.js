import { API, createAPI } from "../types/api";

const api = createAPI();

api.get(() => {
  return API.json({ ok: "yes" });
});

export default api;
