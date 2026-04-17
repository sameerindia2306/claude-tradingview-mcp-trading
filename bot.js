/**
 * Sameer Trading Bot — Pepperstone / cTrader
 * Data:      Twelve Data API (free tier, 800 credits/day)
 * Execution: cTrader Open API (Pepperstone)
 * Symbols:   Top 13 trending from 30-symbol pool (scored every Sunday) + XAUUSD always
 * Strategies:
 *   XAUUSD → ICT Silver Bullet — FVG entry in 4 NY/London time windows
 *   Stocks → EMA(9/21) + VWAP + RSI(14) momentum, NYSE session only
 *   Forex  → Session breakout + EMA(9/21) + FVG confirmation
 * Risk:    ATR-based TP/SL · trailing stop to breakeven · −3% daily loss limit
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { placeMarketOrder, isConfigured } from "./ctrader.js";
import { syncToSheets } from "./sync-sheets.js";
import { exportToExcel } from "./export-excel.js";
import http from "http";

// Health check endpoint so Railway can monitor and auto-restart if unresponsive
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols:           (process.env.SYMBOLS || "EURUSD,GBPUSD,XAUUSD,AAPL,TSLA,NVDA").split(",").map(s => s.trim()),
  timeframe:         process.env.TIMEFRAME || "5m",
  portfolioValue:    parseFloat(process.env.PORTFOLIO_VALUE_USD  || "300"),
  maxTradeSizeUSD:   parseFloat(process.env.MAX_TRADE_SIZE_USD   || "25"),
  maxTradesPerDay:   parseInt(process.env.MAX_TRADES_PER_DAY     || "25"),
  dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "3"),
  paperTrading:      process.env.PAPER_TRADING !== "false",
  tdApiKey:          process.env.TWELVE_DATA_API_KEY || "",
};

const CSV_FILE       = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";
const POSITIONS_FILE = "open-positions.json";
const LOG_FILE       = "safety-check-log.json";
const WATCHLIST_FILE = "watchlist.json";

// Symbol → Twelve Data format (forex needs slash notation)
const TD_SYMBOL = {
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY",
  AUDUSD: "AUD/USD", USDCAD: "USD/CAD", USDCHF: "USD/CHF",
  NZDUSD: "NZD/USD", EURGBP: "EUR/GBP", EURJPY: "EUR/JPY", GBPJPY: "GBP/JPY",
  XAUUSD: "XAU/USD",
};

// Always trade XAUUSD (has its own ICT strategy, not scored)
const ALWAYS_TRADE = ["XAUUSD"];

// Pool of candidates scored each Sunday — top 13 by trend strength + XAUUSD = 14 active
const SYMBOL_POOL = [
  // Forex majors + crosses
  "EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURJPY","GBPJPY",
  // Tech / growth stocks (Twelve Data uses ticker directly)
  "AAPL","TSLA","NVDA","MSFT","GOOGL","AMZN","META",
  "NFLX","AMD","QCOM","CRM","DDOG","AVGO","SPOT",
  "UBER","SHOP","COIN","PLTR","SNOW","SQ",
];

const FOREX_PAIRS = new Set(["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURJPY","GBPJPY"]);
function assetClass(symbol) {
  if (symbol.includes("XAU") || symbol.includes("XAG")) return "commodity";
  if (FOREX_PAIRS.has(symbol)) return "forex";
  return "stock"; // any other symbol (AAPL, QCOM, DDOG, etc.)
}

// ─── Market Data (Twelve Data) ────────────────────────────────────────────────

const INTERVAL_MAP = { "1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1H":"1h","4H":"4h","1D":"1day" };

async function fetchCandles(symbol, limit = 100) {
  const tdSym    = TD_SYMBOL[symbol] || symbol;
  const interval = INTERVAL_MAP[CONFIG.timeframe] || "5min";
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${interval}&outputsize=${limit}&order=ASC&apikey=${CONFIG.tdApiKey}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.status === "error") throw new Error(`Twelve Data: ${json.message}`);
  if (!json.values?.length)    throw new Error(`No candle data for ${symbol}`);
  return json.values.map(v => ({
    time:   new Date(v.datetime).getTime(),
    open:   parseFloat(v.open),   high:  parseFloat(v.high),
    low:    parseFloat(v.low),    close: parseFloat(v.close),
    volume: parseFloat(v.volume || 0),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  const diffs   = closes.slice(-period - 1).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const avgGain = diffs.map(d => d > 0 ? d : 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = diffs.map(d => d < 0 ? -d : 0).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const session  = candles.filter(c => c.time >= midnight.getTime());
  // Fall back to all candles if no intraday data yet (e.g. outside market hours)
  const src      = session.length >= 3 ? session : candles.slice(-20);
  if (!src.length) return null;
  const cumVol = src.reduce((s, c) => s + c.volume, 0);
  // If no volume data (forex), use equal-weighted average of typical price
  if (cumVol === 0) return src.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / src.length;
  const cumTPV = src.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  return cumTPV / cumVol;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low  - candles[i].close)
  ));
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Weekly Pair Scanner ─────────────────────────────────────────────────────

function isWatchlistStale() {
  if (!existsSync(WATCHLIST_FILE)) return true;
  const { updatedAt } = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
  return Date.now() - new Date(updatedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
}

async function scoreSymbol(symbol) {
  try {
    const candles = await fetchCandles(symbol, 50);
    const closes  = candles.map(c => c.close);
    const ema9    = calcEMA(closes, 9);
    const ema21   = calcEMA(closes, 21);
    return Math.abs(ema9 - ema21) / ema21 * 100; // trend strength %
  } catch {
    return 0;
  }
}

async function refreshWatchlist() {
  const isSunday = new Date().getUTCDay() === 0;
  if (!isSunday && !isWatchlistStale()) return;

  console.log("[Watchlist] Sunday scan — scoring 30 symbols for trend strength...");
  const scores = [];
  for (const sym of SYMBOL_POOL) {
    const score = await scoreSymbol(sym);
    console.log(`  ${sym.padEnd(8)} EMA spread: ${score.toFixed(3)}%`);
    scores.push({ sym, score });
    await new Promise(r => setTimeout(r, 8000)); // 8s gap → ~7.5 calls/min, safe under free tier
  }

  const top13 = scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 13)
    .map(s => s.sym);

  const pairs = [...ALWAYS_TRADE, ...top13];
  writeFileSync(WATCHLIST_FILE, JSON.stringify({ pairs, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`[Watchlist] Active symbols: ${pairs.join(", ")}`);
}

function getActiveSymbols() {
  if (existsSync(WATCHLIST_FILE)) {
    const wl = JSON.parse(readFileSync(WATCHLIST_FILE, "utf8"));
    if (wl.pairs?.length) return wl.pairs;
  }
  return CONFIG.symbols;
}

// ─── ICT Silver Bullet (XAUUSD only) ─────────────────────────────────────────

function getNYHour() {
  // Returns current NY hour accounting for EDT/EST
  const now = new Date();
  const nyOffset = isDST(now) ? -4 : -5;
  return ((now.getUTCHours() + nyOffset + 24) % 24) + now.getUTCMinutes() / 60;
}

function isDST(date) {
  // US DST: second Sunday March → first Sunday November
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function isInSilverBulletWindow() {
  const nyH  = getNYHour();
  const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  return (utcH >= 8 && utcH < 10) || // London open (08–10 UTC)
         (nyH >= 3  && nyH < 4)   || // 3–4 AM NY
         (nyH >= 10 && nyH < 11)  || // 10–11 AM NY
         (nyH >= 14 && nyH < 15);    // 2–3 PM NY
}

function detectFVG(candles) {
  for (let i = candles.length - 1; i >= 2; i--) {
    const prev2 = candles[i - 2];
    const curr  = candles[i];
    if (curr.low > prev2.high)
      return { type: "bullish", top: curr.low, bottom: prev2.high, mid: (curr.low + prev2.high) / 2, index: i };
    if (curr.high < prev2.low)
      return { type: "bearish", top: prev2.low, bottom: curr.high, mid: (prev2.low + curr.high) / 2, index: i };
  }
  return null;
}

function runSilverBulletCheck(candles) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const price   = candles[candles.length - 1].close;
  const inWindow = isInSilverBulletWindow();
  const nyH      = getNYHour().toFixed(2);

  check(`Silver Bullet window (London 08–10 UTC / 3–4AM / 10–11AM / 2–3PM NY) — now ${nyH} NY`, inWindow);

  const fvg = detectFVG(candles.slice(-15));
  check("Fair Value Gap detected in last 15 candles", !!fvg);

  if (!fvg) return { results, allPass: false, side: null, fvg: null };

  const inFVG = price >= fvg.bottom && price <= fvg.top;
  check(`Price retracing into FVG (${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)})`, inFVG);
  console.log(`  ℹ️  FVG direction: ${fvg.type.toUpperCase()}`);

  const allPass = results.every(r => r.pass);
  const side    = fvg.type === "bullish" ? "buy" : "sell";
  return { results, allPass, side, fvg };
}

// ─── NYSE Tech Stock Strategy — EMA Cross + VWAP Bounce ──────────────────────

function isInNYSESession() {
  // NYSE: 9:35 AM–3:30 PM NY (skip first 5 min of open)
  const nyH = getNYHour();
  return nyH >= 9.583 && nyH < 15.5; // 9:35–15:30
}

function runStockCheck(symbol, candles) {
  const results = [];
  const check   = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema9     = calcEMA(closes, 9);
  const ema21    = calcEMA(closes, 21);
  const rsi14    = calcRSI(closes, 14);
  const vwap     = calcVWAP(candles);

  console.log(`  EMA(9): ${ema9.toFixed(3)} | EMA(21): ${ema21.toFixed(3)} | RSI(14): ${rsi14 ? rsi14.toFixed(1) : "N/A"}`);

  check("NYSE session (9:35 AM–3:30 PM NY)", isInNYSESession());

  const bullish = price > vwap && ema9 > ema21;
  const bearish = price < vwap && ema9 < ema21;

  if (bullish) {
    check("Price above VWAP — buyers in control", true);
    check("EMA(9) above EMA(21) — uptrend confirmed", true);
    check("RSI(14) in momentum zone (45–65)", rsi14 !== null && rsi14 >= 45 && rsi14 <= 65);
    check("Price within 1.0% of VWAP — near value area", vwap ? Math.abs((price - vwap) / vwap) < 0.010 : false);
  } else if (bearish) {
    check("Price below VWAP — sellers in control", true);
    check("EMA(9) below EMA(21) — downtrend confirmed", true);
    check("RSI(14) in momentum zone (35–55)", rsi14 !== null && rsi14 >= 35 && rsi14 <= 55);
    check("Price within 1.0% of VWAP — near value area", vwap ? Math.abs((price - vwap) / vwap) < 0.010 : false);
  } else {
    check("Market bias — EMA(9)/EMA(21) + VWAP alignment required", false);
  }

  const allPass = results.every(r => r.pass);
  const side    = bullish ? "buy" : bearish ? "sell" : null;
  return { results, allPass, side };
}

// ─── Forex Combo Strategy — Breakout + EMA Cross + FVG ───────────────────────

function getPreSessionRange(candles, fromUTCHour, toUTCHour) {
  // Filter candles by UTC hour range; supports wrap-around midnight (e.g. 22–0)
  const src = candles.filter(c => {
    const h = new Date(c.time).getUTCHours() + new Date(c.time).getUTCMinutes() / 60;
    return fromUTCHour < toUTCHour
      ? h >= fromUTCHour && h < toUTCHour
      : h >= fromUTCHour || h < toUTCHour; // wraps midnight
  });
  if (src.length < 3) return null;
  return {
    high: Math.max(...src.map(c => c.high)),
    low:  Math.min(...src.map(c => c.low)),
  };
}

function runForexComboCheck(symbol, candles) {
  const results  = [];
  const check    = (label, pass) => { results.push({ label, pass }); console.log(`  ${pass ? "✅" : "🚫"} ${label}`); };

  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const ema9     = calcEMA(closes, 9);
  const ema21    = calcEMA(closes, 21);
  const rsi14    = calcRSI(closes, 14);

  // Determine active session and its pre-session range
  const utcH    = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  const inAsia   = symbol === "USDJPY" && utcH >= 0 && utcH < 7;  // Tokyo 00–07 UTC (USDJPY only)
  const inLondon = utcH >= 8 && utcH < 16;                         // Full London 08–16 UTC
  const inNY     = utcH >= 13 && utcH < 21;                        // Full NY 13–21 UTC

  const sessionLabel = symbol === "USDJPY"
    ? "Asia (00–07 UTC) or London (08–16 UTC) or NY (13–21 UTC)"
    : "London (08–16 UTC) or NY (13–21 UTC)";
  check(sessionLabel, inAsia || inLondon || inNY);

  const range = inAsia
    ? getPreSessionRange(candles, 22, 0)    // 22:00–00:00 UTC (wraps midnight)
    : inLondon
    ? getPreSessionRange(candles, 6,  8)    // 06:00–08:00 UTC
    : inNY
    ? getPreSessionRange(candles, 11, 13)   // 11:00–13:00 UTC
    : null;

  const bullish = ema9 > ema21 && price > (range?.high ?? price);
  const bearish = ema9 < ema21 && price < (range?.low  ?? price);

  if (range) {
    console.log(`  Range: ${range.low.toFixed(5)}–${range.high.toFixed(5)} | EMA(9): ${ema9.toFixed(5)} | EMA(21): ${ema21.toFixed(5)} | RSI(14): ${rsi14?.toFixed(1) ?? "N/A"}`);
    if (bullish) {
      check(`Breakout above pre-session high (${range.high.toFixed(5)})`, price > range.high);
    } else if (bearish) {
      check(`Breakout below pre-session low (${range.low.toFixed(5)})`, price < range.low);
    } else {
      check("Breakout above/below pre-session range", false);
    }
  } else {
    check("Pre-session range defined (need data from 2h before session)", false);
  }

  if (bullish) {
    check("EMA(9) above EMA(21) — uptrend aligned", true);
    check("RSI(14) in momentum zone (45–65)", rsi14 !== null && rsi14 >= 45 && rsi14 <= 65);
  } else if (bearish) {
    check("EMA(9) below EMA(21) — downtrend aligned", true);
    check("RSI(14) in momentum zone (35–55)", rsi14 !== null && rsi14 >= 35 && rsi14 <= 55);
  } else {
    check("EMA(9/21) trend aligned with breakout direction", false);
    check("RSI(14) in momentum zone", false);
  }

  // FVG in direction of trade
  const fvg = detectFVG(candles.slice(-15));
  const fvgAligned = fvg &&
    ((bullish && fvg.type === "bullish") ||
     (bearish && fvg.type === "bearish"));

  if (fvg) {
    check(`FVG aligned with direction — ${fvg.type} gap (${fvg.bottom.toFixed(5)}–${fvg.top.toFixed(5)})`, fvgAligned);
  } else {
    check("FVG in trade direction detected", false);
  }

  const allPass = results.every(r => r.pass);
  const side    = bullish ? "buy" : bearish ? "sell" : null;
  return { results, allPass, side, fvg: fvgAligned ? fvg : null };
}

// ─── Position Tracking ────────────────────────────────────────────────────────

function loadPositions() { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }

function addPosition(symbol, side, price, qty, orderId, paper, fvg = null, atr = null) {
  let sl, tp;
  const cls = assetClass(symbol);

  if (cls === "commodity" && fvg) {
    // ICT Silver Bullet: SL beyond FVG edge + small buffer, TP at 2:1
    const buf  = atr ? atr * 0.3 : 2.0;
    sl = side === "buy"  ? fvg.bottom - buf : fvg.top + buf;
    const risk = Math.abs(price - sl);
    tp = side === "buy"  ? price + risk * 2  : price - risk * 2;
  } else if (cls === "stock") {
    // ATR-based: 1.5× ATR SL, 3× ATR TP (2:1 RR)
    const dist = atr ? atr * 1.5 : price * 0.005;
    sl = side === "buy" ? price - dist : price + dist;
    tp = side === "buy" ? price + dist * 2 : price - dist * 2;
  } else {
    // Forex: FVG-anchored SL if available, else 1.5× ATR, TP always 2:1
    let risk;
    if (fvg) {
      const buf = atr ? atr * 0.2 : price * 0.0005;
      sl   = side === "buy" ? fvg.bottom - buf : fvg.top + buf;
      risk = Math.abs(price - sl);
    } else {
      risk = atr ? atr * 1.5 : price * 0.0025;
      sl   = side === "buy" ? price - risk : price + risk;
    }
    tp = side === "buy" ? price + risk * 2 : price - risk * 2;
  }

  const pos = loadPositions();
  pos.push({ symbol, side, entryPrice: price, quantity: qty, orderId, sl, tp, slMoved: false, paperTrading: paper, openedAt: new Date().toISOString() });
  savePositions(pos);
}

function checkAndClosePositions(symbol, price) {
  const positions = loadPositions(), remaining = [], closed = [];
  for (const pos of positions) {
    if (pos.symbol !== symbol) { remaining.push(pos); continue; }
    const isLong = pos.side === "buy";

    // Trailing stop: move SL to breakeven once 50% of TP progress is reached
    if (!pos.slMoved) {
      const tpDist  = Math.abs(pos.tp - pos.entryPrice);
      const moved   = isLong ? price - pos.entryPrice : pos.entryPrice - price;
      if (tpDist > 0 && moved / tpDist >= 0.5) {
        pos.sl      = pos.entryPrice;
        pos.slMoved = true;
        console.log(`  🔒 ${symbol} SL moved to breakeven @ ${pos.entryPrice.toFixed(5)}`);
      }
    }

    const hitTP = isLong ? price >= pos.tp : price <= pos.tp;
    const hitSL = isLong ? price <= pos.sl : price >= pos.sl;
    if (hitTP || hitSL) {
      const exit   = hitTP ? pos.tp : pos.sl;
      const pnlUSD = isLong ? (exit - pos.entryPrice) * pos.quantity : (pos.entryPrice - exit) * pos.quantity;
      const pnlPct = ((exit - pos.entryPrice) / pos.entryPrice) * (isLong ? 100 : -100);
      closed.push({ ...pos, exitPrice: exit, exitTime: new Date().toISOString(), pnlUSD, pnlPct, result: hitTP ? "WIN" : "LOSS" });
    } else {
      remaining.push(pos);
    }
  }
  savePositions(remaining);
  return closed;
}

// ─── Trade Log ────────────────────────────────────────────────────────────────

function loadLog()  { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(l) { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function todayCount(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced).length;
}

const CSV_HEADERS = "Date,Time (UTC),Broker,Symbol,Asset Class,Side,Quantity,Entry Price,Total USD,Fee (est.),Order ID,Mode,Status,Exit Price,Exit Time,P&L USD,P&L %,Notes";

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function getDailyPnL() {
  if (!existsSync(CSV_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1)
    .filter(l => l.startsWith(today))
    .reduce((sum, l) => {
      const pnl = parseFloat(l.split(",")[15]);
      return sum + (isNaN(pnl) ? 0 : pnl);
    }, 0);
}

function writeTradeCsv(entry) {
  const now  = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const cls  = assetClass(entry.symbol);
  let row;
  if (!entry.allPass) {
    const reasons = entry.conditions.filter(c => !c.pass).map(c => c.label).join("; ");
    row = [date, time, "Pepperstone", entry.symbol, cls, "", "", entry.price?.toFixed(5) || "", "", "", "BLOCKED", "BLOCKED", "BLOCKED", "", "", "", "", `"Failed: ${reasons}"`].join(",");
  } else {
    const qty = (entry.tradeSize / entry.price).toFixed(6);
    const fee = (entry.tradeSize * 0.0007).toFixed(4);
    row = [date, time, "Pepperstone", entry.symbol, cls, entry.side?.toUpperCase() || "BUY", qty, entry.price?.toFixed(5) || "", entry.tradeSize.toFixed(2), fee, entry.orderId || "", entry.paperTrading ? "PAPER" : "LIVE", "OPEN", "", "", "", "", `"All conditions met"`].join(",");
  }
  appendFileSync(CSV_FILE, row + "\n");
}

function writeCloseCsv(closed) {
  const o   = new Date(closed.openedAt);
  const x   = new Date(closed.exitTime);
  const cls = assetClass(closed.symbol);
  const row = [
    o.toISOString().slice(0,10), o.toISOString().slice(11,19), "Pepperstone",
    closed.symbol, cls, closed.side.toUpperCase(), closed.quantity.toFixed(6),
    closed.entryPrice.toFixed(5), (closed.entryPrice * closed.quantity).toFixed(2),
    (closed.entryPrice * closed.quantity * 0.0007).toFixed(4),
    closed.orderId, closed.paperTrading ? "PAPER" : "LIVE", closed.result,
    closed.exitPrice.toFixed(5), x.toISOString().slice(0,19).replace("T"," "),
    closed.pnlUSD.toFixed(4), closed.pnlPct.toFixed(2) + "%",
    `"${closed.result === "WIN" ? "Take profit hit" : "Stop loss hit"}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`  ${closed.result === "WIN" ? "✅ WIN" : "❌ LOSS"} ${closed.symbol} | P&L: $${closed.pnlUSD.toFixed(4)} (${closed.pnlPct.toFixed(2)}%)`);
}

// ─── Per-Symbol Run ───────────────────────────────────────────────────────────

async function runSymbol(symbol, log) {
  console.log(`\n── ${symbol} (${assetClass(symbol)}) ${"─".repeat(38)}`);

  let candles;
  try { candles = await fetchCandles(symbol, 100); }
  catch (err) { console.log(`  ⚠️  Data error: ${err.message}`); return; }

  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const vwap   = calcVWAP(candles);
  const atr    = calcATR(candles, 14);

  console.log(`  Price: ${price.toFixed(5)} | VWAP: ${vwap ? vwap.toFixed(5) : "N/A"} | ATR(14): ${atr ? atr.toFixed(5) : "N/A"}`);

  const closed = checkAndClosePositions(symbol, price);
  for (const c of closed) writeCloseCsv(c);

  let results, allPass, side, fvg = null;
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.05, CONFIG.maxTradeSizeUSD);

  if (symbol === "XAUUSD") {
    ({ results, allPass, side, fvg } = runSilverBulletCheck(candles));
  } else if (assetClass(symbol) === "stock") {
    ({ results, allPass, side } = runStockCheck(symbol, candles));
  } else {
    // Forex: London Breakout + EMA Cross + FVG combo
    ({ results, allPass, side, fvg } = runForexComboCheck(symbol, candles));
  }

  const entry = { timestamp: new Date().toISOString(), symbol, price, side, tradeSize, conditions: results, allPass, paperTrading: CONFIG.paperTrading, orderPlaced: false, orderId: null };

  if (!allPass) {
    console.log(`  🚫 BLOCKED — ${results.filter(r => !r.pass).map(r => r.label).join("; ")}`);
  } else {
    const qty = tradeSize / price;
    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER TRADE — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)}`);
      if (fvg) console.log(`  📐 FVG: ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} | SL below/above gap | TP 2:1`);
      entry.orderPlaced = true;
      entry.orderId = `PAPER-${Date.now()}`;
      addPosition(symbol, side, price, qty, entry.orderId, true, fvg, atr);
    } else if (isConfigured()) {
      console.log(`  🔴 LIVE ORDER — ${side.toUpperCase()} ${symbol} ~$${tradeSize.toFixed(2)}`);
      try {
        const order = await placeMarketOrder(symbol, side, tradeSize, price);
        entry.orderPlaced = true;
        entry.orderId = order.orderId;
        addPosition(symbol, side, price, qty, order.orderId, false, fvg, atr);
        console.log(`  ✅ Order placed — ID: ${order.orderId}`);
      } catch (err) {
        console.log(`  ❌ Order failed: ${err.message}`);
        entry.error = err.message;
      }
    } else {
      console.log(`  ⏳ cTrader not configured yet — awaiting KYC approval`);
      console.log(`     Once approved: run get-token.mjs then set PAPER_TRADING=false`);
    }
  }

  log.trades.push(entry);
  writeTradeCsv(entry);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!CONFIG.tdApiKey) {
    console.log("⚠️  TWELVE_DATA_API_KEY missing — set it in Railway Variables.");
    return;
  }

  await refreshWatchlist();
  const symbols = getActiveSymbols();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Sameer Trading Bot — Pepperstone");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "PAPER" : "LIVE"} | cTrader: ${isConfigured() ? "Ready" : "Awaiting KYC"}`);
  console.log(`  Symbols: ${symbols.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  initCsv();
  const log = loadLog();

  if (todayCount(log) >= CONFIG.maxTradesPerDay) {
    console.log(`\n🚫 Daily trade limit reached (${CONFIG.maxTradesPerDay}). Stopping.`);
    return;
  }

  const dailyPnL   = getDailyPnL();
  const lossLimit  = -(CONFIG.portfolioValue * CONFIG.dailyLossLimitPct / 100);
  if (dailyPnL <= lossLimit) {
    console.log(`\n🚫 Daily loss limit hit ($${dailyPnL.toFixed(2)} / limit $${lossLimit.toFixed(2)}). Stopping.`);
    return;
  }

  for (const symbol of symbols) {
    if (todayCount(log) >= CONFIG.maxTradesPerDay) break;
    await runSymbol(symbol, log);
    await new Promise(r => setTimeout(r, 5000));
  }

  saveLog(log);
  await exportToExcel().catch(err => console.log(`  ⚠️  Excel export failed: ${err.message}`));
  await syncToSheets().catch(err => console.log(`  ⚠️  Sheets sync failed: ${err.message}`));
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes — keeps Twelve Data under 800 credits/day (14 symbols × 48 runs = 672)

async function loop() {
  await run().catch(err => console.error("Bot cycle error:", err));
  setTimeout(loop, RUN_INTERVAL_MS);
}

loop();
