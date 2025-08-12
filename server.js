const express = require("express");
const app = express();
app.use(express.json()); // ⬅️ This line is required before routes

const TelegramBot = require("node-telegram-bot-api");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${process.env.BASE_URL}/bot${TELEGRAM_BOT_TOKEN}`);

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

// ── Check Telegram Status Route ──
app.get("/api/check-telegram-status", async (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  try {
    // Query telegram_links instead of user_alerts
    const { data, error } = await supabase
      .from("telegram_links")
      .select("telegram_chat_id, verified")
      .eq("user_id", user_id)
      .single();

    // If no row or not verified, treat as unlinked
    if (error || !data || !data.verified) {
      return res.status(200).json({ linked: false, chat_id: null });
    }

    // Otherwise return true and the chat ID
    res.json({
      linked: true,
      chat_id: data.telegram_chat_id,
    });
  } catch (err) {
    console.error("❌ Failed to check Telegram status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Keep as the ONLY path that sends Telegram
async function sendTelegramAlertsForSignal(signal) {
  console.log("📦 Incoming signal for Telegram:", signal.uid);

  // 0) Trust the frontend decision: must have title/body AND FE key
  if (!signal?.telegramBody || !signal?.telegramTitle || !signal?.key) {
    console.warn("⚠️ Missing telegramBody/telegramTitle/key — skipping:", signal?.uid);
    return;
  }

  // 0.1) Normalize for user prefs checks only (NOT for deciding)
  const sigSymbol    = String(signal.symbol || "").trim();
  const sigTimeframe = String(signal.timeframe || "").trim();
  const sigTier      = String(signal.tier ?? "").trim(); // tier is just for user filters

  // 1) Fetch all verified Telegram links
  const { data: telegramUsers, error: linkError } = await supabase
    .from("telegram_links")
    .select("user_id, telegram_chat_id")
    .eq("verified", true);

  if (linkError || !telegramUsers?.length) {
    console.error("❌ Failed to fetch telegram_links or none found:", linkError);
    return;
  }

  // 1.1) OPTIONAL: Global idempotency by FE key (one-time guard)
  // Create a table with UNIQUE(key) or add 'key' column to sent_telegram_alerts with a unique index.
  const { error: keyInsertErr } = await supabase
    .from("sent_telegram_alerts_keys")  // <- make this table with columns: key TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT now()
    .insert({ key: signal.key });

  if (keyInsertErr && keyInsertErr.code !== "23505") {
    console.warn("⚠️ Global key insert failed:", keyInsertErr?.message);
    // Continue — we'll still dedupe per user below
  }
  if (keyInsertErr && keyInsertErr.code === "23505") {
    console.log("🔁 Duplicate FE key — already processed:", signal.key);
    // You can return here to skip per-user loop entirely if you like:
    // return;
  }

  // 2) Loop through each linked user
  for (const { user_id, telegram_chat_id } of telegramUsers) {
    // 2a) User prefs (symbols/timeframes/tiers)
    const { data: prefs, error: prefsError } = await supabase
      .from("user_alerts")
      .select("telegram, symbols, timeframes, tiers")
      .eq("user_id", user_id)
      .single();

    if (prefsError || !prefs?.telegram) continue;

    const symbols    = (prefs.symbols    || []).map(String);
    const timeframes = (prefs.timeframes || []).map(String);
    const tiers      = (prefs.tiers      || []).map(String);

    if ((symbols.length    && !symbols.includes(sigSymbol)) ||
        (timeframes.length && !timeframes.includes(sigTimeframe)) ||
        (tiers.length      && !tiers.includes(sigTier))) {
      continue;
    }

    // 2b) Per-user idempotency by FE key
    const { data: existing, error: existErr } = await supabase
      .from("sent_telegram_alerts")
      .select("id")
      .eq("user_id", user_id)
      .eq("key", signal.key)           // 🔑 use the FE key, not just uid
      .eq("alert_type", "ENTRY")
      .limit(1);

    if (!existErr && existing?.length) {
      continue; // already sent to this user for this exact FE decision
    }

    // 2c) Record first (so a crash still prevents dupes next loop)
    const { error: insertErr } = await supabase
      .from("sent_telegram_alerts")
      .insert({
        uid: signal.uid,
        user_id,
        alert_type: "ENTRY",
        key: signal.key               // 🔑 store the key
      });

    if (insertErr) {
      console.warn("⚠️ Insert duplicate or error, skipping send:", insertErr?.message);
      continue;
    }

    // 2d) Send exactly what FE chose — no extra emoji, no parse_mode surprises
    try {
      const text = `${signal.telegramTitle}\n\n${signal.telegramBody}`;
      await bot.sendMessage(telegram_chat_id, text);
      console.log(`🔔 Initial alert sent to ${telegram_chat_id}`);
    } catch (err) {
      console.error(`🚫 Failed to send initial alert to ${telegram_chat_id}:`, err);
      // Optional: flag failure
      await supabase
        .from("sent_telegram_alerts")
        .update({ /* success: false */ })
        .eq("user_id", user_id)
        .eq("key", signal.key)
        .eq("alert_type", "ENTRY");
    }
  }
}

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

  // ✅ Always ensure timestamp exists
  payload.timestamp = payload.timestamp || new Date().toISOString();
  
  // ✅ Assign closedAt only if it’s an exit signal
  if (payload.tp1Hit || payload.tp2Hit || payload.slHit) {
    payload.closedAt = new Date().toISOString();
  }

  if (!payload.id || payload.id.includes("undefined")) {
    console.warn("⛔ Bad or missing ID, payload skipped:", payload);
    return res.status(400).end();
  }

  const id      = payload.id.trim();
  const isEntry = !payload.tp1Hit && !payload.tp2Hit && !payload.slHit;

  // ⛔ Never send alerts directly from /webhook — alerts must come from script.js only
  if (payload.telegramTitle || payload.telegramBody) {
    console.warn("⛔ Payload contains Telegram fields — skipping alert for:", id);
    return res.status(200).end(); // Still acknowledge as received
  }
  
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
          closedat: payload.closedAt || payload.timestamp,
          auto_closed: true,
          close_reason: (trade.tp1hit && trade.tp2hit) ? 'tp1+tp2' : 'auto-opposite'
        };
        
        if (!trade.tp1hit) {
          updatePayload.tp1hit = true;
          updatePayload.tp1price = payload.entryPrice;
          updatePayload.tp1time = payload.closedAt || payload.timestamp;
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
          console.log(`↪️ Auto-close reason: ${updatePayload.close_reason} | UID: ${trade.uid}`);
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
      console.warn(`⚠️ Duplicate trade skipped: ${id} | UID would be: ${id}_${payload.timestamp}`);
      return res.status(200).json({ ignored: true });
    }

    // 💡 Determine verified  match (same logic as frontend)
    const { data: verifiedMatch } = await supabase
      .from("verified_s")
      .select("*")
      .or(`symbol.eq.${sym},proxy_symbol.eq.${sym}`)
      .eq("timeframe", timeframe)
      .eq("", payload.tradeType)
      .maybeSingle();
    
    const statsForTier = verifiedMatch
      ? {
          winRate: verifiedMatch.win_rate ?? 0,
          profitFactor: verifiedMatch.profit_factor ?? 0,
        }
      : null;
        
    const tier = getTierFromStats(statsForTier); // 🟨 Compute final tier

    console.log(`📊 Entry tier: ${tier} | HTF Logic: ${payload.htfLogic || "none"}`);
        
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
    console.warn(`⚠️ Unknown trade ID: ${id} | Payload:`, payload);
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

  // ✅ Final safeguard: close if both TP1 and TP2 are now hit
  if (!existing.closedat && (
      (payload.tp1Hit && existing.tp2hit) ||
      (payload.tp2Hit && existing.tp1hit) ||
      (payload.tp1Hit && payload.tp2Hit) // rare but possible
    )) {
    const tp1 = payload.tp1Price || existing.tp1price;
    const tp2 = payload.tp2Price || existing.tp2price;
    const avgExit = (parseFloat(tp1) + parseFloat(tp2)) / 2;
  
    const { error: safeguardErr } = await supabase
      .from("signals")
      .update({
        closedat: payload.closedAt || payload.timestamp,
        pnlpercent: calculatePnl(existing.entryprice, avgExit, existing.direction)
      })
      .eq("trade_id", id)
      .is("closedat", null);
  
    if (safeguardErr) console.error("❌ Safeguard close error:", safeguardErr);
    else console.log(`✅ Safeguard final-close for: ${id} | TP1: ${tp1} | TP2: ${tp2}`);
  }
    
  return res.json({ success: true });
});

app.get("/api/latest-signals", async (req, res) => {
  try {
    const { data: signals, error } = await supabase
      .from("signals_realtime")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(250);

    if (error) {
      console.error("❌ Fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch signals" });
    }

    console.log(`📥 Realtime signals returned: ${signals.length}`);
    res.json(signals);
  } catch (e) {
    console.error("🔥 Unexpected error in latest-signals:", e);
    res.status(500).json({ error: "Unexpected error", message: e.message });
  }
});

app.post("/api/generate-telegram-code", async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  const { error } = await supabase
    .from("telegram_links")
    .upsert({
      user_id,
      telegram_chat_id: 0,
      verified: false,
      link_code: code
    }, { onConflict: ['user_id'] }); // ✅ ensures update not insert if row exists

  if (error) {
    console.error("❌ Error inserting telegram link:", error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ code });
});

// 🔗 Telegram webhook route (must be before bot.onText)
// ✅ Webhook route — required for Telegram to forward updates
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ✅ Handle /start CODE command
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();

  try {
    const { data, error } = await supabase
      .from("telegram_links")
      .select("user_id")
      .eq("link_code", code)
      .single();

    if (error || !data) {
      console.error("❌ Invalid or expired code:", error || "No match");
      return bot.sendMessage(chatId, "Invalid or expired code. Please try again.");
    }

    const userId = data.user_id;

    console.log("🔗 Linking Telegram account:", {
      user_id: userId,
      chat_id: chatId
    });

    const { error: insertError, data: updateData } = await supabase
      .from("telegram_links")
      .update({
        telegram_chat_id: chatId,
        verified: true
      })
      .eq("user_id", userId)
      .select();

    if (insertError) {
      console.error("❌ Error saving Telegram chat_id:", insertError);
      return bot.sendMessage(chatId, "Something went wrong linking your account.");
    }

    if (!updateData || updateData.length === 0) {
      console.error("⚠️ No matching row found for user_id:", userId);
      return bot.sendMessage(chatId, "Could not find your account to link.");
    }

    bot.sendMessage(chatId, "✅ Your account is now linked. You will receive GOD Complex alerts based on your dashboard settings.");
  } catch (err) {
    console.error("❌ Unexpected error:", err);
    bot.sendMessage(chatId, "An unexpected error occurred. Please try again.");
  }
});

app.post("/api/send-signal", async (req, res) => {
  const { uid, key, telegramTitle, telegramBody, symbol, timeframe, tier } = req.body || {};

  if (process.env.QTX_NOTIFY_KEY) {
    const k = req.get("X-QTX-Notify-Key") || "";
    if (k !== process.env.QTX_NOTIFY_KEY) {
      console.warn("🚫 Unauthorized send-signal (bad key)");
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  if (!uid || !key || !telegramTitle || !telegramBody) {      // ← require key
    console.warn("⚠️ Missing uid/key/title/body — skipping relay");
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  console.log("🔔 /api/send-signal hit", { uid, symbol, timeframe, tier });

  const hasMedian = (typeof telegramBody === "string") && telegramBody.toLowerCase().includes("median");
  if (hasMedian) {
    console.warn("🚨 BLOCKED: telegramBody includes 'median' — unauthorized payload");
    return res.status(200).json({ ok: false, blocked: true, reason: "contains 'median'" });
  }

  try {
    await sendTelegramAlertsForSignal({ uid, key, telegramTitle, telegramBody, symbol, timeframe, tier }); // ← pass key down
    console.log("✅ Alert relayed for UID:", uid);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error sending alert for UID:", uid, err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

const sentFollowUpCache = new Set();
const FOLLOWUP_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

app.post("/api/send-followup-alert", async (req, res) => {
  const {
    uid, symbol, timeframe, setup, setup_type, tier,
    typeKey, label, telegramTitle, telegramBody, pnl, time
  } = req.body || {};

  // (optional) simple header key if you enabled it for /api/send-signal
  if (process.env.QTX_NOTIFY_KEY) {
    const k = req.get("X-QTX-Notify-Key") || "";
    if (k !== process.env.QTX_NOTIFY_KEY) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }
  }

  if (!uid || !typeKey || !telegramTitle || !telegramBody) {
    return res.status(400).json({ ok:false, error:"missing fields" });
  }

  // in-memory dedupe for quick repeats
  const followUpKey = `${uid}|${typeKey}`;
  if (sentFollowUpCache.has(followUpKey)) {
    return res.status(200).json({ ok:true, skipped:true, reason:"duplicate (cache)" });
  }
  sentFollowUpCache.add(followUpKey);
  setTimeout(() => sentFollowUpCache.delete(followUpKey), FOLLOWUP_CACHE_TTL);

  try {
    // Get users who received ENTRY (keeps parity with Desktop)
    const { data: recipients, error: recError } = await supabase
      .from("sent_telegram_alerts")
      .select("user_id")
      .eq("uid", uid)
      .eq("alert_type", "ENTRY");

    if (recError) return res.status(500).json({ ok:false, error:"db error" });
    if (!recipients?.length) return res.status(200).json({ ok:true, message:"no recipients" });

    for (const { user_id } of recipients) {
      // Per-user prefs (string-cast lists to avoid 30 vs "30")
      const { data: prefs } = await supabase
        .from("user_alerts")
        .select("telegram, symbols, timeframes, tiers")
        .eq("user_id", user_id)
        .single();
      if (!prefs?.telegram) continue;

      const symbolsList    = (prefs.symbols    || []).map(String);
      const timeframesList = (prefs.timeframes || []).map(String);
      const tiersList      = (prefs.tiers      || []).map(String);

      if ((symbolsList.length    && !symbolsList.includes(String(symbol))) ||
          (timeframesList.length && !timeframesList.includes(String(timeframe))) ||
          (tiersList.length      && !tiersList.includes(String(tier ?? "")))) {
        continue;
      }

      // DB dedupe: only once per (uid, user, typeKey)
      const { error: upErr } = await supabase
        .from("sent_telegram_alerts")
        .upsert(
          { uid, user_id, alert_type: typeKey },
          { onConflict: ['uid','user_id','alert_type'] }
        );
      if (upErr) continue;

      // find chat id
      const { data: link } = await supabase
        .from("telegram_links")
        .select("telegram_chat_id")
        .eq("user_id", user_id)
        .eq("verified", true)
        .single();
      if (!link?.telegram_chat_id) continue;

      // Send exactly what desktop showed
      try {
        await bot.sendMessage(link.telegram_chat_id, `🔁 ${telegramTitle}\n\n${telegramBody}`);
      } catch (err) {
        await supabase.from("sent_telegram_alerts")
          .update({})
          .eq("uid", uid).eq("user_id", user_id).eq("alert_type", typeKey);
      }
    }

    return res.json({ ok:true });
  } catch (err) {
    console.error("follow-up error:", err);
    return res.status(500).json({ ok:false, error:"internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
