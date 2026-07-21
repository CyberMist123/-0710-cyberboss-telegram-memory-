$ErrorActionPreference = "Stop"

$root      = "C:\Users\18717\Documents\cyberlink"
$kitDir    = "C:\Users\18717\Documents\cyberlink\runtime\web\memory-kit"
$dashboard = "C:\Users\18717\Documents\cyberlink\runtime\web\memory-kit\dashboard_continuity.py"
$python    = "C:\Python314\python.exe"
$node      = "C:\Program Files\nodejs\node.exe"
$logDir    = "C:\Users\18717\Documents\cyberlink\runtime\telegram\logs"

$oldDashboard = Join-Path $kitDir "dashboard.py"

$layeredRows = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            ([string]$_.CommandLine).IndexOf(
                $dashboard,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        }
)

if ($layeredRows.Count -gt 0) {
    exit 0
}

$oldRows = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            ([string]$_.CommandLine).IndexOf(
                $oldDashboard,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        }
)

foreach ($row in $oldRows) {
    Stop-Process -Id $row.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath (Join-Path $kitDir ".panel.pid") `
    -Force `
    -ErrorAction SilentlyContinue

$env:CYBERBOSS_HOME                  = "C:\Users\18717\Documents\cyberlink\runtime\app\telegram"
$env:CYBERBOSS_PROJECT_ROOT          = "C:\Users\18717\Documents\cyberlink\runtime\app\telegram"
$env:CYBERBOSS_WORKSPACE             = $root
$env:CYBERBOSS_WORKSPACE_ROOT        = $root
$env:CYBERBOSS_STATE_DIR             = "C:\Users\18717\Documents\cyberlink\runtime\telegram\state"
$env:CYBERBOSS_MEMORY_DIR            = (Join-Path $root "memory")
$env:CYBERBOSS_CONTINUITY_DIR        = (Join-Path $root "memory")
$env:CYBERBOSS_DASHBOARD_HOST        = "127.0.0.1"
$env:CYBERBOSS_DASHBOARD_PORT        = "520"
$env:CYBERBOSS_DASHBOARD_NO_BROWSER  = "1"
$env:CYBERBOSS_DASHBOARD_PID_FILE    = (Join-Path $kitDir ".panel.pid")
$env:CYBERBOSS_DASHBOARD_KEYS_FILE   = "C:\Users\18717\Documents\cyberlink\settings\secrets\dashboard-keys.local.json"
$env:CYBERBOSS_NODE_COMMAND          = $node

# pythonw 静默崩溃无迹可寻(2026-07-22 520起不来的根因);改用 python.exe 隐窗启动并落日志
Start-Process `
    -FilePath $python `
    -ArgumentList @($dashboard) `
    -WorkingDirectory $kitDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "dashboard.out.log") `
    -RedirectStandardError (Join-Path $logDir "dashboard.err.log")