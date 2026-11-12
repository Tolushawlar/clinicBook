const API_KEY = window.__API_KEY__;

const state = {
  slots: [],
  selected: null,
  cursor: null,
  lookupEmail: null,
};

const els = {
  refreshSlots: document.getElementById("refresh-slots"),
  slotsStatus: document.getElementById("slots-status"),
  slotList: document.getElementById("slot-list"),
  form: document.getElementById("booking-form"),
  selectedSlot: document.getElementById("selected-slot"),
  name: document.getElementById("name"),
  email: document.getElementById("email"),
  formError: document.getElementById("form-error"),
  confirmation: document.getElementById("confirmation"),
  confirmationDetails: document.getElementById("confirmation-details"),
  lookupForm: document.getElementById("lookup-form"),
  lookupEmail: document.getElementById("lookup-email"),
  lookupError: document.getElementById("lookup-error"),
  bookingsList: document.getElementById("bookings-list"),
  loadMore: document.getElementById("load-more"),
  apiNote: document.getElementById("api-note"),
};

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const createdFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatSlot(slot) {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (Number.isNaN(start.getTime())) return `${slot.start} – ${slot.end}`;
  return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}

function formatCreated(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : createdFmt.format(date);
}

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function api(path, options = {}) {
  const headers = {
    "X-API-Key": API_KEY,
    "ngrok-skip-browser-warning": "true",
    ...(options.headers || {}),
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function showLookupError(message) {
  els.lookupError.textContent = message;
  els.lookupError.hidden = false;
}

async function loadSlots() {
  els.slotsStatus.hidden = false;
  els.slotsStatus.textContent = "Loading slots…";
  try {
    const data = await api("/slots");
    state.slots = data.slots ?? [];
    renderSlots();
  } catch (err) {
    state.slots = [];
    els.slotList.innerHTML = "";
    els.slotsStatus.hidden = false;
    els.slotsStatus.textContent = err.message;
  }
}

function renderSlots() {
  els.slotList.innerHTML = "";

  if (!state.slots.length) {
    els.slotsStatus.hidden = false;
    els.slotsStatus.textContent = "No slots available right now.";
    return;
  }

  els.slotsStatus.hidden = true;

  for (const slot of state.slots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.disabled = !slot.available;
    if (state.selected?.id === slot.id) button.classList.add("selected");

    const main = document.createElement("span");
    main.className = "slot-main";

    const provider = document.createElement("span");
    provider.className = "slot-provider";
    provider.textContent = slot.provider ?? "Provider";

    const time = document.createElement("span");
    time.className = "slot-time";
    time.textContent = formatSlot(slot);

    main.append(provider, time);

    const badge = document.createElement("span");
    badge.className = `badge ${slot.available ? "available" : "booked"}`;
    badge.textContent = slot.available ? "Available" : "Booked";

    button.append(main, badge);
    button.addEventListener("click", () => selectSlot(slot));
    els.slotList.append(button);
  }
}

function selectSlot(slot) {
  if (!slot.available) return;
  state.selected = slot;
  els.selectedSlot.textContent = `${slot.provider ?? "Provider"} — ${formatSlot(slot)}`;
  els.formError.hidden = true;
  els.confirmation.hidden = true;
  renderSlots();
}

function showConfirmation(booking) {
  const slot = state.slots.find((item) => item.id === booking.slot_id);

  els.confirmationDetails.innerHTML = "";
  const rows = [
    ["Booking ID", booking.id],
    ["Name", booking.name],
    ["Email", booking.email],
    ["Slot", slot ? `${slot.provider ?? "Provider"} — ${formatSlot(slot)}` : booking.slot_id],
    ["Status", booking.status],
  ];

  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    els.confirmationDetails.append(dt, dd);
  }

  els.confirmation.hidden = false;
  els.confirmation.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadBookings(email, { reset = false } = {}) {
  if (!email) return;

  if (reset) {
    state.cursor = null;
    state.lookupEmail = email;
    els.bookingsList.innerHTML = "";
    els.loadMore.hidden = true;
    els.lookupError.hidden = true;
  }

  const params = new URLSearchParams({ email, limit: "10" });
  if (state.cursor) params.set("cursor", state.cursor);

  try {
    const data = await api(`/bookings?${params.toString()}`);

    for (const booking of data.bookings) {
      els.bookingsList.append(renderBookingRow(booking));
    }

    state.cursor = data.next_cursor;
    els.loadMore.hidden = !data.next_cursor;

    if (!els.bookingsList.children.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No bookings found for that email.";
      els.bookingsList.append(empty);
    }
  } catch (err) {
    showLookupError(err.message);
  }
}

function renderBookingRow(booking) {
  const row = document.createElement("li");
  row.className = "booking-row";

  const info = document.createElement("div");
  info.className = "booking-info";

  const slot = state.slots.find((item) => item.id === booking.slot_id);

  const title = document.createElement("span");
  title.className = "booking-title";
  title.textContent = slot
    ? `${slot.provider ?? "Provider"} — ${formatSlot(slot)}`
    : `Slot ${booking.slot_id}`;

  const meta = document.createElement("span");
  meta.className = "booking-meta";
  meta.textContent = `${booking.name} · ${booking.email} · ${formatCreated(booking.created_at)}`;

  const idLine = document.createElement("span");
  idLine.className = "booking-meta";
  idLine.textContent = `ID: ${booking.id}`;

  info.append(title, meta, idLine);

  const actions = document.createElement("div");
  actions.className = "booking-actions";

  const badge = document.createElement("span");
  badge.className = `badge ${booking.status === "confirmed" ? "available" : "cancelled"}`;
  badge.textContent = booking.status === "confirmed" ? "Confirmed" : "Cancelled";
  actions.append(badge);

  if (booking.status === "confirmed") {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn danger small";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => cancelBooking(booking, cancelButton));
    actions.append(cancelButton);
  }

  row.append(info, actions);
  return row;
}

async function cancelBooking(booking, button) {
  if (!window.confirm("Cancel this appointment?")) return;
  button.disabled = true;

  try {
    await api(`/bookings/${encodeURIComponent(booking.id)}`, { method: "DELETE" });
    await loadSlots();
    await loadBookings(state.lookupEmail, { reset: true });
  } catch (err) {
    showLookupError(err.message);
    button.disabled = false;
  }
}

els.refreshSlots.addEventListener("click", loadSlots);

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.formError.hidden = true;

  const name = els.name.value.trim();
  const email = els.email.value.trim();

  if (!state.selected) return showFormError("Pick an available slot first.");
  if (!name) return showFormError("Enter your name.");
  if (!email) return showFormError("Enter your email.");

  const submitButton = els.form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Booking…";

  try {
    const booking = await api("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": newIdempotencyKey() },
      body: JSON.stringify({ slot_id: state.selected.id, name, email }),
    });

    showConfirmation(booking);
    els.lookupEmail.value = booking.email;
    state.selected = null;
    els.selectedSlot.textContent = "No slot selected yet.";
    await loadSlots();
    await loadBookings(booking.email, { reset: true });
  } catch (err) {
    showFormError(err.message);
    if (err.status === 409) {
      state.selected = null;
      els.selectedSlot.textContent = "No slot selected yet.";
      await loadSlots();
    }
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Book appointment";
  }
});

els.lookupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = els.lookupEmail.value.trim();
  if (!email) return showLookupError("Enter an email address.");
  loadBookings(email, { reset: true });
});

els.loadMore.addEventListener("click", () => {
  if (state.lookupEmail) loadBookings(state.lookupEmail);
});

if (!API_KEY) {
  els.apiNote.textContent = "API key missing";
}

loadSlots();
