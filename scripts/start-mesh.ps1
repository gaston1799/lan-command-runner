# Scheduled-task action for `lcr-cli startup install`.
#
# Every path arrives as an explicit parameter so nothing is guessed from the
# environment, and no secret is ever passed in: the child process reads the
# broker and peer tokens out of the config file itself. This script therefore
# never reads, prints, or logs the contents of that file.

param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = "Stop"

# The log directory must exist before anything can be appended to it, including
# the validation failures below.
$logDirectory = Split-Path -Parent $LogPath
if ([string]::IsNullOrWhiteSpace($logDirectory)) {
  throw "LogPath must include a directory: $LogPath"
}
if (!(Test-Path -LiteralPath $logDirectory)) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

function Write-MeshLog([string]$Message) {
  $stamp = (Get-Date).ToString("s")
  Add-Content -LiteralPath $LogPath -Value "[$stamp] [lcr] $Message" -Encoding utf8
}

function Assert-MeshPath([string]$Label, [string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-MeshLog "startup aborted: $Label not found at $Path"
    throw "$Label not found at $Path"
  }
}

Assert-MeshPath "Node executable" $NodePath
Assert-MeshPath "lcr-cli entry point" $CliPath
# A missing config means there is nothing to supervise. Fail loudly in the log
# rather than starting a broker with a generated identity nobody trusts.
Assert-MeshPath "LCR config" $ConfigPath

# The only variable this task injects. Everything else the supervisor needs is
# in the config file at $ConfigPath, whose contents are never echoed.
$env:LCR_CONFIG = $ConfigPath

Write-MeshLog "starting mesh supervisor"
Write-MeshLog "node:   $NodePath"
Write-MeshLog "cli:    $CliPath mesh"
Write-MeshLog "config: $ConfigPath (contents not logged)"

# Append-only: Add-Content never truncates, so restarts accumulate rather than
# discarding the previous session's diagnostics. `*>&1` folds stderr into the
# same stream so both land in one ordered log.
& $NodePath $CliPath mesh *>&1 | Add-Content -LiteralPath $LogPath -Encoding utf8
$exitCode = $LASTEXITCODE

Write-MeshLog "mesh supervisor exited with code $exitCode"
exit $exitCode
