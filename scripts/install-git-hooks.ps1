#!/usr/bin/env pwsh
# Installs the hooks in .githooks/ into the git common dir's hooks directory.
#
# Why not `git config core.hooksPath .githooks`: this repository has several
# worktrees. A relative hooksPath resolves against each worktree's own root, so
# checking out a branch that predates .githooks makes git find no hook and skip
# it SILENTLY -- the secret gate would fail open with no warning. The hooks
# directory in the common dir is shared by every worktree: install once, covers
# all of them, and checking out an old branch cannot switch it off.
#
# Re-run this script after editing anything under .githooks/.
#
# ASCII only, English messages: see .agents/skills/windows-script-encoding.
$ErrorActionPreference = 'Stop'

$root = (git rev-parse --show-toplevel).Trim()
$common = (git rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $root $common }

$source = Join-Path $root '.githooks'
$dest = Join-Path $common 'hooks'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($hook in Get-ChildItem -LiteralPath $source -File) {
    $target = Join-Path $dest $hook.Name
    # Hooks are sh scripts and must stay LF. Copy-Item is a byte copy.
    Copy-Item -LiteralPath $hook.FullName -Destination $target -Force
    Write-Host "installed: $target"
}

Write-Host 'Done. To exercise a hook on its own, run it from Git Bash (PowerShell has no sh on PATH).'
