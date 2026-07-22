$ErrorActionPreference = "Stop"

$scriptRoot = (Resolve-Path $PSScriptRoot).Path
$root = $env:CYBERLINK_ROOT
if (-not $root) {
    $candidate = $scriptRoot
    while ($candidate) {
        if ((Test-Path (Join-Path $candidate "runtime")) -and (Test-Path (Join-Path $candidate "settings"))) {
            $root = $candidate
            break
        }
        $parent = Split-Path -Parent $candidate
        if ($parent -eq $candidate) {
            break
        }
        $candidate = $parent
    }
}
if (-not $root) {
    throw "Unable to locate CYBERLINK_ROOT; set CYBERLINK_ROOT before starting Telegram."
}

$runtime   = Join-Path $root "runtime"
$tgRoot    = Join-Path $runtime "app\telegram"
$tgEntry   = Join-Path $tgRoot "bin\cyberboss.js"
$helper    = Join-Path $tgRoot "extensions\windows-launcher\start-node-hidden-detached.js"
$envFile   = Join-Path $root "settings\secrets\telegram.env"
$stateDir  = Join-Path $runtime "telegram\state"
$logDir    = Join-Path $runtime "telegram\logs"
$node      = if ($env:CYBERBOSS_NODE_COMMAND) { $env:CYBERBOSS_NODE_COMMAND } else { (Get-Command node.exe -ErrorAction Stop).Source }

$pidFile = Join-Path $stateDir "cyberboss.pid"
$logFile = Join-Path $logDir "cyberboss.log"
$errFile = Join-Path $logDir "cyberboss.err.log"

$running = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $command = [string]$_.CommandLine

            $command.IndexOf(
                $tgEntry,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0 -and
            $command -match "(?i)\sstart(\s|$)"
        }
)

if ($running.Count -gt 0) {
    exit 0
}

foreach ($line in Get-Content -LiteralPath $envFile) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $trimmed = $line.Trim()

    if ($trimmed.StartsWith("#")) {
        continue
    }

    $separator = $line.IndexOf("=")

    if ($separator -lt 1) {
        continue
    }

    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()

    [Environment]::SetEnvironmentVariable(
        $key,
        $value,
        "Process"
    )
}

$env:CYBERBOSS_ENV_FILE                = $envFile
$env:CYBERBOSS_CONFIG_DIR              = (Split-Path -Parent $envFile)
$env:CYBERBOSS_STATE_DIR               = $stateDir
$env:CYBERBOSS_LOG_DIR                 = $logDir
$env:CYBERBOSS_WORKSPACE               = $root
$env:CYBERBOSS_WORKSPACE_ROOT          = $root
$env:CYBERBOSS_MEMORY_DIR              = (Join-Path $root "memory")
$env:CYBERBOSS_CONTINUITY_DIR          = (Join-Path $root "memory")
$env:CYBERBOSS_MEMORY_BACKGROUND_WRITE = "0"

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

$rawPid = & $node `
    $helper `
    $tgRoot `
    $logFile `
    $errFile `
    $tgEntry `
    "start"

$ec = $LASTEXITCODE

if ($ec -ne 0) {
    throw "TG 隐藏启动失败，退出码：$ec"
}

$pidText = ([string]$rawPid).Trim()
$newPid = 0

if (
    -not [int]::TryParse($pidText, [ref]$newPid) -or
    $newPid -le 0
) {
    throw "TG 启动器没有返回有效 PID：$pidText"
}

Set-Content `
    -LiteralPath $pidFile `
    -Value $newPid `
    -NoNewline `
    -Encoding ASCII
