const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

app.use(cors());
app.use(bodyParser.json());

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
  console.log(`Server running on port ${PORT}`);
});
