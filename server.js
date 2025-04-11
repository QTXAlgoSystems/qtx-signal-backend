const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

// ✅ Secure CORS setup for your frontend
const corsOptions = {
  origin: "https://qtxalgosystems.com", // exact domain including https
  methods: ["GET", "POST"],
  credentials: true, // future-proof for auth
};

app.use(cors(corsOptions));
app.use(express.json());

let signals = {};

function getKey(symbol, timeframe) {
  return `${symbol}-${timeframe}`;
}

app.post("/webhook", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://qtxalgosystems.com");

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
  res.setHeader("Access-Control-Allow-Origin", "https://qtxalgosystems.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const sorted = Object.values(signals).sort((a, b) => b.totalScore - a.totalScore);
  res.json(sorted);
});


app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
