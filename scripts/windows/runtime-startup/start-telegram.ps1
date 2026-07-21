$ErrorActionPreference = "Stop"

$root      = "C:\Users\18717\Documents\cyberlink"
$tgRoot    = "C:\Users\18717\Documents\cyberlink\runtime\app\telegram"
$tgEntry   = "C:\Users\18717\Documents\cyberlink\runtime\app\telegram\bin\cyberboss.js"
$helper    = "C:\Users\18717\Documents\cyberlink\runtime\app\telegram\extensions\windows-launcher\start-node-hidden-detached.js"
$envFile   = "C:\Users\18717\Documents\cyberlink\settings\secrets\telegram.env"
$stateDir  = "C:\Users\18717\Documents\cyberlink\runtime\telegram\state"
$logDir    = "C:\Users\18717\Documents\cyberlink\runtime\telegram\logs"
$node      = "C:\Program Files\nodejs\node.exe"

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