[CmdletBinding()]
param(
  [string]$ManifestPath = "",
  [string]$DescriptorPath = "",
  [string]$Date = ""
)

# Nightly continuity chain: closeout -> janitor -> auto review -> history writer.
# Reads the cyberlink manifest for paths and env, then runs run-phase3.js all.
# Registered as scheduled task "cyberlink-continuity-nightly" (see docs).

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cyberlink-manifest.ps1")

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath

function Read-CurrentReleaseDescriptor {
  param([string]$PathHint)
  $candidate = $PathHint
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $root = [Environment]::GetEnvironmentVariable('CYBERLINK_ROOT', 'Process')
    if ($root) { $candidate = Join-Path $root 'deployment\current.json' }
  }
  if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $candidate))
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw 'deployment/current.json must be UTF-8 without BOM' }
  try { $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'deployment/current.json is invalid JSON' }
  foreach ($field in @('active_release_id','telegram_entry','config_dir','state_dir','log_dir','pid_file','watchdog_target','rollback_release','last_verified_sha')) {
    if (-not $value.PSObject.Properties.Name.Contains($field) -or [string]::IsNullOrWhiteSpace([string]$value.$field)) { throw "deployment/current.json missing required field: $field" }
  }
  return $value
}

$descriptor = Read-CurrentReleaseDescriptor -PathHint $DescriptorPath
if ($descriptor) {
  # A production descriptor is the sole Telegram topology authority.  A
  # disagreement is unsafe: do not silently regenerate or overwrite it.
  foreach ($pair in @(@('entry','telegram_entry'), @('pid_file','pid_file'), @('watchdog_target','watchdog_target'))) {
    $legacy = [string]$manifest.telegram.($pair[0]); $active = [string]$descriptor.($pair[1])
    if ($legacy -and $legacy -ne $active) { throw "settings manifest conflicts with deployment/current.json for Telegram $($pair[0]); refusing nightly run" }
  }
  $appRoot = Split-Path -Parent (Split-Path -Parent ([string]$descriptor.telegram_entry))
  $logDir = [string]$descriptor.log_dir
  $env:CYBERBOSS_STATE_DIR = [string]$descriptor.state_dir
  $env:CYBERBOSS_CONFIG_DIR = [string]$descriptor.config_dir
} else {
  # Bootstrap only: no formal descriptor exists, so historical manifest
  # behaviour is explicit rather than an accidental rollback mechanism.
  $appRoot = [string]$manifest.telegram.app_root
  $logDir = [string]$manifest.telegram.log_dir
  $env:CYBERBOSS_STATE_DIR = [string]$manifest.telegram.state_dir
  $env:CYBERBOSS_CONFIG_DIR = [string]$manifest.telegram.config_dir
}
if ([string]::IsNullOrWhiteSpace($logDir)) {
  $logDir = Join-Path $env:CYBERBOSS_STATE_DIR "logs"
}
$logFile = Join-Path $logDir "continuity-nightly.log"

$env:CYBERBOSS_WORKSPACE = [string]$manifest.workspace_root
$env:CYBERBOSS_WORKSPACE_ROOT = [string]$manifest.workspace_root
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
$modeProbe = 'const path=require(\"path\"); const root=process.argv[1]; const {loadEnv}=require(path.join(root,\"src\",\"index\")); loadEnv(); const {readConfig}=require(path.join(root,\"src\",\"core\",\"config\")); process.stdout.write(readConfig().nightlyMode);'
$modeProbeErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = "Continue"
  $modeProbeOutput = @(& node -e $modeProbe $appRoot 2>&1)
  $modeProbeExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $modeProbeErrorActionPreference
}
if ($modeProbeExitCode -ne 0) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly gate decision=block reason=invalid-nightly-config exit=$modeProbeExitCode"
  $modeProbeOutput | ForEach-Object { $_.ToString() } | Add-Content -LiteralPath $logFile
  exit $modeProbeExitCode
}
$nightlyMode = ($modeProbeOutput -join [Environment]::NewLine).Trim()
if (@("shadow", "auto") -contains $nightlyMode) {
  $confirmationFile = Join-Path $env:CYBERBOSS_CONFIG_DIR "nightly-mode.confirm"
  if (-not (Test-Path -LiteralPath $confirmationFile -PathType Leaf)) {
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly gate mode=$nightlyMode decision=block reason=missing-confirmation marker=$confirmationFile"
    exit 78
  }
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly gate mode=$nightlyMode decision=allow marker=$confirmationFile"
} else {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly gate mode=$nightlyMode decision=allow reason=default-safe"
}
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly start args=$($nodeArgs -join ' ')"
& node @nodeArgs 2>&1 | ForEach-Object { $_.ToString() } | Add-Content -LiteralPath $logFile
$exitCode = $LASTEXITCODE
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
Add-Content -LiteralPath $logFile -Value "[$stamp] continuity-nightly exit=$exitCode"
exit $exitCode
