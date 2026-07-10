@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Diag: TG line ===
python memory-kit\tg_doctor.py
echo.
echo === Diag: panel port 520 ===
powershell -NoProfile -Command "try { $c = Test-NetConnection -ComputerName 127.0.0.1 -Port 520 -InformationLevel Quiet -WarningAction SilentlyContinue; if ($c) { 'OK  port 520 is open' } else { 'FAIL port 520 not open (panel process dead)' } } catch { 'WARN Test-NetConnection failed: ' + $_ }"
echo.
echo === Diag: dashboard pid file ===
if exist "%~dp0memory-kit\.panel.pid" (
  set /p PANEL_PID=<"%~dp0memory-kit\.panel.pid"
  echo panel pid recorded: %PANEL_PID%
  tasklist /FI "PID eq %PANEL_PID%" /FO CSV /NH 2>nul | findstr /R "\<%PANEL_PID%\>" >nul && (echo OK  panel process alive) || (echo FAIL panel pid dead, need restart)
) else (
  echo FAIL no .panel.pid file
)
echo.
pause
