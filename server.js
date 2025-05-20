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
  const raw = direction === "LONG"
    ? (exitPrice - entryPrice) / entryPrice * 100
    : (entryPrice - exitPrice) / entryPrice * 100;
  return raw.toFixed(3);
}

// Helper to sanitize payload (removes NaN/undefined values)
function sanitizePayload(obj) {
  const clean = {};
  for (const key in obj) {
    const val = obj[key];
    // Keep only values that are not undefined or NaN
    if (val !== undefined && !(typeof val === "number" && isNaN(val))) {
      clean[key] = val;
    }
  }
  return clean;
}

function getTierFromStats(stats) {
  if (!stats) return "base";
  const winRate = stats.winRate ?? 0;
  const profitFactor = stats.profitFactor ?? 0;

  if (winRate >= 0.7 && profitFactor >= 4.0) return "elite";

  const wrScore = winRate * 100;
  const pfScore = profitFactor * 10;
  const blended = wrScore * 0.65 + pfScore * 0.35;

  if (blended >= 55) return "great";
  if (blended >= 45) return "good";
  return "base";
}

app.post("/webhook", async (req, res) => {
  console.log("[RAW]", JSON.stringify(req.body));
  const token = req.query.token;
  if (token !== WEBHOOK_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  let payload = sanitizePayload(req.body);
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
    // 1) parse & normalize the raw tf string into numeric minutes
    const [ sym, tfRaw ] = id.split("_");
    let timeframe;
    if (tfRaw.endsWith("W")) {
      // “nW” → n * 7 * 24 * 60 minutes
      timeframe = parseInt(tfRaw, 10) * 7 * 24 * 60;
    } else if (tfRaw.endsWith("D")) {
      // “nD” → n * 24 * 60 minutes
      timeframe = parseInt(tfRaw, 10) * 24 * 60;
    } else {
      // e.g. “1”, “15”, “60” → already minutes
      timeframe = parseInt(tfRaw, 10);
    }
  
    // 2) auto-close opposite trades using the numeric timeframe
    const { data: openOpposites, error: fetchOppErr } = await supabase
      .from("signals")
      .select("*")
      .eq("timeframe", timeframe)
      .eq("direction", payload.direction === "LONG" ? "SHORT" : "LONG")
      .like("trade_id", `${sym}_${tfRaw}_%`)
      .is("closedat", null)
      .order("startedat", { ascending: false })
      .limit(1);

    if (fetchOppErr) {
      console.error("❌ Failed to fetch opposite trades:", fetchOppErr);
    } else {
      const trade = openOpposites?.[0]; // only one trade now due to .limit(1)
    
      if (!trade) {
        console.log("ℹ️ No opposite trade found to auto-close");
      } else if (trade.slhit) {
        console.log(`⚠️ Skipping auto-close for ${trade.trade_id} — SL already hit`);
      } else {
        const updatePayload = {
          closedat: payload.timestamp,
          auto_closed: true,
          close_reason: (trade.tp1hit && trade.tp2hit) ? 'tp1+tp2' : 'auto-opposite'
        };
    
        // ✅ Only update TP1 if not already hit
        if (!trade.tp1hit) {
          updatePayload.tp1hit = true;
          updatePayload.tp1price = payload.entryPrice;
          updatePayload.tp1time = payload.timestamp;
          updatePayload.tp1percent = calculatePnl(
            trade.entryprice,
            payload.entryPrice,
            trade.direction
          );
        }
    
        // ✅ Only update TP2 if not already hit
        if (!trade.tp2hit) {
          updatePayload.tp2hit = true;
          updatePayload.tp2price = payload.entryPrice;
          updatePayload.tp2time = payload.timestamp;
          updatePayload.tp2percent = calculatePnl(
            trade.entryprice,
            payload.entryPrice,
            trade.direction
          );
        }
    
        // ✅ Set final PnL only if both exits now exist
        const tp1 = trade.tp1hit ? trade.tp1price : updatePayload.tp1price;
        const tp2 = trade.tp2hit ? trade.tp2price : updatePayload.tp2price;
    
        if (tp1 && tp2) {
          const avgExit = (parseFloat(tp1) + parseFloat(tp2)) / 2;
          updatePayload.pnlpercent = calculatePnl(
            trade.entryprice,
            avgExit,
            trade.direction
          );
        }
    
        const { error: closeErr } = await supabase
          .from("signals")
          .update(updatePayload)
          .eq("uid", trade.uid)
    
        if (closeErr) {
          console.error("❌ Auto-close update error:", closeErr);
        } else {
          console.log(`🔁 Auto-closed trade ${trade.trade_id} with protected TP/SL logic`);
        }
      }
    }

    
    // ✅ Deduplication check: prevent duplicate open trade_id entries
    const { data: existingOpen, error: existingErr } = await supabase
      .from("signals")
      .select("uid")
      .eq("trade_id", id)
      .is("closedat", null)
      .limit(1);
  
    if (existingErr) {
      console.error("❌ Error checking for duplicate trade:", existingErr);
    } else if (existingOpen.length > 0) {
      console.warn(`⚠️ Duplicate open trade detected for ${id}, skipping insert`);
      return res.status(200).json({ ignored: true });
    }

    // 💡 Determine verified setup match (same logic as frontend)
    const verifiedMatch = await supabase
      .from("verified_setups")
      .select("*")
      .eq("symbol", sym)
      .eq("timeframe", timeframe)
      .eq("setup", payload.tradeType)
      .maybeSingle(); // if you expect only one match
    
    const statsForTier = verifiedMatch.data
      ? {
          winRate: verifiedMatch.data.win_rate ?? 0,
          profitFactor: verifiedMatch.data.profit_factor ?? 0,
        }
      : null;
    
    const tier = getTierFromStats(statsForTier); // 🟨 Compute final tier
        
    // 2) now insert the new entry
    const { error: insertErr } = await supabase
      .from("signals")
      .insert([{
        trade_id:   id,               // ← write into trade_id, not id
        timeframe:  timeframe, 
        setup:      payload.tradeType,
        direction:  payload.direction,
        entryprice: payload.entryPrice,
        score:      payload.score,
        risk:       payload.risk,
        stoploss:   payload.stopLoss,
        startedat:  payload.startedAt,
        timestamp:  payload.timestamp,
        version:     payload.version     || null,
        biashtf1:    payload.biasHTF1    ?? null,
        biashtf2:    payload.biasHTF2    ?? null,
        biashtf3:    payload.biasHTF3    ?? null,
        htf_logic:   payload.htfLogic    || null,
        tier 
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
  
  const existing = existingArr[0];
  
  // 🚫 If already closed, ignore further updates
  if (existing.closedat) {
    console.warn(`⚠️ Trade ${id} is already closed, skipping update`);
    return res.status(200).json({ ignored: true });
  }
  
  // 🚫 If SL was already hit, block any TP updates
  if (existing.slhit && (payload.tp1Hit || payload.tp2Hit)) {
    console.warn(`⛔ SL already hit for ${id}, ignoring TP update`);
    return res.status(200).json({ ignored: true });
  }

  // ── STOP-LOSS (final close) ──
  if (payload.slHit) {
    const existing = existingArr[0];
  
    // Determine close_reason
    let reason = "sl";
    if (existing.tp1hit || existing.tp2hit) {
      reason = "sl-after-partial";
    }
  
    const { error: slErr } = await supabase
      .from("signals")
      .update({
        slhit:        true,
        slprice:      payload.slPrice,
        closedat:     payload.closedAt || payload.timestamp,
        pnlpercent:   calculatePnl(
                        existing.entryprice,
                        payload.slPrice,
                        existing.direction
                      ),
        close_reason: reason
      })
      .eq("trade_id", id)
      .is("closedat", null);
  
    if (slErr) console.error("❌ SL update error:", slErr);
    console.log(`🔒 SL closed trade: ${id} | Reason: ${reason}`);
    return res.json({ success: true });
  }

  // ── TP1 update (and conditional final-close if TP2 already hit) ──
  if (payload.tp1Hit) {
    const existing = existingArr[0];
  
    // 1) write TP1 fields + TP1%
    const { error: tp1Err } = await supabase
      .from("signals")
      .update({
        tp1hit:     true,
        tp1price:   payload.tp1Price,
        tp1time:    payload.closedAt,
        tp1percent: calculatePnl(
          parseFloat(existing.entryprice),
          parseFloat(payload.tp1Price),
          existing.direction
        )

      })
      .eq("trade_id", id)
      .is("closedat", null);
  
    if (tp1Err) console.error("❌ TP1 update error:", tp1Err);
    console.log(`🔔 TP1 updated for: ${id}`);
  
    // 2) if TP2 already fired, do the final-close now
    if (existing.tp2hit) {
      const tp1 = parseFloat(payload.tp1Price);
      const tp2 = parseFloat(existing.tp2price);
      const avgExit = (tp1 + tp2) / 2;  
      const { error: fcErr } = await supabase
        .from("signals")
        .update({
          closedat:   payload.closedAt,
          pnlpercent: calculatePnl(
                         existing.entryprice,
                         avgExit,
                         existing.direction
                       )
        })
        .eq("trade_id", id)
        .is("closedat", null);
  
      if (fcErr) console.error("❌ Final-close error:", fcErr);
      console.log(`✅ Trade closed (TP1 + TP2) for: ${id} @ ${payload.closedAt}`);
    }
  
    // 🔁 Fallback: TP2 was already hit but final-close never happened
    const freshTP2 = existing.tp2hit && !existing.closedat;
    if (freshTP2) {
      const tp1 = parseFloat(payload.tp1Price);
      const tp2 = parseFloat(existing.tp2price);
      const avgExit = (tp1 + tp2) / 2;
      const { error: fallbackErr } = await supabase
        .from("signals")
        .update({
          closedat:   payload.closedAt,
          pnlpercent: calculatePnl(
                         existing.entryprice,
                         avgExit,
                         existing.direction
                       )
        })
        .eq("trade_id", id)
        .is("closedat", null);
      if (fallbackErr) console.error("❌ Fallback close from TP1 block failed:", fallbackErr);
      else console.log(`✅ Fallback close applied from TP1 block: ${id}`);
    }
  
    // 3) stop further processing in this request
    return res.json({ success: true });
  }
  
  // ── TP2 update (and conditional final-close if TP1 already hit) ──
  if (payload.tp2Hit) {
    const existing = existingArr[0];
  
    // 1) write TP2 fields + TP2%
    const { error: tp2Err } = await supabase
      .from("signals")
      .update({
        tp2hit:     true,
        tp2price:   payload.tp2Price,
        tp2time:    payload.closedAt,
        tp2percent: calculatePnl(
                       existing.entryprice,
                       payload.tp2Price,
                       existing.direction
                     )
      })
      .eq("trade_id", id)
      .is("closedat", null);
  
    if (tp2Err) console.error("❌ TP2 update error:", tp2Err);
    console.log(`🔔 TP2 updated for: ${id}`);
  
    // 2) if TP1 already fired, do the final-close now
    if (existing.tp1hit) {
      const tp1 = parseFloat(existing.tp1price);
      const tp2 = parseFloat(payload.tp2Price);
      const avgExit = (tp1 + tp2) / 2;
      const { error: fcErr } = await supabase
        .from("signals")
        .update({
          closedat:   payload.closedAt,
          pnlpercent: calculatePnl(
                         existing.entryprice,
                         avgExit,
                         existing.direction
                       )
        })
        .eq("trade_id", id)
        .is("closedat", null);
  
      if (fcErr) console.error("❌ Final-close error:", fcErr);
      console.log(`✅ Trade closed (TP1 + TP2) for: ${id} @ ${payload.closedAt}`);
    }
  
    // Fallback: If TP1 already hit but trade never closed (TP1 came first)
    const freshTP1 = existing.tp1hit && !existing.closedat;
    if (freshTP1) {
      const tp1 = parseFloat(existing.tp1price);
      const tp2 = parseFloat(payload.tp2Price);
      const avgExit = (tp1 + tp2) / 2;
      const { error: fallbackErr } = await supabase
        .from("signals")
        .update({
          closedat:   payload.closedAt,
          pnlpercent: calculatePnl(
                         existing.entryprice,
                         avgExit,
                         existing.direction
                       )
        })
        .eq("trade_id", id)
        .is("closedat", null);
      if (fallbackErr) console.error("❌ Fallback close from TP2 block failed:", fallbackErr);
      else console.log(`✅ Fallback close applied from TP2 block: ${id}`);
    }
  
    // 3) stop further processing in this request
    return res.json({ success: true });
  }


  // ── FINAL CLOSE: both TP1+TP2 ──
  if (existing.tp1hit && existing.tp2hit && !existing.closedat) {
    const tp1 = parseFloat(existing.tp1price);
    const tp2 = parseFloat(existing.tp2price);
    const avgExit = (tp1 + tp2) / 2;
    const { error: closeErr } = await supabase
      .from("signals")
      .update({
        closedat:   payload.closedAt || payload.timestamp,
        pnlpercent: calculatePnl(
                       existing.entryprice,
                       avgExit,
                       existing.direction
                     )
      })
      .eq("trade_id", id)
      .is("closedat", null);
    if (closeErr) console.error("❌ Final-close error:", closeErr);
    console.log(`✅ Trade closed (TP1 + TP2): ${id}`);
  }


  return res.json({ success: true });
});

app.get("/api/latest-signals", async (req, res) => {
  // Pull only open or recently closed signals (last 10 minutes), newest first
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("signals")
    .select("*")
    .or(`closedat.is.null,closedat.gt.${tenMinutesAgo}`)
    .order("timestamp", { ascending: false })
    .limit(200); // cap to 200 results to prevent overload

  if (error) {
    console.error("❌ Supabase SELECT error:", error);
    return res.status(500).json({ error: "Database error" });
  }

  console.log("📤 Returning", data.length, "signals (limited to active + recent)");
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
