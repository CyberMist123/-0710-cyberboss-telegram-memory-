[CmdletBinding()]
param(
  [ValidateSet("Telegram", "Dashboard", "Watchdog", "All", "Status")]
  [string]$Mode = "Status",
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

function Stop-ByPidFile {
  param(
    [string]$PidFile,
    [string[]]$ExpectedTokens
  )

  $pidValue = Read-PidFileValue -Path $PidFile
  if ($pidValue -le 0) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
  } catch {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return $false
  }
  $commandLine = [string]$proc.CommandLine
  $lowered = $commandLine.ToLowerInvariant()
  foreach ($token in $ExpectedTokens) {
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    if (-not $lowered.Contains($token.ToLowerInvariant())) {
      return $false
    }
  }
  Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  return $true
}

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath
$watchdogScript = Join-Path $PSScriptRoot "cyberlink-watchdog.ps1"

switch ($Mode) {
  "Telegram" { Stop-ByPidFile -PidFile ([string]$manifest.telegram.pid_file) -ExpectedTokens @([string]$manifest.telegram.entry, "cyberboss.js") | Out-Null; break }
  "Dashboard" { Stop-ByPidFile -PidFile ([string]$manifest.dashboard.pid_file) -ExpectedTokens @([string]$manifest.dashboard.script) | Out-Null; break }
  "Watchdog" { Stop-ByPidFile -PidFile ([string]$manifest.watchdog.pid_file) -ExpectedTokens @($watchdogScript) | Out-Null; break }
  "All" {
    Stop-ByPidFile -PidFile ([string]$manifest.watchdog.pid_file) -ExpectedTokens @($watchdogScript) | Out-Null
    Stop-ByPidFile -PidFile ([string]$manifest.dashboard.pid_file) -ExpectedTokens @([string]$manifest.dashboard.script) | Out-Null
    Stop-ByPidFile -PidFile ([string]$manifest.telegram.pid_file) -ExpectedTokens @([string]$manifest.telegram.entry, "cyberboss.js") | Out-Null
    break
  }
  "Status" {
    & (Join-Path $PSScriptRoot "cyberlink-start.ps1") -Mode Status -ManifestPath [string]$manifest.__manifest_path
    break
  }
}

