param(
  [int]$Port = 8765,
  [string]$HostAddress = "0.0.0.0",
  [string]$Token = $env:LCR_TOKEN
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tokenPath = Join-Path $root ".lcr-token"

if ([string]::IsNullOrWhiteSpace($Token)) {
  if (Test-Path -LiteralPath $tokenPath) {
    $Token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  } else {
    $Token = (& node (Join-Path $root "bin\lcr.js") token).Trim()
    Set-Content -LiteralPath $tokenPath -Value $Token -NoNewline
  }
}

$brokerScript = @"
`$env:LCR_TOKEN = '$Token'
Set-Location '$root'
Write-Host '[lcr] Broker token:' `$env:LCR_TOKEN
Write-Host '[lcr] Starting broker on $HostAddress`:$Port'
node .\bin\lcr.js broker --host $HostAddress --port $Port
Read-Host 'Broker stopped. Press Enter to close'
"@

$brokerScriptPath = Join-Path $env:TEMP ("lcr-broker-" + [guid]::NewGuid().ToString("n") + ".ps1")
Set-Content -LiteralPath $brokerScriptPath -Value $brokerScript

Start-Process powershell -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-NoExit",
  "-File",
  $brokerScriptPath
)

$lanAddresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress

Write-Host "[lcr] Broker launched in a new PowerShell window."
Write-Host "[lcr] Token: $Token"
Write-Host "[lcr] Local URL: http://127.0.0.1:$Port"
foreach ($address in $lanAddresses) {
  Write-Host "[lcr] LAN URL:   http://$address`:$Port"
}
