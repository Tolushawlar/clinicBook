# Clinic Booking API

A Node/Express booking API implementing all five levels of the Koya clinic booking spec, plus a small web page for patients. Data is stored in Supabase (Postgres).

## Quick start

```bash
npm install
cp .env.example .env      # API_KEY, PORT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# apply supabase/migrations/0001_clinic_booking.sql (see Database setup)
npm run seed              # optional: write 20 demo slots to Supabase (no server needed)
npm start                 # http://localhost:3000
npm test                  # 21 integration tests (levels 1-5)
```

Open http://localhost:3000 for the built-in web page.

## Separate frontend

A standalone frontend lives in `frontend/` (no build step, no dependencies) and calls the API over HTTP.

```bash
# terminal 1: API
npm run dev

# terminal 2: frontend
cd frontend
npm run dev   # http://localhost:5173
```

Edit `frontend/config.js` to change `apiBase` or `apiKey`. The built-in page served by the API at `/` remains available.

## Environment

| Variable                      | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `API_KEY`                   | Value required in the `X-API-Key` header                         |
| `PORT`                      | HTTP port (default `3000`)                                       |
| `SUPABASE_URL`              | Supabase project URL                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side key (bypasses RLS; never expose it)                    |
| `SUPABASE_ANON_KEY`         | Optional fallback key                                              |
| `CORS_ORIGIN`               | Optional comma-separated allowed browser origins; unset allows all |

The local API key default is `koya-booking-key-2026`.

## Database setup

The app uses dedicated `clinic_*` tables and Postgres functions, so it can share a Supabase project without touching other tables.

Apply the migration once:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_clinic_booking.sql
```

Or paste `supabase/migrations/0001_clinic_booking.sql` into the Supabase SQL editor.

It creates:

- `clinic_slots` - appointment slots
- `clinic_bookings` - bookings (`confirmed` / `cancelled`)
- `clinic_idempotency` - stored responses keyed by `Idempotency-Key`
- `clinic_attempts` - per-email rate-limit attempts
- `clinic_reset`, `clinic_list_slots`, `clinic_book`, `clinic_list_bookings` functions

RLS is enabled on the tables and only the service role is granted access.

## Endpoints

| Method | Path                 | Level | Notes                                               |
| ------ | -------------------- | ----- | --------------------------------------------------- |
| POST   | `/reset`           | 1     | Replace all slots and delete all bookings           |
| GET    | `/slots`           | 1     | Earliest first; optional `?provider=` exact match |
| POST   | `/bookings`        | 1-5   | Book a slot                                         |
| GET    | `/bookings/:id`    | 1     | Look up one booking                                 |
| DELETE | `/bookings/:id`    | 3     | Cancel (sets `cancelled`, frees slot)             |
| GET    | `/bookings?email=` | 4     | Cursor pagination (`limit` 1-50, default 10)      |

### Booking request

```bash
curl -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: koya-booking-key-2026' \
  -H 'Idempotency-Key: 7c1f2a' \
  -d '{"slot_id":"s1","name":"Ada Obi","email":"ada@example.com"}'
```

## How each level is handled

- **Level 1** - `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/:id`.
- **Level 2** - `X-API-Key` checked on every API route; missing/wrong returns `401`. Fields are validated in Postgres, name/email trimmed, email lower-cased, unknown slots return `404`, started slots return `400`.
- **Level 3** - A partial unique index (`slot_id` where `status = 'confirmed'`) makes the database reject a second confirmed booking for a slot. Concurrent requests produce exactly one `201` and the rest `409`. Cancelling flips the status, so the partial index frees the slot automatically.
- **Level 4** - `Idempotency-Key` is serialized with a Postgres advisory lock; the stored response is replayed for the same body and `422` is returned if the body changes. `GET /bookings` uses an opaque base64url cursor over `(created_at, id)`, oldest first.
- **Level 5** - At most 5 booking attempts per email per rolling 60 seconds, including failed attempts, enforced in `clinic_book` with a per-email advisory lock. The 6th returns `429` with `Retry-After` in whole seconds. Other emails are unaffected.

## Data storage

All state lives in Supabase Postgres, so it survives process restarts and works across instances. `/reset` is the supported way to set up slots for tests; it clears the `clinic_*` tables only.

## Deploy backend on Render

1. Push this folder to GitHub.
2. In Render, create a **New > Blueprint** and connect the repo. Render reads `render.yaml` and builds the `Dockerfile`.
3. Set these environment variables in Render:
   - `API_KEY` - the key clients must send
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `CORS_ORIGIN` - your Vercel URL, e.g. `https://clinic-booking.vercel.app` (optional; unset allows all origins)
4. Apply the Supabase migration once (see Database setup).
5. Deploy and copy the service URL, e.g. `https://clinic-booking-api.onrender.com`.

The built-in page at `/` and the API are served by the same Render service. Render injects `PORT`; do not hardcode it.

**Railway / Fly / any Docker host:**

```bash
docker build -t clinic-booking-api .
docker run -p 3000:3000 \
  -e API_KEY=your-key \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  clinic-booking-api
```

## Deploy frontend on Vercel

The frontend is a static site in `frontend/` with no build step.

1. Edit `frontend/config.js` and replace `YOUR-BACKEND.onrender.com` with your Render service URL:
   ```js
   apiBase: isLocal ? "http://localhost:3000" : "https://clinic-booking-api.onrender.com",
   ```

   Keep the API key in sync with the `API_KEY` value on Render.
2. Push the repo to GitHub.
3. In Vercel, **Add New > Project** and import the repo.
4. Set **Root Directory** to `frontend`.
5. Framework Preset: **Other**. Build Command: leave empty (or `echo 'no build step'`). Output Directory: `.`.
6. Deploy. Vercel serves `index.html` at the project URL.
7. Set `CORS_ORIGIN` on Render to the Vercel URL (no trailing slash) and redeploy the backend.

`frontend/vercel.json` already pins the build command and output directory.
