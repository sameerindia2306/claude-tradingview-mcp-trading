import chokidar from "chokidar";
import { execSync } from "child_process";
import "dotenv/config";

const CSV_FILE = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";

console.log("👀 Watching sameer-trades.csv for changes...");
console.log(`   File: ${CSV_FILE}`);
console.log("   Excel regenerates automatically on every new trade.\n");

let debounce = null;

chokidar.watch(CSV_FILE, { persistent: true, ignoreInitial: true }).on("change", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log(`[${new Date().toISOString()}] sameer-trades.csv updated — regenerating Excel...`);
    try {
      execSync("node export-excel.js", { cwd: "C:/WINDOWS/system32/Sameer-tradingview-mcp-trading", stdio: "inherit" });
      console.log("   ✅ sameer-trades.xlsx refreshed\n");
    } catch (err) {
      console.log(`   ❌ Export failed: ${err.message}\n`);
    }
  }, 500);
});
