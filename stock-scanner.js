/**
 * Tech Stock Auto-Scanner
 * Runs every Sunday. Backtests ~35 major tech stocks using the
 * EMA(9/21) + VWAP strategy, keeps winners (WR ≥ 40%), and
 * updates SYMBOLS in .env automatically.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const BACKTEST_DAYS  = 7;
const MIN_WIN_RATE   = 0.40;
const MIN_SIGNALS    = 3;
const MAX_STOCKS     = 10;   // max tech stocks in watchlist at once
const SL_PCT         = 0.003;
const TP_PCT         = 0.006;
const TIMEFRAME      = "5min";
const TD_API_KEY     = process.env.TWELVE_DATA_API_KEY;

// Always keep these regardless of backtest result
const CORE_STOCKS = ["AAPL", "TSLA", "NVDA"];

// Universe of tech stocks to scan
const UNIVERSE = [
  // Mega-cap tech
  "AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA",
  // Semiconductors
  "AMD","INTC","QCOM","AVGO","MU","ARM","AMAT","KLAC",
  // Software / Cloud
  "CRM","ORCL","ADBE","NOW","INTU","SNOW","PLTR","DDOG",
  // Fintech
  "PYPL","SQ","COIN",
  // Consumer tech
  "NFLX","UBER","SHOP","SPOT","RBLX",
  // Hardware / EV adjacent
  "SMCI","DELL","HPQ",
];

// ─── Twelve Data Candles ──────────────────────────────────────────────────────

async function fetchCandles(symbol) {
  const endDate   = new Date();
  const startDate = new Date(endDate - BACKTEST_DAYS * 24 * 60 * 60 * 1000);
  const start     = startDate.toISOString().slice(0, 10);
  const end       = endDate.toISOString().slice(0, 10);

  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${TIMEFRAME}&start_date=${start}&end_date=${end}&order=ASC&outputsize=5000&timezone=UTC&apikey=${TD_API_KEY}`;
  const res  = await fetch(url);
  const json = await res.json();

  if (json.status === "error" || !json.values?.length) return null;
  return json.values.map(v => ({
    time:   new Date(v.datetime.replace(" ", "T") + "Z").getTime(),
    open:   parseFloat(v.open),
    high:   parseFloat(v.high),
    low:    parseFloat(v.low),
    close:  parseFloat(v.close),
    volume: parseFloat(v.volume || 0),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const diffs   = closes.slice(-period - 1).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const avgGain = diffs.map(d => d > 0 ? d : 0).reduce((a, b) => a + b, 0) / period;
  const avgLoss = diffs.map(d => d < 0 ? -d : 0).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const cumVol = candles.reduce((s, c) => s + c.volume, 0);
  if (cumVol === 0) return candles.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / candles.length;
  return candles.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / cumVol;
}

function isNYSESession(timestamp) {
  const date  = new Date(timestamp);
  const day   = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  // Approximate EDT (UTC-4): 9:35–15:30 NY = 13:35–19:30 UTC
  const utcMins = date.getUTCHours() * 60 + date.getUTCMinutes();
  return utcMins >= 815 && utcMins < 1170;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

function backtest(candles) {
  let wins = 0, losses = 0, openTrade = null;

  for (let i = 25; i < candles.length; i++) {
    const c      = candles[i];
    const closes = candles.slice(0, i + 1).map(x => x.close);

    // Check open trade first
    if (openTrade) {
      const { side, sl, tp } = openTrade;
      if (side === "buy"  ? c.high >= tp : c.low  <= tp) { wins++;   openTrade = null; continue; }
      if (side === "buy"  ? c.low  <= sl : c.high >= sl) { losses++; openTrade = null; continue; }
      continue;
    }

    if (!isNYSESession(c.time)) continue;

    const ema9  = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const rsi14 = calcRSI(closes, 14);
    const vwap  = calcVWAP(candles.slice(Math.max(0, i - 50), i + 1));
    if (!ema9 || !ema21 || !rsi14 || !vwap) continue;

    const price   = c.close;
    const bullish = price > vwap && ema9 > ema21;
    const bearish = price < vwap && ema9 < ema21;

    // Volume spike
    const avgVol = candles.slice(i - 20, i).reduce((s, x) => s + x.volume, 0) / 20;
    if (avgVol === 0 || c.volume / avgVol < 1.5) continue;

    // VWAP proximity
    if (Math.abs((price - vwap) / vwap) > 0.005) continue;

    let side = null;
    if (bullish && rsi14 >= 45 && rsi14 <= 65) side = "buy";
    if (bearish && rsi14 >= 35 && rsi14 <= 55) side = "sell";
    if (!side) continue;

    const sl = side === "buy" ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
    const tp = side === "buy" ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
    openTrade = { side, sl, tp };
  }

  return { wins, losses, total: wins + losses };
}

// ─── Update .env ──────────────────────────────────────────────────────────────

function updateEnv(stockSymbols) {
  let env = readFileSync(".env", "utf8");

  // Preserve existing non-stock symbols (forex + gold)
  const existingSymbols = (env.match(/^SYMBOLS=(.*)$/m)?.[1] || "").split(",").map(s => s.trim());
  const nonStocks = existingSymbols.filter(s =>
    !UNIVERSE.includes(s) && !CORE_STOCKS.includes(s)
  );

  const finalSymbols = [...new Set([...nonStocks, ...stockSymbols])];
  env = env.replace(/^SYMBOLS=.*/m, `SYMBOLS=${finalSymbols.join(",")}`);
  writeFileSync(".env", env);
  return finalSymbols;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TECH STOCK SCANNER — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`  Backtesting ${UNIVERSE.length} stocks over last ${BACKTEST_DAYS} days`);
  console.log(`${"═".repeat(60)}\n`);

  if (!TD_API_KEY) { console.log("❌ TWELVE_DATA_API_KEY not set in .env"); return; }

  const results = [];

  for (const symbol of UNIVERSE) {
    process.stdout.write(`  Testing ${symbol.padEnd(6)}...`);
    try {
      const candles = await fetchCandles(symbol);
      if (!candles || candles.length < 50) { process.stdout.write(" ⚠️  insufficient data\n"); continue; }

      const { wins, losses, total } = backtest(candles);
      const wr = total > 0 ? wins / total : 0;
      process.stdout.write(` ${total} signals, ${(wr * 100).toFixed(0)}% WR\n`);
      results.push({ symbol, wins, losses, total, wr });
    } catch (err) {
      process.stdout.write(` skipped (${err.message})\n`);
    }
    // Twelve Data rate limit: 8 req/min → ~8s between calls
    await new Promise(r => setTimeout(r, 8000));
  }

  // Select winners
  const winners = results
    .filter(r => r.total >= MIN_SIGNALS && r.wr >= MIN_WIN_RATE)
    .sort((a, b) => b.wr - a.wr)
    .slice(0, MAX_STOCKS);

  const winnerSymbols = winners.map(r => r.symbol);
  const finalStocks   = [...new Set([...winnerSymbols, ...CORE_STOCKS])];

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  RESULTS — Tech stocks selected (WR ≥ ${MIN_WIN_RATE * 100}%)\n`);
  winners.forEach(r => console.log(`  ✅ ${r.symbol.padEnd(8)} ${(r.wr * 100).toFixed(1)}% WR  (${r.wins}W / ${r.losses}L)`));
  CORE_STOCKS.filter(s => !winnerSymbols.includes(s)).forEach(s =>
    console.log(`  📌 ${s.padEnd(8)} always included (core stock)`)
  );
  results.filter(r => r.total >= MIN_SIGNALS && r.wr < MIN_WIN_RATE).forEach(r =>
    console.log(`  ❌ ${r.symbol.padEnd(8)} ${(r.wr * 100).toFixed(1)}% WR — removed`)
  );

  const allSymbols = updateEnv(finalStocks);

  console.log(`\n  Final stock watchlist: ${finalStocks.join(", ")}`);
  console.log(`  Full SYMBOLS in .env:  ${allSymbols.join(", ")}`);
  console.log(`\n  .env updated ✅`);
  console.log(`  Next scan: next Sunday at 00:00`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(console.error);
