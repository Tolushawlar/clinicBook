# Clinic Booking Frontend

Standalone frontend for the Clinic Booking API. No build step and no dependencies.

## Run

```bash
# terminal 1: API (from the repo root)
npm run dev

# terminal 2: frontend
cd frontend
npm run dev
```

Open http://localhost:5173.

## Configure

Edit `config.js`:

```js
window.CLINIC_CONFIG = {
  apiBase: "http://localhost:3000",
  apiKey: "koya-booking-key-2026",
};
```

- `apiBase` - API origin (trailing slash optional)
- `apiKey` - value sent in the `X-API-Key` header

The API enables CORS, so the frontend can run on a different origin or port.

## Deploy to Vercel

1. Replace `YOUR-BACKEND.onrender.com` in `config.js` with your Render service URL.
2. Import the repo in Vercel and set **Root Directory** to `frontend`.
3. Framework Preset: **Other**. Build Command: empty. Output Directory: `.`.
4. Deploy. `vercel.json` already pins the static build settings.
5. On Render, set `CORS_ORIGIN` to the Vercel URL (no trailing slash) and redeploy the backend.

## Notes

- The API key is visible to the browser in this demo. For production, proxy API calls through a server and keep the key server-side.
- `npm run dev` uses the zero-dependency `serve.mjs` static server on port 5173. Set `PORT` to change it.
