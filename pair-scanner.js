/**
 * Auto Pair Scanner
 * Runs every Sunday. Fetches top Binance USDT pairs by volume,
 * backtests each one, keeps winners (WR > 40%), updates SYMBOLS
 * in .env and Railway automatically.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const BACKTEST_DAYS     = 7;
const MIN_24H_VOLUME    = 50_000_000;  // $50M min liquidity
const MAX_PAIRS_TO_TEST = 30;          // test top 30 by volume
const MIN_WIN_RATE      = 0.40;        // keep pairs with ≥40% WR
const MIN_SIGNALS       = 3;           // ignore pairs with too few signals
const SL_PCT            = 0.002;
const TP_PCT            = 0.006;
const TIMEFRAME         = "3m";

// Always keep these core pairs regardless of backtest result
const ALWAYS_INCLUDE = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];

// ─── Binance Data ─────────────────────────────────────────────────────────────

async function getTopPairs() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  const tickers = await res.json();
  return tickers
    .filter(t =>
      t.symbol.endsWith("USDT") &&
      !t.symbol.includes("UP") &&
      !t.symbol.includes("DOWN") &&
      !t.symbol.includes("BEAR") &&
      !t.symbol.includes("BULL") &&
      parseFloat(t.quoteVolume) >= MIN_24H_VOLUME
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, MAX_PAIRS_TO_TEST)
    .map(t => t.symbol);
}

async function fetchCandles(symbol, from, to) {
  const candles = [];
  let start = from;
  while (start < to) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&startTime=${start}&endTime=${to}&limit=1000`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    data.forEach(k => candles.push({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    start = data[data.length - 1][0] + 1;
    if (data.length < 1000) break;
  }
  return candles;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  const diffs = closes.slice(-period - 1).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const gains = diffs.map(d => d > 0 ? d : 0);
  const losses = diffs.map(d => d < 0 ? -d : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
  let cumTPV = 0, cumVol = 0;
  const day = dayOf(candles[candles.length - 1].time);
  for (const c of candles.filter(c => dayOf(c.time) === day)) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

function backtest(candles) {
  let wins = 0, losses = 0, openTrade = null;

  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];

    if (openTrade) {
      const { side, sl, tp } = openTrade;
      const hitTP = side === "buy" ? candle.high >= tp : candle.low <= tp;
      const hitSL = side === "buy" ? candle.low <= sl : candle.high >= sl;
      if (hitTP) { wins++; openTrade = null; }
      else if (hitSL) { losses++; openTrade = null; }
      continue;
    }

    const closes = candles.slice(0, i + 1).map(c => c.close);
    const price = candle.close;
    const ema8 = calcEMA(closes, 8);
    const rsi3 = calcRSI(closes, 3);
    const vwap = calcVWAP(candles.slice(0, i + 1));
    if (!rsi3 || !vwap) continue;

    // Session filter
    const h = new Date(candle.time).getUTCHours();
    const m = new Date(candle.time).getUTCMinutes();
    const t = h * 60 + m;
    if (!((t >= 480 && t < 600) || (t >= 780 && t < 960))) continue;

    // VWAP distance
    if (Math.abs((price - vwap) / vwap) > 0.008) continue;

    // Volume spike
    if (i < 20) continue;
    const avgVol = candles.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20;
    if (avgVol === 0 || candle.volume / avgVol < 1.2) continue;

    const bullish = price > vwap && price > ema8;
    const bearish = price < vwap && price < ema8;

    let side = null;
    if (bullish && rsi3 < 20) side = "buy";
    else if (bearish && rsi3 > 80) side = "sell";
    if (!side) continue;

    const sl = side === "buy" ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
    const tp = side === "buy" ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
    openTrade = { side, sl, tp };
  }

  return { wins, losses, total: wins + losses };
}

// ─── Update Config ────────────────────────────────────────────────────────────

function updateEnv(symbols) {
  let env = readFileSync(".env", "utf8");
  env = env.replace(/^SYMBOLS=.*/m, `SYMBOLS=${symbols.join(",")}`);
  writeFileSync(".env", env);
}

function updateRailway(symbols) {
  try {
    execSync(`railway variables set SYMBOLS="${symbols.join(",")}" --service "zippy-communication"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function updateRulesJson(symbols) {
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  rules.watchlist = symbols;
  writeFileSync("rules.json", JSON.stringify(rules, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString();
  console.log(`\n${"═".repeat(58)}`);
  console.log(`  AUTO PAIR SCANNER — ${now.slice(0, 10)}`);
  console.log(`  Scanning Binance for best USDT pairs (last ${BACKTEST_DAYS} days)`);
  console.log(`${"═".repeat(58)}`);

  console.log(`\n  Fetching top ${MAX_PAIRS_TO_TEST} pairs by 24h volume...`);
  const candidates = await getTopPairs();
  console.log(`  Found: ${candidates.join(", ")}\n`);

  const from = Date.now() - BACKTEST_DAYS * 24 * 60 * 60 * 1000;
  const to   = Date.now();
  const results = [];

  for (const symbol of candidates) {
    process.stdout.write(`  Testing ${symbol}...`);
    try {
      const candles = await fetchCandles(symbol, from, to);
      const { wins, losses, total } = backtest(candles);
      const wr = total > 0 ? wins / total : 0;
      process.stdout.write(` ${total} signals, ${(wr * 100).toFixed(0)}% WR\n`);
      results.push({ symbol, wins, losses, total, wr });
    } catch {
      process.stdout.write(` skipped (no data)\n`);
    }
  }

  // Select winners
  const winners = results
    .filter(r => r.total >= MIN_SIGNALS && r.wr >= MIN_WIN_RATE)
    .sort((a, b) => b.wr - a.wr);

  // Always include core pairs even if they didn't pass backtest
  const winnerSymbols = winners.map(r => r.symbol);
  const finalSymbols = [...new Set([...winnerSymbols, ...ALWAYS_INCLUDE])];

  console.log(`\n${"─".repeat(58)}`);
  console.log(`  RESULTS — Pairs selected (WR ≥ ${MIN_WIN_RATE * 100}%)\n`);
  winners.forEach(r => {
    console.log(`  ✅ ${r.symbol.padEnd(12)} ${(r.wr * 100).toFixed(1)}% WR  (${r.wins}W / ${r.losses}L)`);
  });
  ALWAYS_INCLUDE.filter(s => !winnerSymbols.includes(s)).forEach(s => {
    console.log(`  📌 ${s.padEnd(12)} always included (core pair)`);
  });
  results.filter(r => r.total >= MIN_SIGNALS && r.wr < MIN_WIN_RATE).forEach(r => {
    console.log(`  ❌ ${r.symbol.padEnd(12)} ${(r.wr * 100).toFixed(1)}% WR — removed`);
  });

  console.log(`\n  Final watchlist (${finalSymbols.length} pairs):`);
  console.log(`  ${finalSymbols.join(", ")}`);

  // Apply updates
  updateEnv(finalSymbols);
  updateRulesJson(finalSymbols);
  const railwayOk = updateRailway(finalSymbols);

  console.log(`\n  .env updated          ✅`);
  console.log(`  rules.json updated    ✅`);
  console.log(`  Railway updated       ${railwayOk ? "✅" : "⚠️  (run manually: railway variables set SYMBOLS=...)"}`);
  console.log(`\n  Next scan: next Sunday at 00:00 UTC`);
  console.log(`${"═".repeat(58)}\n`);
}

main().catch(console.error);
