const express = require("express");
const app = express();
const PORT = process.env.PORT;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

const ALLOWED_ORIGIN = "https://qtxalgosystems.com";

// ✅ Custom CORS middleware for ALL responses
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json());

// ✅ Handle preflight OPTIONS request
app.options("*", (req, res) => {
  res.sendStatus(204);
});

let signals = {};

function getKey(symbol, timeframe) {
  return `${symbol}-${timeframe}`;
}

app.post("/webhook", (req, res) => {
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;
  if (!payload.symbol || !payload.timeframe) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const key = getKey(payload.symbol, payload.timeframe);
  signals[key] = { ...signals[key], ...payload };
  res.json({ success: true });
});

app.get("/api/latest-signals", (req, res) => {
  const sorted = Object.values(signals).sort((a, b) => b.totalScore - a.totalScore);
  res.json(sorted);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
