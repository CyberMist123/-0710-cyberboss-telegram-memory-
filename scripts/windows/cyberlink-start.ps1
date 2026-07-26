[CmdletBinding()]
param(
  [ValidateSet("Telegram", "Dashboard", "Watchdog", "All", "Status", "InstallStartup")]
  [string]$Mode = "Status",
  [string]$ManifestPath = "",
  [int]$DashboardPortOverride = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cyberlink-manifest.ps1")

function Test-ProcessMatches {
  param(
    [int]$ProcessId,
    [string[]]$ExpectedTokens
  )

  if ($ProcessId -le 0) { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $false
  }
  $commandLine = [string]$proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }
  $lowered = $commandLine.ToLowerInvariant()
  foreach ($token in $ExpectedTokens) {
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    if (-not $lowered.Contains($token.ToLowerInvariant())) {
      return $false
    }
  }
  return $true
}

function Read-PidFileValue {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
  $value = 0
  if (-not [int]::TryParse($raw, [ref]$value)) { return 0 }
  return $value
}

function Start-TelegramLine {
  param($Manifest)

  # Retired path, explicitly fail-closed. Launching Telegram from
  # settings/manifest.json topology could resurrect an old release behind the
  # formal deployment descriptor's back; it previously only failed indirectly
  # through the Write-TelegramDescriptor throw below.
  throw 'Start-TelegramLine is retired. Telegram is launched only from deployment/current.json via the release watchdog and stable launcher (runtime-startup installers).'
}

function Start-DashboardPanel {
  param($Manifest, [int]$PortOverride = 0)

  $scriptPath = [string]$Manifest.dashboard.script
  $pidFile = [string]$Manifest.dashboard.pid_file
  $currentPid = Read-PidFileValue -Path $pidFile
  if ($currentPid -gt 0 -and (Test-ProcessMatches -ProcessId $currentPid -ExpectedTokens @($scriptPath))) {
    Write-Output "Dashboard already running with PID $currentPid"
    return
  }

  $port = if ($PortOverride -gt 0) { $PortOverride } else { [int]$Manifest.dashboard.port }
  $python = Resolve-PythonWindowless

  $env:CYBERBOSS_HOME = [string]$Manifest.telegram.app_root
  $env:CYBERBOSS_PROJECT_ROOT = [string]$Manifest.telegram.app_root
  $env:CYBERBOSS_STATE_DIR = [string]$Manifest.telegram.state_dir
  $env:CYBERBOSS_CONFIG_DIR = [string]$Manifest.telegram.config_dir
  $env:CYBERBOSS_MEMORY_DIR = [string]$Manifest.memory.path
  $env:CYBERBOSS_CONTINUITY_DIR = [string]$Manifest.dashboard.continuity_dir
  $env:CYBERBOSS_CARE_DIR = [string]$Manifest.dashboard.care_dir
  $env:CYBERBOSS_DASHBOARD_KEYS_FILE = [string]$Manifest.dashboard.keys_file
  $env:CYBERBOSS_TODO_FILE = [string]$Manifest.dashboard.todo_file
  $env:CYBERBOSS_TODO_META_FILE = [string]$Manifest.dashboard.todo_meta_file
  $env:CYBERBOSS_TODO_SNAPSHOT_DIR = [string]$Manifest.dashboard.todo_snapshot_dir
  $env:CYBERBOSS_DASHBOARD_HOST = [string]$Manifest.dashboard.host
  $env:CYBERBOSS_DASHBOARD_PORT = [string]$port
  $env:CYBERLINK_MANIFEST = [string]$Manifest.__manifest_path

  Start-Process -FilePath $python -ArgumentList @($scriptPath) -WorkingDirectory (Split-Path -Parent $scriptPath) -WindowStyle Hidden
}

function Start-WatchdogLoop {
  param($Manifest)

  $scriptPath = Join-Path $PSScriptRoot "cyberlink-watchdog.ps1"
  $pidFile = [string]$Manifest.watchdog.pid_file
  $currentPid = Read-PidFileValue -Path $pidFile
  if ($currentPid -gt 0 -and (Test-ProcessMatches -ProcessId $currentPid -ExpectedTokens @($scriptPath))) {
    Write-Output "Watchdog already running with PID $currentPid"
    return
  }

  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $scriptPath,
    "-ManifestPath", [string]$Manifest.__manifest_path
  ) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}

function Show-Status {
  param($Manifest)

  $rows = @(
    [pscustomobject]@{ Service = "telegram"; PidFile = [string]$Manifest.telegram.pid_file; Path = [string]$Manifest.telegram.entry },
    [pscustomobject]@{ Service = "dashboard"; PidFile = [string]$Manifest.dashboard.pid_file; Path = [string]$Manifest.dashboard.script },
    [pscustomobject]@{ Service = "watchdog"; PidFile = [string]$Manifest.watchdog.pid_file; Path = (Join-Path $PSScriptRoot "cyberlink-watchdog.ps1") }
  )

  $rows | ForEach-Object {
    $row = $_
    $pidValue = Read-PidFileValue -Path $row.PidFile
    $alive = $false
    if ($pidValue -gt 0) {
      $alive = Test-ProcessMatches -ProcessId $pidValue -ExpectedTokens @($row.Path)
    }
    [pscustomobject]@{
      service = $row.Service
      pid = $pidValue
      alive = $alive
      path = $row.Path
    }
  } | Format-Table -AutoSize
}

function Install-StartupEntries {
  param($Manifest)

  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  New-Item -Path $runKey -Force | Out-Null

  $startScript = Join-Path $PSScriptRoot "cyberlink-start.ps1"
  $manifestArg = '"' + [string]$Manifest.__manifest_path + '"'
  Set-ItemProperty -Path $runKey -Name "CyberlinkDashboard" -Value ('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '" -Mode Dashboard -ManifestPath ' + $manifestArg)
  Set-ItemProperty -Path $runKey -Name "CyberlinkWatchdog" -Value ('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '" -Mode Watchdog -ManifestPath ' + $manifestArg)
  Write-Output "Installed HKCU Run entries: CyberlinkDashboard, CyberlinkWatchdog"
}

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath
switch ($Mode) {
  "Telegram" { Start-TelegramLine -Manifest $manifest; break }
  "Dashboard" { Start-DashboardPanel -Manifest $manifest -PortOverride $DashboardPortOverride; break }
  "Watchdog" { Start-WatchdogLoop -Manifest $manifest; break }
  "All" {
    Start-TelegramLine -Manifest $manifest
    Start-DashboardPanel -Manifest $manifest -PortOverride $DashboardPortOverride
    Start-WatchdogLoop -Manifest $manifest
    break
  }
  "InstallStartup" { Install-StartupEntries -Manifest $manifest; break }
  "Status" { Show-Status -Manifest $manifest; break }
}
