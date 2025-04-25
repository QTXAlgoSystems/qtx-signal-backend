const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

const ALLOWED_ORIGIN = "https://qtxalgosystems.com";

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json());
app.options("*", (req, res) => res.sendStatus(204));

const signals = new Map();

// Build a unique key: use non‐empty id, else symbol_timestamp
function getKey(payload) {
  const id = payload.id?.trim();
  const ts = payload.timestamp || new Date().toISOString();
  return id && id.length
    ? id
    : `${payload.symbol}_${ts}`;
}

app.post("/webhook", (req, res) => {
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;
  console.log("📩 Webhook Payload:", payload);

  // ensure entry timestamp exists
  if (!payload.timestamp) {
    payload.timestamp = new Date().toISOString();
  }

  const id = getKey(payload);
  const isEntry = !payload.tp1Hit && !payload.tp2Hit && !payload.slHit;
  console.log("🧠 Current signal keys:", Array.from(signals.keys()));

  if (isEntry) {
    // auto-close opposite trades on same symbol+timeframe
    for (const [key, sig] of signals.entries()) {
      const sameSym  = sig.symbol === payload.symbol;
      const sameTF   = sig.timeframe === payload.timeframe;
      const opposite = sig.direction !== payload.direction;
      const notClosed = !sig.slHit && !(sig.tp1Hit && sig.tp2Hit);

      if (sameSym && sameTF && opposite && notClosed) {
        sig.tp1Hit   = true;
        sig.tp2Hit   = true;
        sig.closedAt = payload.timestamp;
        console.log(`🔁 Auto-closed: ${key}`);
      }
    }

    // skip duplicate “Add” trades
    if (signals.has(id)) {
      console.log(`⚠️ Add trade skipped: ${id}`);
      return res.json({ success: true, message: "Add trade skipped" });
    }

    signals.set(id, payload);
    console.log(`✅ New entry stored: ${id}`);
    return res.json({ success: true });
  }

  // --- updates: TP1 / TP2 / SL ---
  const existing = signals.get(id);
  if (!existing) {
    console.warn(`⚠️ Unknown trade ID: ${id}`);
    return res.status(404).json({ error: "Trade not found" });
  }

  if (payload.tp1Hit) existing.tp1Hit = true;
  if (payload.tp2Hit) existing.tp2Hit = true;

  if (payload.slHit) {
    existing.slHit    = true;
    existing.closedAt = payload.timestamp;
  }

  // ensure we set closedAt once fully closed
  const fullyClosed = (existing.tp1Hit && existing.tp2Hit) || existing.slHit;
  if (fullyClosed && !existing.closedAt) {
    existing.closedAt = payload.timestamp;
    console.log(`✅ Trade closed: ${id}`);
  }

  console.log(`🔄 Trade updated: ${id}`);
  return res.json({ success: true });
});

app.get("/api/latest-signals", (req, res) => {
  const signalArray = Array.from(signals.values());
  console.log("📤 Returning", signalArray.length, "signals");
  res.json(signalArray);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
