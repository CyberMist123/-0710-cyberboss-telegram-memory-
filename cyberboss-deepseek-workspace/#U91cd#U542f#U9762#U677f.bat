@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === Kill any running panel process ===
if exist "%~dp0memory-kit\.panel.pid" (
  set /p OLDPID=<"%~dp0memory-kit\.panel.pid"
  taskkill /F /PID %OLDPID% 2>nul
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":520 " ^| findstr LISTENING') do (
  echo Killing PID %%p on port 520
  taskkill /F /PID %%p 2>nul
)

timeout /t 2 /nobreak >nul

echo === Start panel visible (this window) ===
echo If you see a stacktrace below, that's the reason the panel failed.
echo Press Ctrl+C to stop; or close this window to kill the panel.
echo.
cd memory-kit
python dashboard.py
pause
