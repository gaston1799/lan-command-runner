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
