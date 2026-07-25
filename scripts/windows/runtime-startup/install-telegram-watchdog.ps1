[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DescriptorPath,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [string]$CyberlinkRoot = '',
  [string]$RepositoryDirectory = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CyberlinkRoot)) {
  $CyberlinkRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}
$repo = if ($RepositoryDirectory) { $RepositoryDirectory } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
$raw = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $DescriptorPath))
if ($raw.Length -ge 3 -and $raw[0] -eq 0xef -and $raw[1] -eq 0xbb -and $raw[2] -eq 0xbf) { throw 'Descriptor must be UTF-8 without BOM' }
$descriptor = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$descriptor.telegram_entry)) { throw 'Descriptor missing telegram_entry' }
$release = Split-Path -Parent (Split-Path -Parent ([string]$descriptor.telegram_entry))
$source = Join-Path $release 'extensions\relationship-memory\launcher\watchdog.py'
$targetDir = Join-Path $CyberlinkRoot 'runtime\startup'
$target = Join-Path $targetDir 'telegram-watchdog.py'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Stable watchdog source is missing: $source"
}
& node -e "const c=require(process.argv[1]);c.installStartupArtifact({source:process.argv[2],target:process.argv[3],manifestPath:process.argv[4],releaseDir:process.argv[5],repoDir:process.argv[6]})" (Join-Path $repo 'scripts\orchestration\release-control-plane.js') $source $target $ManifestPath $release $repo
if ($LASTEXITCODE -ne 0) { throw 'Stable watchdog installation failed manifest/hash verification' }
Write-Output "Installed stable Telegram watchdog: $target"
