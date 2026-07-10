param(
  [switch]$ConfirmRollback
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$stopScript = Join-Path $repoRoot 'extensions\windows-launcher\stop-safe.ps1'
if (-not (Test-Path $stopScript)) {
  throw 'Cannot find extensions\windows-launcher\stop-safe.ps1.'
}

if (-not $ConfirmRollback) {
  Write-Host 'Rollback preflight passed. No process was stopped or started.'
  Write-Host 'Re-run with -ConfirmRollback to stop the configured Phase 1 service.'
  exit 0
}

& $stopScript

$legacyStartCommand = [System.Environment]::GetEnvironmentVariable('CYBERBOSS_LEGACY_START_COMMAND', 'Process')
if ([string]::IsNullOrWhiteSpace($legacyStartCommand)) {
  Write-Host 'Phase 1 service stopped. Set CYBERBOSS_LEGACY_START_COMMAND to start the old service automatically.'
  exit 0
}

Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $legacyStartCommand) `
  -WindowStyle Hidden
Write-Host 'Phase 1 service stopped and legacy start command launched.'
