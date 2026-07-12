$ErrorActionPreference = 'Stop'

function Resolve-RequiredPathEnv {
  param([string]$Name)
  $raw = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "Missing required environment variable: $Name"
  }
  return [System.IO.Path]::GetFullPath($raw)
}

$stateDir = Resolve-RequiredPathEnv 'CYBERBOSS_STATE_DIR'
$pidFile = Join-Path $stateDir 'cyberboss.pid'

function Get-ProcessTree {
  param([int]$RootPid)
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootPid" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    [int]$childPid = $child.ProcessId
    foreach ($desc in Get-ProcessTree -RootPid $childPid) {
      $desc
    }
    $childPid
  }
}

if (-not (Test-Path $pidFile)) {
  Write-Host "No PID file found at $pidFile"
  exit 0
}

$rootPid = [int](Get-Content $pidFile -Raw)
if ($rootPid -le 0) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "PID file was empty; removed it."
  exit 0
}

$targets = @($rootPid) + @(Get-ProcessTree -RootPid $rootPid) | Sort-Object -Unique -Descending
foreach ($targetPid in $targets) {
  try {
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
    Write-Host "Stopped PID $targetPid"
  } catch {
    Write-Host "Skipped PID $targetPid"
  }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped cyberboss-deepseek tree rooted at PID $rootPid"
