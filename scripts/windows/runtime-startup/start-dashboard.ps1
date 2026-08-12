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
# 2026-08-12: was (Join-Path $root "memory"). That folder was archived to
# backup\legacy-data-20260809\memory on 2026-08-09 19:49, so ROOT.exists() in
# dashboard_continuity.py failed and the panel SystemExit(1)'d on every boot.
# Source of truth is settings\secrets\telegram.env: both CYBERBOSS_MEMORY_DIR and
# CYBERBOSS_CONTINUITY_DIR point at Fluffy-SelfHood\04-memory (equal since the
# continuity cutover). Keep comments ASCII-only: this file is UTF-8 with no BOM
# and the Run/Task entries launch it with Windows PowerShell 5.1, which decodes
# it as ANSI - a CJK comment can swallow the following line.
$env:CYBERBOSS_MEMORY_DIR            = (Join-Path $root "Fluffy-SelfHood\04-memory")
$env:CYBERBOSS_CONTINUITY_DIR        = (Join-Path $root "Fluffy-SelfHood\04-memory")
$env:CYBERBOSS_DASHBOARD_HOST        = "127.0.0.1"
$env:CYBERBOSS_DASHBOARD_PORT        = "520"
$env:CYBERBOSS_DASHBOARD_NO_BROWSER  = "1"
$env:CYBERBOSS_DASHBOARD_PID_FILE    = (Join-Path $kitDir ".panel.pid")
$env:CYBERBOSS_DASHBOARD_KEYS_FILE   = "C:\Users\18717\Documents\cyberlink\settings\secrets\dashboard-keys.local.json"
$env:CYBERBOSS_NODE_COMMAND          = $node
# Required by the panel's janitor-run endpoint (release kit 08-11); value
# mirrors settings\secrets\telegram.env.
$env:CYBERBOSS_CLAUDE_TRANSCRIPT_DIR = "C:\Users\18717\.claude\projects\C--Users-18717-Documents-cyberlink"

# pythonw crashes leave no trace (root cause of the 2026-07-22 panel outage);
# use python.exe with a hidden window and log redirection instead.
Start-Process `
    -FilePath $python `
    -ArgumentList @($dashboard) `
    -WorkingDirectory $kitDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "dashboard.out.log") `
    -RedirectStandardError (Join-Path $logDir "dashboard.err.log")