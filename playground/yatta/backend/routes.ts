// yatta/backend/routes.ts
//
// The API entry point.
//
// Everything under /api is served from here. Each feature is a file that
// exports an API instance; mount it below and it keeps its own middleware,
// validation and error handling.
//
//   yatta/backend/health.ts   ->  /api/health
//   yatta/backend/users.ts    ->  /api/users, /api/users/:id

import { createAPI } from "yatta.js/api";
import { observer } from "../func/observe";
import auth from "./auth";
import health from "./health";

const api = createAPI("/api");

// CORS first, so a preflight never reaches a handler.
api.cors({
  origin: (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(","),
  credentials: true,
});

// Mount a feature router. Add a line per feature file.
api.mount("/health", health);

// Auth ships mounted so signup and signin work on a fresh project.
api.mount("/auth", auth);

// Add your own routes here, or create yatta/backend/users.ts and mount it.
// api.mount("/users", users);

/*
 * Telemetry aliases.
 *
 * The observer answers /_yatta/** itself, ahead of this router. These proxy
 * through it so a client that only knows /api can still read telemetry, and so
 * the numbers match the dashboard exactly rather than being recomputed here.
 */
api.get("/telemetry", async (ctx) => {
  const res = await observer.router.handle(
    new Request(new URL("/_yatta/api/telemetry", ctx.req.url)),
  );
  return res ?? Response.json({ error: "unavailable" }, { status: 503 });
});

api.get("/issues", async (ctx) => {
  const res = await observer.router.handle(
    new Request(new URL("/_yatta/api/errors", ctx.req.url)),
  );
  return res ?? Response.json({ error: "unavailable" }, { status: 503 });
});

/**
 * Every throw lands in one place, in one shape, and is captured by the
 * observer with the request and trace attached.
 *
 * The status is read structurally rather than with `instanceof HttpError`,
 * because auth, db and jobs each define their own error base class — an
 * UnauthorizedError carrying status 401 would otherwise come back as a 500.
 */
api.onError((error, ctx) => {
  observer.errors.capture(error, { request: ctx.req });

  const carried = (error as { status?: unknown }).status;
  const status =
    typeof carried === "number" &&
    Number.isInteger(carried) &&
    carried >= 400 &&
    carried <= 599
      ? carried
      : 500;

  return Response.json(
    {
      error:
        status === 500 && process.env.NODE_ENV === "production"
          ? "Internal Server Error"
          : (error as Error).message,
    },
    { status },
  );
});

export default api;
