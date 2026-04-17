@echo off
cd /d "C:\WINDOWS\system32\claude-tradingview-mcp-trading"
start "Trades Watcher" /min node watch-trades.js
