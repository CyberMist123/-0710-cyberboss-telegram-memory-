@echo off
setlocal
echo === Unregister auto-start ===
schtasks /delete /tn "cyberboss-tg-line"      /f 2>nul
schtasks /delete /tn "cyberboss-wechat-line"  /f 2>nul
schtasks /delete /tn "cyberboss-memory-panel" /f 2>nul
schtasks /delete /tn "cyberboss-watchdog"     /f 2>nul
echo.
echo Done. Running processes are NOT stopped.
echo To stop everything now: double-click  zi-stop-all.bat
pause
