import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BookingError } from "./errors.js";
import { SupabaseStore } from "./supabaseStore.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function createApp(store = new SupabaseStore()) {
  const app = express();
  const apiKey = process.env.API_KEY || "koya-booking-key-2026";

  app.disable("x-powered-by");
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(
    cors(
      corsOrigin
        ? { origin: corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean) }
        : {}
    )
  );
  app.use(express.json());

  app.get("/config.js", (req, res) => {
    res.type("application/javascript");
    res.send(`window.__API_KEY__ = ${JSON.stringify(apiKey)};`);
  });

  app.use(express.static(publicDir));

  const requireApiKey = (req, res, next) => {
    if (req.get("X-API-Key") !== apiKey) {
      return res.status(401).json({ error: "missing or invalid API key" });
    }
    next();
  };

  app.use(requireApiKey);

  app.post(
    "/reset",
    asyncHandler(async (req, res) => {
      const slots = req.body?.slots;
      if (!Array.isArray(slots)) {
        throw new BookingError(400, "slots must be an array");
      }
      await store.reset(slots);
      res.status(200).json({ status: "ok" });
    })
  );

  app.get(
    "/slots",
    asyncHandler(async (req, res) => {
      const provider =
        typeof req.query.provider === "string" ? req.query.provider : undefined;
      const slots = await store.listSlots(provider);
      res.json({ slots });
    })
  );

  app.post(
    "/bookings",
    asyncHandler(async (req, res) => {
      const idempotencyKey = req.get("Idempotency-Key") || null;
      const result = await store.book(req.body ?? {}, idempotencyKey);
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        res.setHeader(name, value);
      }
      res.status(result.status).json(result.body);
    })
  );

  app.get(
    "/bookings",
    asyncHandler(async (req, res) => {
      const { email } = req.query;
      if (typeof email !== "string" || email.trim() === "") {
        throw new BookingError(400, "email is required");
      }
      const result = await store.listBookings(email, req.query.limit, req.query.cursor);
      res.json(result);
    })
  );

  app.get(
    "/bookings/:id",
    asyncHandler(async (req, res) => {
      res.json(await store.getBooking(req.params.id));
    })
  );

  app.delete(
    "/bookings/:id",
    asyncHandler(async (req, res) => {
      res.json(await store.cancelBooking(req.params.id));
    })
  );

  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err, req, res, next) => {
    if (err instanceof BookingError) {
      for (const [name, value] of Object.entries(err.headers ?? {})) {
        res.setHeader(name, value);
      }
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return res.status(400).json({ error: "invalid JSON body" });
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
