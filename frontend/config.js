const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

window.CLINIC_CONFIG = {
  apiBase: isLocal ? "http://localhost:3000" : "https://YOUR-BACKEND.onrender.com",
  apiKey: "koya-booking-key-2026",
};
