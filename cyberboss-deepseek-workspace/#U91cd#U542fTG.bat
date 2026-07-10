@echo off
setlocal
echo === Restart TG line (hidden window) ===

if exist "%~dp0memory-kit\apply_keys_to_env.py" (
  echo [1/3] Sync keys.local.json -^> TG .env ...
  pushd "%~dp0memory-kit"
  python apply_keys_to_env.py
  popd
)

echo [2/3] stop-safe ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test\scripts\windows\stop-safe.ps1"

timeout /t 2 /nobreak >nul
echo [3/3] start (hidden) ...
wscript.exe "%~dp0launcher\tg-hidden.vbs"

echo.
echo Done. Log: C:\Users\18717\.cyberboss-deepseek-test\logs\cyberboss.log
pause
