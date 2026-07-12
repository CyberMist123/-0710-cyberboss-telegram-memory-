[CmdletBinding()]
param(
  [ValidateSet('Install', 'Uninstall', 'Status', 'Dashboard', 'Memory')]
  [string]$Mode = 'Status',
  [string]$DescriptorPath = ''
)

$ErrorActionPreference = 'Stop'
$DashboardTask = 'cyberboss-memory-panel'
$MemoryTask = 'cyberboss-watchdog'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$DashboardRunValue = 'CyberbossMemoryPanel'
$MemoryRunValue = 'CyberbossMemoryWatchdog'

function Resolve-DescriptorPath {
  if ($DescriptorPath) {
    return (Resolve-Path -LiteralPath $DescriptorPath).Path
  }
  $cursor = [IO.DirectoryInfo](Resolve-Path -LiteralPath $PSScriptRoot).Path
  while ($null -ne $cursor) {
    $candidate = Join-Path $cursor.FullName 'deployment\current.json'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $cursor = $cursor.Parent
  }
  throw 'deployment/current.json not found; pass -DescriptorPath explicitly.'
}

function Read-Descriptor([string]$Path) {
  $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($field in @('telegram_entry', 'state_dir', 'config_dir', 'workspace_dir')) {
    if ([string]::IsNullOrWhiteSpace([string]$value.$field)) {
      throw "Release descriptor field is missing: $field"
    }
  }
  return $value
}

function Resolve-ReleaseRoot($Descriptor) {
  $bin = Split-Path -Parent ([string]$Descriptor.telegram_entry)
  return (Split-Path -Parent $bin)
}

function Resolve-DashboardRoot($Descriptor) {
  if (-not [string]::IsNullOrWhiteSpace([string]$Descriptor.dashboard_root)) {
    return (Resolve-Path -LiteralPath ([string]$Descriptor.dashboard_root)).Path
  }
  return Resolve-ReleaseRoot $Descriptor
}

function Resolve-PythonWindowless {
  $override = [System.Environment]::GetEnvironmentVariable('CYBERBOSS_DASHBOARD_PYTHON', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    if (-not (Test-Path -LiteralPath $override -PathType Leaf)) {
      throw "CYBERBOSS_DASHBOARD_PYTHON does not exist: $override"
    }
    return (Resolve-Path -LiteralPath $override).Path
  }
  foreach ($name in @('pythonw.exe', 'python.exe')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  throw 'pythonw.exe or python.exe was not found on PATH.'
}

function Test-VerifiedProcess([string]$PidFile, [string]$ExpectedScript) {
  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $false }
  $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
  $pidValue = 0
  if (-not [int]::TryParse($raw, [ref]$pidValue) -or $pidValue -le 0) { return $false }
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if (-not $row) { return $false }
  return ([string]$row.CommandLine).IndexOf($ExpectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Resolve-DashboardEntry([string]$ReleaseRoot) {
  $kit = Join-Path $ReleaseRoot 'extensions\relationship-memory\memory-kit'
  $layered = Join-Path $kit 'dashboard_continuity.py'
  if (Test-Path -LiteralPath $layered -PathType Leaf) { return $layered }

  $legacy = Join-Path $kit 'dashboard.py'
  if (Test-Path -LiteralPath $legacy -PathType Leaf) { return $legacy }

  throw "Dashboard missing: $layered (legacy fallback also missing: $legacy)"
}

function Start-Dashboard([string]$Path) {
  $descriptor = Read-Descriptor $Path
  $releaseRoot = Resolve-DashboardRoot $descriptor
  $dashboard = Resolve-DashboardEntry $releaseRoot

  $pidOverride = [System.Environment]::GetEnvironmentVariable('CYBERBOSS_DASHBOARD_PID_FILE', 'Process')
  $pidFile = if ([string]::IsNullOrWhiteSpace($pidOverride)) {
    Join-Path (Split-Path -Parent $dashboard) '.panel.pid'
  } else {
    [System.IO.Path]::GetFullPath($pidOverride)
  }
  if (Test-VerifiedProcess $pidFile $dashboard) { return }

  $env:CYBERBOSS_HOME = $releaseRoot
  $env:CYBERBOSS_PROJECT_ROOT = $releaseRoot
  $env:CYBERBOSS_STATE_DIR = [string]$descriptor.state_dir
  $env:CYBERBOSS_CONFIG_DIR = [string]$descriptor.config_dir
  $env:CYBERBOSS_CONTINUITY_DIR = Join-Path ([string]$descriptor.workspace_dir) 'continuity'
  $env:CYBERBOSS_MEMORY_DIR = Join-Path ([string]$descriptor.workspace_dir) 'memory'
  if ([string]::IsNullOrWhiteSpace($env:CYBERBOSS_DASHBOARD_HOST)) { $env:CYBERBOSS_DASHBOARD_HOST = '127.0.0.1' }
  if ([string]::IsNullOrWhiteSpace($env:CYBERBOSS_DASHBOARD_PORT)) { $env:CYBERBOSS_DASHBOARD_PORT = '520' }
  if ([string]::IsNullOrWhiteSpace($env:CYBERBOSS_DASHBOARD_NO_BROWSER)) { $env:CYBERBOSS_DASHBOARD_NO_BROWSER = '1' }
  $env:CYBERBOSS_DASHBOARD_PID_FILE = $pidFile

  $python = Resolve-PythonWindowless
  Start-Process -FilePath $python -ArgumentList @($dashboard) -WorkingDirectory (Split-Path -Parent $dashboard) -WindowStyle Hidden
}

function Start-Memory([string]$Path) {
  $descriptor = Read-Descriptor $Path
  $releaseRoot = Resolve-ReleaseRoot $descriptor
  $ownerDir = [string]$descriptor.watchdog_owner_dir
  $watchdog = if ($ownerDir) { Join-Path $ownerDir 'watchdog.py' } else { Join-Path $releaseRoot 'extensions\relationship-memory\launcher\watchdog.py' }
  if (-not (Test-Path -LiteralPath $watchdog -PathType Leaf)) { throw "Watchdog missing: $watchdog" }
  $pidFile = Join-Path (Split-Path -Parent $watchdog) 'watchdog.pid'
  if (Test-VerifiedProcess $pidFile $watchdog) { return }
  $python = Resolve-PythonWindowless
  Start-Process -FilePath $python -ArgumentList @($watchdog, '--descriptor', $Path) -WorkingDirectory (Split-Path -Parent $watchdog) -WindowStyle Hidden
}

function New-StartupTask([string]$TaskName, [string]$ChildMode, [string]$Path) {
  $quotedScript = '"' + $PSCommandPath + '"'
  $quotedDescriptor = '"' + $Path + '"'
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScript -Mode $ChildMode -DescriptorPath $quotedDescriptor"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Cyberboss independent hidden startup; no Te Launcher dependency.' -Force | Out-Null
}

function New-RunCommand([string]$ChildMode, [string]$Path) {
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $PSCommandPath + '" -Mode ' + $ChildMode + ' -DescriptorPath "' + $Path + '"'
}

function Install-RunFallback([string]$Path) {
  New-Item -Path $RunKey -Force | Out-Null
  Set-ItemProperty -Path $RunKey -Name $DashboardRunValue -Value (New-RunCommand 'Dashboard' $Path)
  Set-ItemProperty -Path $RunKey -Name $MemoryRunValue -Value (New-RunCommand 'Memory' $Path)
}

$resolvedDescriptor = Resolve-DescriptorPath
switch ($Mode) {
  'Dashboard' { Start-Dashboard $resolvedDescriptor; break }
  'Memory' { Start-Memory $resolvedDescriptor; break }
  'Install' {
    try {
      New-StartupTask $DashboardTask 'Dashboard' $resolvedDescriptor
      New-StartupTask $MemoryTask 'Memory' $resolvedDescriptor
      Remove-ItemProperty -Path $RunKey -Name $DashboardRunValue -ErrorAction SilentlyContinue
      Remove-ItemProperty -Path $RunKey -Name $MemoryRunValue -ErrorAction SilentlyContinue
      Write-Output "Installed scheduled tasks: $DashboardTask, $MemoryTask"
    } catch [System.UnauthorizedAccessException], [Microsoft.Management.Infrastructure.CimException] {
      Install-RunFallback $resolvedDescriptor
      Write-Output 'Scheduled-task update was not permitted; installed current-user Run entries instead.'
    }
    break
  }
  'Uninstall' {
    foreach ($task in @($DashboardTask, $MemoryTask)) {
      Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-ItemProperty -Path $RunKey -Name $DashboardRunValue -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKey -Name $MemoryRunValue -ErrorAction SilentlyContinue
    Write-Output 'Startup entries removed where permitted; running processes were not stopped.'
    break
  }
  'Status' {
    foreach ($task in @($DashboardTask, $MemoryTask)) {
      $item = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
      if (-not $item) { Write-Output "$task`tNOT_REGISTERED"; continue }
      $info = Get-ScheduledTaskInfo -TaskName $task
      Write-Output "$task`t$($item.State)`tlast=$($info.LastRunTime)`tresult=$($info.LastTaskResult)"
    }
    $runValues = Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue
    Write-Output "$DashboardRunValue`t$([bool]($runValues.$DashboardRunValue))"
    Write-Output "$MemoryRunValue`t$([bool]($runValues.$MemoryRunValue))"
    break
  }
}
