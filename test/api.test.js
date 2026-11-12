import "dotenv/config";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { SupabaseStore } from "../src/supabaseStore.js";

const API_KEY = "test-key";
process.env.API_KEY = API_KEY;

const store = new SupabaseStore();
const app = createApp(store);

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function isoIn(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function makeSlots(count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    provider: i % 2 === 0 ? "Dr Ade" : "Dr Bello",
    start: isoIn(60 + i * 30),
    end: isoIn(90 + i * 30),
  }));
}

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "X-API-Key": API_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { res, status: res.status, data };
}

async function resetWith(slots) {
  const { status } = await call("POST", "/reset", { body: { slots } });
  assert.equal(status, 200);
}

beforeEach(async () => {
  await resetWith(makeSlots());
});

test("L1: lists slots earliest first with availability", async () => {
  const { status, data } = await call("GET", "/slots");
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.slots));
  assert.equal(data.slots.length, 8);

  for (let i = 1; i < data.slots.length; i++) {
    assert.ok(Date.parse(data.slots[i - 1].start) <= Date.parse(data.slots[i].start));
  }
  assert.ok(data.slots.every((slot) => slot.available === true));
});

test("L1: provider filter is exact", async () => {
  const { data } = await call("GET", `/slots?provider=${encodeURIComponent("Dr Ade")}`);
  assert.ok(data.slots.length > 0);
  assert.ok(data.slots.every((slot) => slot.provider === "Dr Ade"));
});

test("L1: books a slot and looks it up", async () => {
  const created = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.slot_id, "s1");
  assert.equal(created.data.status, "confirmed");
  assert.ok(created.data.id);
  assert.ok(!Number.isNaN(Date.parse(created.data.created_at)));

  const got = await call("GET", `/bookings/${created.data.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.id, created.data.id);
  assert.equal(got.data.slot_id, "s1");

  const slots = await call("GET", "/slots");
  assert.equal(slots.data.slots.find((slot) => slot.id === "s1").available, false);
});

test("L1: unknown booking is 404", async () => {
  const { status, data } = await call("GET", "/bookings/does-not-exist");
  assert.equal(status, 404);
  assert.equal(typeof data.error, "string");
});

test("L1: reset replaces slots and clears bookings", async () => {
  await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Ada", email: "ada@example.com" },
  });

  await resetWith([{ id: "x", provider: "Dr New", start: isoIn(30), end: isoIn(60) }]);

  const slots = await call("GET", "/slots");
  assert.equal(slots.data.slots.length, 1);
  assert.equal(slots.data.slots[0].id, "x");

  const list = await call("GET", "/bookings?email=ada%40example.com");
  assert.equal(list.data.bookings.length, 0);
});

test("L2: missing or wrong API key is 401", async () => {
  const noKey = await fetch(base + "/slots");
  assert.equal(noKey.status, 401);
  assert.equal(typeof (await noKey.json()).error, "string");

  const wrongKey = await fetch(base + "/slots", { headers: { "X-API-Key": "wrong" } });
  assert.equal(wrongKey.status, 401);
  assert.equal(typeof (await wrongKey.json()).error, "string");
});

test("L2: rejects missing, empty and invalid fields", async () => {
  const cases = [
    {},
    { slot_id: "s1", name: "Ada" },
    { slot_id: "s1", name: "", email: "a@b.com" },
    { slot_id: "s1", name: "   ", email: "a@b.com" },
    { slot_id: "s1", name: "Ada", email: "not-an-email" },
    { name: "Ada", email: "a@b.com" },
  ];

  for (const body of cases) {
    const { status, data } = await call("POST", "/bookings", { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(typeof data.error, "string");
  }
});

test("L2: unknown slot is 404", async () => {
  const { status } = await call("POST", "/bookings", {
    body: { slot_id: "nope", name: "Ada", email: "ada@example.com" },
  });
  assert.equal(status, 404);
});

test("L2: slot that already started is 400", async () => {
  await resetWith([{ id: "past", provider: "Dr Ade", start: isoIn(-60), end: isoIn(-30) }]);

  const { status, data } = await call("POST", "/bookings", {
    body: { slot_id: "past", name: "Ada", email: "ada@example.com" },
  });
  assert.equal(status, 400);
  assert.match(data.error, /started/i);
});

test("L2: trims name and lowercases email", async () => {
  const { status, data } = await call("POST", "/bookings", {
    body: { slot_id: "s2", name: "  Ada Obi  ", email: "  ADA@Example.COM  " },
  });
  assert.equal(status, 201);
  assert.equal(data.name, "Ada Obi");
  assert.equal(data.email, "ada@example.com");
});

test("L2: invalid JSON body is 400", async () => {
  const res = await fetch(base + "/bookings", {
    method: "POST",
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("L3: second booking for the same slot is 409", async () => {
  const first = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Ada", email: "ada@example.com" },
  });
  assert.equal(first.status, 201);

  const second = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Bola", email: "bola@example.com" },
  });
  assert.equal(second.status, 409);
});

test("L3: concurrent bookings, exactly one wins", async () => {
  await resetWith([{ id: "only", provider: "Dr Ade", start: isoIn(60), end: isoIn(90) }]);

  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      call("POST", "/bookings", {
        body: { slot_id: "only", name: `Patient ${i}`, email: `patient${i}@example.com` },
      })
    )
  );

  const created = results.filter((result) => result.status === 201);
  const conflicts = results.filter((result) => result.status === 409);
  assert.equal(created.length, 1);
  assert.equal(conflicts.length, 24);

  const list = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(created[0].data.email)}`
  );
  assert.equal(list.data.bookings.length, 1);
});

test("L3: cancelling frees the slot and can be rebooked", async () => {
  const first = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Ada", email: "ada@example.com" },
  });
  const id = first.data.id;

  const cancelled = await call("DELETE", `/bookings/${id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, "cancelled");

  const slots = await call("GET", "/slots");
  assert.equal(slots.data.slots.find((slot) => slot.id === "s1").available, true);

  const rebook = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Bola", email: "bola@example.com" },
  });
  assert.equal(rebook.status, 201);

  const again = await call("DELETE", `/bookings/${id}`);
  assert.equal(again.status, 409);

  const missing = await call("DELETE", "/bookings/does-not-exist");
  assert.equal(missing.status, 404);
});

test("L4: idempotent retry returns the same booking with no duplicate", async () => {
  const body = { slot_id: "s1", name: "Ada", email: "ada@example.com" };
  const headers = { "Idempotency-Key": "idem-retry-1" };

  const first = await call("POST", "/bookings", { body, headers });
  const second = await call("POST", "/bookings", { body, headers });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.data.id, first.data.id);

  const list = await call("GET", `/bookings?email=${encodeURIComponent(body.email)}`);
  assert.equal(list.data.bookings.length, 1);
});

test("L4: same idempotency key with a different body is 422", async () => {
  const headers = { "Idempotency-Key": "idem-conflict-1" };

  const first = await call("POST", "/bookings", {
    headers,
    body: { slot_id: "s1", name: "Ada", email: "ada@example.com" },
  });
  assert.equal(first.status, 201);

  const second = await call("POST", "/bookings", {
    headers,
    body: { slot_id: "s2", name: "Ada", email: "ada@example.com" },
  });
  assert.equal(second.status, 422);
});

test("L4: cursor pagination returns oldest first", async () => {
  const email = "page@example.com";
  for (let i = 1; i <= 5; i++) {
    const result = await call("POST", "/bookings", {
      body: { slot_id: `s${i}`, name: "Page", email },
    });
    assert.equal(result.status, 201);
  }

  const seen = [];
  let cursor = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ email, limit: "2" });
    if (cursor) params.set("cursor", cursor);
    const { status, data } = await call("GET", `/bookings?${params.toString()}`);
    assert.equal(status, 200);
    seen.push(...data.bookings);
    cursor = data.next_cursor;
    pages++;
    assert.ok(pages < 10, "pagination did not terminate");
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen.map((booking) => booking.id)).size, 5);

  for (let i = 1; i < seen.length; i++) {
    const prev = seen[i - 1];
    const curr = seen[i];
    const ordered =
      prev.created_at < curr.created_at ||
      (prev.created_at === curr.created_at && prev.id <= curr.id);
    assert.ok(ordered, "bookings were not returned oldest first");
  }
});

test("L4: email lookup ignores case", async () => {
  await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Ada", email: "ada@example.com" },
  });

  const { status, data } = await call(
    "GET",
    `/bookings?email=${encodeURIComponent("ADA@EXAMPLE.COM")}`
  );
  assert.equal(status, 200);
  assert.equal(data.bookings.length, 1);
});

test("L4: invalid limit is 400", async () => {
  for (const limit of ["0", "51", "abc", "2.5", "-1"]) {
    const { status } = await call(
      "GET",
      `/bookings?email=a%40b.com&limit=${encodeURIComponent(limit)}`
    );
    assert.equal(status, 400, `limit=${limit}`);
  }
});

test("L4: email is required for listing", async () => {
  const { status } = await call("GET", "/bookings");
  assert.equal(status, 400);
});

test("L5: sixth attempt in a minute is 429 with Retry-After", async () => {
  const email = "spam@example.com";

  for (let i = 0; i < 5; i++) {
    const { status } = await call("POST", "/bookings", {
      body: { slot_id: "nope", name: "Spam", email },
    });
    assert.equal(status, 404, `attempt ${i + 1} should be processed`);
  }

  const sixth = await call("POST", "/bookings", {
    body: { slot_id: "nope", name: "Spam", email },
  });
  assert.equal(sixth.status, 429);

  const retryAfter = sixth.res.headers.get("retry-after");
  assert.ok(retryAfter);
  assert.match(retryAfter, /^\d+$/);
  assert.ok(Number(retryAfter) >= 1);

  const other = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "Other", email: "other@example.com" },
  });
  assert.equal(other.status, 201);
});
