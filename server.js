const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000; // Use the environment port
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

const ALLOWED_ORIGIN = "https://qtxalgosystems.com"; // Frontend domain

// ✅ CORS configuration middleware for allowing requests from your frontend domain
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json()); // Middleware to parse JSON bodies

// ✅ Handle preflight OPTIONS request for CORS
app.options("*", (req, res) => {
  res.sendStatus(204); // Respond with no content to OPTIONS requests
});

const signals = new Map();

// Helper function to create unique keys for each symbol and timeframe combination
function getKey(id) {
  return id?.trim() || "unknown-id";
}


// ✅ Webhook route to receive TradingView alert data
app.post("/webhook", (req, res) => {
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;
  console.log("📩 Webhook Payload:", payload);

  const id = getKey(payload.id);
  const isEntry = !payload.tp1Hit && !payload.tp2Hit && !payload.slHit;

  if (isEntry) {
    // Auto-close opposite trades
    for (const [key, sig] of signals.entries()) {
      const isSameSymbol = sig.symbol === payload.symbol;
      const isOpposite = sig.direction !== payload.direction;
      const notClosed = !sig.slHit && !(sig.tp1Hit && sig.tp2Hit);

      if (isSameSymbol && isOpposite && notClosed) {
        sig.tp1Hit = true;
        sig.tp2Hit = true;
        sig.closedAt = payload.timestamp;
        console.log(`🔁 Auto-closed: ${key}`);
      }
    }

    // Skip Add trades (same ID already exists)
    if (signals.has(id)) {
      console.log(`⚠️ Add trade skipped: ${id}`);
      return res.json({ success: true, message: "Add trade skipped" });
    }

    signals.set(id, payload);
    console.log(`✅ New entry stored: ${id}`);
    return res.json({ success: true });
  }

  // Update logic for TP1, TP2, SL
  const existing = signals.get(id);
  if (!existing) {
    console.warn(`⚠️ Unknown trade ID: ${id}`);
    return res.status(404).json({ error: "Trade not found" });
  }

  if (payload.tp1Hit) existing.tp1Hit = true;
  if (payload.tp2Hit) existing.tp2Hit = true;
  if (payload.slHit) existing.slHit = true;
  if (payload.closedAt) existing.closedAt = payload.closedAt;

  console.log(`🔄 Trade updated: ${id}`);
  return res.json({ success: true });
});


// ✅ Route to fetch latest signals and sort them based on score
app.get("/api/latest-signals", (req, res) => {
  const signalArray = Array.from(signals.values());
  console.log("📤 Returning", signalArray.length, "signals");
  res.json(signalArray);
});


// Start the server and listen on the specified port
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
