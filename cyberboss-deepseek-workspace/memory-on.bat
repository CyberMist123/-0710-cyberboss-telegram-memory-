@echo off
chcp 65001 >nul
cd /d "%~dp0"
python memory-kit\memory_toggle.py on
echo.
echo Reminder: run RestartTG.bat / restart TG.bat, or send /reread in TG to apply.
pause
