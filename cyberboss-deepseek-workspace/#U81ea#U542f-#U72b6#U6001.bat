@echo off
setlocal enabledelayedexpansion
echo === Scheduled tasks + 3-line liveness ===
echo.
echo [Scheduled tasks]
for %%T in (cyberboss-tg-line cyberboss-wechat-line cyberboss-memory-panel cyberboss-watchdog) do (
  schtasks /query /tn "%%T" 2>nul | findstr /R /C:"%%T" >nul
  if errorlevel 1 (echo   %%T   [ NOT registered ]) else (echo   %%T   [ registered ])
)
echo.
echo [PID files]
for %%P in (
  "C:\Users\18717\.cyberboss-deepseek-test\cyberboss.pid"
  "C:\Users\18717\.cyberboss\logs\shared-wechat.pid"
  "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\memory-kit\.panel.pid"
  "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace\launcher\watchdog.pid"
) do (
  if exist %%P (echo   [alive] %%P) else (echo   [none]  %%P)
)
echo.
echo [Watchdog log tail]
if exist "%~dp0launcher\watchdog.log" (
  powershell -NoProfile -Command "Get-Content -Tail 12 '%~dp0launcher\watchdog.log'"
) else (
  echo   watchdog.log not yet produced
)
echo.
pause
