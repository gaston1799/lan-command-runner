# Changelog

All notable changes to LAN Command Runner are documented here.

## [0.15.0] — 2026-10-07

### Security

- **Request and response signing.** Every authenticated request and response is
  HMAC-SHA256 signed over method, path, body hash, timestamp, and a per-request
  nonce, keyed by the shared token. Replay protection via a nonce cache and a
  time window. This makes command/file injection by a passive or active
  on-LAN attacker fail closed. (`lib/sign.js`, `lib/guard.js`, `lib/transport.js`)
- **Credential hardening.** Agent ids are now 64-bit and agent tokens 128-bit
  (were 32-bit). Token comparison is constant-time. Repeated auth failures from
  one address trigger a short lockout (429). (`lib/auth.js`)
- **Bounded command output.** stdout/stderr buffering is capped (default 8 MB)
  and flagged `truncated` with a dropped-byte count, instead of growing without
  bound and OOM-killing the agent. (`lib/ring.js`, `lib/proc.js`)
- **Process-tree kill.** A timed-out command kills the whole process tree on
  Windows and POSIX instead of leaving grandchildren orphaned. (`lib/proc.js`)
- **Audit log.** Append-only, redacted JSONL audit trail on broker and agent
  with size-based rotation. (`lib/audit.js`, `lcr-cli log`)
- **File integrity.** Downloads carry a SHA-256 of the source file and the
  client verifies the assembled bytes end-to-end.

### Reliability

- **Download flow control.** The broker pauses the agent while more than a
  bounded amount of output is buffered for a slow client, removing the previous
  ~192 MB in-memory ceiling and index-gap failures.
- **Job registry.** Per-agent backlog cap (429 when full), job listing, queued
  job cancellation, and liveness reporting (`online`, `lastSeenAgeMs`) with
  automatic pruning of dead agents.
- Request body limit lowered and made configurable.

### New commands

- `lcr-cli jobs [--agent <id>] [--json]` — list queued/running/done jobs.
- `lcr-cli cancel <agent-id> <job-id>` — cancel a queued job.
- `lcr-cli log [--tail N] [--json] [--dir <path>]` — view the local audit log.

### Configuration

New environment variables (all optional): `LCR_MAX_OUTPUT_BYTES`,
`LCR_MAX_REQUEST_BYTES`, `LCR_JOB_BACKLOG_MAX`, `LCR_JOB_TTL_MS`,
`LCR_AGENT_OFFLINE_MS`, `LCR_AGENT_PRUNE_MS`, `LCR_AUTH_FAILURE_LIMIT`,
`LCR_AUTH_FAILURE_WINDOW_MS`, `LCR_AUTH_LOCKOUT_MS`, `LCR_SIGN_SKEW_MS`,
`LCR_ALLOW_UNSIGNED`, `LCR_STREAM_HIGH_WATER_BYTES`,
`LCR_STREAM_LOW_WATER_BYTES`, `LCR_STREAM_DRAIN_TIMEOUT_MS`,
`LCR_AUDIT_DIR`, `LCR_AUDIT_DISABLED`.

### Development

- Added a `node:test` suite (`npm test`) covering output bounds, credential
  entropy, throttling, signing/replay, job listing/cancel, audit, and file
  integrity, alongside the existing `npm run smoke` suites.
- `engines.node >= 18.17.0`.
- Installer now uses `npm ci --omit=dev --ignore-scripts`.

## [0.14.0] — 2026-08-31

- Mesh mode with chunked file transfers.

## [0.1.0] — 2026-04-22

- Initial LAN command runner.
