[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$DescriptorPath,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [string]$CyberlinkRoot = '',
  [string]$RepositoryDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repo = if ($RepositoryDirectory) { $RepositoryDirectory } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
$cyberlink = if ($CyberlinkRoot) { $CyberlinkRoot } else { Split-Path -Parent $repo }
$raw = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $DescriptorPath))
if ($raw.Length -ge 3 -and $raw[0] -eq 0xef -and $raw[1] -eq 0xbb -and $raw[2] -eq 0xbf) { throw 'Descriptor must be UTF-8 without BOM' }
$descriptor = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json -ErrorAction Stop
$release = Split-Path -Parent (Split-Path -Parent ([string]$descriptor.telegram_entry))
$targetDir = Join-Path $cyberlink 'runtime\startup'
$pairs = @(
  @{ Source = (Join-Path $release 'extensions\relationship-memory\launcher\watchdog.py'); Target = (Join-Path $targetDir 'telegram-watchdog.py') },
  @{ Source = (Join-Path $release 'scripts\windows\runtime-startup\stable-telegram-launcher.candidate.ps1'); Target = (Join-Path $targetDir 'stable-telegram-launcher.ps1') }
)
foreach ($pair in $pairs) {
  if (-not (Test-Path -LiteralPath $pair.Source -PathType Leaf)) { throw "Active release startup source is missing: $($pair.Source)" }
  & node -e "const c=require(process.argv[1]);c.installStartupArtifact({source:process.argv[2],target:process.argv[3],manifestPath:process.argv[4],releaseDir:process.argv[5],repoDir:process.argv[6]})" (Join-Path $repo 'scripts\orchestration\release-control-plane.js') $pair.Source $pair.Target $ManifestPath $release $repo
  if ($LASTEXITCODE -ne 0) { throw "Startup artifact installation failed manifest/hash verification: $($pair.Source)" }
}
