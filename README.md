# lan-command-runner

Token-authenticated LAN command runner for machines you administer.

It gives you two modes:

- broker/agent mode: one LAN broker, many outbound agents, command by agent id
- direct mode: a small server (`lcr serve`) directly on one target machine
- client commands that return stdout/stderr/exit code
- stdout/stderr/exit-code forwarding
- mandatory bearer-token auth for command execution

## Safety Model

This tool executes commands on the machine running `lcr serve`. Treat its token like an admin password.

Defaults are intentionally conservative:

- `lcr serve` binds to `127.0.0.1` by default.
- You must explicitly use `--host 0.0.0.0` to expose it to your LAN.
- `/run` requires `Authorization: Bearer <token>`.
- Commands time out after 60 seconds by default.
- The maximum timeout is 10 minutes.
- Shell execution is explicit via `lcr shell`; `lcr run` uses argument-array spawning.

Do not expose this to the public internet. Use it only on a trusted LAN, VPN, or SSH tunnel.

## Install For Development

```powershell
cd C:\Users\Naquan\lan-command-runner
npm link
```

This adds `lcr` and `lcr-cli` to PATH.

- `lcr` opens the Windows tray UI by default.
- `lcr-cli` is the terminal-first command interface.

## Install From Latest Release

Run this in PowerShell:

```powershell
iwr -UseB https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1 | iex
```

The installer downloads the latest tagged release source to `%LOCALAPPDATA%\lan-command-runner`, runs `npm install --omit=dev`, and links `lcr` onto PATH with `npm link`.

Optional overrides:

```powershell
$env:LCR_INSTALL_ROOT = 'D:\tools\lan-command-runner'
$env:LCR_VERSION = 'v0.1.0'
iwr -UseB https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1 | iex
```

## Broker / Agent Mode

Broker mode is the best fit when you want machines to connect outbound and then target them by ID:

```text
lcr exec <agent-id> -- <command> [args...]
```

Start the broker on the LAN host:

Generate a token:

```powershell
lcr token
```

```powershell
$env:LCR_TOKEN = '<paste-token-here>'
lcr-cli broker --host 0.0.0.0 --port 8765
```

Quick setup on an agent machine so later you can just run `lcr agent` or `lcr-cli agent`:

```powershell
lcr-cli setup --url http://192.168.1.50:8765 --token '<same-token>' --agent-name gaming-pc
```

Start an agent on another machine:

```powershell
lcr-cli agent
```

The `lcr agent` form works too, because `lcr` forwards subcommands to `lcr-cli` and only opens the tray UI when you run it with no arguments.

List connected agents:

```powershell
$env:LCR_URL = 'http://192.168.1.50:8765'
$env:LCR_TOKEN = '<same-token>'
lcr-cli agents
```

Run commands by agent id:

```powershell
lcr-cli exec agent-1234abcd -- hostname
lcr-cli exec agent-1234abcd -- node --version
lcr-cli sh agent-1234abcd 'whoami; hostname'
lcr-cli pwsh agent-1234abcd 'Get-Process | Select-Object -First 5 Name,Id'
```

Broker command output streams by default, so stdout/stderr appears while the remote process is still running. Add `--no-stream` to use the older wait-for-exit response mode.

Transfer files:

```powershell
lcr-cli get agent-1234abcd C:\remote\file.txt .\file.txt
lcr-cli put agent-1234abcd .\local-file.txt C:\remote\file.txt
lcr-cli cat agent-1234abcd C:\remote\file.txt
'hello from stdin' | lcr-cli write agent-1234abcd C:\remote\hello.txt --stdin
```

Agent lifecycle commands:

```powershell
lcr-cli disconnect agent-1234abcd
lcr-cli update-agent agent-1234abcd
```

`update-agent` tells a Windows agent to disconnect, run the latest release installer, and reconnect to the same broker with the same agent id. Use it after publishing a new release when you want existing agents to upgrade themselves.

The broker prints LAN health URLs. You may need to allow the broker port through Windows Firewall.

### Windows Tray Mode

On Windows, `lcr` opens the tray UI by default:

```powershell
lcr tray
```

Or just:

```powershell
lcr
```

The tray icon uses the 8-bit LCR icon at `assets/lcr-8bit.ico`. The source PNG is kept at `assets/lcr-8bit.png`.

Regenerate the `.ico` from the PNG with:

```powershell
.\scripts\make-icon.ps1
```

The tray companion stays in the Windows notification area. Right-click it for:

- Start broker
- Stop broker
- Copy local broker URL
- Copy LAN broker URLs
- Open logs folder
- Open install folder
- Exit

Useful tray debugging commands:

```powershell
lcr tray --debug
lcr tray --attach
```

- `--debug` runs the tray in the current terminal and shows immediate PowerShell errors.
- `--attach` tails `%LOCALAPPDATA%\lan-command-runner\logs\tray.log` from another terminal without forcing the tray into the foreground.

Double-clicking the tray icon starts the broker. The broker runs hidden and writes logs to:

```text
%LOCALAPPDATA%\lan-command-runner\logs\broker.log
```

Tray lifecycle logs are written to:

```text
%LOCALAPPDATA%\lan-command-runner\logs\tray.log
```

If the tray fails before PowerShell fully starts, check the launcher bootstrap log:

```text
%LOCALAPPDATA%\lan-command-runner\logs\tray-bootstrap.log
```

Tray mode uses the same token behavior as `start-broker.ps1`: it reads `LCR_TOKEN`, then `.lcr-token`, and generates `.lcr-token` if needed.

## Direct Mode

Direct mode runs a command server on the target itself. It is simpler, but every target needs an inbound reachable port.

```powershell
$env:LCR_TOKEN = '<paste-token-here>'
lcr-cli serve --host 0.0.0.0 --port 8765
```

## Run Commands From Another Machine

Set connection values:

```powershell
$env:LCR_URL = 'http://192.168.1.50:8765'
$env:LCR_TOKEN = '<same-token>'
```

Run an argv-safe command:

```powershell
lcr-cli run -- hostname
lcr-cli run -- node --version
lcr-cli powershell '$PSVersionTable.PSVersion.ToString()'
```

Run a shell command:

```powershell
lcr-cli shell 'dir C:\'
lcr-cli shell 'whoami; hostname'
```

Use a working directory:

```powershell
lcr-cli run --cwd C:\Users -- powershell -NoProfile -Command 'Get-ChildItem'
```

Increase timeout:

```powershell
lcr-cli run --timeout-ms 120000 -- powershell -NoProfile -Command 'Start-Sleep 5; "done"'
```

## HTTP API

Health does not require a token:

```http
GET /health
```

Run requires bearer auth:

```http
POST /run
Authorization: Bearer <token>
Content-Type: application/json

{
  "command": ["hostname"],
  "timeoutMs": 60000
}
```

Shell mode:

```json
{
  "command": "dir C:\\",
  "shell": true
}
```

Response:

```json
{
  "ok": true,
  "code": 0,
  "signal": null,
  "timedOut": false,
  "stdout": "example\\n",
  "stderr": ""
}
```

Broker file transfer uses agent jobs over:

```http
POST /agents/:id/file/read
POST /agents/:id/file/write
POST /agents/:id/disconnect
POST /agents/:id/update
```

File payloads are base64 encoded JSON for portability.

## Git

This project is safe to push as long as you do not commit `.env`, `.lcr-token`, logs, or machine-specific secrets.
