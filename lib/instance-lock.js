// Local single-instance guard for agent connections.
//
// The broker keeps one record per agent id, and that record owns one job queue.
// Two agent processes that register with the same broker under the same id are
// therefore not kept apart: both long-poll the same queue, and whichever one
// wins the poll takes the job. A stale, half-configured, or older-version copy
// that takes a job and never reports a result leaves that job "running" on the
// broker forever, and the client waits for an answer that cannot arrive. The
// operator sees "the agent will not fetch tasks" while a healthy agent sits
// right next to the broken one.
//
// One small JSON file per (broker url, agent id) makes that configuration error
// visible at start time instead of silent at job time.
//
// The lock is deliberately not cleared on a crash: liveness is decided by the
// recorded PID, so a force-killed agent self-heals on its next start instead of
// leaving a lock that has to be removed by hand. `allowMultiple` (from
// `--allow-multiple-agents` or LCR_ALLOW_MULTIPLE_AGENTS=1) is the escape hatch
// for the two legitimate cases: the self-update spawn, which starts the
// replacement agent while the current one is still exiting, and a deliberate
// second copy.
//
// Taking over a dead holder is serialized with a short-lived guard file. Without
// it, two agents starting at the same instant both read the same dead PID, both
// pass the liveness check, and both believe they own the slot - recreating the
// exact duplicate-process failure this module exists to prevent.
//
// Known limitation: on POSIX and Windows a reused PID can make a dead holder
// look alive. That only produces a refusal with the holder PID in the message,
// and the escape hatch above clears it, so it never blocks work silently.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { defaultConfigPath } = require("./config");

// A takeover guard older than this belongs to a process that died mid-takeover.
const TAKEOVER_GUARD_STALE_MS = 5000;
const TAKEOVER_ATTEMPTS = 6;
const TAKEOVER_RETRY_MS = 20;

function lockDirectory() {
  return path.join(path.dirname(defaultConfigPath()), "locks");
}

function lockPath(kind, identity) {
  const digest = crypto.createHash("sha256").update(String(identity)).digest("hex").slice(0, 16);
  return path.join(lockDirectory(), `${kind}-${digest}.lock`);
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid)) return parsed;
  } catch {
    // A missing, torn, or malformed record means "nobody is holding this".
  }
  return null;
}

// Signal 0 asks the OS whether the PID exists without touching the process.
// EPERM means it exists but belongs to another user: still alive.
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function describeHolder(holder) {
  const parts = [`pid ${holder.pid}`];
  if (holder.label) parts.push(`name ${JSON.stringify(holder.label)}`);
  if (holder.startedAt) parts.push(`started ${holder.startedAt}`);
  return parts.join(", ");
}

// Synchronous by design: acquireInstanceLock runs before the agent starts, and
// the retry window is a few milliseconds.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No shared memory available: retry immediately rather than throwing.
  }
}

function writeRecord(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
  // Renaming over a record another process is reading can fail transiently on
  // Windows (sharing violation). Retry briefly; anything else is a real error.
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "EBUSY") throw error;
      sleepSync(15);
    }
  }
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Leave it for the OS temp cleanup rather than masking the rename failure.
  }
  throw lastError;
}

// Deletes the record only while it still carries this acquisition's id, so a
// connection that has already been replaced cannot evict its replacement.
function makeRelease(file, instanceId) {
  let released = false;
  return function release() {
    if (released) return false;
    released = true;
    const current = readRecord(file);
    if (!current || current.instanceId !== instanceId) return false;
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  };
}

// Runs under the takeover guard: re-read the record, refuse a holder that
// became live in the meantime, otherwise replace the stale one.
function takeoverLock(file, body) {
  const guard = `${file}.takeover`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(guard, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let ageMs = TAKEOVER_GUARD_STALE_MS;
    try {
      ageMs = Date.now() - fs.statSync(guard).mtimeMs;
    } catch {
      ageMs = TAKEOVER_GUARD_STALE_MS;
    }
    if (ageMs >= TAKEOVER_GUARD_STALE_MS) {
      try {
        fs.rmSync(guard, { force: true });
      } catch {
        // Another process cleared it first; the retry loop re-reads the record.
      }
    }
    return { contended: true };
  }

  try {
    const current = readRecord(file);
    if (current && current.pid !== process.pid && pidIsAlive(current.pid)) {
      return { ok: false, holder: current };
    }
    writeRecord(file, body);
    return { ok: true };
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Already closed.
    }
    try {
      fs.rmSync(guard, { force: true });
    } catch {
      // Already gone.
    }
  }
}

// Returns { ok: true, path, release, tookOver } when this process may proceed,
// or { ok: false, path, holder } when another live process already owns the
// slot. Call the returned `release` when the connection ends.
function acquireInstanceLock(options = {}) {
  const kind = options.kind || "agent";
  const identity = String(options.identity || "");
  if (!identity) throw new Error("An instance lock needs a non-empty identity.");

  const file = lockPath(kind, identity);
  const instanceId = crypto.randomBytes(12).toString("hex");
  const record = {
    pid: process.pid,
    kind,
    identity,
    instanceId,
    label: options.label ? String(options.label) : "",
    startedAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;

  if (options.allowMultiple === true) {
    const previous = readRecord(file);
    writeRecord(file, body);
    return { ok: true, path: file, previous, allowMultiple: true, release: () => false };
  }

  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    // `wx` makes the create atomic: two agents starting at the same instant
    // cannot both believe they created the record.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { ok: true, path: file, previous: null, release: makeRelease(file, instanceId) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const holder = readRecord(file);
    if (holder && holder.pid !== process.pid && pidIsAlive(holder.pid)) {
      return {
        ok: false,
        path: file,
        holder,
        message: `Another LCR agent is already running (${describeHolder(holder)}).`,
      };
    }

    const takeover = takeoverLock(file, body);
    if (takeover.ok) {
      return { ok: true, path: file, previous: holder, tookOver: Boolean(holder), release: makeRelease(file, instanceId) };
    }
    if (takeover.holder) {
      return {
        ok: false,
        path: file,
        holder: takeover.holder,
        message: `Another LCR agent is already running (${describeHolder(takeover.holder)}).`,
      };
    }
    sleepSync(TAKEOVER_RETRY_MS);
  }

  const holder = readRecord(file);
  return {
    ok: false,
    path: file,
    holder,
    message: holder
      ? `Another LCR agent is already running (${describeHolder(holder)}).`
      : "Another LCR agent is taking over the agent instance lock right now.",
  };
}

module.exports = {
  TAKEOVER_GUARD_STALE_MS,
  acquireInstanceLock,
  describeHolder,
  lockDirectory,
  lockPath,
  pidIsAlive,
};
