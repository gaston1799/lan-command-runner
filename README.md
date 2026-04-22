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

This adds `lcr` to PATH.

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
lcr broker --host 0.0.0.0 --port 8765
```

Start an agent on another machine:

```powershell
$env:LCR_TOKEN = '<same-token>'
lcr agent --url http://192.168.1.50:8765 --name gaming-pc
```

List connected agents:

```powershell
$env:LCR_URL = 'http://192.168.1.50:8765'
$env:LCR_TOKEN = '<same-token>'
lcr agents
```

Run commands by agent id:

```powershell
lcr exec agent-1234abcd -- hostname
lcr exec agent-1234abcd -- node --version
lcr sh agent-1234abcd 'whoami; hostname'
```

The broker prints LAN health URLs. You may need to allow the broker port through Windows Firewall.

## Direct Mode

Direct mode runs a command server on the target itself. It is simpler, but every target needs an inbound reachable port.

```powershell
$env:LCR_TOKEN = '<paste-token-here>'
lcr serve --host 0.0.0.0 --port 8765
```

## Run Commands From Another Machine

Set connection values:

```powershell
$env:LCR_URL = 'http://192.168.1.50:8765'
$env:LCR_TOKEN = '<same-token>'
```

Run an argv-safe command:

```powershell
lcr run -- hostname
lcr run -- node --version
lcr run -- powershell -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

Run a shell command:

```powershell
lcr shell 'dir C:\'
lcr shell 'whoami; hostname'
```

Use a working directory:

```powershell
lcr run --cwd C:\Users -- powershell -NoProfile -Command 'Get-ChildItem'
```

Increase timeout:

```powershell
lcr run --timeout-ms 120000 -- powershell -NoProfile -Command 'Start-Sleep 5; "done"'
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

## Git

This project is safe to push as long as you do not commit `.env`, `.lcr-token`, logs, or machine-specific secrets.
