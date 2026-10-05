import { API, createAPI } from "../../types/api";

const api = createAPI();

api.get(() => {
  return API.json({ user: "yes" });
});

export default api;
