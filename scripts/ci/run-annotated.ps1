# Runs a CI command, teeing output to a log; on failure emits the failing TAP
# blocks (or the log tail) as a GitHub annotation so failures are readable
# without repository credentials (run-page annotations are public).
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Command
)

$safe = ($Name -replace '[^\w.-]', '_')
$log = Join-Path $env:RUNNER_TEMP "$safe.log"

& { Invoke-Expression $Command } 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE

if ($code -ne 0) {
  $blocks = Select-String -Path $log -Pattern 'not ok' -Context 0, 30
  $chunk = ($blocks | ForEach-Object { , $_.Line + $_.Context.PostContext } | ForEach-Object { $_ }) -join '%0A'
  if (-not $chunk) { $chunk = ((Get-Content $log | Select-Object -Last 60) -join '%0A') }
  if ($chunk.Length -gt 3800) { $chunk = $chunk.Substring(0, 3800) }
  Write-Output "::error title=$Name failing output::$chunk"
  exit $code
}
