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

// ── Supabase client initialization ──
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Build a unique key: use non‐empty id, else symbol_timestamp
function getKey(payload) {
  const id = payload.id?.trim();
  const ts = payload.timestamp || new Date().toISOString();
  return id && id.length
    ? id
    : `${payload.symbol}_${ts}`;
}

// Helper to parse symbol & timeframe from trade ID
function splitId(id) {
  const [sym, tf] = id.split("_");
  return { sym, tf };
}

// Helper to calculate PnL %
function calculatePnl(entryPrice, exitPrice, direction) {
  if (!entryPrice || !exitPrice) return 0;
  if (direction === "LONG") {
    return ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
  } else {
    return ((entryPrice - exitPrice) / entryPrice * 100).toFixed(2);
  }
}

app.post("/webhook", (req, res) => {
  console.log("[RAW]", JSON.stringify(req.body));
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;

  // Add/overwrite closedAt with the wall-clock moment the packet arrives
  if (payload.tp1Hit || payload.tp2Hit || payload.slHit) {
    payload.closedAt = new Date().toISOString();
  }

  // ID guard
  if (!payload.id || payload.id.includes("undefined")) {
    console.warn("⛔ Bad or missing ID, payload skipped:", payload);
    return res.status(400).end();
  }
  console.log("📩 Webhook Payload:", payload);

  // ensure entry timestamp exists
  if (!payload.timestamp) {
    payload.timestamp = new Date().toISOString();
  }

  const id = getKey(payload);
  const isEntry = !payload.tp1Hit && !payload.tp2Hit && !payload.slHit;
  console.log("🧠 Current signal keys:", Array.from(signals.keys()));

  if (isEntry) {
    // ── auto-close opposite trades on the *same* instrument ──
    const { sym: newSym, tf: newTF } = splitId(id);
    for (const [key, sig] of signals.entries()) {
      const { sym, tf }    = splitId(key);
      const opposite       = sig.direction !== payload.direction;
      const notClosed      = !sig.slHit && !(sig.tp1Hit && sig.tp2Hit);
  
      if (sym === newSym && tf === newTF && opposite && notClosed) {
        // 1) mark the partial-exit flags
        sig.tp1Hit = true;
        sig.tp2Hit = true;
  
        // 2) record the exit price for each leg so PnL math works
        sig.tp1Price = payload.entryPrice;
        sig.tp2Price = payload.entryPrice;
  
        // 3) timestamp the close
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

  // --- updates: SL wins over TP1/TP2 ---
  const existing = signals.get(id);
  if (!existing) {
    console.warn(`⚠️ Unknown trade ID: ${id}`);
    return res.status(404).json({ error: "Trade not found" });
  }

  // 1) STOP-LOSS wins every time: close & calculate PnL
  if (payload.slHit) {
    existing.slHit = true;
    existing.slPrice = payload.slPrice;
    existing.closedAt = payload.closedAt || payload.timestamp || new Date().toISOString();
  
    // 🔥 NEW: calculate PnL for SL
    existing.pnlPercent = calculatePnl(existing.entryPrice, existing.slPrice, existing.direction);
  
    console.log(`🔒 SL closed trade: ${id} | PnL: ${existing.pnlPercent}%`);
    return res.json({ success: true });
  }
  
  // 2) TP1 update
  if (payload.tp1Hit) {
    existing.tp1Hit = true;
    existing.tp1Price = payload.tp1Price;
    existing.tp1Time = payload.closedAt;
    console.log(`🔔 TP1 updated for: ${id}`);
  }

  // 3) TP2 update
  if (payload.tp2Hit) {
    existing.tp2Hit = true;
    existing.tp2Price = payload.tp2Price;
    existing.tp2Time = payload.closedAt;
    console.log(`🔔 TP2 updated for: ${id}`);
  }

  // 4) If both TP1 & TP2 now hit, close the trade and calculate PnL
  if (existing.tp1Hit && existing.tp2Hit && !existing.closedAt) {
    existing.closedAt = payload.closedAt || payload.timestamp || new Date().toISOString();
  
    // 🔥 NEW: calculate blended PnL for TP1 + TP2
    const pnlTp1 = calculatePnl(existing.entryPrice, existing.tp1Price, existing.direction);
    const pnlTp2 = calculatePnl(existing.entryPrice, existing.tp2Price, existing.direction);
    existing.pnlPercent = ((parseFloat(pnlTp1) + parseFloat(pnlTp2)) / 2).toFixed(2);
  
    console.log(`✅ Trade closed (TP1 + TP2): ${id} | Avg PnL: ${existing.pnlPercent}%`);
  }

  console.log(`🔄 Trade updated: ${id}`);
  return res.json({ success: true });
});

app.get("/api/latest-signals", async (req, res) => {
  // Pull all signals, newest first
  const { data, error } = await supabase
    .from("signals")
    .select("*")
    .order("timestamp", { ascending: false });

  if (error) {
    console.error("❌ Supabase SELECT error:", error);
    return res.status(500).json({ error: "Database error" });
  }

  console.log("📤 Returning", data.length, "signals");
  res.json(data);
});


app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
