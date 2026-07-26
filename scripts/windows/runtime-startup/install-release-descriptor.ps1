[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CandidatePath,
  [Parameter(Mandatory=$true)][string]$ExpectedCandidateSha256,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,
  [Parameter(Mandatory=$true)][string]$AuditDirectory,
  [Parameter(Mandatory=$true)][string]$TargetDescriptorPath,
  [string]$RepositoryDirectory = ""
)
$ErrorActionPreference = 'Stop'
$repo = if ($RepositoryDirectory) { $RepositoryDirectory } else { Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }
$target = [IO.Path]::GetFullPath($TargetDescriptorPath)
if (-not [IO.Path]::IsPathRooted($TargetDescriptorPath)) { throw 'TargetDescriptorPath must be an absolute path' }
if ($target -ne $TargetDescriptorPath) { throw 'TargetDescriptorPath must be a normalized absolute path' }
& node (Join-Path $repo 'scripts\orchestration\release-control-plane.js') install-descriptor --candidate $CandidatePath --candidate-sha256 $ExpectedCandidateSha256 --manifest $ManifestPath --manifest-sha256 $ExpectedManifestSha256 --audit $AuditDirectory --target $target --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'release descriptor installation failed' }
