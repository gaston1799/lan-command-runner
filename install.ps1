param(
  [string]$Repo = $env:LCR_REPO,
  [string]$InstallRoot = $env:LCR_INSTALL_ROOT,
  [string]$Version = $env:LCR_VERSION,
  [switch]$SkipLink
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = "gaston1799/lan-command-runner"
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "lan-command-runner"
}

# The install root and the runtime-data root are the same directory by default,
# so replacing the code would otherwise destroy the node's identity. Only these
# exact, known runtime artifacts are preserved across an upgrade. Nothing here
# is a wildcard and nothing here is source code: JavaScript, package.json, and
# every other tracked file always comes from the new release.
$PreservedFiles = @("config.json", "tray-settings.json", ".lcr-token")
$PreservedDirectories = @("logs")

function Require-Command($Name, $InstallHint) {
  if (!(Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $InstallHint"
  }
}

function Protect-LcrRuntimeBackup($Backup) {
  if ($env:OS -eq "Windows_NT") {
    $principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ([string]::IsNullOrWhiteSpace($principal)) {
      throw "Could not determine the current Windows identity for the runtime-state backup."
    }
    $grant = "${principal}:(OI)(CI)F"
    & icacls.exe $Backup "/inheritance:r" "/grant:r" $grant "/T" "/C" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restrict the runtime-state backup to the current Windows user."
    }
    return
  }

  if (Get-Command chmod -ErrorAction SilentlyContinue) {
    & chmod -R "go-rwx" $Backup
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restrict the runtime-state backup permissions."
    }
  }
}

# Copies the known runtime artifacts out of $Root into $Backup. Returns the ACL
# of config.json when it exists, so the restore can put the original permissions
# back rather than inheriting the installer's.
function Backup-LcrRuntimeState($Root, $Backup) {
  $configAcl = $null
  New-Item -ItemType Directory -Force -Path $Backup | Out-Null
  Protect-LcrRuntimeBackup $Backup

  foreach ($name in $PreservedFiles) {
    $source = Join-Path $Root $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      if ($name -eq "config.json") {
        try { $configAcl = Get-Acl -LiteralPath $source } catch { $configAcl = $null }
      }
      Copy-Item -LiteralPath $source -Destination (Join-Path $Backup $name) -Force
      Write-Host "[lcr] Preserving $name"
    }
  }

  foreach ($name in $PreservedDirectories) {
    $source = Join-Path $Root $name
    if (Test-Path -LiteralPath $source -PathType Container) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $Backup $name) -Recurse -Force
      Write-Host "[lcr] Preserving $name\"
    }
  }

  # Reapply after copying so every preserved child has the same private ACL.
  # A failure happens before InstallRoot is removed, leaving the originals safe.
  Protect-LcrRuntimeBackup $Backup
  return $configAcl
}

# Restores exactly what Backup-LcrRuntimeState saved. Never prints file
# contents, and never overwrites a file the new release shipped by name other
# than the known runtime artifacts above.
function Restore-LcrRuntimeState($Root, $Backup, $ConfigAcl) {
  if (!(Test-Path -LiteralPath $Backup -PathType Container)) {
    return
  }

  foreach ($name in $PreservedFiles) {
    $source = Join-Path $Backup $name
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $destination = Join-Path $Root $name
      Copy-Item -LiteralPath $source -Destination $destination -Force
      Write-Host "[lcr] Restored $name"
      if ($name -eq "config.json" -and $ConfigAcl) {
        # Best effort: the config holds the broker token and every peer token,
        # so an inherited-permissions copy is worse than the original.
        try {
          Set-Acl -LiteralPath $destination -AclObject $ConfigAcl
        } catch {
          Write-Host "[lcr] Warning: could not restore config.json permissions. Review the file ACL manually."
        }
      }
    }
  }

  foreach ($name in $PreservedDirectories) {
    $source = Join-Path $Backup $name
    if (Test-Path -LiteralPath $source -PathType Container) {
      Copy-Item -LiteralPath $source -Destination $Root -Recurse -Force
      Write-Host "[lcr] Restored $name\"
    }
  }
}

function Get-LatestTag($RepoName) {
  if (![string]::IsNullOrWhiteSpace($Version) -and $Version -ne "latest") {
    return $Version
  }

  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoName/releases/latest" -Headers @{
    "User-Agent" = "lan-command-runner-installer"
  }
  return $release.tag_name
}

Require-Command "node" "Install Node.js LTS from https://nodejs.org/ and rerun this installer."
Require-Command "npm" "Install Node.js LTS from https://nodejs.org/ and rerun this installer."
Require-Command "git" "Install Git from https://git-scm.com/ and rerun this installer."

$tag = Get-LatestTag $Repo
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lan-command-runner-install-" + [guid]::NewGuid().ToString("n"))
$sourceDir = Join-Path $tempRoot "source"
$cloneUrl = "https://github.com/$Repo.git"

# Unique, outside $InstallRoot, and removed in the finally block below.
$preserveRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lan-command-runner-preserve-" + [guid]::NewGuid().ToString("n"))
$preservedConfigAcl = $null
$preserved = $false
$stateRestored = $false

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  Write-Host "[lcr] Installing $Repo@$tag"
  Write-Host "[lcr] Cloning release tag $tag from $cloneUrl"
  & git clone --quiet --depth 1 --branch $tag --single-branch $cloneUrl $sourceDir
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $sourceDir ".git") -PathType Container)) {
    throw "Could not clone release tag $tag from $cloneUrl."
  }

  if (Test-Path -LiteralPath $InstallRoot) {
    $preservedConfigAcl = Backup-LcrRuntimeState $InstallRoot $preserveRoot
    $preserved = $true
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallRoot) | Out-Null
  Move-Item -LiteralPath $sourceDir -Destination $InstallRoot

  $installedCommit = (& git -C $InstallRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installedCommit)) {
    throw "The installed Git clone has no readable commit."
  }
  @{
    managed = $true
    repo = $Repo
    release = $tag
    commit = $installedCommit
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot ".lcr-managed-install.json") -Encoding UTF8

  if ($preserved) {
    Restore-LcrRuntimeState $InstallRoot $preserveRoot $preservedConfigAcl
    $stateRestored = $true
  }

  Push-Location $InstallRoot
  try {
    npm install --omit=dev
    if (!$SkipLink) {
      npm link
    }
  } finally {
    Pop-Location
  }

  Write-Host "[lcr] Installed to $InstallRoot"
  if (!$SkipLink) {
    Write-Host "[lcr] Linked commands: lcr, lcr-cli"
    Write-Host "[lcr] Run 'lcr' to open the tray UI or 'lcr-cli --help' for terminal commands."
  }
  if ($preserved) {
    Write-Host "[lcr] Existing config.json, .lcr-token, tray settings, and logs were preserved."
  }
  Write-Host ""
  Write-Host "[lcr] Mesh quick start (run on each PC, then link them explicitly):"
  Write-Host "  lcr-cli mesh init --name $env:COMPUTERNAME --host 0.0.0.0 --port 8765"
  Write-Host "  lcr-cli mesh"
  Write-Host "  lcr-cli peer add OTHER_PC --url http://OTHER_PC_LAN_IP:8765"
  Write-Host "  lcr-cli doctor"
  Write-Host "  lcr-cli startup install"
  Write-Host ""
  Write-Host "[lcr] 'peer add' must be run on BOTH machines; discovery grants no trust."
  Write-Host "[lcr] This installer does not configure the mesh or register startup for you."
  Write-Host ""
  Write-Host "[lcr] Legacy single-broker quick start:"
  Write-Host "  `$env:LCR_TOKEN = '<token-from-lcr-token>'"
  Write-Host "  lcr-cli broker --host 0.0.0.0 --port 8765"
  Write-Host ""
  Write-Host "[lcr] Legacy agent quick setup:"
  Write-Host "  lcr-cli setup --url http://BROKER_IP:8765 --token '<same-token>' --agent-name $env:COMPUTERNAME"
  Write-Host "  lcr-cli agent"
} catch {
  $installError = $_

  # Once InstallRoot has been removed, preserveRoot may be the only remaining
  # copy of the node id and every broker/peer token. Try to put the allowlisted
  # runtime state back before propagating the install failure. If that rollback
  # also fails, keep the backup directory for manual recovery.
  if ($preserved -and !$stateRestored -and (Test-Path -LiteralPath $preserveRoot -PathType Container)) {
    try {
      if (!(Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
      }
      Restore-LcrRuntimeState $InstallRoot $preserveRoot $preservedConfigAcl
      $stateRestored = $true
      Write-Host "[lcr] Install failed; the previous runtime configuration was restored."
    } catch {
      Write-Host "[lcr] WARNING: install and automatic state restore both failed."
      Write-Host "[lcr] Your previous config, tokens, settings, and logs remain at:"
      Write-Host "[lcr]   $preserveRoot"
    }
  }

  throw $installError
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (!$preserved -or $stateRestored) {
    Remove-Item -LiteralPath $preserveRoot -Recurse -Force -ErrorAction SilentlyContinue
  } elseif (Test-Path -LiteralPath $preserveRoot -PathType Container) {
    Write-Host "[lcr] Recovery backup retained at $preserveRoot"
  }
}
