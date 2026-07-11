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

function Get-EnvText {
  param([string]$Name)
  $value = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    return ''
  }
  return [string]$value
}

function Resolve-OptionalFullPath {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Read-PidFile {
  param([string]$Path)
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  $text = ([string]$raw).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "PID file is empty: $Path"
  }
  $pidValue = 0
  if (-not [int]::TryParse($text, [ref]$pidValue) -or $pidValue -le 0) {
    throw "PID file is invalid: $Path"
  }
  return $pidValue
}

function Test-PidAlive {
  param([int]$ProcessId)
  $mockPids = Get-EnvText 'CYBERBOSS_SWITCH_MOCK_ALIVE_PIDS'
  if (-not [string]::IsNullOrWhiteSpace($mockPids)) {
    $alive = @($mockPids -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    return $alive -contains ([string]$ProcessId)
  }
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Convert-MockProcessEntry {
  param([object]$Entry)
  if ($null -eq $Entry) {
    return $null
  }
  if ($Entry -is [string]) {
    $text = $Entry.Trim()
    if (-not $text) {
      return $null
    }
    return [pscustomobject]@{
      ProcessId = 0
      CommandLine = $text
    }
  }
  $processId = 0
  if ($Entry.PSObject.Properties.Name -contains 'ProcessId') {
    $processId = [int]$Entry.ProcessId
  } elseif ($Entry.PSObject.Properties.Name -contains 'Pid') {
    $processId = [int]$Entry.Pid
  }
  $commandLine = ''
  if ($Entry.PSObject.Properties.Name -contains 'CommandLine') {
    $commandLine = [string]$Entry.CommandLine
  } elseif ($Entry.PSObject.Properties.Name -contains 'commandLine') {
    $commandLine = [string]$Entry.commandLine
  }
  return [pscustomobject]@{
    ProcessId = $processId
    CommandLine = $commandLine
  }
}

function Get-CyberbossProcessRows {
  $mockFile = Resolve-OptionalFullPath (Get-EnvText 'CYBERBOSS_SWITCH_MOCK_PROCESS_LIST')
  if (-not [string]::IsNullOrWhiteSpace($mockFile)) {
    if (-not (Test-Path -LiteralPath $mockFile)) {
      throw "Mock process list does not exist: $mockFile"
    }
    $content = (Get-Content -LiteralPath $mockFile -Raw -ErrorAction Stop).Trim()
    if (-not $content) {
      return @()
    }
    if ($content.StartsWith('[')) {
      $parsed = $content | ConvertFrom-Json -ErrorAction Stop
      return @($parsed | ForEach-Object { Convert-MockProcessEntry $_ } | Where-Object { $_ })
    }
    return @(($content -split "`r?`n") | ForEach-Object { Convert-MockProcessEntry $_ } | Where-Object { $_ })
  }

  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) } |
      ForEach-Object {
        [pscustomobject]@{
          ProcessId = [int]$_.ProcessId
          CommandLine = [string]$_.CommandLine
        }
      })
  } catch {
    throw "Cannot inspect process list; refusing to switch because safety cannot be determined. $($_.Exception.Message)"
  }
}

function Test-CyberbossStartCommand {
  param([string]$CommandLine)
  $text = [string]$CommandLine
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $false
  }
  $normalized = $text.Replace('\', '/')
  $hasEntrypoint = [regex]::IsMatch($normalized, '(^|[\s"''])(?:[A-Za-z]:)?[^"'']*cyberboss\.js(["''\s]|$)', 'IgnoreCase')
  $hasStartArg = [regex]::IsMatch($normalized, '(^|\s)start($|\s)', 'IgnoreCase')
  return ($hasEntrypoint -and $hasStartArg)
}

function Assert-NoRunningTelegramPoller {
  $legacyPidFile = Resolve-OptionalFullPath (Get-EnvText 'CYBERBOSS_LEGACY_PID_FILE')
  if (-not [string]::IsNullOrWhiteSpace($legacyPidFile)) {
    if (Test-Path -LiteralPath $legacyPidFile) {
      $legacyPid = Read-PidFile $legacyPidFile
      if (Test-PidAlive $legacyPid) {
        throw "Existing Telegram poller PID $legacyPid from CYBERBOSS_LEGACY_PID_FILE is still alive; refusing to start a second poller."
      }
      Write-Host "Legacy PID file is stale; continuing process scan."
    } else {
      Write-Host "Legacy PID file is not present; continuing process scan."
    }
  }

  $running = @(Get-CyberbossProcessRows | Where-Object { Test-CyberbossStartCommand $_.CommandLine })
  if ($running.Count -gt 0) {
    $summary = ($running | Select-Object -First 5 | ForEach-Object {
      "PID=$($_.ProcessId) CMD=$($_.CommandLine)"
    }) -join "`n"
    throw "Detected running cyberboss.js start process; refusing to start a second Telegram poller.`n$summary"
  }
}

foreach ($name in $required) {
  $value = Get-EnvText $name
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $name"
  }
}

Assert-NoRunningTelegramPoller

$configuredStartScript = Resolve-OptionalFullPath (Get-EnvText 'CYBERBOSS_SWITCH_START_SCRIPT')
$startScript = if ($configuredStartScript) {
  $configuredStartScript
} else {
  Join-Path $repoRoot 'extensions\windows-launcher\start-safe.ps1'
}
if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Cannot find start script: $startScript"
}

if (-not $ConfirmSwitch) {
  Write-Host 'Phase 1 switch preflight passed. No process was started.'
  Write-Host 'Re-run with -ConfirmSwitch when the live Telegram poller has been stopped by the operator.'
  exit 0
}

# Re-check immediately before launch so state changes after preflight are caught.
Assert-NoRunningTelegramPoller

& $startScript
