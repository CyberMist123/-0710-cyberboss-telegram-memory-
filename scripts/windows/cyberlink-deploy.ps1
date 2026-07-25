[CmdletBinding()]
param(
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cyberlink-manifest.ps1")

$manifest = Read-CyberlinkManifest -PathHint $ManifestPath
$repoRoot = [string]$manifest.formal_repo.path
$dependencySource = [string]$manifest.build.dependency_source_dir

if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) {
  throw "Formal repo missing: $repoRoot"
}
if (-not (Test-Path -LiteralPath $dependencySource -PathType Container)) {
  throw "Dependency source missing: $dependencySource"
}

$commonCopyArgs = @(
  "/E", "/FFT", "/R:1", "/W:1",
  "/XD", ".git", "node_modules",
  "/XF", ".env", "keys.local.json"
)

Invoke-RobocopySafe -Source $repoRoot -Destination ([string]$manifest.telegram.app_root) -ExtraArgs $commonCopyArgs
Invoke-RobocopySafe -Source $repoRoot -Destination ([string]$manifest.wechat.app_root) -ExtraArgs $commonCopyArgs
Invoke-RobocopySafe -Source (Join-Path $repoRoot "extensions\relationship-memory") -Destination ([string]$manifest.dashboard.app_root) -ExtraArgs @("/E", "/FFT", "/R:1", "/W:1", "/XF", "keys.local.json")

$nodeModulesSource = Join-Path $dependencySource "node_modules"
if (Test-Path -LiteralPath $nodeModulesSource -PathType Container) {
  Invoke-RobocopySafe -Source $nodeModulesSource -Destination (Join-Path ([string]$manifest.telegram.app_root) "node_modules") -ExtraArgs @("/E", "/FFT", "/R:1", "/W:1")
  Invoke-RobocopySafe -Source $nodeModulesSource -Destination (Join-Path ([string]$manifest.wechat.app_root) "node_modules") -ExtraArgs @("/E", "/FFT", "/R:1", "/W:1")
}

$legacyTheater = [string]$manifest.build.legacy_theater_dir
if ($legacyTheater -and (Test-Path -LiteralPath $legacyTheater -PathType Container)) {
  Invoke-RobocopySafe -Source $legacyTheater -Destination (Join-Path ([string]$manifest.dashboard.app_root) "theater") -ExtraArgs @("/E", "/FFT", "/R:1", "/W:1")
}

Write-TelegramDescriptor -Manifest $manifest | Out-Null
& (Join-Path $PSScriptRoot 'runtime-startup\install-telegram-watchdog.ps1') -SourceRoot $repoRoot -CyberlinkRoot (Split-Path -Parent $repoRoot)
Write-Output "Deployed code to runtime apps and web."

