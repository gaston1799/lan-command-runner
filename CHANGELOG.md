# Changelog

All notable changes to LAN Command Runner are documented here.

## [Unreleased]

### Fixed

- **Queued jobs wake an open long-poll again.** The poll waiter queue was not
  cleaned up when a poll expired on its own, so it filled with settled closures
  and each `enqueueJob` woke a dead one instead of the live poll. Jobs were then
  delivered only when the live poll timed out: measured on a real install as
  `startedAt - createdAt` of 11.5-24.8 s with a ~100 ms command, after the first
  job was fast. Every job now wakes the poll that is actually waiting
  (`lib/broker.js`, regression test in `test/poll-wakeup.test.js`).

## [0.16.0] — 2026-11-01

### Fixed

- **Agents no longer loop on `--trust-lan` brokers.** An agent whose saved
  config still carried a broker token signed every request, but a tokenless
  broker cannot sign the replies. The client rejected each one as
  `Missing response signature` and re-registered every two seconds without ever
  polling, so accepted jobs stayed queued while `/agents` reported the agent
  online. The agent now asks `/broker` which mode it runs in and signs only when
  the broker authenticates, and a `--trust-lan` broker echoes a signed reply to
  a signed caller so 0.15 agents recover after a broker restart too.
- **A re-registration no longer discards accepted jobs.** Registering the same
  agent id rebuilt its record with an empty queue, so queued work silently
  vanished while `lcr-cli jobs` still reported it as `queued`. The record and its
  queue now survive, and a registration generation retires long-polls from a
  superseded connection instead of letting them race the new one for the work.
- **One stable broker address per node.** A broker that advertises several
  interfaces used to win by UDP reply order, so the auto-discovery watcher tore
  the connection down and re-registered on every round. Candidates now rank LAN
  over private VPN over loopback, then same-subnet, then a fixed order.
- **`--help` no longer starts a service.** `--help` (and `-h`) on any
  subcommand prints usage and exits 0. Before this, `lcr-cli agent --help`
  silently ran a real agent: it registered on the broker and kept polling,
  so an operator who only wanted the usage text ended up with a second agent
  process competing for the same job queue. A `-h` after `--` still belongs to
  the remote command.
- **One agent process per broker and agent id.** A second `lcr-cli agent` for
  the same broker url and agent id now refuses to start with an actionable
  message instead of joining the first one's queue. Two agents share a single
  broker-side queue, so the one that loses the race takes a job the other never
  sees, and the broker reports that job as `running` forever — the visible
  symptom is "the agent fetches nothing" while `lcr-cli jobs` shows a job that
  never ends. `--allow-multiple-agents` (or `LCR_ALLOW_MULTIPLE_AGENTS=1`) is
  the explicit override, and the self-update spawn uses it so the replacement
  agent can start while the old one exits. Taking over a dead holder is
  serialized, so two agents starting at the same instant cannot both take the
  slot; the identity ignores URL formatting (`http://host:8765` and
  `http://host:8765/` are the same broker); and the lock belongs to the
  connection, so it is released when a connection stops and a superseded
  connection can never delete its successor's record.
- **Actionable, deduplicated connection errors.** A reply that arrives without
  a response signature now names the peer and the fix instead of repeating
  `Response signature verification failed: Missing response signature.`
  forever; one real install had 64,977 identical lines. The agent logs a new
  message immediately and then only every hundredth repeat.
- **`lcr-cli agent --url` works against a `--trust-lan` broker.** A tokenless
  start no longer fails with `Missing token` when the broker advertises
  `authMode: none`; a reachable broker that does want a token still fails
  clearly, and an unreachable broker keeps the old wait-and-retry behavior.

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
