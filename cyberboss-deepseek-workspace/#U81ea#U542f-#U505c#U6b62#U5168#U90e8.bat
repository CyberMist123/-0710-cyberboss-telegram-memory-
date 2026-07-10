@echo off
setlocal
echo === Stop 3 lines + watchdog ===
echo Stop watchdog first, then lines, so watchdog does not re-launch them.

if exist "%~dp0launcher\watchdog.pid" (
  for /f "usebackq delims=" %%p in ("%~dp0launcher\watchdog.pid") do (
    taskkill /pid %%p /f 2>nul
  )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test\scripts\windows\stop-safe.ps1"

if exist "C:\Users\18717\.cyberboss\logs\shared-wechat.pid" (
  for /f "usebackq delims=" %%p in ("C:\Users\18717\.cyberboss\logs\shared-wechat.pid") do (
    taskkill /pid %%p /f 2>nul
  )
)

if exist "%~dp0memory-kit\.panel.pid" (
  for /f "usebackq delims=" %%p in ("%~dp0memory-kit\.panel.pid") do (
    taskkill /pid %%p /f 2>nul
  )
  del /f /q "%~dp0memory-kit\.panel.pid" >nul 2>&1
)

echo.
echo Done. To bring things back: double-click  zi-register.bat  or one of the launcher vbs files.
pause
