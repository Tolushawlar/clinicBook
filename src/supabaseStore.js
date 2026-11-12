import { createClient } from "@supabase/supabase-js";
import { BookingError } from "./errors.js";

export class SupabaseStore {
  constructor(client) {
    if (client) {
      this.supabase = client;
      return;
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error(
        "Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) in the environment."
      );
    }

    this.supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async reset(slots) {
    const { error } = await this.supabase.rpc("clinic_reset", { p_slots: slots });
    if (error) throw error;
  }

  async listSlots(provider) {
    const { data, error } = await this.supabase.rpc("clinic_list_slots", {
      p_provider: provider ?? null,
    });
    if (error) throw error;
    return data ?? [];
  }

  async book(payload, idempotencyKey) {
    const rawSlotId = payload?.slot_id;
    const rawName = payload?.name;
    const rawEmail = payload?.email;

    const fingerprint = JSON.stringify({
      slot_id: rawSlotId ?? null,
      name: rawName ?? null,
      email: rawEmail ?? null,
    });

    const { data, error } = await this.supabase.rpc("clinic_book", {
      p_slot_id: typeof rawSlotId === "string" ? rawSlotId : null,
      p_name: typeof rawName === "string" ? rawName : null,
      p_email: typeof rawEmail === "string" ? rawEmail : null,
      p_idempotency_key: idempotencyKey || null,
      p_fingerprint: fingerprint,
    });
    if (error) throw error;

    const headers = {};
    if (data?.retry_after != null) {
      headers["Retry-After"] = String(data.retry_after);
    }

    return { status: data.status, body: data.body, headers };
  }

  async getBooking(id) {
    const { data, error } = await this.supabase
      .from("clinic_bookings")
      .select("id, slot_id, name, email, status, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new BookingError(404, "booking not found");
    return data;
  }

  async cancelBooking(id) {
    const { data, error } = await this.supabase
      .from("clinic_bookings")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("status", "confirmed")
      .select("id, slot_id, name, email, status, created_at")
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    const { data: existing, error: lookupError } = await this.supabase
      .from("clinic_bookings")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!existing) throw new BookingError(404, "booking not found");
    throw new BookingError(409, "booking already cancelled");
  }

  async listBookings(email, rawLimit, rawCursor) {
    const limit = parseLimit(rawLimit);
    const cursor =
      rawCursor !== undefined && rawCursor !== "" ? decodeCursor(rawCursor) : null;

    const { data, error } = await this.supabase.rpc("clinic_list_bookings", {
      p_email: email,
      p_limit: limit,
      p_cursor_created_at: cursor?.created_at ?? null,
      p_cursor_id: cursor?.id ?? null,
    });
    if (error) throw error;

    return {
      bookings: data?.bookings ?? [],
      next_cursor: data?.next_cursor ?? null,
    };
  }
}

function parseLimit(raw) {
  if (raw === undefined) return 10;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new BookingError(400, "limit must be an integer between 1 and 50");
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new BookingError(400, "limit must be an integer between 1 and 50");
  }
  return limit;
}

function decodeCursor(raw) {
  if (typeof raw !== "string") throw new BookingError(400, "invalid cursor");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.created_at !== "string" || typeof parsed?.id !== "string") {
      throw new Error("invalid cursor shape");
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw new BookingError(400, "invalid cursor");
  }
}
