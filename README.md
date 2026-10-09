# lan-command-runner

Token-authenticated LAN command runner for machines you administer.

## License And Branding

Code is licensed under the MIT license. The LAN Command Runner and LCR names are
reserved trademarks; see `LICENSE` and `TRADEMARKS.md`.

It gives you three modes:

- **mesh mode** (recommended): every PC runs one broker and one supervisor, and
  peers you name explicitly can control each other in any direction
- **broker/agent mode**: one LAN broker, many outbound agents, command by agent id
- **direct mode**: a small server (`lcr serve`) directly on one target machine

All three share:

- client commands that return stdout/stderr/exit code
- stdout/stderr/exit-code forwarding
- bearer-token auth by default, with explicit private-network-only LAN trust

## Safety Model

This tool executes commands on the machine running `lcr serve`. Treat its token like an admin password.

Defaults are intentionally conservative:

- `lcr serve` binds to `127.0.0.1` by default.
- You must explicitly use `--host 0.0.0.0` to expose it to your LAN.
- `/run` requires `Authorization: Bearer <token>`.
- Commands time out after 60 seconds by default.
- The maximum timeout is 10 minutes.
- Shell execution is explicit via `lcr shell`; `lcr run` uses argument-array spawning.
- `peer add` refuses a plain-HTTP peer that is not provably private.
- LAN discovery carries no token and confers no trust.
- Tokens are redacted from every command's output unless you ask for them.
- `startup install` registers an unprivileged, current-user logon task only.

Do not expose this to the public internet. Use it only on a trusted LAN, VPN, or SSH tunnel.

## Hardening In 0.15.0

- **Signed requests and responses** (HMAC-SHA256 + replay protection) make
  command/file injection fail closed on an untrusted network. It provides
  integrity and replay protection, not confidentiality — pair it with a VPN
  for encryption.
- **Bounded output and a real timeout**: runaway output is capped and flagged
  `truncated` instead of crashing the agent, and a timed-out command kills its
  whole process tree.
- **Audit log**: the broker and each agent append redacted JSON lines to
  `%LOCALAPPDATA%\lan-command-runner\logs\audit.log`; read them with
  `lcr-cli log`.
- **Job control**: `lcr-cli jobs` lists jobs, `lcr-cli cancel <agent> <job-id>`
  cancels a queued one, and `lcr-cli agents` now reports `online`/
  `lastSeenAgeMs`.
- **File integrity**: downloads verify a SHA-256 of the source file, and
  streamed downloads are flow-controlled so large files no longer overflow a
  fixed buffer.

## Install For Development

```powershell
cd C:\Users\gaston\lan-command-runner
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

The installer clones the latest tagged release to
`%LOCALAPPDATA%\lan-command-runner`, retains its Git commit metadata, runs
`npm install --omit=dev`, and links `lcr` onto PATH with `npm link`. Git,
Node.js, and npm must be installed.

Optional overrides:

```powershell
$env:LCR_INSTALL_ROOT = 'D:\tools\lan-command-runner'
$env:LCR_VERSION = 'v0.1.0'
iwr -UseB https://github.com/gaston1799/lan-command-runner/releases/latest/download/install.ps1 | iex
```

### Upgrade Preservation

The default install root and the default runtime-data root are the same
directory, so an upgrade has to replace the code without destroying the node's
identity. Before replacing an existing install root, the installer copies these
exact artifacts to a unique temporary directory outside the install root, then
puts them back afterwards:

| Artifact             | What it holds                              |
| -------------------- | ------------------------------------------ |
| `config.json`        | node id, broker settings, peers, all tokens |
| `tray-settings.json` | tray control-panel preferences              |
| `.lcr-token`         | the token `start-broker.ps1` falls back to  |
| `logs\`              | broker, mesh, and tray logs                 |

Nothing else is preserved. JavaScript, `package.json`, and every other tracked
file always come from the new release, so an upgrade can never resurrect stale
code. `config.json` permissions are re-applied best-effort after the restore,
and no preserved file's contents are ever printed. The temporary backup is
removed after a successful install or successful automatic rollback. If both
installation and rollback fail, it is retained and its recovery path is shown.

Because `config.json` survives, your node id, broker token, and peer list carry
across upgrades — and so does the logon task, which points at absolute paths
inside the install root. A custom `LCR_INSTALL_ROOT` gets the same treatment.

The installer prints the mesh quick-start commands when it finishes. It does not
configure the mesh or register startup for you.

### Update Checks

`lcr-cli doctor` checks the installed package version against the latest GitHub
release. If the installed release is current, it then compares the clone's
current commit with `main`.

- An older release is shown as an `[UPDATE]` warning with the exact update
  command. Release updates contain the supported upgrade path.
- Being behind `main` is a smaller development warning. It does not recommend
  replacing a stable release with unreleased code.
- A failed GitHub lookup is a warning and does not prevent the remaining doctor
  checks from running.

Run the managed updater explicitly:

```powershell
lcr-cli update
```

It asks before changing files. For deliberate non-interactive use, run
`lcr-cli update --yes`. The updater invokes the same latest-release installer,
so the existing config, tokens, tray settings, and logs use the preservation
and rollback path described above. It refuses to overwrite a development source
checkout; update such a checkout with Git instead.

For offline or deliberately isolated diagnostics, set
`LCR_DISABLE_UPDATE_CHECK=1`. A custom installer location remains updateable:
the installer writes a non-secret managed-install marker so `lcr-cli update`
can distinguish it from a development checkout.

## Mesh Mode

Mesh mode is the recommended way to run more than two machines. Every PC runs
its own broker *and* connects outbound to each peer's broker, so control is
symmetric: any node can drive any other node it has been explicitly paired with.
There is no central server to lose.

### Decentralized Topology: Three PCs

Three machines on one LAN, each with a broker on TCP 8765:

```text
  pc-a  192.168.1.10          pc-b  192.168.1.11          pc-c  192.168.1.12
  broker :8765                broker :8765                broker :8765
  supervisor                  supervisor                  supervisor
      |                            |                            |
      +------- peer add ---------->+<-------- peer add ---------+
      +<------ peer add -----------+--------- peer add -------->+
      |                                                         |
      +--------------------- peer add -------------------------->+
      +<-------------------- peer add ---------------------------+
```

Each arrow is one `lcr-cli peer add` run on the machine at the tail of the
arrow. Six runs total for three PCs: **trust is per-direction and never
inferred.** `pc-a` trusting `pc-b` does not let `pc-b` control `pc-a`.

### Per-PC Setup

Do all of this on each machine. Substitute that machine's own name.

**1. Install** (see *Install From Latest Release* above), then initialize:

```powershell
lcr-cli mesh init --name $env:COMPUTERNAME --host 0.0.0.0 --port 8765
```

`mesh init` generates a broker token if there isn't one already, derives a node
id from the hostname, and writes `%LOCALAPPDATA%\lan-command-runner\config.json`
with owner-only permissions. It is additive: an existing legacy `setup` config
keeps working and keeps its values.

`--host 0.0.0.0` is required for peers to reach this broker. The default
`127.0.0.1` only accepts local connections.

**2. Start the node:**

```powershell
lcr-cli mesh
```

This runs the local broker, the LAN discovery responder, and one reconnecting
outbound agent connection per enabled peer. It re-reads the config from disk
every two seconds, so `peer add` and `peer remove` take effect without a
restart.

**3. Find the other machines** (optional, and grants nothing):

```powershell
lcr-cli discover
lcr-cli discover --wait-ms 5000 --json
```

**4. Add each peer explicitly, in both directions.**

On `pc-a`:

```powershell
lcr-cli peer add pc-b --url http://192.168.1.11:8765
lcr-cli peer add pc-c --url http://192.168.1.12:8765
```

On `pc-b`:

```powershell
lcr-cli peer add pc-a --url http://192.168.1.10:8765
lcr-cli peer add pc-c --url http://192.168.1.12:8765
```

On `pc-c`:

```powershell
lcr-cli peer add pc-a --url http://192.168.1.10:8765
lcr-cli peer add pc-b --url http://192.168.1.11:8765
```

Each `peer add` prompts for **that peer's** broker token with hidden input, then
prints a reminder of the reciprocal command to run on the other side. `peer add`
refuses to add a peer whose url is this node's own broker, and refuses a second
record pointing at a broker some other peer already owns.

**5. Verify, then drive commands:**

```powershell
lcr-cli doctor
lcr-cli agents
lcr-cli exec pc-b -- hostname
lcr-cli pwsh pc-c 'Get-Service | Where-Object Status -eq "Running" | Measure-Object'
```

Peer and node management:

```powershell
lcr-cli peer list
lcr-cli peer list --json
lcr-cli peer remove pc-c
```

### Automatic Private-Network Connections

For a deliberately tokenless broker on a trusted LAN or private VPN, an agent
can watch discovery continuously and connect whenever a broker appears or
changes ports:

```powershell
lcr-cli broker --trust-lan --host 0.0.0.0
lcr-cli agent --auto-discover --name StreamPC --id StreamPC
```

The watcher polls UDP discovery every 10 seconds and uses the bounded TCP scan
at most once per minute when broadcasts find nothing. It keeps one connection
per discovered node and replaces that connection when the node advertises a
new port. Public IPs and unresolved hostnames are rejected. Token-protected
brokers are connected only when a token is already available in configuration
or the environment.

Use `--scan-interval-ms` and `--tcp-scan-interval-ms` to change the intervals.
`--auto-discover` intentionally grants every reachable trusted-LAN broker the
ability to issue commands to that agent while the watcher is running.

### Discovery Grants No Trust By Default

`lcr-cli discover` broadcasts on UDP 8766 and collects replies. A reply carries
only a node id, a node name, a broker port, and a health path.

- It **never carries a token**, in either direction.
- Plain `discover` **never establishes trust**. A discovered node cannot control
  you and you cannot control it unless you explicitly run `agent --discover`,
  `agent --auto-discover`, or configure it as a peer.
- Its default purpose is telling you the URL to type into `peer add`.

Discovery is a convenience for finding candidates. Pairing is always the
explicit, two-sided `peer add` above. Disable the responder entirely by setting
`discovery.enabled` to `false` in `config.json`.

### Token Handling

The broker token is the admin password for that machine. Treat it that way.

- `mesh init` generates one for you. You never need to invent or type one.
- `peer add` collects the peer's token through a **hidden prompt**, so it never
  lands in shell history, a scheduled-task command line, or a screen share.
  In a non-interactive shell it fails fast rather than hanging.
- For non-interactive automation, use the peer-specific `LCR_PEER_TOKEN`
  environment variable or an explicit `--token`. `LCR_TOKEN` remains the
  local/legacy broker token and is deliberately never reused by `peer add`.
- Read a token deliberately, only when you need to carry it to another machine:

  ```powershell
  lcr-cli show-config          # tokens replaced with <redacted>
  lcr-cli show-config --reveal # prints the real values
  ```

  `show-config` redacts by default. `--reveal` is the explicit escape hatch, and
  is the only supported way to read a stored token.
- Tokens are redacted from `setup`, `peer list`, `discover`, `doctor`, `startup
  status`, and supervisor log output. Nothing token-shaped reaches a log file.
- `config.json` is written with owner-only permissions (`icacls` on Windows,
  mode `0600` elsewhere). If that fails you get a warning — take it seriously,
  because that one file holds every peer's token.
- Never commit `config.json` or `.lcr-token`.

### Diagnostics: `doctor`

```powershell
lcr-cli doctor
lcr-cli doctor --json
```

The overview checks, in order:

| Check          | What it proves                                                   |
| -------------- | ---------------------------------------------------------------- |
| Configuration  | valid v2 config, a broker token exists, no duplicate peer urls    |
| Local broker   | something is listening, `/health` answers, and the node id matches |
| Each peer      | reachable, and actually an LCR broker rather than some other service |
| LAN candidates | the urls peers on this LAN should use for this node              |
| Public IPv4    | how this network egresses — see the warning below                |

A peer with a broken url fails only its own check; the rest of the report still
runs. Exit code is 0 when nothing failed, 1 otherwise.

Probe one target without touching the rest of the config:

```powershell
lcr-cli doctor --url http://192.168.1.11:8765
lcr-cli doctor --peer pc-b
```

`--url` and `--peer` hit only `/health`, which needs no token, so you can point
them at a machine you have not paired with yet.

#### Peer-Assisted Reachability: `--callback-peer`

**A locally discovered public IP never proves inbound forwarding.** `doctor`
looks up how your network egresses so you know what address to hand out, and it
says so explicitly:

```text
This network egresses as 203.0.113.9. This does NOT mean inbound 8765/tcp is
reachable — confirm with: lcr-cli doctor --callback-peer <name>
```

Knowing your public address tells you nothing about whether your router forwards
8765 inbound, whether your ISP blocks it, or whether a firewall drops it. Only a
machine on the outside can answer that.

```powershell
lcr-cli doctor --callback-peer pc-b
```

This asks an **already-trusted** peer to probe you back. The peer derives the
target host solely from the source address it observed your request arriving
from, then probes `/health` on the port you declared with a fresh challenge and
confirms the response echoes it alongside your node id. It accepts no host,
url, path, or protocol from the request body, so the endpoint cannot be turned
into a scanner. It requires that peer's admin token, which you already hold if
the peer is paired.

The result tells you what the peer actually saw and whether the probe succeeded:

```text
[OK  ] Callback reachability
       pc-b reached this node at http://192.168.1.10:8765/health in 3ms.
       Verified path scope: lan.
```

A `lan` scope means the peer is on your LAN. A `public` scope with a successful
probe verifies the current network path. It verifies the identity reported by
the responding LCR broker, not cryptographic machine identity.

### Unsafe: Public Plain HTTP

`peer add` refuses a plain-HTTP url whose host is a public address, or a
hostname it cannot prove is private, unless you pass `--allow-public-http`.

**This is strongly discouraged and it is not a configuration option — it is an
acceptance of a specific, concrete compromise.** Plain HTTP over a public path
provides no confidentiality and no integrity:

- Anyone on the path reads the broker token and can then run any command on the
  machine as your user.
- Anyone on the path reads every command, every command's output, and the
  contents of every transferred file.
- Anyone on the path can **inject** commands and file writes of their own. There
  is no signature or MAC to detect it.

LCR does not configure TLS, UPnP, or your router. The supported ways to link
machines across sites are a private VPN (WireGuard, Tailscale — put the peers on
the VPN's address range and no flag is needed) or a reverse proxy that
terminates HTTPS in front of the broker.

If you accept all of the above anyway:

```powershell
lcr-cli peer add remote-site --url http://203.0.113.40:8765 --allow-public-http
```

The flag is per-peer and recorded in the config, so `doctor` and `peer list`
keep reminding you which peers are exposed. `doctor --url` warns about the same
condition; `--allow-public-http` silences that warning for one run.

Note that a hostname LCR cannot prove is private — including `nas.local` and any
DNS name — is treated as public. This is deliberately conservative. Use the
literal LAN or VPN address instead of the name.

### Start The Mesh At Logon (Windows)

`lcr-cli startup` manages one Windows Scheduled Task named exactly
**`LAN Command Runner Mesh`**.

```powershell
lcr-cli startup install --dry-run   # print the exact plan, change nothing
lcr-cli startup install             # register it
lcr-cli startup status              # inspect it
lcr-cli startup status --json
lcr-cli startup remove --dry-run
lcr-cli startup remove              # unregister it
```

What gets registered:

- **Trigger:** at interactive logon, for the current user only.
- **Principal:** the current user, logon type `Interactive`, run level
  `Limited`. Never `Highest`, never `SYSTEM`. The command does not self-elevate
  and does not ask for or store a Windows password.
- **Action:** `powershell.exe` run hidden, invoking the installed
  `scripts\start-mesh.ps1` with explicit `-ConfigPath`, `-NodePath`, `-CliPath`,
  and `-LogPath`. That script validates each path exists, sets only
  `LCR_CONFIG`, creates the log directory, and runs the absolute current Node
  executable against the absolute `bin\lcr-cli.js` with `mesh`.

`install` is idempotent: re-running it replaces this exact task and nothing
else. `remove` unregisters this exact task by name and leaves your config, your
tokens, and your logs alone. Every path is quoted, and **no token is ever placed
on the task command line, in the task definition, in the generated script, in
the log, or in `startup status` output** — the child process reads tokens from
`config.json` at run time and only its *path* is passed in.

`startup status` reports whether the task exists, its state, last run time and
result code, next run time, principal and run level, action target, config path,
and whether each referenced file actually exists — which is how you catch a task
left pointing at a moved install root.

Mesh output appends to:

```text
%LOCALAPPDATA%\lan-command-runner\logs\mesh.log
```

Appends, never truncates, so restarts accumulate rather than overwrite. The task
starts at your *next* logon; start it immediately with `lcr-cli mesh`.

### Network Requirements

Two ports per machine, both of which you must open yourself. **LCR does not add
firewall rules and does not touch your router.**

| Port     | Protocol | Direction        | Needed for                     |
| -------- | -------- | ---------------- | ------------------------------ |
| 8765/tcp | TCP      | inbound          | peers reaching this broker     |
| 8766/udp | UDP      | inbound + broadcast | `lcr-cli discover` replies  |

On each machine, as Administrator, allow them for the private profile only:

```powershell
New-NetFirewallRule -DisplayName 'LCR broker' -Direction Inbound `
  -Protocol TCP -LocalPort 8765 -Profile Private -Action Allow
New-NetFirewallRule -DisplayName 'LCR discovery' -Direction Inbound `
  -Protocol UDP -LocalPort 8766 -Profile Private -Action Allow
```

Notes:

- Windows often marks a network as **Public** on first connection, which blocks
  both ports. Check with `Get-NetConnectionProfile` and set the LAN to Private.
- The broker port is the only one that must be reachable. Discovery is a
  convenience; skip UDP 8766 entirely and type peer urls by hand.
- **UDP broadcast does not cross subnets or most VPNs.** On a VPN, or across
  VLANs, discovery will find nothing and that is expected — use `peer add` with
  the peer's VPN address directly.
- Guest networks and client isolation block peer-to-peer traffic outright.
- On a VPN, bind to the VPN address range and treat it as your LAN. Tailscale's
  `100.64.0.0/10` and WireGuard's private ranges are recognized as private, so
  no `--allow-public-http` flag is needed.

### One Streamed Transfer At A Time

Run **one streamed file transfer at a time per broker.** Concurrent large
transfers can overflow the broker's in-memory event ring and abort a download.
Mesh mode makes this easier to hit, because several nodes can target the same
broker at once. Serialize your transfers.

## Broker / Agent Mode

Broker/agent mode is the original single-broker topology. It still works
unchanged, and mesh mode is layered additively on top of it — a legacy
`lcr-cli setup` config keeps every one of its values.

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
lcr-cli put agent-1234abcd .\large-file.bin C:\remote\large-file.bin --chunk-size 262144
lcr-cli cat agent-1234abcd C:\remote\file.txt
'hello from stdin' | lcr-cli write agent-1234abcd C:\remote\hello.txt --stdin
```

The put command uploads in bounded chunks (64 KiB to 1 MiB, default 192 KiB), so the CLI does not
load the whole local file into memory or send one oversized JSON request. The agent appends each
chunk to a temporary remote file, verifies its byte count and SHA-256, then moves it into place.
Use --force=false to refuse replacement of an existing destination. If a transfer is interrupted,
the temporary remote path is reported for cleanup.

The get command streams chunks to a local temporary file and renames it only after the remote job
succeeds. The cat command still writes file contents to stdout, so piping remains usable. Broker
file operations print progress to stderr.

Run one streamed transfer at a time per broker — see
[One Streamed Transfer At A Time](#one-streamed-transfer-at-a-time).

Agent lifecycle commands:

```powershell
lcr-cli disconnect agent-1234abcd
lcr-cli update-agent agent-1234abcd
```

`update-agent` tells a Windows agent to disconnect, run the latest release installer, and reconnect to the same broker with the same agent id. Use it after publishing a new release when you want existing agents to upgrade themselves.

The broker prints LAN health URLs. You must allow the broker port through Windows
Firewall yourself; LCR never adds a firewall rule. See
[Network Requirements](#network-requirements).

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

The logon task from `lcr-cli startup install` writes to the same directory:

```text
%LOCALAPPDATA%\lan-command-runner\logs\mesh.log
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

This project is safe to push as long as you do not commit `.env`, `.lcr-token`,
`config.json`, logs, or machine-specific secrets. `config.json` holds the broker
token and every peer token, so it is the single most important file to keep out
of a commit.
