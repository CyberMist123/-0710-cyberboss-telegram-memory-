$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$stateDir = 'C:\Users\18717\.cyberboss-deepseek-test'
$workspaceRoot = 'C:\Users\18717\Documents\cyberlink\cyberboss-deepseek-workspace'
$pidFile = Join-Path $stateDir 'cyberboss.pid'
$logDir = Join-Path $stateDir 'logs'
$logFile = Join-Path $logDir 'cyberboss.log'
$errFile = Join-Path $logDir 'cyberboss.err.log'
$launchEnvFile = Join-Path $logDir 'launch-env.txt'
$envFile = Join-Path $stateDir '.env'

if (-not (Test-Path $envFile)) {
  throw "Missing state env file: $envFile"
}

$required = @(
  'CYBERBOSS_TELEGRAM_BOT_TOKEN',
  'CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS'
)
# ANTHROPIC_AUTH_TOKEN 不再强制:claude.exe 用它自己的 ~/.claude 凭据时,.env 里可以没有。

$envMap = @{}
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line.Split('=', 2)
  if ($parts.Count -eq 2) {
    $envMap[$parts[0].Trim()] = $parts[1].Trim()
  }
}

foreach ($name in $required) {
  if (-not $envMap.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($envMap[$name])) {
    throw "Fill $name in $envFile before starting."
  }
}

if (-not $envMap.ContainsKey('CYBERBOSS_MEMORY_BACKGROUND_WRITE') -or [string]::IsNullOrWhiteSpace([string]$envMap['CYBERBOSS_MEMORY_BACKGROUND_WRITE'])) {
  $envMap['CYBERBOSS_MEMORY_BACKGROUND_WRITE'] = '1'
}

function Test-DirectTelegramReachable {
  try {
    $res = Test-NetConnection api.telegram.org -Port 443 -WarningAction SilentlyContinue
    return [bool]$res.TcpTestSucceeded
  } catch {
    return $false
  }
}

if ($envMap.ContainsKey('CYBERBOSS_TELEGRAM_PROXY_URL')) {
  $proxyValue = [string]$envMap['CYBERBOSS_TELEGRAM_PROXY_URL']
  if (-not [string]::IsNullOrWhiteSpace($proxyValue) -and (Test-DirectTelegramReachable)) {
    $envMap['CYBERBOSS_TELEGRAM_PROXY_URL'] = ''
    $envMap['HTTP_PROXY'] = ''
    $envMap['HTTPS_PROXY'] = ''
    $envMap['ALL_PROXY'] = ''
  }
}

function Resolve-ClaudeCommand {
  param([hashtable]$Config)

  function Find-ClaudeExe {
    $npmClaudeRoot = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code'
    if (Test-Path $npmClaudeRoot) {
      $preferred = Join-Path $npmClaudeRoot 'bin\claude.exe'
      if (Test-Path $preferred) {
        return (Resolve-Path $preferred).Path
      }
      $candidate = Get-ChildItem -Path $npmClaudeRoot -Filter 'claude.exe' -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object FullName |
        Select-Object -First 1
      if ($candidate -and (Test-Path $candidate.FullName)) {
        return (Resolve-Path $candidate.FullName).Path
      }
    }
    $cmd = Get-Command claude.exe -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path $cmd.Source)) {
      return (Resolve-Path $cmd.Source).Path
    }
    return ''
  }

  $configured = ''
  if ($Config.ContainsKey('CYBERBOSS_CLAUDE_COMMAND')) {
    $configured = [string]$Config['CYBERBOSS_CLAUDE_COMMAND']
  }
  $exePath = Find-ClaudeExe
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    if (-not (Test-Path $configured)) {
      throw "Configured CYBERBOSS_CLAUDE_COMMAND does not exist: $configured"
    }
    $resolvedConfigured = (Resolve-Path $configured).Path
    if ($resolvedConfigured -match '\.(cmd|bat|ps1)$' -and -not [string]::IsNullOrWhiteSpace($exePath)) {
      return $exePath
    }
    return $resolvedConfigured
  }

  if (-not [string]::IsNullOrWhiteSpace($exePath)) {
    return $exePath
  }

  $cmd = Get-Command claude.cmd -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Path $cmd.Source)) {
    return (Resolve-Path $cmd.Source).Path
  }

  $all = Get-Command claude -All -ErrorAction Stop
  $candidate = $all | Where-Object { $_.Source -match '\.(cmd|bat|exe)$' } | Select-Object -First 1
  if (-not $candidate) {
    $candidate = $all | Select-Object -First 1
  }
  if (-not $candidate -or -not (Test-Path $candidate.Source)) {
    throw 'Unable to resolve a usable Claude CLI path.'
  }
  return (Resolve-Path $candidate.Source).Path
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\CyberbossDeepseekTelegramStartSafe')
if (-not $mutex.WaitOne(0)) {
  Write-Host 'Another start-safe.ps1 is already starting TG; exit.'
  exit 0
}

New-Item -ItemType Directory -Force $stateDir | Out-Null
New-Item -ItemType Directory -Force $workspaceRoot | Out-Null
New-Item -ItemType Directory -Force $logDir | Out-Null

$existingPid = 0
if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
}
if ($existingPid -gt 0) {
  try {
    $null = Get-Process -Id $existingPid -ErrorAction Stop
  } catch {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    $existingPid = 0
  }
  if ($existingPid -gt 0) {
    Write-Host "cyberboss is already running with PID $existingPid"
    $mutex.ReleaseMutex() | Out-Null
    exit 0
  }
}

$stale = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.CommandLine -like "*$repoRoot*") -and
    ($_.CommandLine -like '*bin\cyberboss.js*' -or $_.CommandLine -like '*bin/cyberboss.js*')
  }
foreach ($p in $stale) {
  try {
    if ([int]$p.ProcessId -ne $PID) {
      Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop
      Write-Host "Stopped stale cyberboss TG PID $($p.ProcessId)"
    }
  } catch {}
}

$env:CYBERBOSS_STATE_DIR = $stateDir
$claudeCommand = Resolve-ClaudeCommand -Config $envMap
$claudeDir = Split-Path -Parent $claudeCommand

if (-not ($env:Path -split ';' | Where-Object { $_ -eq $claudeDir })) {
  $env:Path = "$claudeDir;$env:Path"
}

$env:CYBERBOSS_CLAUDE_COMMAND = $claudeCommand
$anthAuth = ''
if ($envMap.ContainsKey('ANTHROPIC_AUTH_TOKEN')) { $anthAuth = [string]$envMap['ANTHROPIC_AUTH_TOKEN'] }
if (-not [string]::IsNullOrWhiteSpace($anthAuth)) { $env:ANTHROPIC_API_KEY = $anthAuth }

foreach ($entry in $envMap.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace($entry.Key)) { continue }
  [System.Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
}

[System.Environment]::SetEnvironmentVariable('CYBERBOSS_STATE_DIR', $stateDir, 'Process')
[System.Environment]::SetEnvironmentVariable('CYBERBOSS_CLAUDE_COMMAND', $claudeCommand, 'Process')
if (-not [string]::IsNullOrWhiteSpace($anthAuth)) {
  [System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $anthAuth, 'Process')
}

$launchSnapshot = @(
  "PATH contains Claude dir: $([bool](($env:Path -split ';') -contains $claudeDir))"
  "CYBERBOSS_CLAUDE_COMMAND=$claudeCommand"
  "CYBERBOSS_MEMORY_BACKGROUND_WRITE=$($envMap['CYBERBOSS_MEMORY_BACKGROUND_WRITE'])"
  "ANTHROPIC_BASE_URL=$($envMap['ANTHROPIC_BASE_URL'])"
  "ANTHROPIC_API_KEY present=$([bool](-not [string]::IsNullOrWhiteSpace($anthAuth)))"
  "CYBERBOSS_CLAUDE_MODEL=$($envMap['CYBERBOSS_CLAUDE_MODEL'])"
)
try {
  Set-Content -LiteralPath $launchEnvFile -Value $launchSnapshot -Encoding UTF8
} catch {}

$nodeExe = (Get-Command node).Source
$entrypoint = Join-Path $repoRoot 'bin\cyberboss.js'

function Quote-CmdArg {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-HiddenProcessCapture {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FilePath
  $psi.Arguments = ($ArgumentList | ForEach-Object { Quote-CmdArg $_ }) -join " "
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $false
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    throw ($stderr + $stdout).Trim()
  }
  return $stdout
}

$helperScript = Join-Path $repoRoot 'scripts\windows\start-node-hidden-detached.js'
$anchorScript = Join-Path $repoRoot 'scripts\windows\hidden-console-anchor.js'
if (-not (Test-Path $anchorScript)) {
  [System.Environment]::SetEnvironmentVariable('CYBERBOSS_LEGACY_DETACHED_SPAWN', '1', 'Process')
}
$helperArgs = @($helperScript, $repoRoot, $logFile, $errFile, $entrypoint, 'start')
$rawPid = Invoke-HiddenProcessCapture -FilePath $nodeExe -ArgumentList $helperArgs -WorkingDirectory $repoRoot
$text = ([string]$rawPid).Trim()
if (-not $text) {
  throw 'Failed to start hidden cyberboss-deepseek process.'
}
$procId = [int]$text
if ($procId -le 0) {
  throw 'Failed to start hidden cyberboss-deepseek process.'
}
try {
  Set-Content -LiteralPath $pidFile -Value $procId -NoNewline
} catch {}

Start-Sleep -Seconds 2
Write-Host "Started cyberboss-deepseek PID $procId"
Write-Host "Log: $logFile"
Write-Host "Err: $errFile"
Write-Host "Claude: $claudeCommand"
$mutex.ReleaseMutex() | Out-Null
