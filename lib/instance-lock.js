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
// The lock is deliberately never deleted: liveness is decided by the recorded
// PID, so a crashed or force-killed agent self-heals on its next start instead
// of leaving a lock that has to be cleared by hand. `allowMultiple` (from
// `--allow-multiple-agents` or LCR_ALLOW_MULTIPLE_AGENTS=1) is the escape hatch
// for the two legitimate cases: the self-update spawn, which starts the
// replacement agent while the current one is still exiting, and a deliberate
// second copy.
//
// Known limitation: on POSIX and Windows a reused PID can make a dead holder
// look alive. That only produces a refusal with the holder PID in the message,
// and the escape hatch above clears it, so it never blocks work silently.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { defaultConfigPath } = require("./config");

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

// Returns { ok: true, path, previous } when this process may proceed, or
// { ok: false, path, holder } when another live process already owns the slot.
function acquireInstanceLock(options = {}) {
  const kind = options.kind || "agent";
  const identity = String(options.identity || "");
  if (!identity) throw new Error("An instance lock needs a non-empty identity.");

  const file = lockPath(kind, identity);
  const record = {
    pid: process.pid,
    kind,
    identity,
    label: options.label ? String(options.label) : "",
    startedAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;

  if (options.allowMultiple === true) {
    const previous = readRecord(file);
    writeRecord(file, body);
    return { ok: true, path: file, previous, allowMultiple: true };
  }

  // `wx` makes the create atomic: two agents starting at the same instant
  // cannot both believe they created the record.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { ok: true, path: file, previous: null };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const holder = readRecord(file);
  if (holder && holder.pid !== process.pid && pidIsAlive(holder.pid)) {
    return { ok: false, path: file, holder, message: `Another LCR agent is already running (${describeHolder(holder)}).` };
  }

  // The holder is this process (reconnect), a dead PID, or an unreadable
  // record: take the slot over.
  writeRecord(file, body);
  return { ok: true, path: file, previous: holder, tookOver: Boolean(holder) };
}

function writeRecord(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

module.exports = {
  acquireInstanceLock,
  describeHolder,
  lockDirectory,
  lockPath,
  pidIsAlive,
};
