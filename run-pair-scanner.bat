@echo off
cd /d "C:\WINDOWS\system32\claude-tradingview-mcp-trading"
"C:\Program Files\nodejs\node.exe" pair-scanner.js >> "C:\Users\spathan\Desktop\pair-scanner.log" 2>&1
