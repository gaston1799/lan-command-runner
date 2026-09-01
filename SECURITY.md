# Security Policy

## Reporting Vulnerabilities

Report security issues privately to the project owner or through GitHub security
advisories when available. Do not publish working exploits, broker tokens,
machine identifiers, command output, or local network details in public issues.

Include:

- Affected version.
- Broker, agent, or direct mode.
- Steps to reproduce.
- Expected impact.
- Whether command execution, token leakage, path traversal, file transfer, or
  privilege escalation is involved.

## Operational Safety

Treat LCR tokens like admin passwords. Do not expose LCR to the public internet.
Use it only on a trusted LAN, VPN, or SSH tunnel.

Never commit broker tokens, machine-specific config files, command logs, or
local paths.

## Mesh Mode

`lcr-cli peer add` refuses a plain-HTTP peer whose address is public, or whose
hostname it cannot prove is private, unless you pass `--allow-public-http`. That
flag is an explicit acceptance of credential interception and remote-command
interception: over plain HTTP anyone on the path can read the broker token and
every command and file that crosses it, and can inject their own. Prefer a LAN
or a private VPN (WireGuard, Tailscale) over that flag. LCR does not configure
TLS, UPnP, or your router.

LAN discovery (`lcr-cli discover`, UDP 8766) advertises only a node id, node
name, broker port, and health path. It never carries a token and never
establishes trust — peers are only ever added explicitly, in both directions.
Responses cap identity fields and are rate-limited per source address. The mesh
responder binds to the same host as the local broker.

`lcr-cli doctor --callback-peer <name>` asks an already-trusted peer to call
back. The peer probes only the source address it observed the request arriving
from, on the port you declare, at `/health`. It never accepts a host, URL, or
path from the request body, so the endpoint cannot be used as a scanner. It
requires that peer's admin token, so only paired nodes can invoke it. The
public IPv4 address `doctor` discovers locally is a hint about egress only and
never evidence that inbound forwarding works. A peer callback sends a fresh
challenge and verifies the current network path to a broker responding with the
expected node id; it is not cryptographic machine identity.

## Windows Logon Startup

`lcr-cli startup install` registers exactly one Scheduled Task named
`LAN Command Runner Mesh` for the current user, triggered at interactive logon,
with logon type `Interactive` and run level `Limited`. It never requests
`Highest`, never runs as `SYSTEM`, never self-elevates, and never requests or
stores a Windows password.

No token reaches the task command line, the task definition, the generated
runtime script, the log file, or `startup status` output. The task passes only
the *path* of `config.json`; the supervisor reads tokens from that file at run
time, protected by the file's own ACL. Every path in the action is quoted.

`startup install` replaces only that exact task name. `startup remove`
unregisters only that exact task name and never deletes configuration, tokens,
or logs. Use `--dry-run` to review the exact plan before changing anything.

`%LOCALAPPDATA%\lan-command-runner\logs\mesh.log` is append-only and contains no
token and no config contents. It does record commands the supervisor logs, so
treat it as sensitive operational data.

The release installer preserves only `config.json`, `tray-settings.json`,
`.lcr-token`, and `logs\` across an upgrade, and re-applies the config file's
ACL best-effort. It never preserves source files, so an upgrade cannot resurrect
old code.

LCR does not add firewall rules and does not configure your router. Opening the
broker's TCP port and the discovery UDP port is a deliberate act you perform
yourself.

Run one streamed file transfer at a time per broker. Concurrent large transfers
can overflow the broker's in-memory event buffer and abort a download.
