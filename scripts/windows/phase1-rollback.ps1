param(
  [switch]$ConfirmRollback,
  [string]$DescriptorPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')) 'deployment\current.json')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$releaseControl = Join-Path $repoRoot 'scripts\orchestration\release-control.js'
if (-not (Test-Path -LiteralPath $DescriptorPath)) { throw "Missing release descriptor: $DescriptorPath" }
$current = Get-Content -Raw -LiteralPath $DescriptorPath | ConvertFrom-Json
$watchdogDir = [string]$current.watchdog_owner_dir
if ([string]::IsNullOrWhiteSpace($watchdogDir)) {
  throw 'current.json must provide watchdog_owner_dir for rollback.'
}
$watchdogPidFile = Join-Path $watchdogDir 'watchdog.pid'
$watchdogVbs = Join-Path $watchdogDir 'watchdog-hidden.vbs'

function Read-PositivePid([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $value = 0
  if (-not [int]::TryParse(([string](Get-Content -Raw -LiteralPath $Path)).Trim(), [ref]$value) -or $value -le 0) {
    return 0
  }
  return $value
}

function Get-VerifiedProcess([int]$ProcessId, [string]$ExpectedEntry) {
  if ($ProcessId -le 0) { return $null }
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $row) { return $null }
  $normalizedCommand = ([string]$row.CommandLine).Replace('/', '\').ToLowerInvariant()
  $normalizedEntry = ([System.IO.Path]::GetFullPath($ExpectedEntry)).Replace('/', '\').ToLowerInvariant()
  if (-not $normalizedCommand.Contains($normalizedEntry)) {
    throw "PID $ProcessId does not match expected entry $ExpectedEntry. Refusing rollback."
  }
  return $row
}

function Stop-VerifiedTree([object]$RootProcess, [string]$ExpectedEntry) {
  $null = Get-VerifiedProcess -ProcessId ([int]$RootProcess.ProcessId) -ExpectedEntry $ExpectedEntry
  $descendants = New-Object System.Collections.Generic.List[int]
  function Add-Children([int]$ParentId) {
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)) {
      Add-Children -ParentId ([int]$child.ProcessId)
      $descendants.Add([int]$child.ProcessId)
    }
  }
  Add-Children -ParentId ([int]$RootProcess.ProcessId)
  foreach ($id in @($descendants) + @([int]$RootProcess.ProcessId)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

$activePid = Read-PositivePid -Path ([string]$current.pid_file)
$activeProcess = Get-VerifiedProcess -ProcessId $activePid -ExpectedEntry ([string]$current.telegram_entry)
if (-not $activeProcess) { throw 'Active release process could not be verified; refusing rollback.' }

if (-not $ConfirmRollback) {
  Write-Host "Rollback preflight passed for $($current.active_release_id), PID $activePid. No state changed."
  Write-Host 'Re-run with -ConfirmRollback to switch the descriptor before restoring the rollback release.'
  exit 0
}

$watchdogPid = Read-PositivePid -Path $watchdogPidFile
if ($watchdogPid -gt 0) {
  $watchdog = Get-CimInstance Win32_Process -Filter "ProcessId=$watchdogPid" -ErrorAction SilentlyContinue
  if ($watchdog -and ([string]$watchdog.CommandLine) -match 'watchdog\.py') {
    Stop-Process -Id $watchdogPid -Force -ErrorAction Stop
  } elseif ($watchdog) {
    throw "watchdog.pid points to PID $watchdogPid with a mismatched command; refusing rollback."
  }
}

# The release description changes first. Only after the atomic switch do we stop
# the former active release and allow the sole watchdog to restore rollback.
& node $releaseControl rollback $DescriptorPath
if ($LASTEXITCODE -ne 0) { throw 'Atomic release descriptor rollback failed.' }
Stop-VerifiedTree -RootProcess $activeProcess -ExpectedEntry ([string]$current.telegram_entry)
Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$watchdogVbs`"") -WindowStyle Hidden
Write-Host 'Rollback descriptor activated; former release stopped; sole watchdog started.'
