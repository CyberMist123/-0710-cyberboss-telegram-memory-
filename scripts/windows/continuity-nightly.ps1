[CmdletBinding()]
param(
  [string]$ManifestPath = "",
  [string]$Date = ""
)

# Nightly continuity chain: closeout -> janitor -> auto review -> history writer.
# Reads the cyberlink manifest for paths and env, then runs run-phase3.js all.
# Registered as scheduled task "cyberlink-continuity-nightly" (see docs).

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cyberlink-manifest.ps1")

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath

$appRoot = [string]$manifest.telegram.app_root
$logDir = [string]$manifest.telegram.log_dir
if ([string]::IsNullOrWhiteSpace($logDir)) {
  $logDir = Join-Path ([string]$manifest.telegram.state_dir) "logs"
}
$logFile = Join-Path $logDir "continuity-nightly.log"

$env:CYBERBOSS_STATE_DIR = [string]$manifest.telegram.state_dir
$env:CYBERBOSS_WORKSPACE = [string]$manifest.workspace_root
$env:CYBERBOSS_WORKSPACE_ROOT = [string]$manifest.workspace_root
$env:CYBERBOSS_CONFIG_DIR = [string]$manifest.telegram.config_dir
$env:CYBERBOSS_ENV_FILE = [string]$manifest.telegram.env_file

# Auto Review model key: reuse the DeepSeek key from the soft-retrieval env file.
if ([string]::IsNullOrWhiteSpace($env:DS_API_KEY)) {
  $softEnv = [string]$manifest.soft_retrieval.env_file
  if ($softEnv -and (Test-Path -LiteralPath $softEnv)) {
    foreach ($line in Get-Content -LiteralPath $softEnv) {
      $trimmed = $line.Trim()
      if ($trimmed.StartsWith("DEEPSEEK_API_KEY=")) {
        $env:DS_API_KEY = $trimmed.Substring("DEEPSEEK_API_KEY=".Length).Trim()
        break
      }
    }
  }
}

$runner = Join-Path $appRoot "scripts\continuity\run-phase3.js"
$nodeArgs = @($runner, "all")
if (-not [string]::IsNullOrWhiteSpace($Date)) {
  $nodeArgs += "--date=$Date"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly start args=$($nodeArgs -join ' ')"
& node @nodeArgs 2>&1 | ForEach-Object { $_.ToString() } | Add-Content -LiteralPath $logFile
$exitCode = $LASTEXITCODE
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly exit=$exitCode"
exit $exitCode
