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

  // Ensure signals is an array and then save/update the signal
  if (!Array.isArray(signals)) {
    signals = [];  // Initialize as an array if it's not one
  }

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
