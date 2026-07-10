@echo off
chcp 65001 >nul
title cyberboss TG debug visible v2

echo === Cyberboss TG Debug v2 ===
echo This window will stay open.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Continue';" ^
  "$proj='C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-test';" ^
  "$envFile='C:\Users\18717\.cyberboss-deepseek-test\.env';" ^
  "$log=Join-Path $proj ('debug-visible-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log');" ^
  "Write-Host 'Project:' $proj;" ^
  "Write-Host 'Env file:' $envFile;" ^
  "Write-Host 'Log:' $log;" ^
  "Write-Host '--- Stop old process ---';" ^
  "& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $proj 'scripts\windows\stop-safe.ps1') 2>$null;" ^
  "Start-Sleep -Seconds 2;" ^
  "Write-Host '--- Load .env safely ---';" ^
  "if (!(Test-Path $envFile)) { Write-Host 'ENV FILE MISSING'; exit 10 }" ^
  "Get-Content $envFile | ForEach-Object {" ^
  "  $line=$_;" ^
  "  if ($line -match '^\s*$') { return }" ^
  "  if ($line -match '^\s*#') { return }" ^
  "  $idx=$line.IndexOf('=');" ^
  "  if ($idx -lt 1) { return }" ^
  "  $k=$line.Substring(0,$idx).Trim();" ^
  "  $v=$line.Substring($idx+1);" ^
  "  if ($k) { [Environment]::SetEnvironmentVariable($k,$v,'Process') }" ^
  "};" ^
  "$env:HTTP_PROXY='http://127.0.0.1:7897';" ^
  "$env:HTTPS_PROXY='http://127.0.0.1:7897';" ^
  "$env:NO_PROXY='localhost,127.0.0.1';" ^
  "$env:CYBERBOSS_TELEGRAM_PROXY_URL='http://127.0.0.1:7897';" ^
  "Write-Host '--- Env sanity ---';" ^
  "'CYBERBOSS_TELEGRAM_BOT_TOKEN','CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS','CYBERBOSS_STATE_DIR','CYBERBOSS_CLAUDE_COMMAND','CYBERBOSS_CLAUDE_PERMISSION_MODE','HTTP_PROXY','HTTPS_PROXY','CYBERBOSS_TELEGRAM_PROXY_URL' | ForEach-Object { Write-Host ($_ + '=' + [Environment]::GetEnvironmentVariable($_,'Process')) };" ^
  "Write-Host '--- Start cyberboss visible ---';" ^
  "Set-Location $proj;" ^
  "cmd /c 'node bin\cyberboss.js start 2^>^&1' | Tee-Object -FilePath $log;" ^
  "Write-Host '--- EXITED ---';" ^
  "Write-Host 'Log saved to:' $log;"

echo.
echo === BAT reached end ===
pause