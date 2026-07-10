param(
  [switch]$ConfirmSwitch
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$required = @(
  'CYBERBOSS_CONFIG_DIR',
  'CYBERBOSS_STATE_DIR',
  'CYBERBOSS_WORKSPACE',
  'CYBERBOSS_PROMPT_FILE',
  'CYBERBOSS_TELEGRAM_BOT_TOKEN',
  'CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS'
)

foreach ($name in $required) {
  $value = [System.Environment]::GetEnvironmentVariable($name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $name"
  }
}

$startScript = Join-Path $repoRoot 'extensions\windows-launcher\start-safe.ps1'
if (-not (Test-Path $startScript)) {
  throw 'Cannot find extensions\windows-launcher\start-safe.ps1.'
}

if (-not $ConfirmSwitch) {
  Write-Host 'Phase 1 switch preflight passed. No process was started.'
  Write-Host 'Re-run with -ConfirmSwitch when the live Telegram poller has been stopped by the operator.'
  exit 0
}

& $startScript
