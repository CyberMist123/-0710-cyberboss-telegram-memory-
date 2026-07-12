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

function Write-TelegramDescriptor {
  param(
    [Parameter(Mandatory = $true)]$Manifest
  )

  $descriptorPath = [string]$Manifest.telegram.descriptor_path
  $rollback = $null
  if ($Manifest.PSObject.Properties.Name.Contains("rollback")) {
    $rollback = @{
      release_id = [string]$Manifest.rollback.release_id
      telegram_entry = [string]$Manifest.rollback.telegram_entry
      config_dir = [string]$Manifest.rollback.config_dir
      state_dir = [string]$Manifest.rollback.state_dir
      log_dir = [string]$Manifest.rollback.log_dir
      pid_file = [string]$Manifest.rollback.pid_file
      watchdog_target = [string]$Manifest.rollback.watchdog_target
      workspace_dir = [string]$Manifest.rollback.workspace_dir
      last_verified_sha = [string]$Manifest.rollback.last_verified_sha
    }
  }

  $descriptor = [ordered]@{
    active_release_id = [string]$Manifest.telegram.release_id
    telegram_entry = [string]$Manifest.telegram.entry
    dashboard_root = [string]$Manifest.dashboard.app_root
    config_dir = [string]$Manifest.telegram.config_dir
    state_dir = [string]$Manifest.telegram.state_dir
    log_dir = [string]$Manifest.telegram.log_dir
    pid_file = [string]$Manifest.telegram.pid_file
    watchdog_target = [string]$Manifest.telegram.watchdog_target
    watchdog_owner_dir = [string]$Manifest.watchdog.owner_dir
    workspace_dir = [string]$Manifest.workspace_root
    last_verified_sha = [string]$Manifest.formal_repo.commit
    rollback_release = $rollback
    verification_mode = "cyberlink_manifest"
    verification_note = "Generated from settings/manifest.json"
  }

  $dir = Split-Path -Parent $descriptorPath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $json = $descriptor | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($descriptorPath, $json + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
  return $descriptorPath
}
