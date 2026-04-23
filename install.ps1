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

function Require-Command($Name, $InstallHint) {
  if (!(Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $InstallHint"
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

$tag = Get-LatestTag $Repo
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lan-command-runner-install-" + [guid]::NewGuid().ToString("n"))
$zipPath = Join-Path $tempRoot "source.zip"
$extractRoot = Join-Path $tempRoot "extract"
$archiveUrl = "https://github.com/$Repo/archive/refs/tags/$tag.zip"

New-Item -ItemType Directory -Force -Path $tempRoot, $extractRoot | Out-Null

try {
  Write-Host "[lcr] Installing $Repo@$tag"
  Write-Host "[lcr] Downloading $archiveUrl"
  Invoke-WebRequest -Uri $archiveUrl -OutFile $zipPath -Headers @{
    "User-Agent" = "lan-command-runner-installer"
  }

  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $sourceDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (!$sourceDir) {
    throw "Could not find extracted source directory."
  }

  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallRoot) | Out-Null
  Move-Item -LiteralPath $sourceDir.FullName -Destination $InstallRoot

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
  Write-Host ""
  Write-Host "[lcr] Broker quick start:"
  Write-Host "  `$env:LCR_TOKEN = '<token-from-lcr-token>'"
  Write-Host "  lcr-cli broker --host 0.0.0.0 --port 8765"
  Write-Host ""
  Write-Host "[lcr] Agent quick setup:"
  Write-Host "  lcr-cli setup --url http://BROKER_IP:8765 --token '<same-token>' --agent-name $env:COMPUTERNAME"
  Write-Host "  lcr-cli agent"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
