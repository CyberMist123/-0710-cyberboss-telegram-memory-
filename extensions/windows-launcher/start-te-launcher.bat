@echo off
setlocal
if "%CYBERBOSS_REPO_ROOT%"=="" (
  set "CYBERBOSS_REPO_ROOT=%~dp0..\.."
)
cd /d "%CYBERBOSS_REPO_ROOT%"
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%CYBERBOSS_REPO_ROOT%\extensions\windows-launcher\start-safe.ps1"
exit /b %errorlevel%
