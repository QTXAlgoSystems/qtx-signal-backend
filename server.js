const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000; // Default port 3000 if not provided 
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

let signals = {};

// Helper function to create unique keys for each symbol and timeframe combination
function getKey(symbol, timeframe) {
  return `${symbol}-${timeframe}`;
}

// ✅ Webhook route to receive TradingView alert data
app.post("/webhook", (req, res) => {
  const token = req.query.token;  // Validate the token sent in the query string

  // Validate webhook token for security
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;

  // Log the received payload to verify the data
  console.log("Received Payload:", payload);

  // Check if the essential fields are present in the payload
  if (!payload.symbol || !payload.timeframe) {
    return res.status(400).json({ error: "Missing required fields (symbol, timeframe)" });
  }

  const key = getKey(payload.symbol, payload.timeframe);

  // Save the signal data or update it if it already exists
  signals[key] = { ...signals[key], ...payload };

  // Respond with success
  res.json({ success: true });
});

// ✅ Route to fetch latest signals and sort them based on score
app.get("/api/latest-signals", (req, res) => {
  // Ensure signals is an array, sort it by highest totalScore
  const signalArray = Object.values(signals); // This should be an array
  if (!Array.isArray(signalArray)) {
    return res.status(500).json({ error: "Signals is not an array" });
  }
  
  const sorted = signalArray.sort((a, b) => b.totalScore - a.totalScore); // Sort by highest score
  res.json(sorted); // Return the array of sorted signals
});

// Start the server and listen on the specified port
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
