// Central limit configuration. Every value is env-overridable so operators and
// tests can tighten or loosen a bound without touching code. Values are read at
// call time, never cached at module load, so a test that sets an env var after
// `require()` still takes effect.

const KiB = 1024;
const MiB = 1024 * 1024;

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Command output retained in memory per stream. Beyond this the stream is
// dropped from the buffered copy (the live stream still receives everything)
// and the result is flagged `truncated` instead of growing without bound.
function outputLimitBytes() {
  return intFromEnv("LCR_MAX_OUTPUT_BYTES", 8 * MiB, 64 * KiB, 512 * MiB);
}

// Largest JSON request body accepted. Was a flat 64 MiB, which let one request
// block the event loop in JSON.parse.
function maxRequestBodyBytes() {
  return intFromEnv("LCR_MAX_REQUEST_BYTES", 16 * MiB, 64 * KiB, 256 * MiB);
}

// Jobs a single agent may have queued before the broker refuses more.
function jobBacklogMax() {
  return intFromEnv("LCR_JOB_BACKLOG_MAX", 64, 1, 10000);
}

// Jobs a single agent may run at once. The agent polls one job at a time, so
// this is really "queued + in flight" admission control on the broker side.
function maxConcurrentJobs() {
  return intFromEnv("LCR_JOB_CONCURRENCY", 2, 1, 64);
}

// How long a finished job (and its stream buffer) is retained for late pollers.
function jobTtlMs() {
  return intFromEnv("LCR_JOB_TTL_MS", 10 * 60 * 1000, 5000, 24 * 60 * 60 * 1000);
}

// An agent that has not polled within this window is reported offline.
function agentOfflineMs() {
  return intFromEnv("LCR_AGENT_OFFLINE_MS", 90 * 1000, 5000, 60 * 60 * 1000);
}

// An offline agent record is deleted after this long with no contact.
function agentPruneMs() {
  return intFromEnv("LCR_AGENT_PRUNE_MS", 30 * 60 * 1000, 10000, 7 * 24 * 60 * 60 * 1000);
}

// A staged broker upload that is never fetched by its agent expires.
function uploadTtlMs() {
  return intFromEnv("LCR_UPLOAD_TTL_MS", 30 * 60 * 1000, 10000, 24 * 60 * 60 * 1000);
}

// Auth failures from one address before a short lockout.
function authFailureLimit() {
  return intFromEnv("LCR_AUTH_FAILURE_LIMIT", 10, 1, 100000);
}

function authFailureWindowMs() {
  return intFromEnv("LCR_AUTH_FAILURE_WINDOW_MS", 60 * 1000, 1000, 60 * 60 * 1000);
}

function authLockoutMs() {
  return intFromEnv("LCR_AUTH_LOCKOUT_MS", 60 * 1000, 1000, 60 * 60 * 1000);
}

// Signed-request acceptance window and replay-cache retention. Five minutes is
// generous for unmanaged LAN boxes with drifting clocks while still bounding
// a replay window.
function signSkewMs() {
  return intFromEnv("LCR_SIGN_SKEW_MS", 5 * 60 * 1000, 1000, 60 * 60 * 1000);
}

function signNonceTtlMs() {
  return intFromEnv("LCR_SIGN_NONCE_TTL_MS", 5 * 60 * 1000, 5000, 60 * 60 * 1000);
}

// Streaming pump shaping: batch size, flush interval, and in-flight cap.
function streamBatchBytes() {
  return intFromEnv("LCR_STREAM_BATCH_BYTES", 64 * KiB, 1024, 4 * MiB);
}

function streamBatchMs() {
  return intFromEnv("LCR_STREAM_BATCH_MS", 50, 5, 5000);
}

function streamInflightMax() {
  return intFromEnv("LCR_STREAM_INFLIGHT_MAX", 4, 1, 64);
}

// Default file-transfer chunk size (agent -> broker and broker -> client).
function streamChunkBytes() {
  return intFromEnv("LCR_FILE_STREAM_CHUNK_BYTES", 192 * KiB, 64 * KiB, 4 * MiB);
}

// Broker-side byte budget for a streamed download: the agent is paused while
// more than HIGH_WATER bytes are buffered for a client that has not yet read
// them, and released once the client drains below LOW_WATER.
function streamHighWaterBytes() {
  return intFromEnv("LCR_STREAM_HIGH_WATER_BYTES", 8 * MiB, 1 * MiB, 256 * MiB);
}

function streamLowWaterBytes() {
  return intFromEnv("LCR_STREAM_LOW_WATER_BYTES", 4 * MiB, 256 * KiB, 128 * MiB);
}

function streamDrainTimeoutMs() {
  return intFromEnv("LCR_STREAM_DRAIN_TIMEOUT_MS", 60000, 1000, 60 * 60 * 1000);
}

// Broker-side spool directory for staged uploads. Defaults to the OS temp dir.
function uploadSpoolDir() {
  return process.env.LCR_UPLOAD_SPOOL_DIR || "";
}

// Directory for audit logs. Empty means "next to the config file", which is
// resolved by lib/audit.js so this module stays free of filesystem concerns.
function auditDir() {
  return process.env.LCR_AUDIT_DIR || "";
}

module.exports = {
  agentOfflineMs,
  agentPruneMs,
  auditDir,
  authFailureLimit,
  authFailureWindowMs,
  authLockoutMs,
  jobBacklogMax,
  jobTtlMs,
  maxConcurrentJobs,
  maxRequestBodyBytes,
  outputLimitBytes,
  signNonceTtlMs,
  signSkewMs,
  streamBatchBytes,
  streamBatchMs,
  streamChunkBytes,
  streamDrainTimeoutMs,
  streamHighWaterBytes,
  streamInflightMax,
  streamLowWaterBytes,
  uploadSpoolDir,
  uploadTtlMs,
};
