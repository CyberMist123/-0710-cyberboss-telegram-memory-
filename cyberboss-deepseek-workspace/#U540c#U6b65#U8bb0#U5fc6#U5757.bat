@echo off
chcp 65001 >nul
cd /d "%~dp0"
python memory-kit\sync_memory_block.py
echo.
pause
