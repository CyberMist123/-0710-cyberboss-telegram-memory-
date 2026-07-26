# Retired. The robocopy deploy model (mutable worktree copies as production)
# is replaced by immutable git-archive releases installed through
# runtime-startup/install-release-descriptor.ps1 and
# install-runtime-startup-artifacts.ps1 with explicit targets and verified
# manifests. This script previously ended in Write-TelegramDescriptor (which
# already throws) and a call to a retired installer with removed parameters;
# it is now explicitly fail-closed at the top so no path through it can copy
# code or rewrite topology.
$ErrorActionPreference = 'Stop'
throw 'cyberlink-deploy.ps1 is retired. Build an immutable release and install it with the runtime-startup installers (see docs/ORCHESTRATION_PHASE1.md).'
