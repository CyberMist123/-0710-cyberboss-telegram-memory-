@echo off
chcp 65001 >nul
cd /d "%~dp0"
python memory-kit\memory_toggle.py status
echo.
pause
