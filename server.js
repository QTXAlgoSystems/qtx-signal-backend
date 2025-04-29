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

app.post("/webhook", async (req, res) => {
  console.log("[RAW]", JSON.stringify(req.body));
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  const payload = req.body;
  if (payload.tp1Hit || payload.tp2Hit || payload.slHit) {
    payload.closedAt = new Date().toISOString();
  }
  if (!payload.id || payload.id.includes("undefined")) {
    console.warn("⛔ Bad or missing ID, payload skipped:", payload);
    return res.status(400).end();
  }
  if (!payload.timestamp) {
    payload.timestamp = new Date().toISOString();
  }

  const id      = payload.id.trim();
  const isEntry = !payload.tp1Hit && !payload.tp2Hit && !payload.slHit;

  // ── ENTRY: insert new signal ───────────────────────────────
  if (isEntry) {
    const { error: insertErr } = await supabase
      .from("signals")
      .insert([{
        id,
        setup:      payload.tradeType,
        direction:  payload.direction,
        entryprice: payload.entryPrice,
        score:      payload.score,
        risk:       payload.risk,
        stoploss:   payload.stopLoss,
        startedat:  payload.startedAt,
        timestamp:  payload.timestamp
      }], { returning: "minimal" });

    if (insertErr) {
      console.error("❌ INSERT error:", insertErr);
      return res.status(500).json({ error: "DB insert failed" });
    }

    console.log(`✅ New entry stored: ${id}`);
    return res.json({ success: true });
  }

  // --- UPDATES: TP1 / TP2 / SL ---
  let { data: existingArr, error: selectErr } = await supabase
    .from("signals")
    .select("*")
    .eq("trade_id", id)
    .is("closedat", null)
    .limit(1);

  if (selectErr) {
    console.error("❌ SELECT error:", selectErr);
    return res.status(500).json({ error: "DB select failed" });
  }
  if (existingArr.length === 0) {
    console.warn(`⚠️ Unknown trade ID: ${id}`);
    return res.status(404).json({ error: "Trade not found" });
  }

  // 1) STOP-LOSS
  if (payload.slHit) {
    const { error: slErr } = await supabase
      .from("signals")
      .update({
        slhit:    true,
        slprice:  payload.slPrice,
        closedat: payload.closedAt || payload.timestamp
      })
      .eq("trade_id", id)
      .is("closedat", null);
    if (slErr) console.error("❌ SL update error:", slErr);
    console.log(`🔒 SL closed trade: ${id}`);
    return res.json({ success: true });
  }

  // 2) TP1
  if (payload.tp1Hit) {
    const { error: tp1Err } = await supabase
      .from("signals")
      .update({
        tp1hit:   true,
        tp1price: payload.tp1Price,
        tp1time:  payload.closedAt
      })
      .eq("trade_id", id)
      .is("closedat", null);
    if (tp1Err) console.error("❌ TP1 update error:", tp1Err);
    console.log(`🔔 TP1 updated for: ${id}`);
  }

  // 3) TP2
  if (payload.tp2Hit) {
    const { error: tp2Err } = await supabase
      .from("signals")
      .update({
        tp2hit:   true,
        tp2price: payload.tp2Price,
        tp2time:  payload.closedAt
      })
      .eq("trade_id", id)
      .is("closedat", null);
    if (tp2Err) console.error("❌ TP2 update error:", tp2Err);
    console.log(`🔔 TP2 updated for: ${id}`);
  }

  // 4) Final-close if TP1 & TP2
  const existing = existingArr[0];
  if (existing.tp1hit && existing.tp2hit && !existing.closedat) {
    const { error: closeErr } = await supabase
      .from("signals")
      .update({ closedat: payload.closedAt || payload.timestamp })
      .eq("trade_id", id)
      .is("closedat", null);
    if (closeErr) console.error("❌ Final-close error:", closeErr);
    console.log(`✅ Trade closed (TP1 + TP2): ${id}`);
  }

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
