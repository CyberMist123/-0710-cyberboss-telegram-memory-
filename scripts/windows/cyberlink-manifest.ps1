[CmdletBinding()]
param(
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

function Resolve-CyberlinkManifestPath {
  param([string]$PathHint = "")

  if ($PathHint) {
    return (Resolve-Path -LiteralPath $PathHint).Path
  }

  $envHint = [System.Environment]::GetEnvironmentVariable("CYBERLINK_MANIFEST", "Process")
  if (-not [string]::IsNullOrWhiteSpace($envHint) -and (Test-Path -LiteralPath $envHint -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $envHint).Path
  }

  # Walk up from this script towards the workspace root; no hardcoded machine paths.
  $cursor = [IO.DirectoryInfo](Resolve-Path -LiteralPath $PSScriptRoot).Path
  while ($null -ne $cursor) {
    $candidate = Join-Path $cursor.FullName "settings\manifest.json"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
    $cursor = $cursor.Parent
  }

  throw "settings/manifest.json not found; pass -ManifestPath or set CYBERLINK_MANIFEST."
}

function Read-CyberlinkManifest {
  param([string]$PathHint = "")

  $resolved = Resolve-CyberlinkManifestPath -PathHint $PathHint
  $value = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
  $value | Add-Member -NotePropertyName "__manifest_path" -NotePropertyValue $resolved -Force
  foreach ($field in @("workspace_root", "formal_repo", "telegram", "dashboard", "watchdog", "soft_retrieval")) {
    if (-not $value.PSObject.Properties.Name.Contains($field)) {
      throw "Manifest field missing: $field"
    }
  }
  return $value
}

function Resolve-NodeCommand {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-Path $command.Source)) {
    return (Resolve-Path $command.Source).Path
  }
  throw "node.exe was not found on PATH."
}

function Resolve-PythonWindowless {
  foreach ($name in @("pythonw.exe", "python.exe")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and (Test-Path $command.Source)) {
      return (Resolve-Path $command.Source).Path
    }
  }
  throw "pythonw.exe or python.exe was not found on PATH."
}

function Invoke-RobocopySafe {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExtraArgs = @()
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy $Source $Destination @ExtraArgs | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed: $Source -> $Destination (code=$LASTEXITCODE)"
  }
}

function Resolve-DescriptorAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Field
  )

  if ([string]::IsNullOrWhiteSpace($Value) -or -not [System.IO.Path]::IsPathRooted($Value)) {
    throw "$Field must be an absolute path."
  }
  $full = [System.IO.Path]::GetFullPath($Value)
  if (-not [string]::Equals($full, $Value, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Field must be a normalized absolute path."
  }
  return $full
}

function Test-DescriptorChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )

  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  if ([string]::Equals($parentFull, $childFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
  return $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DescriptorTarget {
  param(
    [Parameter(Mandatory = $true)]$Target,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $releaseId = [string]$Target.release_id
  if ([string]::IsNullOrWhiteSpace($releaseId)) {
    throw "$Name.release_id must be a non-empty string."
  }
  $sha = [string]$Target.last_verified_sha
  if ($sha -notmatch '^[0-9a-fA-F]{40}$') {
    throw "$Name.last_verified_sha must be a full 40-character git SHA."
  }
  $paths = @{}
  foreach ($field in @('telegram_entry', 'config_dir', 'state_dir', 'log_dir', 'pid_file', 'watchdog_target')) {
    $paths[$field] = Resolve-DescriptorAbsolutePath -Value ([string]$Target.$field) -Field "$Name.$field"
  }
  $releasePath = Split-Path -Parent (Split-Path -Parent $paths.telegram_entry)
  if (-not (Test-Path -LiteralPath $releasePath -PathType Container)) {
    throw "$Name.release_path does not exist as a directory: $releasePath"
  }
  if (-not (Test-DescriptorChildPath -Parent $releasePath -Child $paths.telegram_entry)) {
    throw "$Name.telegram_entry must be inside the inferred release_path."
  }
  if (-not (Test-DescriptorChildPath -Parent $releasePath -Child $paths.watchdog_target)) {
    throw "$Name.watchdog_target must be inside the inferred release_path."
  }
  foreach ($field in @('config_dir', 'state_dir', 'log_dir', 'pid_file')) {
    if (Test-DescriptorChildPath -Parent $releasePath -Child $paths[$field]) {
      throw "$Name.$field must be outside the inferred release_path."
    }
  }
  if (-not (Test-DescriptorChildPath -Parent $paths.state_dir -Child $paths.pid_file)) {
    throw "$Name.pid_file must belong to $Name.state_dir."
  }
  foreach ($field in @('telegram_entry', 'watchdog_target')) {
    if (-not (Test-Path -LiteralPath $paths[$field] -PathType Leaf)) {
      throw "$Name.$field does not exist as a file: $($paths[$field])"
    }
  }
  foreach ($field in @('config_dir', 'state_dir', 'log_dir')) {
    if (-not (Test-Path -LiteralPath $paths[$field] -PathType Container)) {
      throw "$Name.$field does not exist as a directory: $($paths[$field])"
    }
  }
  $pidParent = Split-Path -Parent $paths.pid_file
  if (-not (Test-Path -LiteralPath $pidParent -PathType Container)) {
    throw "$Name.pid_file parent directory does not exist: $pidParent"
  }
  if (Test-Path -LiteralPath $paths.pid_file) {
    $pidItem = Get-Item -LiteralPath $paths.pid_file -Force
    $isReparsePoint = (($pidItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    if (-not ($pidItem -is [System.IO.FileInfo]) -or $isReparsePoint) {
      throw "$Name.pid_file must be a regular file when present: $($paths.pid_file)"
    }
  }
  return [pscustomobject]@{ release_id = $releaseId; last_verified_sha = $sha; release_path = $releasePath; paths = $paths }
}

function Write-TelegramDescriptor {
  param(
    [Parameter(Mandatory = $true)]$Manifest
  )

  $descriptorPath = Resolve-DescriptorAbsolutePath -Value ([string]$Manifest.telegram.descriptor_path) -Field 'descriptor_path'
  if (-not $Manifest.PSObject.Properties.Name.Contains('rollback')) {
    throw 'Manifest field missing: rollback'
  }
  $activeTarget = [pscustomobject]@{
    release_id = [string]$Manifest.telegram.release_id
    telegram_entry = [string]$Manifest.telegram.entry
    config_dir = [string]$Manifest.telegram.config_dir
    state_dir = [string]$Manifest.telegram.state_dir
    log_dir = [string]$Manifest.telegram.log_dir
    pid_file = [string]$Manifest.telegram.pid_file
    watchdog_target = [string]$Manifest.telegram.watchdog_target
    last_verified_sha = [string]$Manifest.formal_repo.commit
  }
  $rollbackTarget = [pscustomobject]@{
    release_id = [string]$Manifest.rollback.release_id
    telegram_entry = [string]$Manifest.rollback.telegram_entry
    config_dir = [string]$Manifest.rollback.config_dir
    state_dir = [string]$Manifest.rollback.state_dir
    log_dir = [string]$Manifest.rollback.log_dir
    pid_file = [string]$Manifest.rollback.pid_file
    watchdog_target = [string]$Manifest.rollback.watchdog_target
    last_verified_sha = [string]$Manifest.rollback.last_verified_sha
  }
  $active = Assert-DescriptorTarget -Target $activeTarget -Name 'active'
  $rollback = Assert-DescriptorTarget -Target $rollbackTarget -Name 'rollback'
  if ([string]::Equals($active.release_path, $rollback.release_path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'active.release_path and rollback.release_path must refer to distinct release directories.'
  }
  if ([string]::Equals($active.release_id, $rollback.release_id, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'active.release_id and rollback.release_id must be distinct.'
  }
  if (Test-DescriptorChildPath -Parent $rollback.release_path -Child $active.paths.pid_file) {
    throw 'active.pid_file must be outside rollback.release_path.'
  }
  if (Test-DescriptorChildPath -Parent $active.release_path -Child $rollback.paths.pid_file) {
    throw 'rollback.pid_file must be outside active.release_path.'
  }
  $descriptorDir = Split-Path -Parent $descriptorPath
  if (-not (Test-Path -LiteralPath $descriptorDir -PathType Container)) {
    throw "descriptor_path parent directory does not exist: $descriptorDir"
  }

  $descriptor = [ordered]@{
    active_release_id = $active.release_id
    telegram_entry = $active.paths.telegram_entry
    dashboard_root = [string]$Manifest.dashboard.app_root
    config_dir = $active.paths.config_dir
    state_dir = $active.paths.state_dir
    log_dir = $active.paths.log_dir
    pid_file = $active.paths.pid_file
    watchdog_target = $active.paths.watchdog_target
    watchdog_owner_dir = [string]$Manifest.watchdog.owner_dir
    workspace_dir = [string]$Manifest.workspace_root
    last_verified_sha = $active.last_verified_sha
    rollback_release = [ordered]@{
      release_id = $rollback.release_id
      telegram_entry = $rollback.paths.telegram_entry
      config_dir = $rollback.paths.config_dir
      state_dir = $rollback.paths.state_dir
      log_dir = $rollback.paths.log_dir
      pid_file = $rollback.paths.pid_file
      watchdog_target = $rollback.paths.watchdog_target
      workspace_dir = [string]$Manifest.rollback.workspace_dir
      last_verified_sha = $rollback.last_verified_sha
    }
    verification_mode = "cyberlink_manifest"
    verification_note = "Generated from settings/manifest.json"
  }

  $json = $descriptor | ConvertTo-Json -Depth 20
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $tempPath = Join-Path $descriptorDir ('.' + [System.IO.Path]::GetFileName($descriptorPath) + '.' + [System.IO.Path]::GetRandomFileName() + '.tmp')
  $backupPath = Join-Path $descriptorDir ('.' + [System.IO.Path]::GetFileName($descriptorPath) + '.' + [System.IO.Path]::GetRandomFileName() + '.bak')
  try {
    $stream = [System.IO.FileStream]::new($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $writer = [System.IO.StreamWriter]::new($stream, $encoding, 4096, $true)
      try {
        $writer.Write($json + [Environment]::NewLine)
        $writer.Flush()
        $stream.Flush($true)
      } finally {
        $writer.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    if (Test-Path -LiteralPath $descriptorPath -PathType Leaf) {
      [System.IO.File]::Replace($tempPath, $descriptorPath, $backupPath, $true)
    } else {
      [System.IO.File]::Move($tempPath, $descriptorPath)
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
  }
  return $descriptorPath
}
