import "dotenv/config";

const SYMBOLS = (process.env.SYMBOLS || "ADAUSDT,DOTUSDT,DOGEUSDT,BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,LINKUSDT,AVAXUSDT,MATICUSDT,UNIUSDT,ATOMUSDT,LTCUSDT").split(",").map(s => s.trim());
const TIMEFRAME = "3m";
const SL_PCT = 0.002;
const TP_PCT = 0.006;
const TRADE_SIZE_USD = parseFloat(process.env.MAX_TRADE_SIZE_USD || "25");
const DAYS = 7;
const BINANCE_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT"];

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchAllCandles(symbol) {
  const now = Date.now();
  const from = now - DAYS * 24 * 60 * 60 * 1000;
  return BINANCE_SYMBOLS.includes(symbol)
    ? fetchBinanceAll(symbol, from, now)
    : fetchBitgetAll(symbol, from, now);
}

async function fetchBinanceAll(symbol, from, to) {
  const candles = [];
  let start = from;
  while (start < to) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&startTime=${start}&endTime=${to}&limit=1000`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.length) break;
    data.forEach(k => candles.push({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    start = data[data.length - 1][0] + 1;
    if (data.length < 1000) break;
  }
  return candles;
}

async function fetchBitgetAll(symbol, from, to) {
  const candles = [];
  let end = to;
  while (end > from) {
    const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=5m&endTime=${end}&limit=1000&productType=USDT-FUTURES`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.data || !json.data.length) break;
    const batch = json.data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    batch.sort((a, b) => a.time - b.time);
    const newCandles = batch.filter(c => c.time >= from);
    candles.unshift(...newCandles);
    end = batch[0].time - 1;
    if (batch[0].time <= from) break;
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
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

function backtest(symbol, candles) {
  const trades = [];
  let openTrade = null;

  // Group candles by day (UTC) for VWAP reset
  const dayOf = ts => new Date(ts).toISOString().slice(0, 10);

  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const price = candle.close;

    // Check open trade first
    if (openTrade) {
      const { side, sl, tp, entry, entryTime, qty } = openTrade;
      const hitTP = side === "buy" ? candle.high >= tp : candle.low <= tp;
      const hitSL = side === "buy" ? candle.low <= sl : candle.high >= sl;

      if (hitTP || hitSL) {
        const exit = hitTP ? tp : sl;
        const pnl = side === "buy"
          ? (exit - entry) * qty
          : (entry - exit) * qty;
        trades.push({ symbol, side, entry, exit, entryTime, exitTime: candle.time, pnl, result: hitTP ? "WIN" : "LOSS" });
        openTrade = null;
      }
      continue; // one trade at a time
    }

    // Calculate indicators
    const ema8 = calcEMA(closes, 8);
    const rsi3 = calcRSI(closes, 3);

    // VWAP: use candles from start of same UTC day
    const todayStart = candles.findIndex(c => dayOf(c.time) === dayOf(candle.time));
    const todayCandles = candles.slice(todayStart, i + 1);
    const vwap = calcVWAP(todayCandles);

    if (!rsi3 || !vwap) continue;

    const bullish = price > vwap && price > ema8;
    const bearish = price < vwap && price < ema8;
    const vwapDist = Math.abs(price - vwap) / vwap;

    if (vwapDist > 0.008) continue; // overextended — must be within 0.8% of VWAP

    let side = null;
    // Session filter — London 08:00–10:00 UTC, NY 13:00–16:00 UTC
    const h = new Date(candle.time).getUTCHours();
    const m = new Date(candle.time).getUTCMinutes();
    const t = h * 60 + m;
    const inSession = (t >= 480 && t < 600) || (t >= 780 && t < 960);
    if (!inSession) continue;

    // Volume spike filter
    if (candles.length < i + 1 || i < 20) continue;
    const avgVol = candles.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio = avgVol === 0 ? 0 : candle.volume / avgVol;
    if (volRatio < 1.2) continue;

    if (bullish && rsi3 < 20) side = "buy";
    else if (bearish && rsi3 > 80) side = "sell";

    if (side) {
      const sl = side === "buy" ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
      const tp = side === "buy" ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
      const qty = TRADE_SIZE_USD / price;
      openTrade = { side, entry: price, sl, tp, entryTime: candle.time, qty };
    }
  }

  return trades;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function report(symbol, trades) {
  const wins = trades.filter(t => t.result === "WIN");
  const losses = trades.filter(t => t.result === "LOSS");
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0";
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ${symbol}`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Total signals     : ${trades.length}`);
  console.log(`  Wins / Losses     : ${wins.length} / ${losses.length}`);
  console.log(`  Win rate          : ${winRate}%`);
  console.log(`  Total P&L         : $${totalPnL.toFixed(2)}`);
  console.log(`  Avg win           : $${avgWin.toFixed(2)}`);
  console.log(`  Avg loss          : $${avgLoss.toFixed(2)}`);
  console.log(`  Best trade        : $${trades.length ? Math.max(...trades.map(t => t.pnl)).toFixed(2) : "N/A"}`);
  console.log(`  Worst trade       : $${trades.length ? Math.min(...trades.map(t => t.pnl)).toFixed(2) : "N/A"}`);

  // Monthly breakdown (last 4 weeks)
  const weeks = [0, 1, 2, 3].map(w => {
    const now = Date.now();
    const wStart = now - (w + 1) * 7 * 24 * 60 * 60 * 1000;
    const wEnd = now - w * 7 * 24 * 60 * 60 * 1000;
    const wTrades = trades.filter(t => t.entryTime >= wStart && t.entryTime < wEnd);
    const wPnL = wTrades.reduce((s, t) => s + t.pnl, 0);
    const wWins = wTrades.filter(t => t.result === "WIN").length;
    return { label: `Week -${w + 1}`, count: wTrades.length, wins: wWins, pnl: wPnL };
  }).reverse();

  console.log(`\n  Weekly breakdown:`);
  weeks.forEach(w => {
    const wr = w.count ? (w.wins / w.count * 100).toFixed(0) : "0";
    const pnlStr = w.pnl >= 0 ? `+$${w.pnl.toFixed(2)}` : `-$${Math.abs(w.pnl).toFixed(2)}`;
    console.log(`    ${w.label}  ${w.count} trades  ${wr}% WR  ${pnlStr}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const fromDate = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  BACKTEST — Last ${DAYS} Days (${fromDate} → ${toDate})`);
  console.log(`  Strategy: VWAP + RSI(3) + EMA(8) Scalp | ${TIMEFRAME}`);
  console.log(`  SL: 0.3%  |  TP: 0.6%  |  Trade size: $${TRADE_SIZE_USD}`);
  console.log(`${"═".repeat(55)}`);

  let grandTotal = 0, grandWins = 0, grandLosses = 0;

  for (const symbol of SYMBOLS) {
    process.stdout.write(`\n  Fetching ${symbol}...`);
    const candles = await fetchAllCandles(symbol);
    process.stdout.write(` ${candles.length} candles\n`);
    const trades = backtest(symbol, candles);
    grandTotal += trades.length;
    grandWins += trades.filter(t => t.result === "WIN").length;
    grandLosses += trades.filter(t => t.result === "LOSS").length;
    report(symbol, trades);
  }

  const grandPnL = grandWins * TRADE_SIZE_USD * TP_PCT - grandLosses * TRADE_SIZE_USD * SL_PCT;
  console.log(`\n${"═".repeat(55)}`);
  console.log(`  OVERALL SUMMARY`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  Total signals     : ${grandTotal}`);
  console.log(`  Total wins        : ${grandWins}`);
  console.log(`  Total losses      : ${grandLosses}`);
  console.log(`  Overall win rate  : ${grandTotal ? (grandWins / grandTotal * 100).toFixed(1) : 0}%`);
  console.log(`  Estimated P&L     : $${grandPnL.toFixed(2)}`);
  console.log(`${"═".repeat(55)}\n`);
}

main().catch(console.error);
