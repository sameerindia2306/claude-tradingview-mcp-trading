import { readFileSync, existsSync } from "fs";
import ExcelJS from "exceljs";
import "dotenv/config";

const CSV_FILE = process.env.TRADE_LOG_PATH || "C:/Users/spathan/Desktop/sameer-trades.csv";
const OUT_FILE = CSV_FILE.replace(".csv", ".xlsx");

// Asset class → tab config (Asset Class column is index 4)
const TABS = [
  { key: "forex",     label: "Forex",       tabColor: "338833" },
  { key: "commodity", label: "Gold",        tabColor: "FFD600" },
  { key: "stock",     label: "Tech Stocks", tabColor: "1565C0" },
];

const HEADER_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1565C0" } };
const BLOCKED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD50000" } };
const OPEN_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00C853" } };
const WIN_FILL     = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFD600" } };
const LOSS_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF6D00" } };
const stripeFill   = i => ({ type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? "FFF5F5F5" : "FFFFFFFF" } });

const THIN_BORDER = {
  top: { style: "thin", color: { argb: "FF999999" } }, left:  { style: "thin", color: { argb: "FF999999" } },
  bottom: { style: "thin", color: { argb: "FF999999" } }, right: { style: "thin", color: { argb: "FF999999" } },
};
const HEADER_BORDER = {
  top: { style: "medium", color: { argb: "FFFFFFFF" } }, left:  { style: "medium", color: { argb: "FFFFFFFF" } },
  bottom: { style: "medium", color: { argb: "FFFFFFFF" } }, right: { style: "medium", color: { argb: "FFFFFFFF" } },
};

function parseCSV(raw) {
  const rows = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    const cols = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur);
    rows.push(cols.map(c => c.replace(/"/g, "").trim()));
  }
  return rows;
}

function rowFill(status) {
  switch ((status || "").toUpperCase()) {
    case "BLOCKED": return BLOCKED_FILL;
    case "OPEN":    return OPEN_FILL;
    case "WIN":     return WIN_FILL;
    case "LOSS":    return LOSS_FILL;
    default:        return null;
  }
}

function buildSheet(workbook, headers, dataRows, sheetName, tabColor) {
  const ws = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { tabColor: { argb: "FF" + tabColor } },
  });

  ws.columns = headers.map(h => ({ header: h, key: h, width: Math.max(h.length + 4, 14) }));

  // Header row
  const hRow = ws.getRow(1);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = HEADER_BORDER;
  });

  // Data rows
  dataRows.forEach((cols, i) => {
    const exRow = ws.addRow(cols);
    exRow.height = 18;
    const fill      = rowFill(cols[12]);
    const textWhite = (cols[12] || "").toUpperCase() === "BLOCKED";
    exRow.eachCell({ includeEmpty: true }, cell => {
      cell.fill      = fill || stripeFill(i);
      cell.font      = { color: { argb: textWhite ? "FFFFFFFF" : "FF000000" } };
      cell.alignment = { vertical: "middle" };
      cell.border    = THIN_BORDER;
    });
  });
}

async function main() {
  if (!existsSync(CSV_FILE)) { console.log("No trades file found yet."); return; }

  const all     = parseCSV(readFileSync(CSV_FILE, "utf8"));
  if (all.length < 2) { console.log("No trades to export yet."); return; }

  const headers  = all[0];
  const dataRows = all.slice(1);

  // Split rows by Asset Class (column index 4)
  const byClass = { forex: [], commodity: [], stock: [] };
  for (const row of dataRows) {
    const cls = (row[4] || "forex").toLowerCase();
    (byClass[cls] || byClass.forex).push(row);
  }

  const workbook = new ExcelJS.Workbook();

  for (const { key, label, tabColor } of TABS) {
    buildSheet(workbook, headers, byClass[key], label, tabColor);
    console.log(`  ✅ ${label}: ${byClass[key].length} trade(s)`);
  }

  // Legend tab
  const leg = workbook.addWorksheet("Legend", { properties: { tabColor: { argb: "FF607D8B" } } });
  leg.columns = [{ key: "a", width: 22 }, { key: "b", width: 36 }];
  [
    ["Colour",         "Meaning",                              "1565C0", true ],
    ["🔵 Blue header", "Column labels",                        "1565C0", true ],
    ["🟢 Green",       "OPEN — trade placed, awaiting TP/SL", "00C853", false],
    ["🔴 Red",         "BLOCKED — conditions not met",        "D50000", true ],
    ["🟡 Gold",        "WIN — take profit hit",               "FFD600", false],
    ["🟠 Orange",      "LOSS — stop loss hit",                "FF6D00", false],
  ].forEach(([a, b, argb, white]) => {
    const r = leg.addRow([a, b]);
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } };
    r.getCell(1).font = { bold: true, color: { argb: white ? "FFFFFFFF" : "FF000000" } };
    r.eachCell(c => { c.border = THIN_BORDER; c.alignment = { vertical: "middle" }; });
  });

  await workbook.xlsx.writeFile(OUT_FILE);
  console.log(`\n✅ Exported → ${OUT_FILE}  (${dataRows.length} total trades)`);
}

main().catch(console.error);
