@echo off
setlocal
set "HERE=%~dp0"
set "LAUNCHER=%HERE%launcher"

echo === Register auto-start (hidden, on logon) ===
echo.
echo Will register 4 scheduled tasks:
echo   cyberboss-tg-line       - TG line
echo   cyberboss-wechat-line   - WeChat line + shared 8785
echo   cyberboss-memory-panel  - 520 memory panel
echo   cyberboss-watchdog      - watchdog (always on)
echo.

schtasks /create /tn "cyberboss-tg-line"      /sc onlogon /tr "wscript.exe \"%LAUNCHER%\tg-hidden.vbs\""        /rl LIMITED /f
schtasks /create /tn "cyberboss-wechat-line"  /sc onlogon /tr "wscript.exe \"%LAUNCHER%\wechat-hidden.vbs\""    /rl LIMITED /f
schtasks /create /tn "cyberboss-memory-panel" /sc onlogon /tr "wscript.exe \"%LAUNCHER%\dashboard-hidden.vbs\"" /rl LIMITED /f
schtasks /create /tn "cyberboss-watchdog"     /sc onlogon /tr "wscript.exe \"%LAUNCHER%\watchdog-hidden.vbs\""  /rl LIMITED /f

echo.
echo Done. Next logon: all four start silently, no black windows.
echo Check status:  double-click  zi-status.bat  or  self-start-status.bat
echo Unregister:    double-click  zi-cancel.bat  or  self-start-cancel.bat
pause
