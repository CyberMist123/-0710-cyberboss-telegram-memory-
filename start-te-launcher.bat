@echo off
cd /d "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test"
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test\scripts\windows\start-safe.ps1"
exit /b %errorlevel%
