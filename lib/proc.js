// Safe command execution: bounded output, a real timeout, and a process-tree
// kill that reaches grandchildren.
//
// The previous implementation sent SIGTERM and then checked `child.killed`,
// which Node sets to true on *signal delivery* — so the SIGKILL escalation was
// dead code, and killing `cmd.exe`/`sh` left the actual command orphaned.

const { spawn, spawnSync } = require("node:child_process");
const { BoundedBuffer, truncatedText } = require("./ring");

// Delay between the polite signal and the forced tree kill.
const KILL_ESCALATION_MS = 1500;
// Absolute cap after the forced kill, so an unkillable process can never hang
// the caller forever.
const HARD_DEADLINE_MS = 5000;

function isWindows() {
  return process.platform === "win32";
}

// Kills the child and everything it spawned. Windows has no process groups to
// rely on, so `taskkill /T` walks the PID tree; POSIX uses a negative PID
// (which requires the child to have been spawned detached).
function killProcessTree(child, force = true) {
  if (!child || !child.pid) return { ok: false, reason: "no-pid" };

  if (isWindows()) {
    const args = ["/pid", String(child.pid), "/T"];
    if (force) args.push("/F");
    const result = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
    if (!result.error && result.status === 0) return { ok: true, mode: "taskkill" };
    // Fall back to the Node-level kill (a child with no grandchildren, or a
    // taskkill that is blocked by policy).
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
      return { ok: true, mode: "signal" };
    } catch {
      return { ok: false, reason: "taskkill-and-signal-failed" };
    }
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, signal);
    return { ok: true, mode: "process-group" };
  } catch {
    /* not a group leader; fall through */
  }
  try {
    child.kill(signal);
    return { ok: true, mode: "signal" };
  } catch {
    return { ok: false, reason: "signal-failed" };
  }
}

function processAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

// Runs one command to completion. Resolves (never rejects) with:
//   { ok, code, signal, timedOut, startedAt, endedAt, cwd, stdout, stderr,
//     truncated, stdoutTruncated, stderrTruncated, droppedBytes }
function spawnCommand(options = {}) {
  const {
    command,
    args = [],
    shell = false,
    cwd,
    env,
    timeoutMs,
    outputLimitBytes,
    onOutput,
    detached = !isWindows(),
  } = options;

  const stdoutBuffer = new BoundedBuffer(outputLimitBytes);
  const stderrBuffer = new BoundedBuffer(outputLimitBytes);
  const startedAt = new Date().toISOString();

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      shell: Boolean(shell),
      windowsHide: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.resolve({
      ok: false,
      code: null,
      signal: null,
      timedOut: false,
      startedAt,
      endedAt: new Date().toISOString(),
      cwd,
      stdout: "",
      stderr: error.message,
      truncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      droppedBytes: 0,
    });
  }

  let timedOut = false;
  let settled = false;
  let timer = null;
  let killTimer = null;
  let hardDeadline = null;

  const emit = (stream, buffer) => {
    if (!onOutput) return;
    try {
      onOutput(stream, buffer.toString("utf8"));
    } catch {
      /* a broken stream consumer must never kill the command */
    }
  };

  return new Promise((resolve) => {
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardDeadline) clearTimeout(hardDeadline);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        cwd,
        stdout: truncatedText(stdoutBuffer, "stdout"),
        stderr: truncatedText(stderrBuffer, "stderr"),
        truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
        droppedBytes: stdoutBuffer.droppedBytes + stderrBuffer.droppedBytes,
      });
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child, false);
        killTimer = setTimeout(() => {
          if (processAlive(child)) killProcessTree(child, true);
          hardDeadline = setTimeout(() => finish(null, null), HARD_DEADLINE_MS);
          if (hardDeadline.unref) hardDeadline.unref();
        }, KILL_ESCALATION_MS);
        if (killTimer.unref) killTimer.unref();
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutBuffer.push(chunk);
        emit("stdout", chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrBuffer.push(chunk);
        emit("stderr", chunk);
      });
    }

    child.on("error", (error) => {
      stderrBuffer.push(`\n${error.message}\n`);
      finish(null, null);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

module.exports = {
  HARD_DEADLINE_MS,
  KILL_ESCALATION_MS,
  killProcessTree,
  processAlive,
  spawnCommand,
};
