# Retired. This installer derived a default target directory and loaded its
# helper implementation from a caller-influenced directory, both of which
# violate the release cutover control-plane contract (explicit targets only,
# fixed code provenance). Keeping it fail-closed prevents any legacy caller
# or scheduled task from silently installing startup artifacts outside the
# audited path.
$ErrorActionPreference = 'Stop'
throw 'install-telegram-watchdog.ps1 is retired. Use runtime-startup/install-runtime-startup-artifacts.ps1 with an explicit -TargetStartupDirectory and a verified release manifest.'
