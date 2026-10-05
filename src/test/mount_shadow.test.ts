// Two routers mounted at the same prefix, with different methods on one path.
import { describe, it, expect } from "bun:test";
import { API, createAPI } from "../types/api";

describe("API — mounts sharing a prefix", () => {
  it("does not let an earlier mount shadow a later one", async () => {
    const comments = createAPI();
    comments.get("/tasks/:taskId/comments", () => new Response("read"));
    comments.post("/tasks/:taskId/comments", () => new Response("write"));

    const tasks = createAPI();
    // The same path pattern, registered first.
    tasks.get("/tasks/:taskId/comments", () => new Response("also read"));

    const root = createAPI("/api");
    root.mount("", tasks);
    root.mount("", comments);

    const post = await root.handle(
      new Request("http://x/api/tasks/abc/comments", { method: "POST" }),
    );
    // The first mount has a route for this path but not for POST. It used to
    // claim the request and answer 405, so the comment could never be created.
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("write");

    const get = await root.handle(new Request("http://x/api/tasks/abc/comments"));
    expect(get.status).toBe(200);
  });

  it("still answers 405 with an Allow header for a verb nobody has", async () => {
    const child = createAPI();
    child.get("/things", () => new Response("ok"));
    child.delete("/things", () => new Response("gone"));

    const other = createAPI();
    other.post("/things", () => new Response("made"));

    const root = createAPI("/api");
    root.mount("", child);
    root.mount("", other);

    const put = await root.handle(
      new Request("http://x/api/things", { method: "PUT" }),
    );
    expect(put.status).toBe(405);
    const allow = put.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("DELETE");
    expect(allow).toContain("POST");
  });

  it("404s a path no mount knows", async () => {
    const child = createAPI();
    child.get("/known", () => new Response("ok"));
    const root = createAPI("/api");
    root.mount("", child);

    const res = await root.handle(new Request("http://x/api/unknown"));
    expect(res.status).toBe(404);
  });
});
