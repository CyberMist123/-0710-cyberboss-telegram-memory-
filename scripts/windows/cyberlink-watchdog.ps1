[CmdletBinding()]
param(
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cyberlink-manifest.ps1")

function Read-PidFileValue {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
  $value = 0
  if (-not [int]::TryParse($raw, [ref]$value)) { return 0 }
  return $value
}

function Test-TelegramAlive {
  param($Manifest)

  $pidValue = Read-PidFileValue -Path ([string]$Manifest.telegram.pid_file)
  if ($pidValue -le 0) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
  } catch {
    return $false
  }
  $commandLine = [string]$proc.CommandLine
  return $commandLine.ToLowerInvariant().Contains(([string]$Manifest.telegram.entry).ToLowerInvariant())
}

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath
$pidFile = [string]$manifest.watchdog.pid_file
$interval = [int]$manifest.watchdog.interval_seconds
if ($interval -lt 5) { $interval = 5 }

$existing = Read-PidFileValue -Path $pidFile
if ($existing -gt 0 -and $existing -ne $PID) {
  try {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $existing" -ErrorAction Stop
    if ([string]$row.CommandLine -match "cyberlink-watchdog\.ps1") {
      throw "Watchdog already running with PID $existing"
    }
  } catch {
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null
Set-Content -LiteralPath $pidFile -Value "$PID" -Encoding UTF8

try {
  while ($true) {
    $manifest = Read-CyberlinkManifest -PathHint $ManifestPath
    if (-not (Test-TelegramAlive -Manifest $manifest)) {
      # NOTE: relaunch goes through cyberlink-start.ps1 -Mode Telegram, which
      # is retired and now throws; this legacy watchdog can no longer
      # resurrect a manifest-topology Telegram. (Also fixed: the argument was
      # previously passed unparenthesized as literal "[string]$manifest...".)
      & (Join-Path $PSScriptRoot "cyberlink-start.ps1") -Mode Telegram -ManifestPath ([string]$manifest.__manifest_path) | Out-Null
    }
    Start-Sleep -Seconds $interval
  }
} finally {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
