$ErrorActionPreference = "Stop"

$scriptRoot = (Resolve-Path $PSScriptRoot).Path
# R4 F4.1: no ancestor walking. The workspace root decides which python file
# gets executed and where the dashboard keys live, so it must be pinned
# explicitly at install time — a nearer decoy directory that happens to
# contain runtime/ and settings/ must never win.
$root = $env:CYBERLINK_ROOT
if (-not $root) {
    throw "CYBERLINK_ROOT is not set. Refusing to guess the workspace root (R4 F4): pin CYBERLINK_ROOT in the startup entry before starting the dashboard."
}
$root = (Resolve-Path -LiteralPath $root -ErrorAction Stop).Path
foreach ($required in @("runtime", "settings")) {
    if (-not (Test-Path (Join-Path $root $required))) {
        throw "CYBERLINK_ROOT does not look like the workspace root (missing '$required'): $root"
    }
}

$runtime   = Join-Path $root "runtime"
$kitDir    = Join-Path $runtime "web\memory-kit"
$dashboard = Join-Path $kitDir "dashboard_continuity.py"
$python    = if ($env:CYBERBOSS_PYTHON_COMMAND) { $env:CYBERBOSS_PYTHON_COMMAND } else { (Get-Command python.exe -ErrorAction Stop).Source }
$node      = if ($env:CYBERBOSS_NODE_COMMAND) { $env:CYBERBOSS_NODE_COMMAND } else { (Get-Command node.exe -ErrorAction Stop).Source }
$logDir    = Join-Path $runtime "telegram\logs"

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

# 2026-08-12: memory/continuity moved off (Join-Path $root "memory"). That
# folder was archived to backup\legacy-data-20260809\memory on 2026-08-09, so
# ROOT.exists() in dashboard_continuity.py failed and the panel SystemExit(1)'d
# on every boot. Source of truth is settings\secrets\telegram.env: both
# CYBERBOSS_MEMORY_DIR and CYBERBOSS_CONTINUITY_DIR point at
# Fluffy-SelfHood\04-memory (equal since the continuity cutover).
# Keep comments ASCII-only: this file is UTF-8 with no BOM and the Run/Task
# entries launch it with Windows PowerShell 5.1, which decodes it as ANSI -
# a CJK comment can swallow the following line.
$env:CYBERBOSS_HOME                  = Join-Path $runtime "app\telegram"
$env:CYBERBOSS_PROJECT_ROOT          = Join-Path $runtime "app\telegram"
$env:CYBERBOSS_WORKSPACE             = $root
$env:CYBERBOSS_WORKSPACE_ROOT        = $root
$env:CYBERBOSS_STATE_DIR             = Join-Path $runtime "telegram\state"
$env:CYBERBOSS_MEMORY_DIR            = (Join-Path $root "Fluffy-SelfHood\04-memory")
$env:CYBERBOSS_CONTINUITY_DIR        = (Join-Path $root "Fluffy-SelfHood\04-memory")
$env:CYBERBOSS_DASHBOARD_HOST        = "127.0.0.1"
$env:CYBERBOSS_DASHBOARD_PORT        = "520"
$env:CYBERBOSS_DASHBOARD_NO_BROWSER  = "1"
$env:CYBERBOSS_DASHBOARD_PID_FILE    = (Join-Path $kitDir ".panel.pid")
$env:CYBERBOSS_DASHBOARD_KEYS_FILE   = Join-Path $root "settings\secrets\dashboard-keys.local.json"
$env:CYBERBOSS_NODE_COMMAND          = $node
# Required by the panel's janitor-run endpoint. The Claude projects directory
# encodes the workspace root with ':' and '\' flattened to '-', so derive it
# from the pinned root instead of hardcoding a user path.
if (-not $env:CYBERBOSS_CLAUDE_TRANSCRIPT_DIR) {
    $env:CYBERBOSS_CLAUDE_TRANSCRIPT_DIR = Join-Path $env:USERPROFILE (".claude\projects\" + ($root -replace "[:\\]", "-"))
}

# pythonw crashes leave no trace (root cause of the 2026-07-22 panel outage);
# use python.exe with a hidden window and log redirection instead.
Start-Process `
    -FilePath $python `
    -ArgumentList @($dashboard) `
    -WorkingDirectory $kitDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "dashboard.out.log") `
    -RedirectStandardError (Join-Path $logDir "dashboard.err.log")
