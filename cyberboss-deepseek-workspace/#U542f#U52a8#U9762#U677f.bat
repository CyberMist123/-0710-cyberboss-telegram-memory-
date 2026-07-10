@echo off
cd /d "%~dp0memory-kit"
python dashboard.py
if errorlevel 1 (
  echo.
  echo dashboard.py exited with an error. See message above.
  pause
)
