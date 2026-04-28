param(
  [int]$Port = 8765,
  [string]$HostAddress = "0.0.0.0",
  [string]$Token = $env:LCR_TOKEN,
  [switch]$DebugConsole
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tokenPath = Join-Path $root ".lcr-token"
$iconPath = Join-Path $root "assets\lcr-8bit.ico"
$sourceIconPath = Join-Path $root "assets\lcr-8bit.png"
$logRoot = Join-Path $env:LOCALAPPDATA "lan-command-runner\logs"
$brokerLog = Join-Path $logRoot "broker.log"
$trayLog = Join-Path $logRoot "tray.log"
$script:brokerProcess = $null
$script:brokerUrl = "http://127.0.0.1:$Port"
$script:appContext = $null
$script:resolvedToken = $null
$script:mainForm = $null
$script:agentComboBox = $null
$script:commandLogTextBox = $null
$script:agentsListView = $null
$script:connectedAgentsMenuItem = $null
$script:isExiting = $false
$script:settingsPath = Join-Path $env:LOCALAPPDATA "lan-command-runner\tray-settings.json"
$script:settings = $null
$script:commandPollTimer = $null
$script:currentCommandJobId = $null
$script:currentCommandAfter = 0
$script:isPollingCommand = $false
$script:commandStatusLabel = $null
$script:executeButton = $null
$script:refreshAgentsButton = $null
$script:tokenInput = $null
$script:notifyIcon = $null

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Write-TrayLog($message) {
  $timestamp = Get-Date -Format "MM/dd/yyyy hh:mm:ss tt"
  Add-Content -LiteralPath $trayLog -Value "[$timestamp] $message"
}

trap {
  Write-TrayLog ("ERROR: " + $_.Exception.Message)
  if ($DebugConsole) {
    Write-Error $_
  }
  exit 1
}

function New-TrayIcon {
  if (Test-Path -LiteralPath $iconPath) {
    return New-Object System.Drawing.Icon $iconPath
  }

  if (Test-Path -LiteralPath $sourceIconPath) {
    $source = [System.Drawing.Bitmap]::FromFile($sourceIconPath)
    $bitmap = New-Object System.Drawing.Bitmap 16, 16
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, 0, 0, 16, 16)

    $iconHandle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)

    $graphics.Dispose()
    $bitmap.Dispose()
    $source.Dispose()

    return $icon
  }

  $bitmap = New-Object System.Drawing.Bitmap 16, 16
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(32, 98, 210))
  $foreground = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font "Segoe UI", 8, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center

  $graphics.FillEllipse($background, 0, 0, 15, 15)
  $graphics.DrawString("L", $font, $foreground, (New-Object System.Drawing.RectangleF 0, 0, 16, 16), $format)

  $iconHandle = $bitmap.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)

  $graphics.Dispose()
  $background.Dispose()
  $foreground.Dispose()
  $font.Dispose()
  $format.Dispose()
  $bitmap.Dispose()

  return $icon
}

function Get-LcrToken {
  if (-not [string]::IsNullOrWhiteSpace($script:resolvedToken)) {
    return $script:resolvedToken
  }

  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    Write-TrayLog "Using token from parameter/environment."
    $script:resolvedToken = $Token
    return $script:resolvedToken
  }

  if (Test-Path -LiteralPath $tokenPath) {
    Write-TrayLog "Using token from .lcr-token."
    $script:resolvedToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    return $script:resolvedToken
  }

  $newToken = (& node (Join-Path $root "bin\lcr.js") token).Trim()
  Set-Content -LiteralPath $tokenPath -Value $newToken -NoNewline
  Write-TrayLog "Generated new token and wrote .lcr-token."
  $script:resolvedToken = $newToken
  return $script:resolvedToken
}

function Set-LcrToken($newToken) {
  $rawToken = if ($null -eq $newToken) { "" } else { [string]$newToken }
  $normalizedToken = $rawToken.Trim()
  if ([string]::IsNullOrWhiteSpace($normalizedToken)) {
    throw "Token cannot be empty."
  }

  Set-Content -LiteralPath $tokenPath -Value $normalizedToken -NoNewline
  [Environment]::SetEnvironmentVariable("LCR_TOKEN", $normalizedToken, "User")
  $env:LCR_TOKEN = $normalizedToken
  $script:resolvedToken = $normalizedToken
  Write-TrayLog "Saved LCR token to .lcr-token and user environment."
}

function Get-TokenInputText {
  if ($script:tokenInput -and $null -ne $script:tokenInput.Text) {
    return [string]$script:tokenInput.Text
  }
  return ""
}

function Get-AgentSetupUrl {
  $lanAddress = @(Get-LanAddresses | Where-Object { $_ -and $_ -notlike "169.254.*" } | Select-Object -First 1)
  if ($lanAddress.Count -gt 0) {
    return "http://$($lanAddress[0]):$Port"
  }
  return $script:brokerUrl
}

function ConvertTo-PowerShellSingleQuoted($value) {
  return "'" + ([string]$value).Replace("'", "''") + "'"
}

function Get-AgentSetupCommand($agentName, $agentId) {
  $resolvedToken = Get-LcrToken
  $setupUrl = Get-AgentSetupUrl
  $safeAgentName = if ([string]::IsNullOrWhiteSpace($agentName)) { "StreamPC" } else { $agentName.Trim() }
  $safeAgentId = if ([string]::IsNullOrWhiteSpace($agentId)) { $safeAgentName } else { $agentId.Trim() }
  $quotedUrl = ConvertTo-PowerShellSingleQuoted $setupUrl
  $quotedToken = ConvertTo-PowerShellSingleQuoted $resolvedToken
  $quotedAgentName = ConvertTo-PowerShellSingleQuoted $safeAgentName
  $quotedAgentId = ConvertTo-PowerShellSingleQuoted $safeAgentId
  return "iwr -UseB https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1 | iex; lcr-cli setup --url $quotedUrl --token $quotedToken --agent-name $quotedAgentName --agent-id $quotedAgentId; lcr-cli agent"
}

function Get-LanAddresses {
  try {
    Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
      Select-Object -ExpandProperty IPAddress
  } catch {
    @()
  }
}

function Show-Balloon($title, $message) {
  if (-not $script:notifyIcon) {
    Write-TrayLog "Balloon skipped because notify icon is not available: $title - $message"
    return
  }

  try {
    $script:notifyIcon.BalloonTipTitle = $title
    $script:notifyIcon.BalloonTipText = $message
    $script:notifyIcon.ShowBalloonTip(2500)
  } catch {
    Write-TrayLog "Balloon failed: $($_.Exception.Message)"
  }
  Write-TrayLog "Balloon: $title - $message"
}

function Get-DefaultSettings {
  @{
    CloseToTray = $true
    ShowTrayAgentIp = $false
  }
}

function Load-Settings {
  $defaults = Get-DefaultSettings
  if (Test-Path -LiteralPath $script:settingsPath) {
    try {
      $loaded = Get-Content -LiteralPath $script:settingsPath -Raw | ConvertFrom-Json -AsHashtable
      foreach ($key in $defaults.Keys) {
        if (-not $loaded.ContainsKey($key)) {
          $loaded[$key] = $defaults[$key]
        }
      }
      return $loaded
    } catch {
      Write-TrayLog ("Failed to load settings, using defaults: " + $_.Exception.Message)
    }
  }
  return $defaults
}

function Save-Settings {
  if (-not $script:settings) {
    return
  }
  $settingsDir = Split-Path -Parent $script:settingsPath
  if ($settingsDir) {
    New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  }
  ($script:settings | ConvertTo-Json) | Set-Content -LiteralPath $script:settingsPath -Encoding UTF8
  Write-TrayLog "Saved tray settings."
}

function Invoke-BrokerJson($path) {
  $resolvedToken = Get-LcrToken
  return Invoke-RestMethod -Uri ($script:brokerUrl + $path) -Headers @{
    Authorization = "Bearer $resolvedToken"
  }
}

function Get-ConnectedAgents {
  try {
    $agents = Invoke-BrokerJson "/agents"
    return @($agents.agents)
  } catch {
    Write-TrayLog ("Connected agents request failed: " + $_.Exception.Message)
    return @()
  }
}

function Get-BrokerStatusText {
  try {
    $health = Invoke-RestMethod -Uri ($script:brokerUrl + "/health")
    $agentLines = @(Get-ConnectedAgents | ForEach-Object {
      "- $($_.name) [$($_.id)] pending=$($_.pendingJobs)"
    })
    if ($agentLines.Count -eq 0) {
      $agentLines = @("- No connected agents")
    }

    $lanLines = @($health.lanAddresses | ForEach-Object { "- http://$_`:$Port" })
    if ($lanLines.Count -eq 0) {
      $lanLines = @("- No LAN IPv4 addresses detected")
    }

    return @(
      "Broker URL: $script:brokerUrl"
      "Host: $($health.host)"
      "Connected agents: $($health.agents)"
      ""
      "LAN URLs:"
      $lanLines
      ""
      "Agents:"
      $agentLines
    ) -join [Environment]::NewLine
  } catch {
    Write-TrayLog ("Broker status request failed: " + $_.Exception.Message)
    return @(
      "Broker URL: $script:brokerUrl"
      "Status: unavailable"
      ""
      $_.Exception.Message
      ""
      "Start the broker from the tray menu, then try again."
    ) -join [Environment]::NewLine
  }
}

function Append-CommandLog($message) {
  if (-not $script:commandLogTextBox) {
    return
  }
  $timestamp = Get-Date -Format "MM/dd/yyyy hh:mm:ss tt"
  $script:commandLogTextBox.AppendText("[$timestamp] $message" + [Environment]::NewLine)
}

function Set-CommandUiBusy($isBusy, $statusText) {
  if ($script:executeButton) {
    $script:executeButton.Enabled = -not $isBusy
  }
  if ($script:refreshAgentsButton) {
    $script:refreshAgentsButton.Enabled = -not $isBusy
  }
  if ($script:mainForm) {
    $script:mainForm.UseWaitCursor = $isBusy
  }
  if ($script:commandStatusLabel) {
    $script:commandStatusLabel.Text = $statusText
  }
}

function Refresh-AgentSelector {
  if (-not $script:agentComboBox) {
    return
  }

  $selectedId = $null
  if ($script:agentComboBox.SelectedItem) {
    $selectedId = [string]$script:agentComboBox.SelectedItem
  }

  $script:agentComboBox.Items.Clear()
  foreach ($agent in Get-ConnectedAgents) {
    [void]$script:agentComboBox.Items.Add([string]$agent.id)
  }

  if ($selectedId -and $script:agentComboBox.Items.Contains($selectedId)) {
    $script:agentComboBox.SelectedItem = $selectedId
  } elseif ($script:agentComboBox.Items.Count -gt 0) {
    $script:agentComboBox.SelectedIndex = 0
  }
}

function Refresh-AgentsListView {
  if (-not $script:agentsListView) {
    return
  }

  $script:agentsListView.Items.Clear()
  foreach ($agent in Get-ConnectedAgents) {
    $item = New-Object System.Windows.Forms.ListViewItem($agent.name)
    [void]$item.SubItems.Add([string]$agent.id)
    [void]$item.SubItems.Add([string]$agent.info.hostname)
    [void]$item.SubItems.Add([string]$agent.host)
    [void]$item.SubItems.Add([string]$agent.pendingJobs)
    $item.Tag = $agent
    [void]$script:agentsListView.Items.Add($item)
  }
  $script:agentsListView.AutoResizeColumns([System.Windows.Forms.ColumnHeaderAutoResizeStyle]::HeaderSize)
}

function Select-AgentInUi($agentId) {
  if (-not $script:agentComboBox) {
    return
  }
  if ($script:agentComboBox.Items.Contains($agentId)) {
    $script:agentComboBox.SelectedItem = $agentId
  }
}

function Format-TrayAgentLabel($agent) {
  $label = [string]$agent.name
  if ([string]::IsNullOrWhiteSpace($label)) {
    $label = [string]$agent.id
  }
  if ($script:settings.ShowTrayAgentIp -and -not [string]::IsNullOrWhiteSpace([string]$agent.host)) {
    return "$label ($($agent.host))"
  }
  return $label
}

function Refresh-ConnectedAgentsMenu {
  if (-not $script:connectedAgentsMenuItem) {
    return
  }

  $script:connectedAgentsMenuItem.DropDownItems.Clear()
  $agents = Get-ConnectedAgents
  if ($agents.Count -eq 0) {
    $emptyItem = $script:connectedAgentsMenuItem.DropDownItems.Add("No connected agents")
    $emptyItem.Enabled = $false
    return
  }

  foreach ($agent in $agents) {
    $menuItem = $script:connectedAgentsMenuItem.DropDownItems.Add((Format-TrayAgentLabel $agent))
    $menuItem.Tag = [string]$agent.id
    $menuItem.add_Click({
      param($sender, $eventArgs)
      $agentId = [string]$sender.Tag
      Show-ControlPanel
      Select-AgentInUi $agentId
      [System.Windows.Forms.Clipboard]::SetText($agentId)
      Show-Balloon "Agent selected" "Selected $agentId and copied id."
    })
  }
}

function Show-ControlPanel {
  if ($script:mainForm) {
    $script:mainForm.Show()
    $script:mainForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $script:mainForm.Activate()
    Refresh-AgentSelector
    Refresh-AgentsListView
    Refresh-ConnectedAgentsMenu
  }
}

function Invoke-AgentCommand($agentId, $mode, $source) {
  $resolvedToken = Get-LcrToken
  $payload = if ($mode -eq "Shell") {
    @{
      command = $source
      shell = $true
      waitMs = 600000
      stream = $true
    }
  } else {
    @{
      command = @("powershell", "-NoProfile", "-Command", $source)
      waitMs = 600000
      stream = $true
    }
  }

  return Invoke-RestMethod -Method Post -Uri ($script:brokerUrl + "/agents/" + [uri]::EscapeDataString($agentId) + "/run") -Headers @{
    Authorization = "Bearer $resolvedToken"
  } -ContentType "application/json" -Body (($payload | ConvertTo-Json -Depth 6) -as [string])
}

function Complete-CommandPolling($result) {
  if ($script:commandPollTimer) {
    $script:commandPollTimer.Stop()
  }
  $script:currentCommandJobId = $null
  $script:currentCommandAfter = 0
  $script:isPollingCommand = $false

  if ($null -ne $result) {
    Append-CommandLog("Exit code: $($result.code)")
    if ($result.timedOut) {
      Append-CommandLog("Timed out waiting for remote process.")
    }
    Append-CommandLog("")
  }
  Set-CommandUiBusy $false "Idle"
}

function Poll-CommandEvents {
  if (-not $script:currentCommandJobId -or $script:isPollingCommand) {
    return
  }

  $script:isPollingCommand = $true
  try {
    $resolvedToken = Get-LcrToken
    $payload = Invoke-RestMethod -Uri ($script:brokerUrl + "/jobs/" + [uri]::EscapeDataString($script:currentCommandJobId) + "/events?after=$($script:currentCommandAfter)&waitMs=0") -Headers @{
      Authorization = "Bearer $resolvedToken"
    }

    foreach ($event in @($payload.events)) {
      $script:currentCommandAfter = [Math]::Max($script:currentCommandAfter, [int]$event.seq)
      if ($event.type -eq "output") {
        if ($event.stream -eq "stderr") {
          Append-CommandLog("STDERR> $($event.data)")
        } else {
          Append-CommandLog($event.data)
        }
      } elseif ($event.type -eq "result") {
        Complete-CommandPolling $event.result
        return
      }
    }
  } catch {
    Append-CommandLog("ERROR: $($_.Exception.Message)")
    Append-CommandLog("")
    Complete-CommandPolling $null
    return
  } finally {
    $script:isPollingCommand = $false
  }
}

function New-ControlPanel {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "LAN Command Runner"
  $form.Size = New-Object System.Drawing.Size(980, 720)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen

  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.Dock = [System.Windows.Forms.DockStyle]::Fill

  $commandTab = New-Object System.Windows.Forms.TabPage("Command")
  $agentsTab = New-Object System.Windows.Forms.TabPage("Agents")
  $settingsTab = New-Object System.Windows.Forms.TabPage("Settings")

  $commandTopPanel = New-Object System.Windows.Forms.Panel
  $commandTopPanel.Dock = [System.Windows.Forms.DockStyle]::Top
  $commandTopPanel.Height = 260
  $commandTopPanel.Padding = New-Object System.Windows.Forms.Padding(12)

  $agentLabel = New-Object System.Windows.Forms.Label
  $agentLabel.Text = "Agent"
  $agentLabel.Location = New-Object System.Drawing.Point(12, 16)
  $agentLabel.AutoSize = $true

  $agentCombo = New-Object System.Windows.Forms.ComboBox
  $agentCombo.Location = New-Object System.Drawing.Point(80, 12)
  $agentCombo.Size = New-Object System.Drawing.Size(260, 24)
  $agentCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  $script:agentComboBox = $agentCombo

  $modeLabel = New-Object System.Windows.Forms.Label
  $modeLabel.Text = "Mode"
  $modeLabel.Location = New-Object System.Drawing.Point(360, 16)
  $modeLabel.AutoSize = $true

  $modeCombo = New-Object System.Windows.Forms.ComboBox
  $modeCombo.Location = New-Object System.Drawing.Point(420, 12)
  $modeCombo.Size = New-Object System.Drawing.Size(140, 24)
  $modeCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$modeCombo.Items.Add("PowerShell")
  [void]$modeCombo.Items.Add("Shell")
  $modeCombo.SelectedIndex = 0

  $refreshAgentsButton = New-Object System.Windows.Forms.Button
  $refreshAgentsButton.Text = "Refresh Agents"
  $refreshAgentsButton.Location = New-Object System.Drawing.Point(580, 10)
  $refreshAgentsButton.Size = New-Object System.Drawing.Size(120, 28)
  $refreshAgentsButton.add_Click({
    Refresh-AgentSelector
    Refresh-AgentsListView
    Refresh-ConnectedAgentsMenu
  })
  $script:refreshAgentsButton = $refreshAgentsButton

  $commandLabel = New-Object System.Windows.Forms.Label
  $commandLabel.Text = "Command / script"
  $commandLabel.Location = New-Object System.Drawing.Point(12, 52)
  $commandLabel.AutoSize = $true

  $commandInput = New-Object System.Windows.Forms.TextBox
  $commandInput.Location = New-Object System.Drawing.Point(12, 76)
  $commandInput.Size = New-Object System.Drawing.Size(920, 130)
  $commandInput.Multiline = $true
  $commandInput.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
  $commandInput.WordWrap = $false
  $commandInput.Font = New-Object System.Drawing.Font("Consolas", 10)

  $executeButton = New-Object System.Windows.Forms.Button
  $executeButton.Text = "Execute"
  $executeButton.Location = New-Object System.Drawing.Point(12, 220)
  $executeButton.Size = New-Object System.Drawing.Size(110, 30)
  $executeButton.add_Click({
    $agentId = [string]$agentCombo.SelectedItem
    $source = $commandInput.Text
    if ([string]::IsNullOrWhiteSpace($agentId)) {
      [System.Windows.Forms.MessageBox]::Show("Select an agent first.", "LCR", "OK", "Warning") | Out-Null
      return
    }
    if ([string]::IsNullOrWhiteSpace($source)) {
      [System.Windows.Forms.MessageBox]::Show("Enter a command or script first.", "LCR", "OK", "Warning") | Out-Null
      return
    }

    Append-CommandLog("Executing on $agentId using $($modeCombo.SelectedItem)")
    Append-CommandLog($source)
    Set-CommandUiBusy $true "Starting..."
    try {
      $result = Invoke-AgentCommand $agentId ([string]$modeCombo.SelectedItem) $source
      if ($result.stream -and $result.jobId) {
        $script:currentCommandJobId = [string]$result.jobId
        $script:currentCommandAfter = 0
        Set-CommandUiBusy $true "Streaming..."
        $script:commandPollTimer.Start()
      } else {
        if (-not [string]::IsNullOrEmpty([string]$result.stdout)) {
          Append-CommandLog([string]$result.stdout)
        }
        if (-not [string]::IsNullOrEmpty([string]$result.stderr)) {
          Append-CommandLog("STDERR: $([string]$result.stderr)")
        }
        Append-CommandLog("Exit code: $($result.code)")
        Append-CommandLog("")
        Set-CommandUiBusy $false "Idle"
      }
    } catch {
      Append-CommandLog("ERROR: $($_.Exception.Message)")
      Append-CommandLog("")
      Set-CommandUiBusy $false "Idle"
    }
  })
  $script:executeButton = $executeButton

  $clearLogButton = New-Object System.Windows.Forms.Button
  $clearLogButton.Text = "Clear Log"
  $clearLogButton.Location = New-Object System.Drawing.Point(136, 220)
  $clearLogButton.Size = New-Object System.Drawing.Size(110, 30)
  $clearLogButton.add_Click({
    if ($script:commandLogTextBox) {
      $script:commandLogTextBox.Clear()
    }
  })

  $commandTopPanel.Controls.AddRange(@(
    $agentLabel, $agentCombo, $modeLabel, $modeCombo, $refreshAgentsButton,
    $commandLabel, $commandInput, $executeButton, $clearLogButton
  ))

  $commandLog = New-Object System.Windows.Forms.TextBox
  $commandLog.Multiline = $true
  $commandLog.ReadOnly = $true
  $commandLog.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
  $commandLog.WordWrap = $false
  $commandLog.Dock = [System.Windows.Forms.DockStyle]::Fill
  $commandLog.Font = New-Object System.Drawing.Font("Consolas", 10)
  $script:commandLogTextBox = $commandLog

  $commandStatusLabel = New-Object System.Windows.Forms.Label
  $commandStatusLabel.Text = "Idle"
  $commandStatusLabel.Location = New-Object System.Drawing.Point(270, 226)
  $commandStatusLabel.AutoSize = $true
  $script:commandStatusLabel = $commandStatusLabel

  $commandTab.Controls.Add($commandLog)
  $commandTab.Controls.Add($commandTopPanel)
  $commandTopPanel.Controls.Add($commandStatusLabel)

  $agentsTopPanel = New-Object System.Windows.Forms.Panel
  $agentsTopPanel.Dock = [System.Windows.Forms.DockStyle]::Top
  $agentsTopPanel.Height = 48
  $agentsTopPanel.Padding = New-Object System.Windows.Forms.Padding(12)

  $refreshListButton = New-Object System.Windows.Forms.Button
  $refreshListButton.Text = "Refresh"
  $refreshListButton.Size = New-Object System.Drawing.Size(110, 28)
  $refreshListButton.Location = New-Object System.Drawing.Point(12, 10)
  $refreshListButton.add_Click({
    Refresh-AgentSelector
    Refresh-AgentsListView
    Refresh-ConnectedAgentsMenu
  })

  $copyIdButton = New-Object System.Windows.Forms.Button
  $copyIdButton.Text = "Copy Id"
  $copyIdButton.Size = New-Object System.Drawing.Size(110, 28)
  $copyIdButton.Location = New-Object System.Drawing.Point(132, 10)
  $copyIdButton.add_Click({
    if ($script:agentsListView.SelectedItems.Count -eq 0) {
      return
    }
    $agentId = [string]$script:agentsListView.SelectedItems[0].SubItems[1].Text
    [System.Windows.Forms.Clipboard]::SetText($agentId)
    Show-Balloon "Copied" "Copied agent id $agentId."
  })

  $agentsTopPanel.Controls.AddRange(@($refreshListButton, $copyIdButton))

  $agentsList = New-Object System.Windows.Forms.ListView
  $agentsList.Dock = [System.Windows.Forms.DockStyle]::Fill
  $agentsList.View = [System.Windows.Forms.View]::Details
  $agentsList.FullRowSelect = $true
  $agentsList.GridLines = $true
  [void]$agentsList.Columns.Add("Name", 180)
  [void]$agentsList.Columns.Add("Id", 180)
  [void]$agentsList.Columns.Add("Hostname", 180)
  [void]$agentsList.Columns.Add("IP", 140)
  [void]$agentsList.Columns.Add("Pending", 80)
  $agentsList.add_DoubleClick({
    if ($agentsList.SelectedItems.Count -eq 0) {
      return
    }
    $agentId = [string]$agentsList.SelectedItems[0].SubItems[1].Text
    $tabs.SelectedTab = $commandTab
    Select-AgentInUi $agentId
  })
  $script:agentsListView = $agentsList

  $agentsTab.Controls.Add($agentsList)
  $agentsTab.Controls.Add($agentsTopPanel)

  $settingsPanel = New-Object System.Windows.Forms.Panel
  $settingsPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $settingsPanel.AutoScroll = $true
  $settingsPanel.Padding = New-Object System.Windows.Forms.Padding(16)

  $closeToTrayCheck = New-Object System.Windows.Forms.CheckBox
  $closeToTrayCheck.Text = "Close window to system tray"
  $closeToTrayCheck.AutoSize = $true
  $closeToTrayCheck.Location = New-Object System.Drawing.Point(16, 20)
  $closeToTrayCheck.Checked = [bool]$script:settings.CloseToTray
  $closeToTrayCheck.add_CheckedChanged({
    $script:settings.CloseToTray = [bool]$closeToTrayCheck.Checked
    Save-Settings
  })

  $showIpCheck = New-Object System.Windows.Forms.CheckBox
  $showIpCheck.Text = "Show agent IPs in tray connected-agents menu"
  $showIpCheck.AutoSize = $true
  $showIpCheck.Location = New-Object System.Drawing.Point(16, 54)
  $showIpCheck.Checked = [bool]$script:settings.ShowTrayAgentIp
  $showIpCheck.add_CheckedChanged({
    $script:settings.ShowTrayAgentIp = [bool]$showIpCheck.Checked
    Save-Settings
    Refresh-ConnectedAgentsMenu
  })

  $settingsHelp = New-Object System.Windows.Forms.Label
  $settingsHelp.Text = "Close-to-tray keeps the app running in the notification area. Use the tray icon to reopen the control panel or exit fully."
  $settingsHelp.AutoSize = $false
  $settingsHelp.Size = New-Object System.Drawing.Size(880, 60)
  $settingsHelp.Location = New-Object System.Drawing.Point(16, 92)

  $tokenLabel = New-Object System.Windows.Forms.Label
  $tokenLabel.Text = "Broker token"
  $tokenLabel.AutoSize = $true
  $tokenLabel.Location = New-Object System.Drawing.Point(16, 160)

  $tokenInput = New-Object System.Windows.Forms.TextBox
  $tokenInput.Location = New-Object System.Drawing.Point(16, 184)
  $tokenInput.Size = New-Object System.Drawing.Size(640, 24)
  $tokenInput.Text = Get-LcrToken
  $script:tokenInput = $tokenInput

  $saveTokenButton = New-Object System.Windows.Forms.Button
  $saveTokenButton.Text = "Save Token"
  $saveTokenButton.Location = New-Object System.Drawing.Point(672, 181)
  $saveTokenButton.Size = New-Object System.Drawing.Size(110, 30)

  $copyTokenButton = New-Object System.Windows.Forms.Button
  $copyTokenButton.Text = "Copy Token"
  $copyTokenButton.Location = New-Object System.Drawing.Point(792, 181)
  $copyTokenButton.Size = New-Object System.Drawing.Size(110, 30)

  $setupLabel = New-Object System.Windows.Forms.Label
  $setupLabel.Text = "Agent install/setup command"
  $setupLabel.AutoSize = $true
  $setupLabel.Location = New-Object System.Drawing.Point(16, 232)

  $agentNameLabel = New-Object System.Windows.Forms.Label
  $agentNameLabel.Text = "Agent name"
  $agentNameLabel.AutoSize = $true
  $agentNameLabel.Location = New-Object System.Drawing.Point(16, 262)

  $agentNameInput = New-Object System.Windows.Forms.TextBox
  $agentNameInput.Location = New-Object System.Drawing.Point(100, 258)
  $agentNameInput.Size = New-Object System.Drawing.Size(180, 24)
  $agentNameInput.Text = "StreamPC"

  $agentIdLabel = New-Object System.Windows.Forms.Label
  $agentIdLabel.Text = "Agent id"
  $agentIdLabel.AutoSize = $true
  $agentIdLabel.Location = New-Object System.Drawing.Point(308, 262)

  $agentIdInput = New-Object System.Windows.Forms.TextBox
  $agentIdInput.Location = New-Object System.Drawing.Point(372, 258)
  $agentIdInput.Size = New-Object System.Drawing.Size(180, 24)
  $agentIdInput.Text = "StreamPC"

  $setupCommandBox = New-Object System.Windows.Forms.TextBox
  $setupCommandBox.Location = New-Object System.Drawing.Point(16, 298)
  $setupCommandBox.Size = New-Object System.Drawing.Size(886, 88)
  $setupCommandBox.Multiline = $true
  $setupCommandBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $setupCommandBox.WordWrap = $true
  $setupCommandBox.ReadOnly = $true
  $setupCommandBox.Font = New-Object System.Drawing.Font("Consolas", 9)

  $refreshSetupButton = New-Object System.Windows.Forms.Button
  $refreshSetupButton.Text = "Refresh Command"
  $refreshSetupButton.Location = New-Object System.Drawing.Point(16, 398)
  $refreshSetupButton.Size = New-Object System.Drawing.Size(130, 30)

  $copySetupButton = New-Object System.Windows.Forms.Button
  $copySetupButton.Text = "Copy Command"
  $copySetupButton.Location = New-Object System.Drawing.Point(158, 398)
  $copySetupButton.Size = New-Object System.Drawing.Size(130, 30)

  $refreshSetupCommand = {
    $setupCommandBox.Text = Get-AgentSetupCommand $agentNameInput.Text $agentIdInput.Text
  }

  $saveTokenButton.add_Click({
    try {
      $tokenText = (Get-TokenInputText).Trim()
      if ([string]::IsNullOrWhiteSpace($tokenText)) {
        $tokenText = Get-LcrToken
        $script:tokenInput.Text = $tokenText
        Write-TrayLog "Token input was empty during save; restored current token before saving."
      }
      Set-LcrToken $tokenText
      & $refreshSetupCommand
      Show-Balloon "Token saved" "LCR_TOKEN was saved for this user."
    } catch {
      [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "LCR", "OK", "Error") | Out-Null
    }
  })

  $copyTokenButton.add_Click({
    $tokenText = (Get-TokenInputText).Trim()
    if ([string]::IsNullOrWhiteSpace($tokenText)) {
      $tokenText = Get-LcrToken
      $script:tokenInput.Text = $tokenText
    }
    [System.Windows.Forms.Clipboard]::SetText($tokenText)
    Show-Balloon "Copied" "Copied broker token."
  })

  $refreshSetupButton.add_Click({
    & $refreshSetupCommand
  })

  $copySetupButton.add_Click({
    & $refreshSetupCommand
    [System.Windows.Forms.Clipboard]::SetText($setupCommandBox.Text)
    Show-Balloon "Copied" "Copied agent setup command."
  })

  $agentNameInput.add_TextChanged({ & $refreshSetupCommand })
  $agentIdInput.add_TextChanged({ & $refreshSetupCommand })
  & $refreshSetupCommand

  $settingsPanel.Controls.AddRange(@(
    $closeToTrayCheck, $showIpCheck, $settingsHelp,
    $tokenLabel, $tokenInput, $saveTokenButton, $copyTokenButton,
    $setupLabel, $agentNameLabel, $agentNameInput, $agentIdLabel, $agentIdInput,
    $setupCommandBox, $refreshSetupButton, $copySetupButton
  ))
  $settingsTab.Controls.Add($settingsPanel)

  [void]$tabs.TabPages.Add($commandTab)
  [void]$tabs.TabPages.Add($agentsTab)
  [void]$tabs.TabPages.Add($settingsTab)
  $form.Controls.Add($tabs)

  $form.add_FormClosing({
    param($sender, [System.Windows.Forms.FormClosingEventArgs]$eventArgs)
    $closeToTray = $true
    if ($script:settings -and $script:settings.ContainsKey("CloseToTray")) {
      $closeToTray = [bool]$script:settings.CloseToTray
    }

    if (-not $script:isExiting -and $closeToTray) {
      if ($eventArgs) {
        $eventArgs.Cancel = $true
      }
      if ($sender -is [System.Windows.Forms.Form]) {
        $sender.Hide()
      } elseif ($script:mainForm) {
        $script:mainForm.Hide()
      }
      Show-Balloon "LCR still running" "The control panel was hidden to the tray."
    }
  })

  $script:commandPollTimer = New-Object System.Windows.Forms.Timer
  $script:commandPollTimer.Interval = 350
  $script:commandPollTimer.add_Tick({ Poll-CommandEvents })

  return $form
}

function Update-Menu {
  $isRunning = $script:brokerProcess -and -not $script:brokerProcess.HasExited
  $statusItem.Text = if ($isRunning) { "Status: broker running" } else { "Status: broker stopped" }
  $startBrokerItem.Enabled = -not $isRunning
  $stopBrokerItem.Enabled = $isRunning
}

function Start-Broker {
  if ($script:brokerProcess -and -not $script:brokerProcess.HasExited) {
    Write-TrayLog "Start-Broker ignored because broker is already running."
    Update-Menu
    return
  }

  $resolvedToken = Get-LcrToken
  $command = @"
`$env:LCR_TOKEN = '$resolvedToken'
Set-Location '$root'
node .\bin\lcr.js broker --host $HostAddress --port $Port *>> '$brokerLog'
"@

  $tempScript = Join-Path $env:TEMP ("lcr-tray-broker-" + [guid]::NewGuid().ToString("n") + ".ps1")
  Set-Content -LiteralPath $tempScript -Value $command

  $process = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $tempScript
  )

  $script:brokerProcess = $process
  Write-TrayLog "Started hidden broker process Id=$($process.Id) host=$HostAddress port=$Port."
  Update-Menu
  Show-Balloon "LCR broker started" "Broker listening on $script:brokerUrl"
}

function Stop-Broker {
  if ($script:brokerProcess -and -not $script:brokerProcess.HasExited) {
    Write-TrayLog "Stopping broker process Id=$($script:brokerProcess.Id)."
    $script:brokerProcess.Kill()
    $script:brokerProcess.WaitForExit(3000) | Out-Null
  }

  $script:brokerProcess = $null
  Update-Menu
  Show-Balloon "LCR broker stopped" "The hidden broker process was stopped."
}

function Copy-Text($value, $label) {
  $text = if ($null -eq $value) { "" } else { [string]$value }
  [System.Windows.Forms.Clipboard]::SetText($text)
  Write-TrayLog "Copied text to clipboard: $label"
  Show-Balloon "Copied" $label
}

function Exit-Tray {
  Write-TrayLog "Exit requested from tray."
  $script:isExiting = $true
  if ($script:mainForm) {
    $script:mainForm.Close()
  }
  Stop-Broker
  if ($script:notifyIcon) {
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
    $script:notifyIcon = $null
  }
  if ($script:appContext) {
    $script:appContext.ExitThread()
  }
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:settings = Load-Settings
$script:appContext = New-Object System.Windows.Forms.ApplicationContext
$script:mainForm = New-ControlPanel
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon = $notifyIcon
$notifyIcon.Icon = New-TrayIcon
$notifyIcon.Text = "LAN Command Runner"
$notifyIcon.Visible = $true
Write-TrayLog "Tray icon created and made visible."

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Status: broker stopped")
$statusItem.Enabled = $false

[void]$menu.Items.Add("-")

$startBrokerItem = $menu.Items.Add("Start broker")
$startBrokerItem.add_Click({ Start-Broker })

$stopBrokerItem = $menu.Items.Add("Stop broker")
$stopBrokerItem.add_Click({ Stop-Broker })

[void]$menu.Items.Add("-")

$copyLocalItem = $menu.Items.Add("Copy local broker URL")
$copyLocalItem.add_Click({ Copy-Text $script:brokerUrl "Copied $script:brokerUrl" })

$copyLanItem = $menu.Items.Add("Copy LAN broker URLs")
$copyLanItem.add_Click({
  $urls = @(Get-LanAddresses | ForEach-Object { "http://$_`:$Port" })
  if ($urls.Count -eq 0) {
    Show-Balloon "No LAN IP found" "Could not detect a non-loopback IPv4 address."
    return
  }
  Copy-Text ($urls -join [Environment]::NewLine) "Copied $($urls.Count) LAN URL(s)."
})

[void]$menu.Items.Add("-")

$openControlPanelItem = $menu.Items.Add("Open control panel")
$openControlPanelItem.add_Click({ Show-ControlPanel })

$script:connectedAgentsMenuItem = $menu.Items.Add("Connected agents")
$script:connectedAgentsMenuItem.add_DropDownOpening({ Refresh-ConnectedAgentsMenu })

[void]$menu.Items.Add("-")

$viewAgentsItem = $menu.Items.Add("View agents")
$viewAgentsItem.add_Click({
  Show-ControlPanel
  $script:mainForm.Controls[0].SelectedTab = $script:mainForm.Controls[0].TabPages[1]
})

$copyTokenItem = $menu.Items.Add("Copy token")
$copyTokenItem.add_Click({
  $resolvedToken = Get-LcrToken
  Copy-Text $resolvedToken "Copied broker token."
})

[void]$menu.Items.Add("-")

$openLogsItem = $menu.Items.Add("Open logs folder")
$openLogsItem.add_Click({ Start-Process explorer $logRoot })

$openFolderItem = $menu.Items.Add("Open install folder")
$openFolderItem.add_Click({ Start-Process explorer $root })

[void]$menu.Items.Add("-")

$exitItem = $menu.Items.Add("Exit")
$exitItem.add_Click({ Exit-Tray })

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.add_DoubleClick({ Show-ControlPanel })

Update-Menu
Refresh-AgentSelector
Refresh-AgentsListView
Refresh-ConnectedAgentsMenu
if ($DebugConsole) {
  Write-Host "[lcr-tray] Running. Right-click the LCR tray icon for broker controls."
  Write-Host "[lcr-tray] Logs: $logRoot"
}
Show-Balloon "LCR tray is running" "Right-click the LCR tray icon for broker controls."
[void]$script:mainForm.Show()
[System.Windows.Forms.Application]::Run($script:appContext)
