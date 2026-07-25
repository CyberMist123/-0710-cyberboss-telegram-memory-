[CmdletBinding()]
param(
  [string]$SourceRoot = '',
  [string]$CyberlinkRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}
if ([string]::IsNullOrWhiteSpace($CyberlinkRoot)) {
  $CyberlinkRoot = Split-Path -Parent $SourceRoot
}
$source = Join-Path $SourceRoot 'extensions\relationship-memory\launcher\watchdog.py'
$targetDir = Join-Path $CyberlinkRoot 'runtime\startup'
$target = Join-Path $targetDir 'telegram-watchdog.py'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Stable watchdog source is missing: $source"
}
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Output "Installed stable Telegram watchdog: $target"
