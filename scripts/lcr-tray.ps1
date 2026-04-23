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
  $notifyIcon.BalloonTipTitle = $title
  $notifyIcon.BalloonTipText = $message
  $notifyIcon.ShowBalloonTip(2500)
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
    }
  } else {
    @{
      command = @("powershell", "-NoProfile", "-Command", $source)
      waitMs = 600000
    }
  }

  return Invoke-RestMethod -Method Post -Uri ($script:brokerUrl + "/agents/" + [uri]::EscapeDataString($agentId) + "/run") -Headers @{
    Authorization = "Bearer $resolvedToken"
  } -ContentType "application/json" -Body (($payload | ConvertTo-Json -Depth 6) -as [string])
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
    $executeButton.Enabled = $false
    $refreshAgentsButton.Enabled = $false
    $form.UseWaitCursor = $true
    try {
      $result = Invoke-AgentCommand $agentId ([string]$modeCombo.SelectedItem) $source
      if (-not [string]::IsNullOrEmpty([string]$result.stdout)) {
        Append-CommandLog("STDOUT:")
        Append-CommandLog([string]$result.stdout)
      }
      if (-not [string]::IsNullOrEmpty([string]$result.stderr)) {
        Append-CommandLog("STDERR:")
        Append-CommandLog([string]$result.stderr)
      }
      Append-CommandLog("Exit code: $($result.code)")
      Append-CommandLog("")
    } catch {
      Append-CommandLog("ERROR: $($_.Exception.Message)")
      Append-CommandLog("")
    } finally {
      $form.UseWaitCursor = $false
      $executeButton.Enabled = $true
      $refreshAgentsButton.Enabled = $true
    }
  })

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

  $commandTab.Controls.Add($commandLog)
  $commandTab.Controls.Add($commandTopPanel)

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
  $settingsPanel.Dock = [System.Windows.Forms.DockStyle]::Top
  $settingsPanel.Height = 180
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

  $settingsPanel.Controls.AddRange(@($closeToTrayCheck, $showIpCheck, $settingsHelp))
  $settingsTab.Controls.Add($settingsPanel)

  [void]$tabs.TabPages.Add($commandTab)
  [void]$tabs.TabPages.Add($agentsTab)
  [void]$tabs.TabPages.Add($settingsTab)
  $form.Controls.Add($tabs)

  $form.add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:isExiting -and $script:settings.CloseToTray) {
      $eventArgs.Cancel = $true
      $form.Hide()
      Show-Balloon "LCR still running" "The control panel was hidden to the tray."
    }
  })

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
  [System.Windows.Forms.Clipboard]::SetText($value)
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
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $script:appContext.ExitThread()
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:settings = Load-Settings
$script:appContext = New-Object System.Windows.Forms.ApplicationContext
$script:mainForm = New-ControlPanel
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
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
