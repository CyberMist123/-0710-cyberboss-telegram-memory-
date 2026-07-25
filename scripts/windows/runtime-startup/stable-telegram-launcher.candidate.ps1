[CmdletBinding()]
param(
  [string]$DescriptorPath = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-Descriptor {
  param([string]$Hint)

  if ($Hint) {
    return (Resolve-Path -LiteralPath $Hint -ErrorAction Stop).Path
  }

  $configured = [Environment]::GetEnvironmentVariable("CYBERBOSS_DESCRIPTOR_PATH", "Process")
  if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $configured).Path
  }

  $root = [Environment]::GetEnvironmentVariable("CYBERLINK_ROOT", "Process")
  if ($root) {
    $candidate = Join-Path $root "deployment\current.json"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Descriptor not found. Pass -DescriptorPath or set CYBERBOSS_DESCRIPTOR_PATH."
}

function Read-Descriptor {
  param([string]$Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
    throw "Descriptor must be UTF-8 without BOM: $Path"
  }
  return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
}

function Require-AbsolutePath {
  param([string]$Value, [string]$Field)

  if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
    throw "$Field must be an absolute path."
  }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full -ne $Value) {
    throw "$Field must be normalized."
  }
  return $full
}

function Assert-Target {
  param($Target, [string]$Name)

  foreach ($field in @("telegram_entry", "config_dir", "state_dir", "log_dir", "pid_file", "watchdog_target")) {
    $null = Require-AbsolutePath ([string]$Target.$field) "$Name.$field"
  }

  $releaseRoot = Split-Path -Parent (Split-Path -Parent ([string]$Target.telegram_entry))
  foreach ($field in @("telegram_entry", "watchdog_target")) {
    $path = [IO.Path]::GetFullPath([string]$Target.$field)
    if (-not $path.StartsWith($releaseRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Name.$field must be inside its release."
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "$Name.$field does not exist: $path"
    }
  }

  foreach ($field in @("config_dir", "state_dir", "log_dir")) {
    if (-not (Test-Path -LiteralPath ([string]$Target.$field) -PathType Container)) {
      throw "$Name.$field does not exist: $($Target.$field)"
    }
  }

  $pidPath = [string]$Target.pid_file
  $pidParent = Split-Path -Parent $pidPath
  if (-not (Test-Path -LiteralPath $pidParent -PathType Container)) {
    throw "$Name.pid_file parent does not exist: $pidParent"
  }
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $item = Get-Item -LiteralPath $pidPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Name.pid_file must not be a reparse point."
    }
  }
}

function Read-Pid {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  $value = 0
  if ([int]::TryParse((Get-Content -LiteralPath $Path -Raw).Trim(), [ref]$value) -and $value -gt 0) {
    return $value
  }
  return 0
}

# ---- Exact-identity poller matching -----------------------------------
#
# A process is the "active Telegram poller" only if all of the following hold:
#   1. One of its command-line tokens is, after canonicalization, exactly the
#      descriptor's telegram_entry (not merely a substring/basename match).
#   2. The immediately following token is the standalone word "start".
#   3. No later token is "--checkin" or "--help" (a checkin companion process
#      or a help invocation is never the active poller).
# Comparison is case-insensitive (Windows paths) and token-based (never a
# whole-command-line regex/substring test), so a differently-cased path, a
# different release directory, a canary/dashboard/continuity process, or any
# other same-named cyberboss.js process cannot be mistaken for the active
# poller.

function Get-CanonicalWindowsPath {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  try {
    $full = [IO.Path]::GetFullPath($Value)
  } catch {
    return $null
  }
  return $full.TrimEnd('\').ToLowerInvariant()
}

function ConvertTo-ArgvTokens {
  param([string]$CommandLine)

  $tokens = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $tokens }

  # Pragmatic Windows command-line tokenizer: a double-quoted run (with
  # backslash-escaped quotes) or a run of non-whitespace characters.
  $pattern = '"((?:[^"\\]|\\.)*)"|(\S+)'
  foreach ($match in [regex]::Matches($CommandLine, $pattern)) {
    if ($match.Groups[1].Success) {
      $tokens.Add(($match.Groups[1].Value -replace '\\"', '"'))
    } else {
      $tokens.Add($match.Groups[2].Value)
    }
  }
  return $tokens
}

function Test-ArgvIsActivePoller {
  param(
    [System.Collections.Generic.List[string]]$Tokens,
    [string]$CanonicalEntry
  )

  if (-not $Tokens -or $Tokens.Count -eq 0 -or -not $CanonicalEntry) { return $false }

  for ($i = 0; $i -lt $Tokens.Count; $i++) {
    $candidate = Get-CanonicalWindowsPath -Value $Tokens[$i]
    if (-not $candidate -or $candidate -ne $CanonicalEntry) { continue }

    if ($i + 1 -ge $Tokens.Count) { continue }
    if ($Tokens[$i + 1].ToLowerInvariant() -ne "start") { continue }

    $excluded = $false
    for ($j = $i + 2; $j -lt $Tokens.Count; $j++) {
      $flag = $Tokens[$j].ToLowerInvariant()
      if ($flag -eq "--checkin" -or $flag -eq "--help") {
        $excluded = $true
        break
      }
    }
    if ($excluded) { continue }

    return $true
  }
  return $false
}

function Test-ExistingTelegramPoller {
  param([Parameter(Mandatory = $true)][string]$Entry)

  $canonicalEntry = Get-CanonicalWindowsPath -Value $Entry
  if (-not $canonicalEntry) {
    throw "telegram_entry could not be canonicalized: $Entry"
  }

  $rows = Get-CimInstance Win32_Process -ErrorAction Stop
  $matchCount = 0
  foreach ($row in $rows) {
    $commandLine = [string]$row.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
    $tokens = ConvertTo-ArgvTokens -CommandLine $commandLine
    if (Test-ArgvIsActivePoller -Tokens $tokens -CanonicalEntry $canonicalEntry) {
      $matchCount += 1
    }
  }

  if ($matchCount -gt 1) {
    throw "Multiple exact active Telegram pollers detected for entry '$Entry'; refusing to proceed (fail closed)."
  }
  return $matchCount -eq 1
}

$descriptorFile = Resolve-Descriptor -Hint $DescriptorPath
$descriptor = Read-Descriptor -Path $descriptorFile
foreach ($field in @("active_release_id", "telegram_entry", "config_dir", "state_dir", "log_dir", "pid_file", "watchdog_target", "last_verified_sha")) {
  if (-not $descriptor.PSObject.Properties.Name.Contains($field)) { throw "Descriptor field missing: $field" }
  if ([string]::IsNullOrWhiteSpace([string]$descriptor.$field)) { throw "Descriptor field is empty: $field" }
}
Assert-Target -Target $descriptor -Name "active"
Assert-Target -Target $descriptor.rollback_release -Name "rollback"

$canonicalEntry = Get-CanonicalWindowsPath -Value ([string]$descriptor.telegram_entry)

# PID-file fast path: only trust it when the recorded PID is alive AND its
# exact command line still matches the active poller identity above. A dead
# PID, a reused PID belonging to an unrelated process, or a PID that now
# belongs to a "start --checkin" companion process is never trusted here;
# execution safely falls through to the full-process scan (and from there,
# if still negative, to the dry-run/start path) instead of stopping early.
$pidValue = Read-Pid ([string]$descriptor.pid_file)
if ($pidValue -gt 0) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
    if ($process) {
      $tokens = ConvertTo-ArgvTokens -CommandLine ([string]$process.CommandLine)
      if (Test-ArgvIsActivePoller -Tokens $tokens -CanonicalEntry $canonicalEntry) {
        Write-Output "Telegram already running with PID $pidValue; no process started."
        exit 0
      }
    }
  } catch {
    # PID file is stale (process gone) or otherwise unreadable; ignore and
    # fall through to the full-process scan below.
  }
}

if (Test-ExistingTelegramPoller -Entry ([string]$descriptor.telegram_entry)) {
  Write-Output "A Telegram cyberboss start process already exists; no process started."
  exit 0
}

$env:CYBERBOSS_DESCRIPTOR_PATH = $descriptorFile
$env:CYBERBOSS_CONFIG_DIR = [string]$descriptor.config_dir
$env:CYBERBOSS_STATE_DIR = [string]$descriptor.state_dir
$env:CYBERBOSS_LOG_DIR = [string]$descriptor.log_dir
$env:CYBERBOSS_WORKSPACE = [string]$descriptor.workspace_dir
$env:CYBERBOSS_WORKSPACE_ROOT = [string]$descriptor.workspace_dir
$envFile = Join-Path ([string]$descriptor.config_dir) "telegram.env"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  $envFile = Join-Path ([string]$descriptor.config_dir) ".env"
}
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  $env:CYBERBOSS_ENV_FILE = $envFile
}

if ($DryRun) {
  Write-Output "DRY-RUN descriptor=$descriptorFile release=$($descriptor.active_release_id) entry=$($descriptor.telegram_entry) watchdog=$($descriptor.watchdog_target)"
  exit 0
}

& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ([string]$descriptor.watchdog_target)
if ($LASTEXITCODE -ne 0) {
  throw "Release watchdog target failed with exit code $LASTEXITCODE."
}
