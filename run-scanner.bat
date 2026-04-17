@echo off
cd /d "C:\WINDOWS\system32\Sameer-tradingview-mcp-trading"
"C:\Program Files\nodejs\node.exe" stock-scanner.js >> "C:\Users\spathan\Desktop\sameer-scanner.log" 2>&1
